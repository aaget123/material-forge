import type { DatabaseSync } from 'node:sqlite';
import type { Modality } from './kind.ts';

/**
 * 组（bundle）：把"一次加入的一批内容"当成一个单元。
 *
 * 用户反馈是"综合里一次加的多种类型素材被分开放了"——它们本来就是一组，
 * 所以这里给素材加一层"组"，而**不改素材本身**：成员照样能搜索、能挂项目、能进专注模式。
 * 画廊里默认只显示一张"组卡"（封面 + 件数），展开后就是成员。
 */

export interface BundleRow {
  id: number;
  title: string;
  note: string | null;
  coverAssetId: number | null;
  createdAt: string;
  count: number;
  /** 成员里出现过的模态（去重后给卡片角标用） */
  modalities: Modality[];
}

export interface BundleMember {
  assetId: number;
  title: string;
  modality: Modality;
  ext: string | null;
  size: number | null;
  sortKey: number | null;
}

/** 建一个组；封面默认取第一个成员 */
export function createBundle(
  db: DatabaseSync,
  input: { title: string; assetIds: number[]; note?: string },
): BundleRow {
  const title = input.title.trim();
  if (!title) throw new Error('组标题不能为空');
  const requested = [...new Set(input.assetIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (requested.length === 0) throw new Error('组里至少要有一件素材');
  // 先确认这些素材真的存在，否则插入 bundle_member 会直接撞外键，
  // 报出来的是 "FOREIGN KEY constraint failed" 这种没法排查的话（实测踩到）
  const placeholders = requested.map(() => '?').join(',');
  const existing = new Set(
    (db.prepare(`SELECT id FROM asset WHERE id IN (${placeholders})`).all(...requested) as Array<{ id: number }>)
      .map((row) => row.id),
  );
  const ids = requested.filter((id) => existing.has(id));
  if (ids.length === 0) throw new Error(`这些素材不存在：${requested.join('、')}`);

  const now = new Date().toISOString();
  const res = db.prepare('INSERT INTO bundle (title, note, cover_asset_id, created_at) VALUES (?, ?, ?, ?)')
    .run(title, input.note?.trim() ?? null, ids[0] ?? null, now);
  const bundleId = Number(res.lastInsertRowid);
  const insert = db.prepare('INSERT OR IGNORE INTO bundle_member (bundle_id, asset_id, sort_key) VALUES (?, ?, ?)');
  ids.forEach((assetId, index) => insert.run(bundleId, assetId, index));
  const created = getBundle(db, bundleId);
  if (!created) throw new Error('建组后未能读回');
  return created;
}

const BUNDLE_SELECT = `
SELECT b.id, b.title, b.note, b.cover_asset_id AS coverAssetId, b.created_at AS createdAt,
       (SELECT COUNT(*) FROM bundle_member m WHERE m.bundle_id = b.id) AS count
  FROM bundle b`;

export function listBundles(db: DatabaseSync, titleQuery?: string): BundleRow[] {
  const rows = db
    .prepare(`${BUNDLE_SELECT} ${titleQuery ? 'WHERE b.title LIKE ?' : ''} ORDER BY b.created_at DESC, b.id DESC`)
    .all(...(titleQuery ? [`%${titleQuery}%`] : [])) as Array<Omit<BundleRow, 'modalities'>>;
  return rows.map((row) => ({ ...row, modalities: modalitiesOf(db, row.id) }));
}

export function getBundle(db: DatabaseSync, id: number): BundleRow | null {
  const row = db.prepare(`${BUNDLE_SELECT} WHERE b.id = ?`).get(id) as Omit<BundleRow, 'modalities'> | undefined;
  return row ? { ...row, modalities: modalitiesOf(db, row.id) } : null;
}

function modalitiesOf(db: DatabaseSync, bundleId: number): Modality[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.kind AS kind FROM bundle_member m JOIN asset a ON a.id = m.asset_id
        WHERE m.bundle_id = ? AND a.deleted_at IS NULL`,
    )
    .all(bundleId) as Array<{ kind: string }>;
  const out = new Set<Modality>();
  for (const row of rows) out.add(modalityOfKind(row.kind));
  return [...out];
}

/** 与 core/kind.ts 的 modalityOf 保持同一口径（这里只按 kind 名映射，避免再引一层） */
function modalityOfKind(kind: string): Modality {
  switch (kind) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'music';
    case 'music': return 'music';
    case 'code': return 'code';
    case 'note':
    case 'document': return 'text';
    default: return 'mixed';
  }
}

export function listMembers(db: DatabaseSync, bundleId: number): BundleMember[] {
  const rows = db
    .prepare(
      `SELECT m.asset_id AS assetId, a.title AS title, a.kind AS kind, a.ext AS ext, a.size AS size, m.sort_key AS sortKey
         FROM bundle_member m JOIN asset a ON a.id = m.asset_id
        WHERE m.bundle_id = ? AND a.deleted_at IS NULL
        ORDER BY m.sort_key IS NULL, m.sort_key, m.asset_id`,
    )
    .all(bundleId) as Array<{ assetId: number; title: string; kind: string; ext: string | null; size: number | null; sortKey: number | null }>;
  return rows.map((row) => ({ ...row, modality: modalityOfKind(row.kind) }));
}

/** 把一件素材加进组（已经在一组里就先摘出来，保证"一个素材只属于一个组"） */
export function addMember(db: DatabaseSync, bundleId: number, assetId: number): BundleRow {
  const bundle = getBundle(db, bundleId);
  if (!bundle) throw new Error('组不存在');
  const exists = db.prepare('SELECT id FROM asset WHERE id = ?').get(assetId) as { id: number } | undefined;
  if (!exists) throw new Error(`素材 ${assetId} 不存在`);
  db.prepare('DELETE FROM bundle_member WHERE asset_id = ?').run(assetId);
  db.prepare('INSERT OR IGNORE INTO bundle_member (bundle_id, asset_id, sort_key) VALUES (?, ?, ?)')
    .run(bundleId, assetId, bundle.count);
  const next = getBundle(db, bundleId);
  if (!next) throw new Error('加成员后未能读回');
  return next;
}

export function removeMember(db: DatabaseSync, bundleId: number, assetId: number): BundleRow | null {
  db.prepare('DELETE FROM bundle_member WHERE bundle_id = ? AND asset_id = ?').run(bundleId, assetId);
  // 成员被摘空之后这个组就没有意义了，删掉；封面也不该再指向别人
  const bundle = getBundle(db, bundleId);
  if (!bundle || bundle.count === 0) {
    db.prepare('DELETE FROM bundle WHERE id = ?').run(bundleId);
    return null;
  }
  if (bundle.coverAssetId === assetId) {
    const first = db
      .prepare('SELECT asset_id FROM bundle_member WHERE bundle_id = ? ORDER BY sort_key IS NULL, sort_key, asset_id LIMIT 1')
      .get(bundleId) as { asset_id: number } | undefined;
    db.prepare('UPDATE bundle SET cover_asset_id = ? WHERE id = ?').run(first?.asset_id ?? null, bundleId);
  }
  return getBundle(db, bundleId);
}

/** 拆组：成员留在库里当散件（不动素材本身） */
export function expandBundle(db: DatabaseSync, bundleId: number): { members: number } {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM bundle_member WHERE bundle_id = ?').get(bundleId) as { c: number }).c;
  db.prepare('DELETE FROM bundle_member WHERE bundle_id = ?').run(bundleId);
  db.prepare('DELETE FROM bundle WHERE id = ?').run(bundleId);
  return { members: count };
}

/**
 * 成员被删/被清空回收站之后的收尾：只剩 0 个或 1 个成员的组自动解散
 * （1 个成员的"组"是个空壳，留着只会让人困惑）。
 */
export function pruneBundles(db: DatabaseSync): { removed: number } {
  const rows = db
    .prepare('SELECT bundle_id, COUNT(*) AS c FROM bundle_member GROUP BY bundle_id HAVING c <= 1')
    .all() as Array<{ bundle_id: number }>;
  for (const row of rows) {
    db.prepare('DELETE FROM bundle_member WHERE bundle_id = ?').run(row.bundle_id);
    db.prepare('DELETE FROM bundle WHERE id = ?').run(row.bundle_id);
  }
  const orphans = db
    .prepare('SELECT id FROM bundle WHERE id NOT IN (SELECT bundle_id FROM bundle_member)')
    .all() as Array<{ id: number }>;
  for (const row of orphans) db.prepare('DELETE FROM bundle WHERE id = ?').run(row.id);
  return { removed: rows.length + orphans.length };
}
