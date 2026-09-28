/**
 * M0 本地服务：把 core 暴露成 REST + 媒体流，供浏览器界面使用。
 *
 * 本地服务的安全边界（开发建议 §9 第 2 条）：
 *  - 只绑定 127.0.0.1，绝不 0.0.0.0；
 *  - 每次启动生成随机 token，写进 runtime.json；前端从页面注入的 meta 里拿；
 *  - 校验 Host 必须是 127.0.0.1/localhost（防 DNS rebinding）；
 *  - 带 Origin 的跨源请求一律拒绝；不发任何 CORS 头；
 *  - 诚实说明：token 防的是"网页来源的攻击"，防不住本机其他进程——
 *    任何本地进程本来就能直接读磁盘上的库文件。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LIBRARY_DIR, RUNTIME_FILE, loadConfig, thumbPathForHash, type LibraryConfig,
} from '../core/config.ts';
import { openDb, sqliteVersion } from '../core/db.ts';
import { apiDoc } from './openapi.ts';
import { indexRoot, type IndexProgress, type IndexStats } from '../core/indexer.ts';
import { importToLibrary } from '../core/importer.ts';
import { getAsset, getStats, listTrashedAssets, searchAssets } from '../core/query.ts';
import { ftsNeedsReindex, purgeTrashed, reindexFts, restoreAsset, trashAsset, verifyLibrary } from '../core/maintenance.ts';
import {
  createProject, deleteProject, renameProject, importExternalFile, importTextAsset, listAssetVersions, listProjects,
  listTrashProjects, projectScopeIds, restoreTrashProject, saveTextVersion, setAssetProject, updateAssetMeta, updateAssetMetaForBundle, updateAssetModel,
} from '../core/organize.ts';
import { makeImageThumb, makeVideoThumb, mimeOf, THUMB_SIZE } from '../core/ffmpeg.ts';
import { buildPeaks, readCachedPeaks, writePeaksCache } from '../core/peaks.ts';
import { isAudioExt, isTextExt, type Modality } from '../core/kind.ts';
import { launchCandidate, listOpenWith } from '../core/openwith.ts';
import { readTextFile, writeTextFile } from '../core/fstext.ts';
import { addMember, createBundle, expandBundle, getBundle, listBundles, listMembers, pruneBundles, removeMember } from '../core/bundles.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const WEB_DIST = join(PROJECT_ROOT, 'dist', 'web');
const TOKEN_PLACEHOLDER = '__PM_TOKEN__';

const cfg: LibraryConfig = loadConfig();
const db = openDb();
const TOKEN = randomBytes(24).toString('hex');
const STARTED_AT = new Date().toISOString();
const TMP_DIR = join(LIBRARY_DIR, '.tmp');

// 启动自愈：全文索引结构升级过、或行数与素材数不符时，从 asset 表重建（纯派生数据）
const ftsHealed = ftsNeedsReindex(db) ? reindexFts(db).rows : 0;

interface ScanState {
  running: boolean;
  phase: string;
  processed: number;
  total: number;
  current: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  last: IndexStats | null;
}

const scanState: ScanState = {
  running: false, phase: 'idle', processed: 0, total: 0, current: '',
  startedAt: null, finishedAt: null, error: null, last: null,
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Host 头必须是本机回环地址：这是防 DNS rebinding 的关键一步 */
function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  const ok = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return ok.includes(host);
}

/** 带 Origin 的请求必须是同源（浏览器同源请求不会带 Origin 的 GET 除外） */
function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return allowed.includes(origin.toLowerCase());
}

/**
 * token 校验。除了自定义请求头，还接受 ?token= —— 因为 <img>/<video>/<audio>
 * 标签由浏览器发起，无法附加自定义请求头（M0 实测踩到的点）。
 */
function tokenAllowed(req: IncomingMessage, url: URL): boolean {
  const header = req.headers['x-pm-token'];
  if (typeof header === 'string' && header === TOKEN) return true;
  return url.searchParams.get('token') === TOKEN;
}

/** 文本类素材的前 N 字节，用于代码/笔记/文本预览（回收站里的也可读） */function serveText(res: ServerResponse, id: number, max: number): void {
  const asset = getAsset(db, id, { includeTrashed: true });
  if (!asset) return json(res, 404, { error: '素材不存在' });
  if (!isTextExt(asset.ext)) return json(res, 415, { error: `不支持文本预览：${asset.ext}` });
  if (!existsSync(asset.absPath)) return json(res, 410, { error: '文件已不在磁盘上' });
  const size = statSync(asset.absPath).size;
  const length = Math.min(max, size);
  const buffer = Buffer.alloc(length);
  const fd = openSync(asset.absPath, 'r');
  try {
    readSync(fd, buffer, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  const body = buffer.toString('utf8');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Truncated': size > length ? 'true' : 'false',
    'X-File-Size': String(size),
  });
  res.end(body);
}

/** 缩略图：按内容哈希定位，缓存缺失时**就地补生成**。
 *  回收站里的素材同样可用 —— 缩略图缓存是内容寻址的，删素材并不会删它。 */
async function serveThumb(res: ServerResponse, id: number): Promise<void> {
  const asset = getAsset(db, id, { includeTrashed: true });
  if (!asset) return json(res, 404, { error: '素材不存在' });
  if (!asset.hash) return json(res, 404, { error: '该素材没有内容哈希，无法定位缩略图' });

  const file = thumbPathForHash(asset.hash);
  if (!existsSync(file) && (asset.kind === 'image' || asset.kind === 'video') && existsSync(asset.absPath)) {
    const ok =
      asset.kind === 'image'
        ? await makeImageThumb(asset.absPath, file, cfg.ffmpegDir)
        : await makeVideoThumb(asset.absPath, file, cfg.ffmpegDir);
    if (ok) db.prepare('UPDATE file SET thumb_at = ? WHERE asset_id = ?').run(new Date().toISOString(), id);
  }
  if (!existsSync(file)) {
    return json(res, 404, { error: '该素材没有缩略图' });
  }
  const st = statSync(file);
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=604800',
    ETag: `"thumb-${asset.hash}-${st.mtimeMs}"`,
  });
  createReadStream(file).pipe(res);
}

/** 波形并发去重：同一段音频同时被请求时只跑一次 ffmpeg */
const peaksInFlight = new Map<string, Promise<import('../core/peaks.ts').Peaks | null>>();

/**
 * 音频波形 peaks：缓存命中就直接返回；缺缓存时用 ffmpeg 现算一次并写缓存。
 * 内容哈希命名 → 同一段音频只算一次；回收站里的素材也能看到波形。
 */
async function servePeaks(res: ServerResponse, id: number): Promise<void> {
  const asset = getAsset(db, id, { includeTrashed: true });
  if (!asset) return json(res, 404, { error: '素材不存在' });
  if (!asset.hash) return json(res, 404, { error: '该素材没有内容哈希，无法定位波形缓存' });
  const hash = asset.hash;
  if (!asset.ext || !isAudioExt(asset.ext)) return json(res, 415, { error: `不是音频：${asset.ext ?? '无后缀'}` });

  let peaks = readCachedPeaks(hash);
  if (!peaks && existsSync(asset.absPath)) {
    // 同一个哈希只算一次：并发请求共用同一个 promise
    const running = peaksInFlight.get(hash);
    const task = running ?? buildPeaks(asset.absPath, cfg.ffmpegDir);
    if (!running) {
      peaksInFlight.set(hash, task);
      void task.finally(() => peaksInFlight.delete(hash));
    }
    const built = await task;
    if (!built) return json(res, 500, { error: '波形生成失败（文件可能不是有效音频）' });
    writePeaksCache(hash, built);
    peaks = built;
  }
  if (!peaks) return json(res, 404, { error: '波形不可用' });

  const body = JSON.stringify({ durationSec: peaks.durationSec, points: peaks.points, source: peaks.source });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 媒体流：必须支持 Range，否则浏览器里视频进度条拖不动（M0 验收项之一）。
 *  回收站里的素材也能播（托管对象此时位于 trash\），便于恢复前先确认内容。 */
function serveMedia(req: IncomingMessage, res: ServerResponse, id: number): void {
  const asset = getAsset(db, id, { includeTrashed: true });
  if (!asset) return json(res, 404, { error: '素材不存在' });
  if (!existsSync(asset.absPath)) {
    return json(res, 410, { error: '文件已不在磁盘上', path: asset.absPath });
  }
  const size = statSync(asset.absPath).size;
  const type = mimeOf(asset.ext || extname(asset.absPath));
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(asset.absPath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  let start: number;
  let end: number;
  if (hasStart) {
    start = Number(match[1]);
    end = hasEnd ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    // 后缀范围：bytes=-N 表示最后 N 字节
    const suffix = Number(match[2]);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(asset.absPath, { start, end }).pipe(res);
}

/**
 * 用系统默认程序打开素材。
 *
 * 为什么用 explorer.exe 而不是 `cmd /c start "" <路径>`：
 * Node 在 Windows 上不会给空字符串参数生成引号，空标题消失后 `start` 会把路径当成
 * **窗口标题**，结果是"接口返回 ok 但什么都没打开"（实测踩到过）。explorer.exe 按系统
 * 关联启动默认程序，且正确处理 Unicode 路径，也不需要一个"标题"占位参数。
 */
function openWithSystem(id: number): { ok: boolean; method?: string; error?: string } {
  const asset = getAsset(db, id);
  if (!asset) return { ok: false, error: '素材不存在' };
  if (!existsSync(asset.absPath)) return { ok: false, error: '文件已不在磁盘上，无法打开' };

  try {
    const child = spawn('explorer.exe', [asset.absPath], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      // 兜底：给 start 一个**非空**标题，避开上面的标题陷阱
      spawn('cmd.exe', ['/c', 'start', 'pm-open', asset.absPath], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    });
    child.unref();
    return { ok: true, method: 'explorer' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 打开"打开方式"对话框：让用户自己挑程序（Windows 的 OpenAs_RunDLL 就是这个对话框） */
function openWithChooser(absPath: string): { ok: boolean; error?: string } {
  if (!existsSync(absPath)) return { ok: false, error: '文件已不在磁盘上' };
  try {
    const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', absPath], {
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 在资源管理器中"定位"某个路径（选中它），而不是用默认程序打开它 */
function revealInExplorer(absPath: string): void {
  const child = spawn('explorer.exe', [`/select,${absPath}`], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** 文本类请求体的上限：编辑保存的正文（代码文件可能很大），比普通 JSON 请求宽松些 */
const MAX_TEXT_BODY = 8 * 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((done) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxBytes) req.destroy();
    });
    req.on('end', () => done(data));
    req.on('error', () => done(''));
  });
}

/** 把上传的原始字节流写入临时文件（浏览器直接 POST 文件体，不需要 multipart 解析） */
function receiveUpload(req: IncomingMessage, dest: string, maxBytes = 8 * 1024 * 1024 * 1024): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const out = createWriteStream(dest);
    const fail = (err: Error): void => {
      req.destroy();
      out.destroy();
      rejectPromise(err);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) fail(new Error('文件超过上限'));
    });
    out.on('finish', () => resolvePromise(size));
    out.on('error', fail);
    req.on('error', fail);
    req.pipe(out);
  });
}

function startScan(dir?: string): void {
  if (scanState.running) return;
  const target = dir ?? cfg.roots[0]?.path;
  if (!target) {
    scanState.error = '没有可扫描的目录';
    return;
  }
  scanState.running = true;
  scanState.error = null;
  scanState.startedAt = new Date().toISOString();
  scanState.finishedAt = null;
  scanState.phase = 'walk';
  scanState.processed = 0;
  scanState.total = 0;
  scanState.current = '';

  const onProgress = (p: IndexProgress): void => {
    scanState.phase = p.phase;
    scanState.processed = p.processed;
    scanState.total = p.total;
    scanState.current = p.current;
  };

  void indexRoot(db, cfg, target, { onProgress })
    .then((stats) => {
      scanState.last = stats;
    })
    .catch((err: unknown) => {
      scanState.error = (err as Error).message;
    })
    .finally(() => {
      scanState.running = false;
      scanState.phase = 'idle';
      scanState.finishedAt = new Date().toISOString();
    });
}

interface ImportState {
  running: boolean;
  processed: number;
  total: number;
  current: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  last: { copied: number; dedupedByHash: number; sidecarsWritten: number; managedFilesCreated: number; mergedAssets: number; bytesCopied: number; durationMs: number } | null;
}

const importState: ImportState = {
  running: false, processed: 0, total: 0, current: '', startedAt: null, finishedAt: null, error: null, last: null,
};

function startImport(rootPath?: string): void {
  if (importState.running) return;
  importState.running = true;
  importState.error = null;
  importState.startedAt = new Date().toISOString();
  importState.finishedAt = null;
  importState.processed = 0;
  importState.total = 0;
  importState.current = '准备导入';

  void importToLibrary(db, cfg, {
    rootPath,
    onProgress: (p) => {
      importState.processed = p.processed;
      importState.total = p.total;
      importState.current = p.current;
    },
  })
    .then((stats) => {
      importState.last = {
        copied: stats.copied,
        dedupedByHash: stats.dedupedByHash,
        sidecarsWritten: stats.sidecarsWritten,
        managedFilesCreated: stats.managedFilesCreated,
        mergedAssets: stats.mergedAssets,
        bytesCopied: stats.bytesCopied,
        durationMs: stats.durationMs,
      };
    })
    .catch((err: unknown) => {
      importState.error = (err as Error).message;
    })
    .finally(() => {
      importState.running = false;
      importState.finishedAt = new Date().toISOString();
    });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(WEB_DIST, rel));
  if (!target.startsWith(normalize(WEB_DIST))) {
    return text(res, 403, 'forbidden');
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return text(res, 404, `未找到 ${rel}（前端尚未构建？先运行 npm run web:build）`);
  }
  const body = readFileSync(target);
  if (rel === 'index.html') {
    // 把本次会话的 token 注入页面：同源、不需要 CORS，浏览器端也拿不到明文以外的秘密
    const html = body.toString('utf8').replaceAll(TOKEN_PLACEHOLDER, TOKEN);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
    });
    return res.end(html);
  }
  const type = mimeOf(extname(target));
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

const server = createServer((req, res) => {
  void (async () => {
    const port = (server.address() as { port: number } | null)?.port ?? cfg.server.port;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);

    if (!hostAllowed(req, port) || !originAllowed(req, port)) {
      return text(res, 403, 'forbidden');
    }

    // 静态资源与首页不需要 token（页面本身要能加载），其余一律需要
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/thumb/') && !pathname.startsWith('/media/')) {
      return serveStatic(req, res, pathname);
    }
      if (pathname === '/api/openapi.json') {
        return json(res, 200, apiDoc());
      }
    if (!tokenAllowed(req, url)) {
      return json(res, 401, { error: '缺少或错误的 x-pm-token' });
    }

    if (pathname === '/api/ping') {
      return json(res, 200, {
        ok: true, libraryDir: LIBRARY_DIR, sqliteVersion: sqliteVersion(db),
        thumbSize: THUMB_SIZE, roots: cfg.roots, ffmpegDir: cfg.ffmpegDir,
        // 进程标识：同时存在多个实例（旧代码 / 旧端口）时，一眼看出是谁在服务
        pid: process.pid, startedAt: STARTED_AT,
      });
    }
    if (pathname === '/api/stats') {
      return json(res, 200, getStats(db));
    }
    if (pathname === '/api/projects' && req.method === 'GET') {
      return json(res, 200, { items: listProjects(db) });
    }
    const projectRenameMatch = /^\/api\/projects\/(\d+)$/.exec(pathname);
    if (projectRenameMatch && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as { name?: string };
        return json(res, 200, renameProject(db, Number(projectRenameMatch[1]), input.name ?? ''));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as {
          name?: string; description?: string; color?: string; modality?: Modality; parentId?: number | null;
        };
        const project = createProject(db, {
          name: input.name ?? '',
          description: input.description,
          color: input.color,
          modality: input.modality,
          parentId: input.parentId === null || input.parentId === undefined ? null : Number(input.parentId),
        });
        return json(res, 200, project);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const projectMatch = /^\/api\/projects\/(\d+)$/.exec(pathname);
    if (projectMatch && req.method === 'DELETE') {
      try {
        return json(res, 200, deleteProject(db, Number(projectMatch[1])));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const assetProjectMatch = /^\/api\/assets\/(\d+)\/project$/.exec(pathname);
    if (assetProjectMatch && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as { projectId?: number | null };
        const projectId = input.projectId === null || input.projectId === undefined ? null : Number(input.projectId);
        return json(res, 200, setAssetProject(db, Number(assetProjectMatch[1]), projectId));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    // 生成信息（模型/提示词/来源/关联提示词）：原来只支持模型，现在一并支持
    const assetModelMatch = /^\/api\/assets\/(\d+)\/meta$/.exec(pathname);
    if (assetModelMatch && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as {
          model?: string; prompt?: string; origin?: string; params?: string;
          promptAssetId?: number | null; applyToBundle?: boolean;
        };
        const target = Number(assetModelMatch[1]);
        return json(res, 200, input.applyToBundle
          ? updateAssetMetaForBundle(db, target, input)
          : updateAssetMeta(db, target, input));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    // 编辑文本/代码后保存：默认存成新版本（旧内容进 asset_version），可选写回原文件
    const saveTextMatch = /^\/api\/assets\/(\d+)\/save-text$/.exec(pathname);
    if (saveTextMatch && req.method === 'POST') {
      try {
        const raw = await readBody(req, MAX_TEXT_BODY);
        const input = JSON.parse(raw || '{}') as { body?: string; writeOriginal?: boolean };
        const result = await saveTextVersion(db, cfg, {
          assetId: Number(saveTextMatch[1]),
          body: input.body ?? '',
          writeOriginal: input.writeOriginal === true,
        });
        return json(res, 200, result);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const versionsMatch = /^\/api\/assets\/(\d+)\/versions$/.exec(pathname);
    if (versionsMatch && req.method === 'GET') {
      return json(res, 200, { items: listAssetVersions(db, Number(versionsMatch[1])) });
    }
    // 上传素材：浏览器把文件字节直接放进请求体，文件名走 x-filename（省掉 multipart 解析）
    if (pathname === '/api/upload' && req.method === 'POST') {
      const rawName = req.headers['x-filename'];
      if (typeof rawName !== 'string' || !rawName) return json(res, 400, { error: '缺少 x-filename 请求头' });
      const originalName = decodeURIComponent(rawName);
      if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
      const tempPath = join(TMP_DIR, `up-${Date.now()}-${randomBytes(4).toString('hex')}${extname(originalName)}`);
      try {
        const size = await receiveUpload(req, tempPath);
        if (size === 0) {
          rmSync(tempPath, { force: true });
          return json(res, 400, { error: '文件为空' });
        }
        const header = (name: string): string | undefined => {
          const value = req.headers[name];
          return typeof value === 'string' && value ? decodeURIComponent(value) : undefined;
        };
        const projectHeader = header('x-project');
        const result = await importExternalFile(db, cfg, {
          tempPath,
          originalName,
          title: header('x-title'),
          model: header('x-model'),
          projectId: projectHeader ? Number(projectHeader) : null,
        });
        rmSync(tempPath, { force: true });
        return json(res, 200, { ...result, size });
      } catch (err) {
        rmSync(tempPath, { force: true });
        return json(res, 400, { error: (err as Error).message });
      }
    }
    // 直接粘贴文本/代码作为一条素材
    if (pathname === '/api/text-asset' && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as {
          title?: string; body?: string; ext?: string; model?: string; projectId?: number | null; modality?: Modality;
        };
        const result = await importTextAsset(db, cfg, {
          title: input.title ?? '',
          body: input.body ?? '',
          ext: input.ext,
          model: input.model,
          projectId: input.projectId ?? null,
          modality: input.modality,
        });
        return json(res, 200, result);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (pathname === '/api/assets') {
      const projectParam = url.searchParams.get('project');
      const projectId = projectParam ? Number(projectParam) : undefined;
      // 选中父项目时把子项目的素材一并列出：否则「分了小项目」之后父项目看着像空的
      const res1 = searchAssets(db, {
        q: url.searchParams.get('q') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined,
        projects: typeof projectId === 'number' && Number.isFinite(projectId) ? projectScopeIds(db, projectId) : undefined,
        limit: Number(url.searchParams.get('limit') ?? 60),
        offset: Number(url.searchParams.get('offset') ?? 0),
      });
      return json(res, 200, res1);
    }
    const assetMatch = /^\/api\/assets\/(\d+)$/.exec(pathname);
    if (assetMatch) {
      const includeTrashed = url.searchParams.get('trashed') === '1';
      const asset = getAsset(db, Number(assetMatch[1]), { includeTrashed });
      return asset ? json(res, 200, asset) : json(res, 404, { error: '素材不存在' });
    }
    if (pathname === '/api/import/status') {
      return json(res, 200, importState);
    }
    if (pathname === '/api/import' && req.method === 'POST') {
      if (importState.running) return json(res, 409, { error: '已有导入在进行', state: importState });
      if (scanState.running) return json(res, 409, { error: '扫描进行中，稍后再导入' });
      const raw = await readBody(req);
      let root: string | undefined;
      try {
        const parsed = raw ? (JSON.parse(raw) as { root?: string }) : {};
        root = parsed.root;
      } catch {
        /* 空 body 也允许 */
      }
      startImport(root);
      return json(res, 202, { started: true, root: root ?? null });
    }
    if (pathname === '/api/trash' && req.method === 'GET') {
      // 除了素材，还返回"可以整项目恢复"的项目（删项目时记下来的）
      return json(res, 200, { items: listTrashedAssets(db), projects: listTrashProjects(db) });
    }
    const trashProjectRestore = /^\/api\/trash\/project\/(\d+)\/restore$/.exec(pathname);
    if (trashProjectRestore && req.method === 'POST') {
      try {
        return json(res, 200, restoreTrashProject(db, Number(trashProjectRestore[1])));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (pathname === '/api/trash/purge' && req.method === 'POST') {
      // 带 ids = 彻底删除所选；不带 = 清空整个回收站
      try {
        const raw = await readBody(req);
        const input = raw ? (JSON.parse(raw) as { ids?: number[] }) : {};
        const ids = Array.isArray(input.ids) ? input.ids.map(Number) : undefined;
        return json(res, 200, purgeTrashed(db, ids));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const trashMatch = /^\/api\/trash\/(\d+)$/.exec(pathname);
    if (trashMatch && req.method === 'POST') {
      try {
        const report = trashAsset(db, Number(trashMatch[1]));
        return json(res, 200, report);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const restoreMatch = /^\/api\/restore\/(\d+)$/.exec(pathname);
    if (restoreMatch && req.method === 'POST') {
      try {
        const report = restoreAsset(db, Number(restoreMatch[1]));
        return json(res, 200, report);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (pathname === '/api/verify') {
      const withHash = url.searchParams.get('hash') === '1';
      return json(res, 200, verifyLibrary(db, { hash: withHash }));
    }
    if (pathname === '/api/scan/status') {
      return json(res, 200, scanState);
    }
    if (pathname === '/api/scan' && req.method === 'POST') {
      const raw = await readBody(req);
      let dir: string | undefined;
      try {
        const parsed = raw ? (JSON.parse(raw) as { dir?: string }) : {};
        dir = parsed.dir;
      } catch {
        /* 空 body 也允许，用默认根目录 */
      }
      if (scanState.running) return json(res, 409, { error: '已有扫描在进行', state: scanState });
      startScan(dir);
      return json(res, 202, { started: true, target: dir ?? cfg.roots[0]?.path ?? null });
    }
    const openMatch = /^\/api\/open\/(\d+)$/.exec(pathname);
    if (openMatch && req.method === 'POST') {
      const result = openWithSystem(Number(openMatch[1]));
      return json(res, result.ok ? 200 : 400, result);
    }
    // "打开方式…"：让用户自己挑程序，而不是只能用默认程序
    const openAsMatch = /^\/api\/open-as\/(\d+)$/.exec(pathname);
    if (openAsMatch && req.method === 'POST') {
      const asset = getAsset(db, Number(openAsMatch[1]), { includeTrashed: true });
      if (!asset) return json(res, 404, { error: '素材不存在' });
      const result = openWithChooser(asset.absPath);
      return json(res, result.ok ? 200 : 400, result);
    }
    // 打开方式的候选列表（自建选择器用它，不弹系统对话框）
    const openWithMatch = /^\/api\/open-with\/(\d+)$/.exec(pathname);
    if (openWithMatch) {
      const asset = getAsset(db, Number(openWithMatch[1]), { includeTrashed: true });
      if (!asset) return json(res, 404, { error: '素材不存在' });
      if (req.method === 'GET') {
        return json(res, 200, await listOpenWith(asset.ext));
      }
      if (req.method === 'POST') {
        try {
          const raw = await readBody(req);
          const input = JSON.parse(raw || '{}') as { id?: string; exe?: string; args?: string[]; useSystemDialog?: boolean };
          if (input.useSystemDialog) {
            const result = openWithChooser(asset.absPath);
            return json(res, result.ok ? 200 : 400, result);
          }
          const listing = await listOpenWith(asset.ext);
          const picked = listing.items.find((candidate) => candidate.id === input.id)
            ?? (input.exe ? { id: input.exe, label: input.exe, exe: input.exe, args: input.args ?? [], isDefault: false } : null);
          if (!picked) return json(res, 400, { error: '这个程序不在候选列表里' });
          launchCandidate(picked, asset.absPath);
          return json(res, 200, { ok: true, label: picked.label });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
    }
    // 文件浏览模式：按层列举任意本地目录（浏览 ≠ 索引，被忽略的目录也会列出来并标注）
    // 把磁盘上的某个文件复制进库（浏览模式里的"导入到库"，原文件不动）
    // 在资源管理器中定位任意路径（浏览模式用；库内素材走 /api/open/:id）
    // 组（bundle）：一次加入的一批内容算一个单元
    if (pathname === '/api/bundles' && req.method === 'GET') {
      return json(res, 200, { items: listBundles(db, url.searchParams.get('q') ?? undefined) });
    }
    if (pathname === '/api/bundles' && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as { title?: string; assetIds?: number[]; note?: string };
        return json(res, 200, createBundle(db, {
          title: input.title ?? '',
          assetIds: Array.isArray(input.assetIds) ? input.assetIds.map(Number) : [],
          note: input.note,
        }));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const bundleMatch = /^\/api\/bundles\/(\d+)$/.exec(pathname);
    if (bundleMatch && req.method === 'GET') {
      const bundle = getBundle(db, Number(bundleMatch[1]));
      if (!bundle) return json(res, 404, { error: '组不存在' });
      return json(res, 200, { ...bundle, members: listMembers(db, bundle.id) });
    }
    const bundleExpand = /^\/api\/bundles\/(\d+)\/expand$/.exec(pathname);
    if (bundleExpand && req.method === 'POST') {
      try {
        return json(res, 200, expandBundle(db, Number(bundleExpand[1])));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const bundleMember = /^\/api\/bundles\/(\d+)\/members$/.exec(pathname);
    if (bundleMember && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const input = JSON.parse(raw || '{}') as { assetId?: number };
        return json(res, 200, addMember(db, Number(bundleMember[1]), Number(input.assetId)));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const bundleMemberOne = /^\/api\/bundles\/(\d+)\/members\/(\d+)$/.exec(pathname);
    if (bundleMemberOne && req.method === 'DELETE') {
      try {
        const result = removeMember(db, Number(bundleMemberOne[1]), Number(bundleMemberOne[2]));
        return json(res, 200, { bundle: result });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    // 直接在磁盘上读写文本文件（"在文件里打开项目里的任何文件"，默认只读）
    if (pathname === '/api/fs/text' && req.method === 'GET') {
      const target = url.searchParams.get('path');
      if (!target) return json(res, 400, { error: '缺少 path 参数' });
      try {
        return json(res, 200, readTextFile(target));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    if (pathname === '/api/fs/text' && req.method === 'POST') {
      try {
        const raw = await readBody(req, MAX_TEXT_BODY);
        const input = JSON.parse(raw || '{}') as { path?: string; body?: string; backup?: boolean };
        if (!input.path || typeof input.body !== 'string') return json(res, 400, { error: '缺少 path 或 body' });
        return json(res, 200, writeTextFile(input.path, input.body, { backup: input.backup !== false }));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }
    const thumbMatch = /^\/thumb\/(\d+)$/.exec(pathname);    if (thumbMatch) {
      return await serveThumb(res, Number(thumbMatch[1]));
    }
    const peaksMatch = /^\/api\/peaks\/(\d+)$/.exec(pathname);
    if (peaksMatch) {
      return await servePeaks(res, Number(peaksMatch[1]));
    }
    const textMatch = /^\/api\/text\/(\d+)$/.exec(pathname);
    if (textMatch) {
      // 上限放到与编辑保存同一量级：编辑器要读全文，而不是预览用的前 64KB
      const max = Math.min(Number(url.searchParams.get('max') ?? 65536) || 65536, MAX_TEXT_BODY);
      return serveText(res, Number(textMatch[1]), max);
    }    const mediaMatch = /^\/media\/(\d+)$/.exec(pathname);
    if (mediaMatch) {
      return serveMedia(req, res, Number(mediaMatch[1]));
    }
    return json(res, 404, { error: `未知接口 ${pathname}` });
  })().catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  });
});

/** 端口占用时自动往后找一个可用端口（开发建议 §9） */
function listen(preferred: number, attempt = 0): void {
  const port = preferred + attempt;
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(preferred, attempt + 1);
      return;
    }
    console.error('服务启动失败：', err.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = (server.address() as { port: number }).port;
    writeFileSync(
      RUNTIME_FILE,
      JSON.stringify({ port: actual, token: TOKEN, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    const webReady = existsSync(join(WEB_DIST, 'index.html'));
    console.log('个人项目管理器 M0 已启动');
    console.log(`  界面    : http://127.0.0.1:${actual}`);
    console.log(`  库目录  : ${LIBRARY_DIR}`);
    console.log(`  SQLite  : ${sqliteVersion(db)}`);
    console.log(`  前端    : ${webReady ? '已构建' : '未构建（先 npm run web:build）'}`);
    if (ftsHealed) console.log(`  全文索引: 自愈重建 ${ftsHealed} 行`);
    console.log(`  扫描根  : ${cfg.roots.map((r) => r.path).join(', ')}`);
    console.log(`  token 已写入 ${RUNTIME_FILE}（开发模式 Vite 代理会用它）`);
  });
}

listen(cfg.server.port);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    try {
      db.close();
    } catch {
      /* 关闭失败不影响退出 */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
