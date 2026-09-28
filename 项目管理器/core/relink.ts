import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

/**
 * 按内容哈希重新链接：磁盘上的文件被移动/改名之后，把库里的引用指回它。
 *
 * 为什么需要：库里的引用记录存的是**绝对路径**。一旦你在系统里移动或重命名源文件，
 * 引用就断了（素材还在库里，但"原始文件"那条线断了、也没法再写回原文件）。
 * 这个模块用库里已经存好的内容哈希，在新位置把同一份内容找回来并重新指路。
 *
 * 三步都留着口子：
 *  - `planRelink` 只读：扫目录、算哈希、列出"能找回的"和"找不回的"，不写库；
 *  - `applyRelink` 写库：把能找回的重新指路，并把每条改动前的位置记进 tidy_journal；
 *  - `undoRelink` 撤销：按记账号原样退回。
 *
 * 扫描时的两个省力点：只算"库里确实缺文件、且大小对得上"的那些；库自己的目录不扫。
 */

export interface BrokenRow {
  fileId: number;
  assetId: number;
  title: string;
  oldPath: string;
  size: number;
  hash: string | null;
}

export interface RelinkPlan {
  scannedFiles: number;
  hashedFiles: number;
  broken: BrokenRow[];
  matches: Array<{ fileId: number; assetId: number; title: string; oldPath: string; newPath: string; size: number }>;
  unmatched: BrokenRow[];
  roots: string[];
  /** 扫描时跳过的目录（例如素材库自己） */
  skipped: string[];
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** 扫一个根下的所有文件（不跟符号链接；跳过库自己的目录） */
function scanFiles(root: string, skip: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限之类的读不了就跳过，不影响其余
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const lower = full.toLowerCase();
      if (skip.some((s) => lower.startsWith(s.toLowerCase()))) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** 找出库里"引用指向的文件已经不在磁盘上"的记录 */
export function listBrokenRows(db: DatabaseSync): BrokenRow[] {
  const rows = db
    .prepare(
      `SELECT f.id AS fileId, f.asset_id AS assetId, f.abs_path AS absPath, a.title AS title,
              COALESCE(a.size, 0) AS size, a.hash AS hash
         FROM file f JOIN asset a ON a.id = f.asset_id
        WHERE a.deleted_at IS NULL AND f.abs_path NOT LIKE '%\\objects\\%'`,
    )
    .all() as Array<{ fileId: number; assetId: number; absPath: string; title: string; size: number; hash: string | null }>;
  return rows
    .filter((row) => !existsSync(row.absPath))
    .map((row) => ({
      fileId: row.fileId,
      assetId: row.assetId,
      title: row.title,
      oldPath: row.absPath,
      size: row.size,
      hash: row.hash,
    }));
}

export function planRelink(db: DatabaseSync, roots: string[], options: { skip?: string[] } = {}): RelinkPlan {
  const skip = [options.skip ?? []].flat().filter(Boolean);
  const broken = listBrokenRows(db);
  const wanted = new Map<string, BrokenRow[]>(); // hash → 记录
  const bySize = new Map<number, BrokenRow[]>(); // size → 记录（没有哈希时靠大小初筛）
  for (const row of broken) {
    if (row.hash) {
      const list = wanted.get(row.hash) ?? [];
      list.push(row);
      wanted.set(row.hash, list);
    }
    const sized = bySize.get(row.size) ?? [];
    sized.push(row);
    bySize.set(row.size, sized);
  }

  const files = roots.flatMap((root) => (existsSync(root) ? scanFiles(root, skip) : []));
  const matches: RelinkPlan['matches'] = [];
  let hashedFiles = 0;
  const claimed = new Set<number>();

  for (const file of files) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (wanted.size === 0) break;
    if (!bySize.has(size)) continue; // 大小都对不上，不必算哈希
    hashedFiles += 1;
    const hash = sha256File(file);
    const candidates = wanted.get(hash);
    if (!candidates) continue;
    const row = candidates.find((item) => !claimed.has(item.fileId) && !existsSync(item.oldPath));
    if (!row) continue;
    claimed.add(row.fileId);
    matches.push({
      fileId: row.fileId,
      assetId: row.assetId,
      title: row.title,
      oldPath: row.oldPath,
      newPath: file,
      size,
    });
    // 这个哈希已经全部找回的，就别再扫了
    if (candidates.every((item) => claimed.has(item.fileId) || existsSync(item.oldPath))) wanted.delete(hash);
  }

  const matchedIds = new Set(matches.map((m) => m.fileId));
  return {
    scannedFiles: files.length,
    hashedFiles,
    broken,
    matches,
    unmatched: broken.filter((row) => !matchedIds.has(row.fileId)),
    roots,
    skipped: skip,
  };
}

/** 应用：重新指路（写 abs_path / rel_path / display_path），改动前记进 tidy_journal */
export function applyRelink(db: DatabaseSync, plan: RelinkPlan): { journalId: number; relinked: number } {
  if (plan.matches.length === 0) throw new Error('没有可重新链接的文件');
  const previous: Array<{ fileId: number; absPath: string; relPath: string; assetId: number; displayPath: string | null }> = [];
  for (const match of plan.matches) {
    const row = db
      .prepare('SELECT rel_path AS relPath, asset_id AS assetId FROM file WHERE id = ?')
      .get(match.fileId) as { relPath: string; assetId: number } | undefined;
    const asset = db.prepare('SELECT display_path AS displayPath FROM asset WHERE id = ?').get(match.assetId) as
      | { displayPath: string | null }
      | undefined;
    if (!row) continue;
    previous.push({
      fileId: match.fileId,
      absPath: match.oldPath,
      relPath: row.relPath,
      assetId: match.assetId,
      displayPath: asset?.displayPath ?? null,
    });
  }

  for (const match of plan.matches) {
    // rel_path 取"相对扫描根"的路径，保持与扫描进来的素材同一套记法
    const root = plan.roots.find((candidate) => match.newPath.toLowerCase().startsWith(candidate.toLowerCase())) ?? '';
    const rel = root ? relative(root, match.newPath).replace(/\//g, '/') : match.newPath.replace(/\\/g, '/');
    db.prepare('UPDATE file SET abs_path = ?, rel_path = ? WHERE id = ?').run(match.newPath, rel, match.fileId);
    db.prepare('UPDATE asset SET display_path = ? WHERE id = ?').run(rel, match.assetId);
  }

  const now = new Date().toISOString();
  const res = db
    .prepare('INSERT INTO tidy_journal (kind, payload_json, created_at) VALUES (?, ?, ?)')
    .run('relink', JSON.stringify({ previous, matches: plan.matches.map((m) => ({ fileId: m.fileId, newPath: m.newPath })) }), now);
  return { journalId: Number(res.lastInsertRowid), relinked: plan.matches.length };
}

/** 撤销一次重新链接：把每条记录指回原来的位置 */
export function undoRelink(db: DatabaseSync, journalId: number): { restored: number } {
  const row = db.prepare('SELECT payload_json FROM tidy_journal WHERE id = ?').get(journalId) as
    | { payload_json: string }
    | undefined;
  if (!row) throw new Error('找不到这次重新链接的记录');
  const payload = JSON.parse(row.payload_json) as {
    previous: Array<{ fileId: number; absPath: string; relPath: string; assetId: number; displayPath: string | null }>;
  };
  let restored = 0;
  for (const entry of payload.previous) {
    db.prepare('UPDATE file SET abs_path = ?, rel_path = ? WHERE id = ?').run(entry.absPath, entry.relPath, entry.fileId);
    db.prepare('UPDATE asset SET display_path = ? WHERE id = ?').run(entry.displayPath, entry.assetId);
    restored += 1;
  }
  db.prepare('DELETE FROM tidy_journal WHERE id = ?').run(journalId);
  return { restored };
}

/** 库里引用型记录的体检：多少条有效、多少条断了 */
export function relinkHealth(db: DatabaseSync): { referenced: number; broken: number } {
  const rows = db
    .prepare("SELECT abs_path AS absPath FROM file WHERE abs_path NOT LIKE '%\\objects\\%'")
    .all() as Array<{ absPath: string }>;
  const broken = rows.filter((row) => !existsSync(row.absPath)).length;
  return { referenced: rows.length, broken };
}
