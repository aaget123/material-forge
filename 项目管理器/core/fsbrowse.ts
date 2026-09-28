import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { classify, modalityOf, type Kind, type Modality } from './kind.ts';
import type { LibraryConfig } from './config.ts';

/**
 * 文件浏览模式的后端：按层列举任意本地目录。
 *
 * 与扫描的区别（这是本项目最要紧的一条界线）：
 * 浏览 ≠ 索引。被忽略规则挡住的目录（node_modules/dist/.cache…）在这里**默认折叠但仍然可见**，
 * 并挂一个 ignored 标记 —— 这样"为什么这些没进库"是个看得见的事实，而不是黑箱。
 *
 * 只读：这一层不重命名、不删除磁盘上的文件，那是资源管理器的活；
 * 本工具承诺"绝不改动你的原文件"，只在用户明确点"导入到库"时复制一份。
 */

export interface FsEntry {
  name: string;
  absPath: string;
  isDir: boolean;
  size: number | null;
  mtime: string | null;
  ext: string;
  kind: Kind | null;
  modality: Modality | null;
  /** 命中忽略规则（目录名或扩展名） */
  ignored: boolean;
  /** 已经在库里的素材 id（按绝对路径匹配索引里的文件行） */
  assetId: number | null;
  /** 库里那条素材是不是被回收了 */
  trashed: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  name: string;
  entries: FsEntry[];
  /** 这一层有多少项被忽略规则挡住（前端用来做"默认折叠但仍可见"的提示） */
  ignoredCount: number;
  truncated: boolean;
}

const MAX_ENTRIES = 5000;

/** 列出某个目录的一层内容；失败（不存在/无权限）抛错由调用方转成 400 */
export function listDirectory(db: DatabaseSync, cfg: LibraryConfig, rawPath: string): FsListing {
  const target = normalize(resolve(rawPath));
  if (!isAbsolute(target)) throw new Error('必须是绝对路径');
  const st = statSync(target); // 不存在会抛错
  if (!st.isDirectory()) throw new Error('不是目录');

  const names = readdirSync(target);
  const truncated = names.length > MAX_ENTRIES;
  const sliced = truncated ? names.slice(0, MAX_ENTRIES) : names;

  const ignoredDirs = new Set(cfg.ignoreDirs.map((d) => d.toLowerCase()));
  const ignoredExts = new Set(cfg.ignoreExts.map((e) => e.toLowerCase()));

  const entries: FsEntry[] = [];
  for (const name of sliced) {
    const abs = join(target, name);
    let isDir = false;
    let size: number | null = null;
    let mtime: string | null = null;
    try {
      const entryStat = statSync(abs);
      isDir = entryStat.isDirectory();
      size = isDir ? null : entryStat.size;
      mtime = entryStat.mtime.toISOString();
    } catch {
      continue; // 权限/竞态：跳过这一项，不要让整层失败
    }
    const ext = isDir ? '' : extname(name).toLowerCase();
    const ignored = isDir ? ignoredDirs.has(name.toLowerCase()) : ignoredExts.has(ext);
    const kind = isDir ? null : classify(name);
    entries.push({
      name, absPath: abs, isDir, size, mtime, ext, kind,
      modality: kind ? modalityOf(kind) : null,
      ignored,
      assetId: null,
      trashed: false,
    });
  }

  // 目录在前、同类按名称排（中文按本地顺序）
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  annotateIndexed(db, entries);

  return {
    path: target,
    parent: dirname(target) === target ? null : dirname(target),
    name: basename(target),
    entries,
    ignoredCount: entries.filter((e) => e.ignored).length,
    truncated,
  };
}

/**
 * 一次性把这些绝对路径在索引里的状态查出来（分批 IN，避免上千项时拼出一条巨型 SQL）。
 * 顺带把"这条素材是不是在回收站"也带回来，前端才能给出正确的动作。
 */
function annotateIndexed(db: DatabaseSync, entries: FsEntry[]): void {
  const files = entries.filter((e) => !e.isDir);
  if (files.length === 0) return;
  const byPath = new Map<string, FsEntry>();
  for (const entry of files) byPath.set(entry.absPath.toLowerCase(), entry);

  const chunkSize = 400;
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT f.abs_path AS abs_path, f.asset_id AS asset_id, a.deleted_at AS deleted_at
           FROM file f JOIN asset a ON a.id = f.asset_id
          WHERE f.abs_path IN (${placeholders})
          ORDER BY f.id DESC`,
      )
      .all(...chunk.map((entry) => entry.absPath)) as Array<{ abs_path: string; asset_id: number; deleted_at: string | null }>;
    for (const row of rows) {
      const entry = byPath.get(row.abs_path.toLowerCase());
      if (!entry || entry.assetId !== null) continue; // 同一路径多行时取最新那条
      entry.assetId = row.asset_id;
      entry.trashed = row.deleted_at !== null;
    }
  }
}

/** 可浏览的起点：本机盘符 + 库里配置的根目录 */
export function listRoots(cfg: LibraryConfig): Array<{ path: string; label: string; kind: 'drive' | 'root' }> {
  const roots: Array<{ path: string; label: string; kind: 'drive' | 'root' }> = [];
  for (const root of cfg.roots) {
    if (existsSync(root.path)) roots.push({ path: root.path, label: root.path, kind: 'root' });
  }
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) roots.push({ path: drive, label: drive, kind: 'drive' });
    }
  } else {
    roots.push({ path: '/', label: '/', kind: 'drive' });
  }
  return roots;
}
