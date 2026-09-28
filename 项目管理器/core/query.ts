import type { DatabaseSync } from 'node:sqlite';
import { buildFtsQuery } from './bigram.ts';
import { KIND_LABEL, modalityOf, type Kind, type Modality } from './kind.ts';

/**
 * 一个素材可能有多个文件行（引用型原文件 + 库内托管对象）。
 * 列表与检索必须"每个素材恰好一行"，并优先展示库内托管对象。
 * 这里的相关子查询就是做这件事：优先 mode='managed'，其次取 id 最小的一行。
 */
/** 一个素材只属于一个项目，所以这里的 LEFT JOIN 不会造成行放大 */
const PROJECT_JOIN = `
  LEFT JOIN project_asset pa ON pa.asset_id = a.id
  LEFT JOIN project p ON p.id = pa.project_id
`;

const BUNDLE_JOIN = `
  LEFT JOIN bundle_member bm ON bm.asset_id = a.id
  LEFT JOIN bundle b ON b.id = bm.bundle_id
`;

const PREFERRED_FILE_JOIN = `
  JOIN file f ON f.id = (
    SELECT f2.id FROM file f2
    JOIN source_root sr2 ON sr2.id = f2.source_root_id
    WHERE f2.asset_id = a.id AND f2.status = 'present'
    ORDER BY CASE WHEN sr2.mode = 'managed' THEN 0 ELSE 1 END, f2.id
    LIMIT 1
  )
  ${PROJECT_JOIN}
  ${BUNDLE_JOIN}
`;

/**
 * 回收站视图专用：允许取 status='trashed' 的文件行。
 * 这样已删除素材在回收站里仍能显示缩略图与预览（托管对象此时在 trash\ 下），
 * 否则用户看不出自己删了什么，只能盲恢复。
 */
const TRASHED_FILE_JOIN = `
  JOIN file f ON f.id = (
    SELECT f2.id FROM file f2
    JOIN source_root sr2 ON sr2.id = f2.source_root_id
    WHERE f2.asset_id = a.id
    ORDER BY CASE WHEN f2.status = 'present' THEN 0 ELSE 1 END,
             CASE WHEN sr2.mode = 'managed' THEN 0 ELSE 1 END, f2.id
    LIMIT 1
  )
  ${PROJECT_JOIN}
  ${BUNDLE_JOIN}
`;

const SELECT_COLS = `
  a.id            AS id,
  a.kind          AS kind,
  a.title         AS title,
  a.ext           AS ext,
  a.size          AS size,
  a.hash          AS hash,
  a.captured_at   AS capturedAt,
  a.imported_at   AS importedAt,
  a.meta_json     AS metaJson,
  a.deleted_at    AS deletedAt,
  a.model         AS model,
  a.excerpt       AS excerpt,
  a.prompt        AS prompt,
  a.origin        AS origin,
  a.prompt_asset_id AS promptAssetId,
  a.params        AS params,
  a.caption       AS caption,
  a.tags          AS tags,
  (SELECT COUNT(*) FROM asset m WHERE m.prompt_asset_id = a.id AND m.deleted_at IS NULL) AS promptOutputs,
  pa.project_id   AS projectId,
  p.name          AS projectName,
  p.color         AS projectColor,
  COALESCE(a.display_path, f.rel_path) AS sourcePath,
  f.rel_path      AS relPath,
  f.abs_path      AS absPath,
  f.thumb_at      AS thumbAt,
  f.status        AS status,
  bm.bundle_id    AS bundleId,
  b.title         AS bundleTitle,
  (SELECT COUNT(*) FROM bundle_member m2 JOIN asset a2 ON a2.id = m2.asset_id
    WHERE m2.bundle_id = bm.bundle_id AND a2.deleted_at IS NULL) AS bundleCount,
  CASE WHEN b.cover_asset_id = a.id THEN 1 ELSE 0 END AS bundleCover
`;

export interface AssetSource {
  mode: string;
  status: string;
  relPath: string;
  absPath: string;
  size: number;
}

export interface AssetListItem {
  id: number;
  kind: Kind;
  /** 面向界面的 7 类模态（文本/代码/图片/视频/音乐/声音/综合） */
  modality: Modality;
  title: string;
  ext: string;
  size: number;
  hash: string | null;
  capturedAt: string | null;
  importedAt: string;
  /** 人能认出来的相对路径（来源路径），用于展示与高亮 */
  sourcePath: string;
  /** 当前代表文件的库内相对路径（托管对象是哈希路径） */
  relPath: string;
  absPath: string;
  thumbAt: string | null;
  status: string;
  inLibrary: boolean;
  /** 是否在回收站里（列表项在回收站视图下为 true） */
  trashed?: boolean;
  /** 生成该素材的模型（可空） */
  model: string | null;
  /** 文本/代码摘要，卡片直接展示 */
  excerpt: string | null;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** 所属组（bundle）：一次加入的一批内容 */
  bundleId: number | null;
  bundleTitle: string | null;
  bundleCount: number;
  /** 是不是这个组的封面（画廊里默认只显示封面那张卡） */
  bundleCover: boolean;
}

export interface SearchOptions {
  q?: string;
  kind?: string;
  /** 按项目筛选（单个项目，等价于 projects 只有一项） */
  project?: number;
  /** 按一组项目筛选：选中父项目时传它和它所有子项目的 id */
  projects?: number[];
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  total: number;
  items: AssetListItem[];
  /** 本次实际走的检索路径，便于验证「bigram 是否生效」 */
  strategy: 'fts' | 'like' | 'none';
  ftsQuery: string | null;
}

function withMeta(rows: Array<Record<string, unknown>>, inLibraryById: Set<number>): AssetListItem[] {
  return rows.map((row) => {
    let durationSec: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    const metaJson = row['metaJson'] as string | null;
    if (metaJson) {
      try {
        const meta = JSON.parse(metaJson) as { durationSec?: number; width?: number; height?: number };
        durationSec = meta.durationSec ?? null;
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch {
        /* 元数据坏了不影响列表 */
      }
    }
    const id = Number(row['id']);
    return {
      ...(row as unknown as AssetListItem),
      durationSec,
      width,
      height,
      modality: modalityOf(row['kind'] as Kind),
      projectId: (row['projectId'] as number | null) ?? null,
      projectName: (row['projectName'] as string | null) ?? null,
      projectColor: (row['projectColor'] as string | null) ?? null,
      bundleId: (row['bundleId'] as number | null) ?? null,
      bundleTitle: (row['bundleTitle'] as string | null) ?? null,
      bundleCount: Number(row['bundleCount'] ?? 0),
      // SQLite 里 CASE 给的是 0/1，这里统一成布尔，前端不用再记
      bundleCover: Number(row['bundleCover'] ?? 0) === 1,
      inLibrary: inLibraryById.has(id),
    };
  });
}

/** 哪些素材在库内有托管副本 */
function inLibraryIds(db: DatabaseSync, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT f.asset_id AS id FROM file f JOIN source_root sr ON sr.id = f.source_root_id
        WHERE sr.mode = 'managed' AND f.status = 'present' AND f.asset_id IN (${placeholders})`,
    )
    .all(...ids) as Array<{ id: number }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * 检索：中文走 bigram（FTS5），单个汉字走 LIKE 兜底。
 * 这条路径是本项目最重要的实测项之一（开发建议 D4）。
 */
export function searchAssets(db: DatabaseSync, opts: SearchOptions = {}): SearchResult {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = (opts.q ?? '').trim();
  const kindWhere = opts.kind ? ' AND a.kind = ?' : '';
  const kindParams: Array<string | number> = opts.kind ? [opts.kind] : [];
  const projectIds = opts.projects ?? (typeof opts.project === 'number' ? [opts.project] : []);
  const projectWhere = projectIds.length > 0 ? ` AND pa.project_id IN (${projectIds.map(() => '?').join(',')})` : '';
  const projectParams: Array<string | number> = projectIds;

  const finish = (rows: Array<Record<string, unknown>>, total: number, strategy: SearchResult['strategy'], ftsQuery: string | null): SearchResult => {
    const ids = rows.map((row) => Number(row['id']));
    const librarySet = inLibraryIds(db, ids);
    return { total, items: withMeta(rows, librarySet), strategy, ftsQuery };
  };

  if (!q) {
    const total = (
      db
        // COUNT(DISTINCT a.id)：任何 JOIN 出现多值（多项目/多组）时都不会重复计数
        .prepare(`SELECT COUNT(DISTINCT a.id) AS c FROM asset a ${PREFERRED_FILE_JOIN} WHERE a.deleted_at IS NULL${kindWhere}${projectWhere}`)
        .get(...kindParams, ...projectParams) as { c: number }
    ).c;
    const rows = db
      .prepare(
        // GROUP BY a.id：一件素材只返回一行。
        // 少了它，只要某个 JOIN 出现多值（例如一件素材挂了两个项目/两个组），
        // 同一张卡就会在画廊里出现两次，而且两张是同一份数据（用户看到的"重复且同步"）。
        `SELECT ${SELECT_COLS} FROM asset a ${PREFERRED_FILE_JOIN}
          WHERE a.deleted_at IS NULL${kindWhere}${projectWhere}
          GROUP BY a.id
          ORDER BY a.imported_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...kindParams, ...projectParams, limit, offset) as Array<Record<string, unknown>>;
    return finish(rows, total, 'none', null);
  }

  const { match, likeTerms } = buildFtsQuery(q);

  if (match) {
    const total = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT a.id) AS c FROM asset_fts JOIN asset a ON a.id = asset_fts.rowid ${PREFERRED_FILE_JOIN}
            WHERE asset_fts MATCH ? AND a.deleted_at IS NULL${kindWhere}${projectWhere}`,
        )
        .get(match, ...kindParams, ...projectParams) as { c: number }
    ).c;
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLS} FROM asset_fts JOIN asset a ON a.id = asset_fts.rowid ${PREFERRED_FILE_JOIN}
          WHERE asset_fts MATCH ? AND a.deleted_at IS NULL${kindWhere}${projectWhere}
          GROUP BY a.id
          ORDER BY asset_fts.rank LIMIT ? OFFSET ?`,
      )
      .all(match, ...kindParams, ...projectParams, limit, offset) as Array<Record<string, unknown>>;
    return finish(rows, total, 'fts', match);
  }

  // 单个汉字等无法切 bigram 的输入：退回子串匹配
  const term = `%${likeTerms.join('%')}%`;
  const likeWhere = '(a.title LIKE ? OR a.display_path LIKE ? OR f.rel_path LIKE ? OR a.model LIKE ? OR a.excerpt LIKE ?)';
  const total = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT a.id) AS c FROM asset a ${PREFERRED_FILE_JOIN}
          WHERE ${likeWhere} AND a.deleted_at IS NULL${kindWhere}${projectWhere}`,
      )
      .get(term, term, term, term, term, ...kindParams, ...projectParams) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM asset a ${PREFERRED_FILE_JOIN}
        WHERE ${likeWhere} AND a.deleted_at IS NULL${kindWhere}${projectWhere}
        GROUP BY a.id
        ORDER BY a.imported_at DESC LIMIT ? OFFSET ?`,
    )
    .all(term, term, term, term, term, ...kindParams, ...projectParams, limit, offset) as Array<Record<string, unknown>>;
  return finish(rows, total, 'like', null);
}

export interface LibraryStats {
  assets: number;
  files: number;
  managedFiles: number;
  referencedFiles: number;
  missing: number;
  bytes: number;
  thumbnails: number;
  trashed: number;
  projects: number;
  lastScanAt: string | null;
  byKind: Array<{ kind: Kind; label: string; count: number; bytes: number }>;
  /** 面向界面的 7 类模态计数（参考设计的筛选药丸直接用这个） */
  byModality: Array<{ modality: Modality; count: number }>;
}

export function getStats(db: DatabaseSync): LibraryStats {
  // 注意：字节数与缩略图必须按素材统计，不能 JOIN file 后 SUM（一个素材有多行会翻倍）
  const assets = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM asset WHERE deleted_at IS NULL')
    .get() as { c: number; bytes: number };
  const fileCounts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM file WHERE status = 'present') AS files,
         (SELECT COUNT(*) FROM file f JOIN source_root sr ON sr.id = f.source_root_id WHERE f.status = 'present' AND sr.mode = 'managed') AS managedFiles,
         (SELECT COUNT(*) FROM file f JOIN source_root sr ON sr.id = f.source_root_id WHERE f.status = 'present' AND sr.mode = 'referenced') AS referencedFiles,
         (SELECT COUNT(*) FROM file WHERE status = 'missing') AS missing,
         (SELECT COUNT(*) FROM asset WHERE deleted_at IS NOT NULL) AS trashed,
         (SELECT COUNT(DISTINCT asset_id) FROM file WHERE thumb_at IS NOT NULL) AS thumbnails`,
    )
    .get() as { files: number; managedFiles: number; referencedFiles: number; missing: number; trashed: number; thumbnails: number };
  const byKindRaw = db
    .prepare(
      `SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM asset
        WHERE deleted_at IS NULL GROUP BY kind ORDER BY count DESC`,
    )
    .all() as Array<{ kind: Kind; count: number; bytes: number }>;
  const lastScan = db.prepare('SELECT MAX(last_scan_at) AS t FROM source_root').get() as { t: string | null };
  const projectCount = (db.prepare('SELECT COUNT(*) AS c FROM project').get() as { c: number }).c;
  const modalityRows = db
    .prepare('SELECT kind, COUNT(*) AS count FROM asset WHERE deleted_at IS NULL GROUP BY kind')
    .all() as Array<{ kind: Kind; count: number }>;
  const modalityTotals = new Map<Modality, number>();
  for (const row of modalityRows) {
    const modality = modalityOf(row.kind);
    modalityTotals.set(modality, (modalityTotals.get(modality) ?? 0) + row.count);
  }

  return {
    assets: assets.c,
    bytes: assets.bytes,
    ...fileCounts,
    projects: projectCount,
    lastScanAt: lastScan.t,
    byKind: byKindRaw.map((row) => ({ ...row, label: KIND_LABEL[row.kind] ?? row.kind })),
    byModality: [...modalityTotals.entries()].map(([modality, count]) => ({ modality, count })),
  };
}

export interface AssetDetail extends AssetListItem {
  meta: unknown;
  sizeHuman: string;
  sources: AssetSource[];
  trashable: boolean;
  trashed: boolean;
  deletedAt: string | null;
}

/**
 * 取素材详情。默认只看未删除的素材；回收站视图传 includeTrashed，
 * 此时会连同 trash\ 下的托管对象一起返回，缩略图与预览才有的可用。
 */
export function getAsset(db: DatabaseSync, id: number, opts: { includeTrashed?: boolean } = {}): AssetDetail | null {
  const join = opts.includeTrashed ? TRASHED_FILE_JOIN : PREFERRED_FILE_JOIN;
  const filter = opts.includeTrashed ? '' : 'AND a.deleted_at IS NULL';
  const row = db
    .prepare(`SELECT ${SELECT_COLS} FROM asset a ${join} WHERE a.id = ? ${filter}`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  let meta: unknown = null;
  try {
    meta = row['metaJson'] ? JSON.parse(row['metaJson'] as string) : null;
  } catch {
    meta = null;
  }

  const sources = db
    .prepare(
      `SELECT sr.mode AS mode, f.status AS status, f.rel_path AS relPath, f.abs_path AS absPath, f.size AS size
         FROM file f JOIN source_root sr ON sr.id = f.source_root_id
        WHERE f.asset_id = ? ORDER BY CASE WHEN sr.mode = 'managed' THEN 0 ELSE 1 END, f.id`,
    )
    .all(id) as AssetSource[];

  const item = withMeta([row], inLibraryIds(db, [id]))[0];
  if (!item) return null;
  const deletedAt = (row['deletedAt'] as string | null) ?? null;
  return {
    ...item,
    meta,
    sizeHuman: humanSize(item.size),
    sources,
    trashable: deletedAt === null,
    trashed: deletedAt !== null,
    deletedAt,
  };
}

/** 回收站里的素材（M1 的软删除，原文件不受影响） */
export function listTrashedAssets(db: DatabaseSync, limit = 200): AssetListItem[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM asset a ${TRASHED_FILE_JOIN}
        WHERE a.deleted_at IS NOT NULL
        ORDER BY a.deleted_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  const ids = rows.map((row) => Number(row['id']));
  const librarySet = inLibraryIds(db, ids);
  return withMeta(rows, librarySet).map((item) => ({ ...item, trashed: true }));
}

export function humanSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
