import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { THUMB_DIR, thumbPathForHash, type LibraryConfig } from './config.ts';
import { ensureRoot } from './db.ts';
import { buildIgnore, walk, type ScanEntry } from './scan.ts';
import { refineKind, isTextExt, type Kind } from './kind.ts';
import { readExcerpt } from './excerpt.ts';
import { hashFile } from './hash.ts';
import { makeImageThumb, makeVideoThumb, probe, type ProbeResult } from './ffmpeg.ts';
import { bigramIndexText } from './bigram.ts';
import { mergeDuplicateAssets } from './maintenance.ts';

export interface IndexStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  probed: number;
  thumbnails: number;
  thumbFailed: number;
  hashFailed: number;
  skippedDirs: number;
  skippedExts: number;
  bytesIndexed: number;
  mergedDuplicates: number;
  durationMs: number;
}

export interface IndexProgress {
  phase: 'walk' | 'index' | 'missing' | 'done';
  processed: number;
  total: number;
  current: string;
  stats: IndexStats;
}

function emptyStats(): IndexStats {
  return {
    scanned: 0, added: 0, updated: 0, unchanged: 0, missing: 0, probed: 0,
    thumbnails: 0, thumbFailed: 0, hashFailed: 0, skippedDirs: 0, skippedExts: 0,
    bytesIndexed: 0, mergedDuplicates: 0, durationMs: 0,
  };
}

/** 需要探元数据的类型：音视频/图片，以及扩展名有歧义的（.mts/.ts 可能是 MPEG-TS 视频） */
const AMBIGUOUS_EXTS = new Set(['.mts', '.ts', '.m4a', '.webm', '.ogv', '.flv', '.mp4', '.mov']);

function needsProbe(entry: ScanEntry): boolean {
  if (entry.kind === 'video' || entry.kind === 'audio' || entry.kind === 'music' || entry.kind === 'image') return true;
  return AMBIGUOUS_EXTS.has(entry.ext);
}

function titleOf(entry: ScanEntry): string {
  const base = entry.relPath.split('/').pop() ?? entry.relPath;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

/** 素材不再被任何文件引用时清掉它（含全文索引行），避免留下空壳素材 */
function removeOrphanAsset(db: DatabaseSync, assetId: number): void {
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM file WHERE asset_id = ?').get(assetId) as { c: number };
  if (remaining.c > 0) return;
  db.prepare('DELETE FROM asset_fts WHERE rowid = ?').run(assetId);
  db.prepare('DELETE FROM asset WHERE id = ?').run(assetId);
}

function upsertFts(
  db: DatabaseSync, assetId: number, title: string, relPath: string, note: string, model: string, kind: Kind,
): void {
  db.prepare('DELETE FROM asset_fts WHERE rowid = ?').run(assetId);
  db.prepare(
    'INSERT INTO asset_fts (rowid, title, path_text, note, model, bigram, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(assetId, title, relPath.replace(/\//g, ' '), note, model, bigramIndexText(`${title} ${relPath} ${model}`), kind);
}

export interface IndexOptions {
  force?: boolean;
  onProgress?: (p: IndexProgress) => void;
  /** 只处理前 N 个文件，用于快速样品验证 */
  limit?: number;
}

/**
 * 索引一个真实目录：扫描 → 分类 → 哈希 → 元数据 → 缩略图 → 全文索引。
 * 增量规则：size + mtime 都没变就跳过（这就是"重启不重扫"的依据）。
 */
export async function indexRoot(
  db: DatabaseSync,
  cfg: LibraryConfig,
  rootPath: string,
  opts: IndexOptions = {},
): Promise<IndexStats> {
  const started = Date.now();
  const stats = emptyStats();
  const rootId = ensureRoot(db, rootPath, 'referenced');
  const ignore = buildIgnore(cfg.ignoreDirs, cfg.ignoreExts);

  if (!existsSync(THUMB_DIR)) mkdirSync(THUMB_DIR, { recursive: true });

  const walked = walk(rootPath, ignore);
  stats.skippedDirs = walked.skippedDirs;
  stats.skippedExts = walked.skippedExts;
  const files = opts.limit ? walked.files.slice(0, opts.limit) : walked.files;
  stats.scanned = files.length;

  const report = (phase: IndexProgress['phase'], processed: number, current: string): void => {
    opts.onProgress?.({ phase, processed, total: files.length, current, stats });
  };
  report('walk', 0, `${files.length} 个文件（忽略 ${stats.skippedDirs} 个目录 / ${stats.skippedExts} 个后缀）`);

  const findFile = db.prepare(
    `SELECT f.id AS file_id, f.asset_id, f.size, f.mtime, f.status, f.thumb_at, a.kind, a.model
       FROM file f JOIN asset a ON a.id = f.asset_id
      WHERE f.source_root_id = ? AND f.rel_path = ?`,
  );
  const insertAsset = db.prepare(
    `INSERT INTO asset (kind, title, ext, size, hash, hash_algo, captured_at, imported_at, meta_json, display_path, model, excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateAsset = db.prepare(
    `UPDATE asset SET kind = ?, title = ?, ext = ?, size = ?, hash = ?, hash_algo = ?, captured_at = ?,
            meta_json = ?, display_path = ?, excerpt = ?
      WHERE id = ?`,
  );
  const insertFile = db.prepare(
    `INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, size, mtime, status, thumb_at, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?)`,
  );
  const updateFile = db.prepare(
    `UPDATE file SET asset_id = ?, abs_path = ?, size = ?, mtime = ?, status = 'present', thumb_at = ?, probed_at = ?
      WHERE id = ?`,
  );

  const seen = new Set<number>();
  let processed = 0;

  for (const entry of files) {
    processed++;
    const existing = findFile.get(rootId, entry.relPath) as
      | { file_id: number; asset_id: number; size: number; mtime: string; status: string; thumb_at: string | null; kind: string }
      | undefined;

    if (existing && existing.status === 'present') seen.add(existing.file_id);

    const unchanged =
      existing && !opts.force && existing.size === entry.size && existing.mtime === entry.mtime;

    if (unchanged) {
      stats.unchanged++;
      if (processed % 25 === 0 || processed === files.length) report('index', processed, entry.relPath);
      continue;
    }

    let probeResult: ProbeResult | null = null;
    if (needsProbe(entry)) {
      probeResult = await probe(entry.absPath, cfg.ffmpegDir);
      if (probeResult) stats.probed++;
    }
    const kind = refineKind(entry.kind, probeResult);

    const hash = await hashFile(entry.absPath);
    if (!hash) stats.hashFailed++;

    // 文本/代码类抽一段摘要，卡片直接显示（参考设计的 excerpt）
    const excerpt = isTextExt(entry.ext) ? readExcerpt(entry.absPath) : null;

    const title = titleOf(entry);
    const capturedAt =
      probeResult?.tags['creation_time'] ?? probeResult?.tags['date'] ?? new Date(entry.mtimeMs).toISOString();
    const metaJson = probeResult
      ? JSON.stringify({
          durationSec: probeResult.durationSec,
          width: probeResult.width,
          height: probeResult.height,
          videoCodec: probeResult.videoCodec,
          audioCodec: probeResult.audioCodec,
          bitrate: probeResult.bitrate,
          formatName: probeResult.formatName,
          tags: probeResult.tags,
        })
      : null;

    // 内容哈希去重：同一个内容只允许一个素材。
    // 少了这一步，"重建索引后再扫描"会把 113 个素材变成 226 个（实测踩到过）。
    const byHash = hash
      ? (db.prepare('SELECT id FROM asset WHERE hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as
          | { id: number }
          | undefined)
      : undefined;

    let assetId: number;
    if (byHash) {
      assetId = byHash.id;
      if (existing && existing.asset_id !== assetId) {
        // 文件内容变了、新内容已有素材：把这一行改挂过去，旧素材没有文件了就清掉
        db.prepare('UPDATE file SET asset_id = ? WHERE id = ?').run(assetId, existing.file_id);
        removeOrphanAsset(db, existing.asset_id);
        stats.updated++;
      } else if (existing) {
        stats.unchanged++;
      } else {
        stats.added++;
      }
    } else if (existing) {
      updateAsset.run(
        kind, title, entry.ext, entry.size, hash, 'sha256', capturedAt, metaJson, entry.relPath, excerpt, existing.asset_id,
      );
      assetId = existing.asset_id;
      stats.updated++;
    } else {
      const res = insertAsset.run(
        kind, title, entry.ext, entry.size, hash, 'sha256', capturedAt, new Date().toISOString(), metaJson,
        entry.relPath, null, excerpt,
      );
      assetId = Number(res.lastInsertRowid);
      stats.added++;
    }

    // 缩略图按内容哈希命名（见 config.ts 的说明），库重建后依然能复用
    let thumbAt: string | null = existing?.thumb_at ?? null;
    const thumbPath = hash ? thumbPathForHash(hash) : null;
    if (thumbPath && (kind === 'image' || kind === 'video')) {
      const wantThumb = opts.force || !existsSync(thumbPath);
      if (wantThumb) {
        if (existsSync(thumbPath)) rmSync(thumbPath, { force: true });
        const ok =
          kind === 'image'
            ? await makeImageThumb(entry.absPath, thumbPath, cfg.ffmpegDir)
            : await makeVideoThumb(entry.absPath, thumbPath, cfg.ffmpegDir);
        if (ok) {
          stats.thumbnails++;
        } else {
          stats.thumbFailed++;
        }
      }
      if (existsSync(thumbPath)) thumbAt = new Date().toISOString();
    }

    const probedAt = probeResult ? new Date().toISOString() : null;
    if (existing) {
      updateFile.run(assetId, entry.absPath, entry.size, entry.mtime, thumbAt, probedAt, existing.file_id);
      seen.add(existing.file_id);
    } else {
      const inserted = insertFile.run(assetId, rootId, entry.relPath, entry.absPath, entry.size, entry.mtime, thumbAt, probedAt);
      seen.add(Number(inserted.lastInsertRowid));
    }
    // 同一素材的其它文件行（库内托管副本 / 原文件）一起更新，避免两行状态不一致
    if (thumbAt) db.prepare('UPDATE file SET thumb_at = ? WHERE asset_id = ?').run(thumbAt, assetId);

    // 用素材当前记录的 model 建索引（用户标注的模型不能被重扫抹掉）
    const modelRow = db.prepare('SELECT model FROM asset WHERE id = ?').get(assetId) as { model: string | null } | undefined;
    upsertFts(db, assetId, title, entry.relPath, '', modelRow?.model ?? '', kind);
    stats.bytesIndexed += entry.size;

    report('index', processed, entry.relPath);
  }

  // 磁盘上没有了 → 标记 missing，不删数据（软语义，见开发建议 §9）。
  // 局部扫描（--limit）没有覆盖全部文件，此时不能做缺失判定。
  if (!opts.limit) {
    const allRows = db
      .prepare('SELECT id FROM file WHERE source_root_id = ? AND status = ?')
      .all(rootId, 'present') as Array<{ id: number }>;
    const markMissing = db.prepare("UPDATE file SET status = 'missing' WHERE id = ?");
    for (const row of allRows) {
      if (!seen.has(row.id)) {
        markMissing.run(row.id);
        stats.missing++;
      }
    }
  }

  db.prepare('UPDATE source_root SET last_scan_at = ? WHERE id = ?').run(new Date().toISOString(), rootId);
  // 兜底：历史遗留的重复素材（同 hash 多素材）在每次扫描后合并
  stats.mergedDuplicates = mergeDuplicateAssets(db).merged;
  stats.durationMs = Date.now() - started;
  report('done', processed, '完成');
  return stats;
}
