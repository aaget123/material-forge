import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { LibraryConfig } from './config.ts';
import { canonicalizeManagedRoot, mergeDuplicateAssets } from './maintenance.ts';
import {
  copyIntoLibrary, ensureLibraryLayout, loadLibraryMeta, objectAbsPath, objectRelPath,
  readSidecar, sidecarPathOf, writeSidecar, type Sidecar,
} from './library.ts';

export interface ImportStats {
  considered: number;
  copied: number;
  dedupedByHash: number;
  sidecarsWritten: number;
  managedFilesCreated: number;
  bytesCopied: number;
  mergedAssets: number;
  skippedMissingSource: number;
  noHash: number;
  errors: string[];
  durationMs: number;
}

export interface ImportProgress {
  phase: 'merge' | 'import' | 'done';
  processed: number;
  total: number;
  current: string;
  stats: ImportStats;
}

function emptyStats(): ImportStats {
  return {
    considered: 0, copied: 0, dedupedByHash: 0, sidecarsWritten: 0, managedFilesCreated: 0,
    bytesCopied: 0, mergedAssets: 0, skippedMissingSource: 0, noHash: 0, errors: [], durationMs: 0,
  };
}

/**
 * 合并内容相同的素材（同一 hash 只留一个 asset）放在 maintenance.ts，
 * 扫描与导入都会兜底调用，避免同一内容留下重复素材。
 */

interface ImportRow {
  assetId: number;
  hash: string;
  kind: string;
  title: string;
  ext: string;
  size: number;
  capturedAt: string | null;
  metaJson: string | null;
  excerpt: string | null;
  thumbAt: string | null;
  relPath: string;
  absPath: string;
  rootPath: string;
}

export interface ImportOptions {
  /** 只导入某个来源根目录（默认全部引用型根目录） */
  rootPath?: string;
  force?: boolean;
  limit?: number;
  onProgress?: (p: ImportProgress) => void;
}

/**
 * 复制导入：把引用型素材复制成库内托管对象（内容寻址），并写 sidecar。
 * 铁律：**只复制，绝不移动或删除原文件**（开发建议 D2、§9）。
 */
export async function importToLibrary(
  db: DatabaseSync,
  _cfg: LibraryConfig,
  opts: ImportOptions = {},
): Promise<ImportStats> {
  const started = Date.now();
  const stats = emptyStats();
  ensureLibraryLayout();
  loadLibraryMeta();
  // 库目录可能搬过家：先把托管根归并到一个规范行，再决定文件行挂到哪
  const managedRootId = canonicalizeManagedRoot(db).canonicalId;

  const report = (phase: ImportProgress['phase'], processed: number, current: string): void => {
    opts.onProgress?.({ phase, processed, total: stats.considered, current, stats });
  };

  report('merge', 0, '合并内容相同的素材');
  const mergeResult = mergeDuplicateAssets(db);
  stats.mergedAssets = mergeResult.merged;

  const rows = db
    .prepare(
      `SELECT a.id AS assetId, a.hash, a.kind, a.title, a.ext, a.size, a.captured_at AS capturedAt,
              a.meta_json AS metaJson, a.excerpt AS excerpt, f.rel_path AS relPath, f.abs_path AS absPath,
              f.thumb_at AS thumbAt, sr.path AS rootPath
         FROM asset a
         JOIN file f ON f.asset_id = a.id
         JOIN source_root sr ON sr.id = f.source_root_id
        WHERE a.deleted_at IS NULL AND f.status = 'present' AND sr.mode = 'referenced'
          ${opts.rootPath ? 'AND sr.path = ?' : ''}
        ORDER BY a.id`,
    )
    .all(...(opts.rootPath ? [opts.rootPath] : [])) as unknown as ImportRow[];

  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
  stats.considered = limited.length;

  const findManaged = db.prepare('SELECT id FROM file WHERE source_root_id = ? AND rel_path = ?');
  const insertManaged = db.prepare(
    `INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, size, mtime, status, thumb_at, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?)`,
  );

  let processed = 0;
  for (const row of limited) {
    processed++;
    try {
      if (!existsSync(row.absPath)) {
        stats.skippedMissingSource++;
        continue;
      }
      const rel = objectRelPath(row.hash, row.ext);
      const target = objectAbsPath(row.hash, row.ext);
      const alreadyOnDisk = existsSync(target);
      const { copied, objectPath } = copyIntoLibrary(row.absPath, row.hash, row.ext);
      if (copied) {
        stats.copied++;
        stats.bytesCopied += row.size;
      } else if (alreadyOnDisk) {
        stats.dedupedByHash++;
      }

      const sidecarPath = sidecarPathOf(objectPath);
      if (opts.force || !existsSync(sidecarPath)) {
        const sidecar: Sidecar = {
          schema: 1,
          hash: row.hash,
          hashAlgo: 'sha256',
          ext: row.ext,
          kind: row.kind,
          title: row.title,
          size: row.size,
          capturedAt: row.capturedAt,
          importedAt: new Date().toISOString(),
          rating: null,
          note: '',
          tags: [],
          projects: [],
          meta: row.metaJson ? (JSON.parse(row.metaJson) as unknown) : null,
          source: { rootPath: row.rootPath, relPath: row.relPath },
          model: null,
          excerpt: row.excerpt ?? null,
        };
        writeSidecar(sidecarPath, sidecar);
        stats.sidecarsWritten++;
      }

      const existingManaged = findManaged.get(managedRootId, rel) as { id: number } | undefined;
      if (!existingManaged) {
        insertManaged.run(
          row.assetId, managedRootId, rel, objectPath, row.size,
          new Date().toISOString(), row.thumbAt, new Date().toISOString(),
        );
        stats.managedFilesCreated++;
      }
    } catch (err) {
      stats.errors.push(`${row.relPath}: ${(err as Error).message}`);
    }
    if (processed % 10 === 0 || processed === limited.length) report('import', processed, row.relPath);
  }

  stats.durationMs = Date.now() - started;
  report('done', processed, '导入完成');
  return stats;
}

/** sidecar 是否为有效对象（供重建与核对使用） */
export function sidecarOf(hash: string, ext: string): Sidecar | null {
  return readSidecar(sidecarPathOf(objectAbsPath(hash, ext)));
}
