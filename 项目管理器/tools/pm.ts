/**
 * pm —— 给人和 AI 共用的命令行入口。
 *
 * 为什么不只做界面：Agent 用 shell 调 CLI 比对接协议更省事，脚本/批处理也能复用同一套。
 * 所有命令都支持 --json（机器可读），默认输出给人看。
 *
 * 用法（在 项目管理器 目录下）：
 *   node --no-warnings tools/pm.ts health
 *   node --no-warnings tools/pm.ts projects --json
 *   node --no-warnings tools/pm.ts search --kind image --limit 10 [--q 关键词] [--project <角色E>] --json
 *   node --no-warnings tools/pm.ts get <id|sha256:哈希> --json
 *   node --no-warnings tools/pm.ts read <id|sha256:哈希> [--max-bytes 20000]
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** 与 core 一致的内容哈希（用于 import 去重判断） */
async function hashFile(p: string): Promise<string> {
  const { openSync, readSync, closeSync } = await import('node:fs');
  const h = createHash('sha256');
  const fd = openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(buf.subarray(0, n)); } } finally { closeSync(fd); }
  return h.digest('hex');
}
import { openDb, sqliteVersion } from '../core/db.ts';
import { getAsset, searchAssets } from '../core/query.ts';
import { createProject, importExternalFile, listProjects, setAssetProject, updateAssetMeta } from '../core/organize.ts';
import { readTextFile } from '../core/fstext.ts';
import { LIBRARY_DIR, loadConfig } from '../core/config.ts';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { upsertFts } from '../core/maintenance.ts';

const argv = process.argv.slice(2);
const command = argv[0];
const asJson = argv.includes('--json');
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? null : null;
};
const out = (human: string, machine: unknown): void => {
  if (asJson) console.log(JSON.stringify(machine, null, 2));
  else console.log(human);
};
const fail = (message: string): never => {
  console.error(asJson ? JSON.stringify({ ok: false, error: message }) : `错误：${message}`);
  process.exit(1);
};

/** 按 id 或 sha256:哈希 找素材；哈希更稳（改名/移动都不受影响） */
function resolve(db: DatabaseSync, key: string): number {
  if (/^sha256:/i.test(key)) {
    const hash = key.slice(7).toLowerCase();
    const row = db.prepare('SELECT id FROM asset WHERE hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as { id: number } | undefined;
    if (!row) fail(`没有哈希为 ${hash} 的素材`);
    return row.id;
  }
  const id = Number(key);
  if (!Number.isInteger(id) || id <= 0) fail(`id 或 sha256:哈希 才对，收到 ${key}`);
  return id;
}

/** 托管对象的绝对路径（AI 要拿原始字节时用） */
function managedPath(db: DatabaseSync, assetId: number): string | null {
  const row = db
    .prepare("SELECT f.abs_path AS p FROM file f JOIN source_root sr ON sr.id = f.source_root_id WHERE f.asset_id = ? AND sr.mode = 'managed' LIMIT 1")
    .get(assetId) as { p: string } | undefined;
  return row?.p ?? null;
}

/** 记一条审计：谁在什么时候改了什么（人和 agent 都走这里） */
function audit(db: DatabaseSync, action: string, assetId: number | null, detail: unknown): void {
  const actor = process.env['PM_ACTOR'] ?? 'agent:unknown';
  db.prepare('INSERT INTO agent_audit (actor, action, asset_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(actor, action, assetId, JSON.stringify(detail ?? {}), new Date().toISOString());
}

/** 读现有标签（JSON 数组） */
function readTags(db: DatabaseSync, assetId: number): string[] {
  const row = db.prepare('SELECT tags FROM asset WHERE id = ?').get(assetId) as { tags: string | null } | undefined;
  if (!row?.tags) return [];
  try { const parsed = JSON.parse(row.tags); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

/** 写回标签并让检索跟上（标签并入全文索引） */
function writeTags(db: DatabaseSync, assetId: number, tags: string[]): void {
  db.prepare('UPDATE asset SET tags = ? WHERE id = ?').run(JSON.stringify(tags), assetId);
  const row = db.prepare('SELECT title, note, model, kind, COALESCE(display_path, \'\') AS dp FROM asset WHERE id = ?').get(assetId) as { title: string; note: string | null; model: string | null; kind: string; dp: string };
  upsertFts(db, assetId, row.title, row.dp, row.note ?? '', row.model ?? '', row.kind);
}

const db = openDb();

if (command === 'health' || command === undefined) {
  out(
    `库目录: ${LIBRARY_DIR}\nSQLite: ${sqliteVersion(db)}`,
    { ok: true, libraryDir: LIBRARY_DIR, sqliteVersion: sqliteVersion(db) },
  );
} else if (command === 'projects') {
  const items = listProjects(db);
  out(items.map((p) => `${'  '.repeat(p.depth ?? 1)}${p.name}（${p.count ?? 0} 件）`).join('\n'), { items });
} else if (command === 'search') {
  const q = flag('q') ?? '';
  const kind = flag('kind') ?? undefined;
  const limit = Number(flag('limit') ?? 30);
  const projectName = flag('project');
  let projects: number[] | undefined;
  if (projectName) {
    const all = listProjects(db);
    const hit = all.find((p) => p.name === projectName);
    if (!hit) fail(`没有名为 ${projectName} 的项目`);
    projects = [hit.id];
  }
  const result = searchAssets(db, { q, kind, limit, projects });
  const items = result.items.map((a) => ({
    id: a.id,
    hash: `sha256:${a.hash}`,
    title: a.title,
    modality: a.modality,
    ext: a.ext,
    size: a.size,
    model: a.model ?? null,
    origin: a.origin ?? null,
    sourcePath: a.sourcePath,
    caption: a.caption ?? null,
    tags: a.tags ? JSON.parse(a.tags) : null,
    origin: a.origin ?? null,
    thumbUrl: `/thumb/${a.id}`,
    contentUrl: `/media/${a.id}`,
  }));
  out(
    items.map((a) => `#${a.id} ${a.title}${a.ext}  ${Math.round(a.size / 1024)}KB  ${a.sourcePath}`).join('\n') + `\n共 ${result.total} 件（显示 ${items.length}）`,
    { total: result.total, count: items.length, items },
  );
} else if (command === 'get') {
  const key = argv[1];
  if (!key) fail('用法：pm get <id|sha256:哈希> [--json]');
  const id = resolve(db, key);
  const detail = getAsset(db, id);
  if (!detail) fail(`找不到素材 ${key}`);
  const objectPath = managedPath(db, id);
  out(JSON.stringify({ ...detail, objectPath }, null, 2), {
    ...detail,
    hash: detail.hash ? `sha256:${detail.hash}` : null,
    objectPath,
    objectExists: objectPath ? existsSync(objectPath) : false,
    thumbUrl: `/thumb/${id}`,
    contentUrl: `/media/${id}`,
  });


} else if (command === 'tag') {
  const key = argv[1]; if (!key) fail('用法：pm tag <id|sha256:哈希> --add 词 [--add 词2] [--remove 词] [--json]');
  const id = resolve(db, key);
  const adds = argv.reduce((acc, a, i) => (a === '--add' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), [] as string[]);
  const removes = argv.reduce((acc, a, i) => (a === '--remove' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), [] as string[]);
  const before = readTags(db, id);
  const after = [...new Set([...before.filter((t) => !removes.includes(t)), ...adds])];
  writeTags(db, id, after);
  audit(db, 'tag', id, { before, after });
  out(`#${id} 标签：${before.join(' / ') || '（空）'} → ${after.join(' / ') || '（空）'}`, { id, before, after });
} else if (command === 'meta') {
  const key = argv[1]; if (!key) fail('用法：pm meta <id|sha256:哈希> [--model 名] [--origin ai|real|other|空] [--params 文本] [--json]');
  const id = resolve(db, key);
  const input: Record<string, string> = {};
  for (const f of ['model', 'origin', 'params']) { const v = flag(f); if (v !== null) input[f] = v; }
  if (Object.keys(input).length === 0) fail('至少给一个字段：--model / --origin / --params');
  const result = updateAssetMeta(db, id, input);
  audit(db, 'meta', id, input);
  out(`#${id} 已更新 ${JSON.stringify(input)}`, { id, updated: result });
} else if (command === 'project' && argv.includes('--create')) {
  const name = argv[argv.indexOf('--create') + 1];
  if (!name) fail('用法：pm project --create 项目名 [--parent 父项目名] [--json]');
  const parentName = flag('parent');
  let parentId: number | null = null;
  if (parentName) {
    const parent = listProjects(db).find((p) => p.name === parentName);
    if (!parent) fail(`没有名为 ${parentName} 的父项目`);
    parentId = parent.id;
  }
  const created = createProject(db, { name, parentId });
  audit(db, 'project.create', null, { projectId: created.id, name, parentId });
  out(`已新建项目「${created.name}」（#${created.id}）`, { project: created });
} else if (command === 'project') {
  const key = argv[1]; const name = flag('to');
  if (!key || name === null) fail('用法：pm project <id|sha256:哈希> --to 项目名（--to "" 表示移出项目） [--json]');
  const id = resolve(db, key);
  if (name === '') { setAssetProject(db, id, null); audit(db, 'project', id, { projectId: null }); out(`#${id} 已移出项目`, { id, projectId: null }); }
  else {
    const hitRow = listProjects(db).find((p) => p.name === name);
    if (!hitRow) fail(`没有名为 ${name} 的项目`);
    setAssetProject(db, id, hitRow.id);
    audit(db, 'project', id, { projectId: hitRow.id, projectName: name });
    out(`#${id} 已归入项目「${name}」`, { id, projectId: hitRow.id, projectName: name });
  }
} else if (command === 'import') {
  const paths = argv.slice(1).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) fail('用法：pm import <文件或目录...> [--to 项目名] [--title 标题] [--json]');
  const cfg = loadConfig();
  const projectName = flag('to');
  let projectId: number | null = null;
  if (projectName) {
    const found = listProjects(db).find((p) => p.name === projectName);
    if (!found) fail(`没有名为 ${projectName} 的项目（要新建用 pm project --create ${projectName}）`);
    projectId = found.id;
  }
  const results: Array<Record<string, unknown>> = [];
  for (const p of paths) {
    if (!existsSync(p)) { results.push({ path: p, ok: false, error: '文件不存在' }); continue; }
    try {
      const hash = await hashFile(p);
      if (!hash) throw new Error('无法计算哈希');
      const dup = db.prepare('SELECT id FROM asset WHERE hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as { id: number } | undefined;
      if (dup) { results.push({ path: p, ok: true, deduped: true, assetId: dup.id }); continue; }
      const tmpDir = join(LIBRARY_DIR, '.tmp');
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const tempPath = join(tmpDir, 'agent-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + extname(p));
      copyFileSync(p, tempPath);
      let result: { assetId: number } | null = null;
      try {
        result = await importExternalFile(db, cfg, {
          tempPath,
          originalName: basename(p),
          title: flag('title') ?? undefined,
          projectId,
          displayPath: (/(audio|video|image)/.test('') ? '' : '') + p.replace(/\\/g, '/'),
        }) as { assetId: number };
      } finally { rmSync(tempPath, { force: true }); }
      if (result) audit(db, 'import', result.assetId, { path: p, hash });
      results.push({ path: p, ok: true, assetId: result?.assetId ?? null, hash: 'sha256:' + hash });
    } catch (error) {
      results.push({ path: p, ok: false, error: (error as Error).message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  out(results.map((r) => (r.ok ? `导入成功 #${r.assetId}${r.deduped ? '（内容已存在，跳过）' : ''}` : `失败 ${r.error}`)).join('\n') + `\n共 ${okCount}/${results.length} 成功`, { items: results });
} else if (command === 'audit') {
  const rows = db.prepare('SELECT id, actor, action, asset_id AS assetId, detail, created_at AS createdAt FROM agent_audit ORDER BY id DESC LIMIT ?').all(Number(flag('limit') ?? 20));
  out(rows.map((r) => `${r.createdAt} ${r.actor} ${r.action} #${r.assetId ?? '-'} ${r.detail}`).join('\n'), { items: rows });
} else if (command === 'read') {
  const key = argv[1];
  if (!key) fail('用法：pm read <id|sha256:哈希> [--max-bytes N]');
  const id = resolve(db, key);
  const detail = getAsset(db, id);
  if (!detail) fail(`找不到素材 ${key}`);
  const objectPath = managedPath(db, id);
  if (!objectPath || !existsSync(objectPath)) fail('这件素材没有可读的库内对象');
  const maxBytes = Number(flag('max-bytes') ?? 20000);
  const info = readTextFile(objectPath);
  const body = info.text.slice(0, maxBytes);
  out(body + (info.text.length > maxBytes ? `\n…（已截断，共 ${info.text.length} 字符）` : ''), {
    id,
    hash: `sha256:${detail.hash}`,
    title: detail.title,
    ext: detail.ext,
    encoding: info.encoding,
    totalChars: info.text.length,
    truncated: info.text.length > maxBytes,
    body,
  });
} else {
  out(
    [
      'pm —— 素材库命令行（人和 AI 共用）',
      '',
      '  health                                    库路径与版本',
      '  projects [--json]                         项目树与计数',
      '  search [--q 词] [--kind image] [--project 名] [--limit N] [--json]',
      '  get <id|sha256:哈希> [--json]              单件详情 + contentUrl/thumbUrl',
      '  read <id|sha256:哈希> [--max-bytes N]      文本/代码内容直出',
      '  tag <id> --add 词 [--remove 词]           增删标签（写操作，记审计）',
      '  meta <id> [--model 名] [--origin ai|real|other|] [--params 文本]   改元数据（写操作）',
      '  project <id> --to 项目名                  归入项目（--to "" 移出；写操作）',
      '  import <路径...> [--to 项目名] [--title 标题]   把文件入库（幂等：内容已存在则跳过）',
      '  project --create 名字 [--parent 父名]      新建项目（写操作，记审计）',
      '  audit [--limit N]                        最近的写操作记录',
      '  （生成描述用独立命令，见 README：node --no-warnings tools/caption.ts --kind image --limit 50）',
      '',
      '接口清单（含字段说明）：GET /api/openapi.json',
    ].join('\n'),
    { usage: ['health', 'projects', 'search', 'get', 'read'], doc: '/api/openapi.json' },
  );
}
db.close();
