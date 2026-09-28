import type { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { THUMB_DIR, thumbPathForHash } from './config.ts';
import { peaksPathForHash } from './peaks.ts';
import { pruneBundles } from './bundles.ts';
import { ensureRoot } from './db.ts';
import { bigramIndexText } from './bigram.ts';
import { KIND_LABEL, type Kind } from './kind.ts';
import {
  MANIFESTS_DIR, OBJECTS_DIR, TRASH_DIR, ensureDirFor, listObjects, loadLibraryMeta,
  objectAbsPath, objectRelPath, sidecarPathOf, writeSidecar, type Sidecar,
} from './library.ts';

/**
 * 合并内容相同的素材（同一 hash 只留一个 asset）。
 * 扫描与导入都会兜底调用它：这样"同一内容被多次入库"不会留下重复素材。
 */
export function mergeDuplicateAssets(db: DatabaseSync): { groups: number; merged: number } {
  const groups = db
    .prepare(
      `SELECT hash, MIN(id) AS keeper, COUNT(*) AS c FROM asset
        WHERE hash IS NOT NULL AND deleted_at IS NULL GROUP BY hash HAVING c > 1`,
    )
    .all() as Array<{ hash: string; keeper: number; c: number }>;

  let merged = 0;
  for (const group of groups) {
    const losers = db
      .prepare('SELECT id FROM asset WHERE hash = ? AND id != ? AND deleted_at IS NULL')
      .all(group.hash, group.keeper) as Array<{ id: number }>;
    for (const loser of losers) {
      db.prepare('UPDATE file SET asset_id = ? WHERE asset_id = ?').run(group.keeper, loser.id);
      db.prepare('UPDATE OR IGNORE asset_tag SET asset_id = ? WHERE asset_id = ?').run(group.keeper, loser.id);
      db.prepare('DELETE FROM asset_tag WHERE asset_id = ?').run(loser.id);
      db.prepare('UPDATE OR IGNORE project_asset SET asset_id = ? WHERE asset_id = ?').run(group.keeper, loser.id);
      db.prepare('DELETE FROM project_asset WHERE asset_id = ?').run(loser.id);
      db.prepare('UPDATE project SET cover_asset_id = ? WHERE cover_asset_id = ?').run(group.keeper, loser.id);
      db.prepare('DELETE FROM asset_fts WHERE rowid = ?').run(loser.id);
      db.prepare('DELETE FROM asset WHERE id = ?').run(loser.id);
      merged++;
    }
  }
  return { groups: groups.length, merged };
}

export function upsertFts(
  db: DatabaseSync, assetId: number, title: string, pathText: string, note: string, model: string, kind: string,
): void {
  // 提示词与来源也要能被搜到：直接读库里的最新值，调用方不必改签名。
  // 提示词写进 note 列（该列只用于匹配，素材自己的备注在 asset.note）与 bigram 文本。
  const extra = db.prepare('SELECT prompt, origin, params, caption, tags FROM asset WHERE id = ?').get(assetId) as
    | { prompt: string | null; origin: string | null; params: string | null; caption: string | null; tags: string | null }
    | undefined;
  const tagsText = (extra?.tags ?? '').replace(/[\[\]"']/g, ' ');
  // AI 生成的一句话描述也参与检索：这样 pm search --q 海边的逆光 能命中画面内容
  const captionText = extra?.caption ?? '';
  const promptText = extra?.prompt ?? '';
  const originText = extra?.origin === 'ai' ? 'AI生成' : extra?.origin === 'real' ? '非AI' : extra?.origin === 'other' ? '其他' : '';
  const searchable = `${title} ${pathText} ${model} ${promptText} ${originText} ${extra?.params ?? ''} ${captionText} ${tagsText}`;
  db.prepare('DELETE FROM asset_fts WHERE rowid = ?').run(assetId);
  db.prepare(
    'INSERT INTO asset_fts (rowid, title, path_text, note, model, bigram, kind) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(assetId, title, pathText.replace(/\//g, ' '), `${note} ${promptText} ${captionText} ${tagsText}`, model, bigramIndexText(searchable), kind);
}

/**
 * 从 asset 表重建全文索引。用于：FTS 结构升级后自愈、以及手工 `reindex`。
 * 索引是纯派生数据，任何时候重建都安全。
 */
export function reindexFts(db: DatabaseSync): { rows: number } {
  db.exec('DELETE FROM asset_fts');
  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.kind, a.model, a.note,
              COALESCE(a.display_path, '') AS display_path
         FROM asset a WHERE a.deleted_at IS NULL`,
    )
    .all() as Array<{ id: number; title: string; kind: string; model: string | null; note: string | null; display_path: string }>;
  for (const row of rows) {
    upsertFts(db, row.id, row.title, row.display_path, row.note ?? '', row.model ?? '', row.kind);
  }
  return { rows: rows.length };
}

/** FTS 行数与素材数是否一致（启动时自愈判断用） */
export function ftsNeedsReindex(db: DatabaseSync): boolean {
  const assets = (db.prepare('SELECT COUNT(*) AS c FROM asset WHERE deleted_at IS NULL').get() as { c: number }).c;
  const indexed = (db.prepare('SELECT COUNT(*) AS c FROM asset_fts').get() as { c: number }).c;
  return assets !== indexed;
}

function hashOf(filePath: string): string | null {
  try {
    const size = statSync(filePath).size;
    const buffer = Buffer.alloc(size);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    return createHash('sha256').update(buffer).digest('hex');
  } catch {
    return null;
  }
}

export interface CanonicalizeReport {
  canonicalId: number;
  mergedFiles: number;
  removedRoots: number;
  pathRepaired: boolean;
}

/**
 * 托管根归并：库目录改名/搬家后可能出现多个 mode='managed' 的 source_root 行
 * （旧路径一行、新路径一行）。硬改路径会撞 UNIQUE 约束——实测报过
 * `UNIQUE constraint failed: source_root.path`，所以这里先挑出规范行，
 * 再把其余行的文件并过来、删掉多余行。
 */
export function canonicalizeManagedRoot(db: DatabaseSync): CanonicalizeReport {
  const rows = db.prepare("SELECT id, path FROM source_root WHERE mode = 'managed'").all() as Array<{ id: number; path: string }>;
  const report: CanonicalizeReport = { canonicalId: 0, mergedFiles: 0, removedRoots: 0, pathRepaired: false };

  let canonical = rows.find((row) => row.path === OBJECTS_DIR);
  if (!canonical && rows.length > 0) {
    let best: { id: number; path: string; files: number } | null = null;
    for (const row of rows) {
      const files = (db.prepare('SELECT COUNT(*) AS c FROM file WHERE source_root_id = ?').get(row.id) as { c: number }).c;
      if (!best || files > best.files) best = { id: row.id, path: row.path, files };
    }
    if (best) {
      db.prepare('UPDATE source_root SET path = ? WHERE id = ?').run(OBJECTS_DIR, best.id);
      report.pathRepaired = true;
      canonical = { id: best.id, path: OBJECTS_DIR };
    }
  }

  const canonicalId = canonical?.id ?? ensureRoot(db, OBJECTS_DIR, 'managed');
  report.canonicalId = canonicalId;

  for (const row of rows) {
    if (row.id === canonicalId) continue;
    const files = db.prepare('SELECT id, rel_path FROM file WHERE source_root_id = ?').all(row.id) as Array<{ id: number; rel_path: string }>;
    for (const file of files) {
      db.prepare('UPDATE OR REPLACE file SET source_root_id = ?, abs_path = ? WHERE id = ?').run(
        canonicalId, join(OBJECTS_DIR, file.rel_path), file.id,
      );
      report.mergedFiles++;
    }
    db.prepare('DELETE FROM source_root WHERE id = ?').run(row.id);
    report.removedRoots++;
  }
  return report;
}

export interface RelinkReport {
  managedRootRepaired: boolean;
  mergedFiles: number;
  removedRoots: number;
  managedFilesChecked: number;
  managedPathsFixed: number;
  referencedChecked: number;
  missing: string[];
}

/**
 * 重链：库目录整体改名/搬家后，让索引重新指向真实位置。
 * 托管文件靠"内容哈希推导出的相对路径"自我修复；引用型文件只报告、绝不改动用户文件。
 */
export function relink(db: DatabaseSync): RelinkReport {
  const report: RelinkReport = {
    managedRootRepaired: false, mergedFiles: 0, removedRoots: 0,
    managedFilesChecked: 0, managedPathsFixed: 0, referencedChecked: 0, missing: [],
  };

  const canon = canonicalizeManagedRoot(db);
  report.managedRootRepaired = canon.pathRepaired || canon.removedRoots > 0;
  report.mergedFiles = canon.mergedFiles;
  report.removedRoots = canon.removedRoots;

  const managedFiles = db
    .prepare("SELECT id, rel_path, abs_path FROM file WHERE source_root_id = ? AND status = 'present'")
    .all(canon.canonicalId) as Array<{ id: number; rel_path: string; abs_path: string }>;
  for (const file of managedFiles) {
    report.managedFilesChecked++;
    const expected = join(OBJECTS_DIR, file.rel_path);
    if (expected !== file.abs_path) {
      db.prepare('UPDATE file SET abs_path = ? WHERE id = ?').run(expected, file.id);
      report.managedPathsFixed++;
    }
    if (!existsSync(expected)) report.missing.push(file.rel_path);
  }

  const referenced = db
    .prepare(
      `SELECT f.abs_path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
        WHERE sr.mode = 'referenced' AND f.status = 'present'`,
    )
    .all() as Array<{ abs_path: string }>;
  for (const row of referenced) {
    report.referencedChecked++;
    if (!existsSync(row.abs_path)) report.missing.push(row.abs_path);
  }

  return report;
}

export interface RebuildReport {
  objects: number;
  sidecars: number;
  withoutSidecar: number;
  assetsCreated: number;
  assetsReused: number;
  filesCreated: number;
  ftsRows: number;
  wipedFiles: number;
  errors: string[];
}

/**
 * 从 objects/*.json 重建索引 —— "数据库可整库重建"的兑现方式。
 * 只按 sidecar 重建托管对象；引用型素材重跑一次 scan 即可（磁盘才是真相源）。
 */
export function rebuildFromSidecars(db: DatabaseSync, opts: { wipeManaged?: boolean } = {}): RebuildReport {
  const report: RebuildReport = {
    objects: 0, sidecars: 0, withoutSidecar: 0, assetsCreated: 0, assetsReused: 0,
    filesCreated: 0, ftsRows: 0, wipedFiles: 0, errors: [],
  };
  loadLibraryMeta();
  const canon = canonicalizeManagedRoot(db);
  const managedRootId = canon.canonicalId;

  if (opts.wipeManaged) {
    const existing = db
      .prepare('SELECT id, asset_id FROM file WHERE source_root_id = ?')
      .all(managedRootId) as Array<{ id: number; asset_id: number }>;
    db.prepare('DELETE FROM file WHERE source_root_id = ?').run(managedRootId);
    report.wipedFiles = existing.length;
    for (const assetId of new Set(existing.map((row) => row.asset_id))) {
      const remaining = db.prepare('SELECT COUNT(*) AS c FROM file WHERE asset_id = ?').get(assetId) as { c: number };
      if (remaining.c === 0) {
        db.prepare('DELETE FROM asset_fts WHERE rowid = ?').run(assetId);
        db.prepare('DELETE FROM asset WHERE id = ?').run(assetId);
      }
    }
  }

  const objects = listObjects();
  report.objects = objects.length;

  const findByHash = db.prepare('SELECT id FROM asset WHERE hash = ? AND deleted_at IS NULL LIMIT 1');
  const insertAsset = db.prepare(
    `INSERT INTO asset (kind, title, ext, size, hash, hash_algo, captured_at, imported_at, meta_json, display_path, model, excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const findManaged = db.prepare('SELECT id FROM file WHERE source_root_id = ? AND rel_path = ?');
  const insertFile = db.prepare(
    `INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, size, mtime, status, thumb_at, probed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?)`,
  );

  for (const entry of objects) {
    const sidecar: Sidecar | null = entry.sidecar;
    if (!sidecar) {
      report.withoutSidecar++;
      continue;
    }
    report.sidecars++;
    try {
      // 人能认出来的路径来自 sidecar 的来源记录；托管对象路径是哈希，不能拿来展示或检索
      const relPath = objectRelPath(sidecar.hash, sidecar.ext);
      const displayPath = sidecar.source?.relPath ?? relPath;

      let assetId: number;
      const found = findByHash.get(sidecar.hash) as { id: number } | undefined;
      if (found) {
        assetId = found.id;
        report.assetsReused++;
      } else {
        const res = insertAsset.run(
          sidecar.kind, sidecar.title, sidecar.ext, sidecar.size, sidecar.hash, sidecar.hashAlgo,
          sidecar.capturedAt, sidecar.importedAt, sidecar.meta ? JSON.stringify(sidecar.meta) : null, displayPath,
          sidecar.model ?? null, sidecar.excerpt ?? null,
        );
        assetId = Number(res.lastInsertRowid);
        report.assetsCreated++;
      }

      if (!findManaged.get(managedRootId, relPath)) {
        // 缩略图按内容哈希命名，所以重建索引后缓存照样命中
        const thumbAt = existsSync(thumbPathForHash(sidecar.hash)) ? new Date().toISOString() : null;
        insertFile.run(
          assetId, managedRootId, relPath, entry.objectPath, entry.size,
          new Date().toISOString(), thumbAt, new Date().toISOString(),
        );
        report.filesCreated++;
      }
      upsertFts(db, assetId, sidecar.title, displayPath, sidecar.note ?? '', sidecar.model ?? '', sidecar.kind);
      report.ftsRows++;
    } catch (err) {
      report.errors.push(`${entry.relPath}: ${(err as Error).message}`);
    }
  }
  return report;
}

export interface VerifyReport {
  assets: number;
  files: number;
  managedFiles: number;
  referencedFiles: number;
  trashedAssets: number;
  thumbnails: number;
  objectsOnDisk: number;
  sidecarsOnDisk: number;
  objectsWithoutDbRow: number;
  dbRowsWithoutObject: number;
  assetsWithoutSidecar: number;
  duplicateHashGroups: number;
  /** 托管文件记录里的绝对路径与当前库位置不一致（库搬过家、还没 relink） */
  managedPathsStale: number;
  /** 托管文件在库内根本找不到（真的丢了） */
  managedFilesMissing: number;
  /** derived/thumbs 里的缩略图文件数，以及没有对应素材的孤儿缓存（可安全清理） */
  thumbFilesOnDisk: number;
  orphanThumbs: number;
  hashChecked: number;
  hashMismatch: number;
  hashedBytes: number;
}

/** 完整性核对：索引、对象、sidecar 是否互相一致；可选重算哈希（较慢但最可信） */
export function verifyLibrary(db: DatabaseSync, opts: { hash?: boolean } = {}): VerifyReport {
  canonicalizeManagedRoot(db);
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM asset WHERE deleted_at IS NULL) AS assets,
         (SELECT COUNT(*) FROM asset WHERE deleted_at IS NOT NULL) AS trashedAssets,
         (SELECT COUNT(*) FROM file WHERE status = 'present') AS files,
         (SELECT COUNT(*) FROM file f JOIN source_root sr ON sr.id = f.source_root_id
           WHERE f.status = 'present' AND sr.mode = 'managed') AS managedFiles,
         (SELECT COUNT(*) FROM file f JOIN source_root sr ON sr.id = f.source_root_id
           WHERE f.status = 'present' AND sr.mode = 'referenced') AS referencedFiles,
         (SELECT COUNT(DISTINCT asset_id) FROM file WHERE thumb_at IS NOT NULL) AS thumbnails,
         (SELECT COUNT(*) FROM (SELECT hash FROM asset WHERE hash IS NOT NULL AND deleted_at IS NULL
             GROUP BY hash HAVING COUNT(*) > 1)) AS duplicateHashGroups`,
    )
    .get() as Omit<VerifyReport, 'objectsOnDisk' | 'sidecarsOnDisk' | 'objectsWithoutDbRow' | 'dbRowsWithoutObject' | 'assetsWithoutSidecar' | 'hashChecked' | 'hashMismatch' | 'hashedBytes'>;

  const objects = listObjects();
  // 索引侧的库内相对路径集合：只看 status='present' 的托管文件。
  // 已回收的文件其对象本来就该在 trash\ 而不在 objects\，否则会把"正常回收"误报成异常。
  // 另外要把**历史版本**的对象也算进来：编辑保存出的旧版本仍然是有意保留的内容，
  // 不是"库外孤儿"（否则每保存一次编辑，verify 就会多报一个 objectsWithoutDbRow）。
  const versionHashes = new Set(
    (db.prepare('SELECT hash FROM asset_version').all() as Array<{ hash: string }>).map((row) => row.hash),
  );
  const dbRels = new Set(
    (
      db
        .prepare(
          `SELECT f.rel_path AS rel_path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
            WHERE sr.mode = 'managed' AND f.status = 'present'`,
        )
        .all() as Array<{ rel_path: string }>
    ).map((row) => row.rel_path.replace(/\\/g, '/')),
  );
  for (const rel of objects.map((o) => o.relPath)) {
    // objects/ab/cd/<hash>.<ext> → 取出哈希部分判断是否属于某个历史版本
    const name = rel.split('/').pop() ?? '';
    const hash = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    if (versionHashes.has(hash)) dbRels.add(rel);
  }

  // 库搬家后最容易出问题的两件事：绝对路径过期、对象真的找不到
  let managedPathsStale = 0;
  let managedFilesMissing = 0;
  const managedRows = db
    .prepare(
      `SELECT f.rel_path AS rel_path, f.abs_path AS abs_path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
        WHERE sr.mode = 'managed' AND f.status = 'present'`,
    )
    .all() as Array<{ rel_path: string; abs_path: string }>;
  for (const row of managedRows) {
    const expected = join(OBJECTS_DIR, row.rel_path);
    if (row.abs_path !== expected) managedPathsStale++;
    if (!existsSync(expected)) managedFilesMissing++;
  }
  const diskRels = new Set(objects.map((o) => o.relPath));

  let hashChecked = 0;
  let hashMismatch = 0;
  let hashedBytes = 0;
  if (opts.hash) {
    for (const entry of objects) {
      const actual = hashOf(entry.objectPath);
      hashChecked++;
      hashedBytes += entry.size;
      if (!actual || actual !== entry.hash || (entry.sidecar && entry.sidecar.hash !== actual)) hashMismatch++;
    }
  }

  const thumbFiles = existsSync(THUMB_DIR) ? readdirSync(THUMB_DIR).filter((name) => name.endsWith('.webp')) : [];
  const assetHashes = new Set(
    (db.prepare('SELECT hash FROM asset WHERE hash IS NOT NULL').all() as Array<{ hash: string }>).map((row) => row.hash),
  );
  const orphanThumbs = thumbFiles.filter((name) => !assetHashes.has(name.slice(0, -'.webp'.length))).length;

  return {
    ...counts,
    objectsOnDisk: objects.length,
    sidecarsOnDisk: objects.filter((o) => o.sidecar !== null).length,
    objectsWithoutDbRow: objects.filter((o) => !dbRels.has(o.relPath)).length,
    dbRowsWithoutObject: [...dbRels].filter((rel) => !diskRels.has(rel)).length,
    assetsWithoutSidecar: objects.filter((o) => o.sidecar === null).length,
    managedPathsStale,
    managedFilesMissing,
    thumbFilesOnDisk: thumbFiles.length,
    orphanThumbs,
    hashChecked,
    hashMismatch,
    hashedBytes,
  };
}

export interface TrashReport {
  assetId: number;
  title: string;
  movedObjects: string[];
  markedFiles: number;
  referencedLeftAlone: number;
  alreadyTrashed: boolean;
}

/**
 * 移入回收站（软删除）。托管对象移到 trash/ 并保留 sidecar；
 * **引用型素材只从库里摘掉记录，绝不动磁盘上的原文件**。
 */
export function trashAsset(db: DatabaseSync, assetId: number): TrashReport {
  const asset = db.prepare('SELECT id, title, deleted_at FROM asset WHERE id = ?').get(assetId) as
    | { id: number; title: string; deleted_at: string | null }
    | undefined;
  if (!asset) throw new Error(`素材不存在: ${assetId}`);

  const report: TrashReport = {
    assetId, title: asset.title, movedObjects: [], markedFiles: 0, referencedLeftAlone: 0,
    alreadyTrashed: asset.deleted_at !== null,
  };
  if (report.alreadyTrashed) return report;

  const canon = canonicalizeManagedRoot(db);
  const managedRootIds = new Set(
    (db.prepare("SELECT id FROM source_root WHERE mode = 'managed'").all() as Array<{ id: number }>).map((row) => row.id),
  );
  void canon;
  const files = db
    .prepare('SELECT id, source_root_id, rel_path, abs_path, status FROM file WHERE asset_id = ?')
    .all(assetId) as Array<{ id: number; source_root_id: number | null; rel_path: string; abs_path: string; status: string }>;

  if (!existsSync(TRASH_DIR)) mkdirSync(TRASH_DIR, { recursive: true });

  const updateFile = db.prepare("UPDATE file SET status = 'trashed', abs_path = ? WHERE id = ?");
  for (const file of files) {
    if (file.source_root_id !== null && managedRootIds.has(file.source_root_id) && file.status === 'present') {
      const target = join(TRASH_DIR, file.rel_path.replace(/\//g, '\\'));
      ensureDirFor(target);
      try {
        if (existsSync(file.abs_path)) renameSync(file.abs_path, target);
        const sidecar = sidecarPathOf(file.abs_path);
        if (existsSync(sidecar)) {
          ensureDirFor(sidecarPathOf(target));
          renameSync(sidecar, sidecarPathOf(target));
        }
        report.movedObjects.push(file.rel_path);
      } catch (err) {
        throw new Error(`移动对象失败 ${file.rel_path}: ${(err as Error).message}`);
      }
      updateFile.run(target, file.id);
    } else if (file.status === 'present') {
      // 引用型：只改库内状态，绝不移动或删除用户的文件
      report.referencedLeftAlone++;
      updateFile.run(file.abs_path, file.id);
    }
    report.markedFiles++;
  }

  db.prepare('DELETE FROM asset_fts WHERE rowid = ?').run(assetId);
  db.prepare('UPDATE asset SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), assetId);
  return report;
}

export interface PurgeReport {
  assets: number;
  removedObjects: number;
  removedSidecars: number;
  droppedFileRows: number;
  keptOriginalFiles: number;
  removedThumbs: number;
  removedPeaks: number;
}

/**
 * 清空回收站（真正删除）。
 * 只删库内的托管对象与 sidecar 以及索引行；**引用型素材对应的原文件绝不删除**，
 * 所以清空回收站之后，原目录里的文件依然完好，重新扫描又能把它们索引回来。
 *
 * 缩略图按内容哈希命名，所以要单独清：不清的话每清一次回收站都会在
 * derived/thumbs 里攒下孤儿文件（verify 会报 orphanThumbs，实测就是清空回收站后的残留）。
 * 只有确认"这个哈希在库里已经没有任何素材"时才删，避免删掉同内容其他素材还在用的缩略图。
 */
export function purgeTrashed(db: DatabaseSync, onlyIds?: number[]): PurgeReport {
  canonicalizeManagedRoot(db);
  const managedRootIds = new Set(
    (db.prepare("SELECT id FROM source_root WHERE mode = 'managed'").all() as Array<{ id: number }>).map((row) => row.id),
  );
  // 给了 ids 就只彻底删这几件（回收站里的"彻底删除所选"），否则清空整个回收站
  const filter = onlyIds && onlyIds.length > 0
    ? ` AND id IN (${onlyIds.filter((id) => Number.isFinite(id)).map(() => '?').join(',')})`
    : '';
  const trashed = db
    .prepare(`SELECT id, hash FROM asset WHERE deleted_at IS NOT NULL${filter}`)
    .all(...(filter ? onlyIds!.filter((id) => Number.isFinite(id)) : [])) as Array<{ id: number; hash: string | null }>;

  const report: PurgeReport = {
    assets: 0, removedObjects: 0, removedSidecars: 0, droppedFileRows: 0, keptOriginalFiles: 0, removedThumbs: 0,
    removedPeaks: 0,
  };
  const dropFile = db.prepare('DELETE FROM file WHERE id = ?');
  const dropAsset = db.prepare('DELETE FROM asset WHERE id = ?');
  const dropFts = db.prepare('DELETE FROM asset_fts WHERE rowid = ?');

  for (const row of trashed) {
    const files = db
      .prepare('SELECT id, source_root_id, abs_path FROM file WHERE asset_id = ?')
      .all(row.id) as Array<{ id: number; source_root_id: number | null; abs_path: string }>;
    for (const file of files) {
      if (file.source_root_id !== null && managedRootIds.has(file.source_root_id)) {
        try {
          if (existsSync(file.abs_path)) {
            rmSync(file.abs_path, { force: true });
            report.removedObjects++;
          }
          const sidecar = sidecarPathOf(file.abs_path);
          if (existsSync(sidecar)) {
            rmSync(sidecar, { force: true });
            report.removedSidecars++;
          }
        } catch {
          /* 删不掉就留着，不要让整次清空失败 */
        }
      } else {
        report.keptOriginalFiles++;
      }
      dropFile.run(file.id);
      report.droppedFileRows++;
    }
    dropFts.run(row.id);
    dropAsset.run(row.id);
    report.assets++;

    // 缩略图与波形都是"按内容哈希命名"的派生缓存：库里已无同哈希素材时才删，
    // 否则会把同内容其他素材还在用的缓存删掉（删了也能重算，但没必要）。
    if (row.hash) {
      const stillUsed = db.prepare('SELECT COUNT(*) AS c FROM asset WHERE hash = ?').get(row.hash) as { c: number };
      if (stillUsed.c === 0) {
        const thumb = thumbPathForHash(row.hash);
        try {
          if (existsSync(thumb)) {
            rmSync(thumb, { force: true });
            report.removedThumbs++;
          }
        } catch {
          /* 删不掉就留着，孤儿缓存不影响正确性 */
        }
        const peaks = peaksPathForHash(row.hash);
        try {
          if (existsSync(peaks)) {
            rmSync(peaks, { force: true });
            report.removedPeaks++;
          }
        } catch {
          /* 同上 */
        }
      }
    }
  }
  // 素材都清掉了，"可以整项目恢复"的记录也就没有意义了，留着只会误导。
  // 但**只删所选**时不能清：回收站里还有别的素材，那些记录还有用。
  if (!onlyIds || onlyIds.length === 0) {
    db.prepare('DELETE FROM trash_project').run();
  }
  // 组的收尾无论哪种删除都要做：成员被真删之后只剩 0/1 个成员的组是空壳，留着没意义。
  // （只删所选时刚才实测漏了——组会带着 1 个成员继续存在）
  pruneBundles(db);
  return report;
}

/** 从回收站恢复 */
export function restoreAsset(db: DatabaseSync, assetId: number): { restored: number } {  canonicalizeManagedRoot(db);
  const managedRootIds = new Set(
    (db.prepare("SELECT id FROM source_root WHERE mode = 'managed'").all() as Array<{ id: number }>).map((row) => row.id),
  );
  const files = db
    .prepare("SELECT id, source_root_id, rel_path, abs_path FROM file WHERE asset_id = ? AND status = 'trashed'")
    .all(assetId) as Array<{ id: number; source_root_id: number | null; rel_path: string; abs_path: string }>;

  let restored = 0;
  for (const file of files) {
    if (file.source_root_id !== null && managedRootIds.has(file.source_root_id)) {
      const target = join(OBJECTS_DIR, file.rel_path.replace(/\//g, '\\'));
      // 回收站里的对象文件可能已被外部删掉/磁盘损坏：这时必须**报错**而不是假装恢复成功，
      // 否则库里会留下一条指向不存在文件的行（用户看到"恢复成功"但打不开）。实测踩到过。
      if (!existsSync(file.abs_path)) {
        throw new Error(`库内对象文件已丢失，无法恢复：${file.abs_path}`);
      }
      ensureDirFor(target);
      if (existsSync(file.abs_path)) renameSync(file.abs_path, target);
      const sidecar = sidecarPathOf(file.abs_path);
      if (existsSync(sidecar)) {
        ensureDirFor(sidecarPathOf(target));
        renameSync(sidecar, sidecarPathOf(target));
      }
      db.prepare("UPDATE file SET status = 'present', abs_path = ? WHERE id = ?").run(target, file.id);
    } else {
      db.prepare("UPDATE file SET status = 'present' WHERE id = ?").run(file.id);
    }
    restored++;
  }

  db.prepare('UPDATE asset SET deleted_at = NULL WHERE id = ?').run(assetId);
  const asset = db.prepare('SELECT id, title, kind, note, model, display_path FROM asset WHERE id = ?').get(assetId) as
    | { id: number; title: string; kind: Kind; note: string | null; model: string | null; display_path: string | null }
    | undefined;
  if (asset) {
    const rel = db.prepare('SELECT rel_path FROM file WHERE asset_id = ? LIMIT 1').get(assetId) as { rel_path: string } | undefined;
    upsertFts(db, asset.id, asset.title, asset.display_path ?? rel?.rel_path ?? '', asset.note ?? '', asset.model ?? '', asset.kind);
  }
  return { restored };
}

/** 校验和清单：备份/迁移前后用来核对对象是否损坏或缺失 */
export function writeChecksumManifest(db: DatabaseSync): { path: string; entries: number; totalBytes: number } {
  if (!existsSync(MANIFESTS_DIR)) mkdirSync(MANIFESTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const path = join(MANIFESTS_DIR, `checksums-${stamp}.txt`);
  const objects = listObjects();
  const lines = objects.map((o) => `${o.hash}\t${o.size}\t${o.relPath}`);
  const header = [
    `# 个人项目管理器校验和清单`,
    `# 生成时间: ${new Date().toISOString()}`,
    `# 对象数: ${objects.length}`,
    `# 格式: sha256<TAB>字节数<TAB>库内相对路径`,
  ];
  writeFileSync(path, [...header, ...lines].join('\n') + '\n', 'utf8');
  return { path, entries: objects.length, totalBytes: objects.reduce((sum, o) => sum + o.size, 0) };
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as Kind] ?? kind;
}
