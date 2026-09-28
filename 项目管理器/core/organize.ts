/**
 * 组织与标注：项目、生成模型、以及"添加素材"（把外部文件或一段文本收进库）。
 *
 * 设计约束（对齐参考设计）：
 *  - 一个素材同时只属于一个项目（卡片上只显示一个项目），改挂即移动；
 *  - 项目带标记色（project-1..4）与主要类型（modality）；
 *  - 手动标注的生成模型不能被重扫覆盖。
 */
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { LIBRARY_DIR, thumbPathForHash, type LibraryConfig } from './config.ts';
import { classify, isTextExt, modalityOf, refineKind, type Kind, type Modality } from './kind.ts';
import { hashFile } from './hash.ts';
import { readExcerpt } from './excerpt.ts';
import { makeImageThumb, makeVideoThumb, probe } from './ffmpeg.ts';
import { restoreAsset, trashAsset, upsertFts } from './maintenance.ts';
import {
  OBJECTS_DIR, copyIntoLibrary, ensureLibraryLayout, loadLibraryMeta, objectRelPath, sidecarPathOf, writeSidecar,
} from './library.ts';
import { ensureRoot } from './db.ts';

export const PROJECT_COLORS = ['project-1', 'project-2', 'project-3', 'project-4'];

export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  color: string;
  modality: Modality;
  /** 上级项目；null 表示顶层项目 */
  parentId: number | null;
  /** 只属于本项目自己的素材数 */
  count: number;
  /** 本项目 + 所有子项目的素材数（去重） */
  totalCount: number;
  trashCount: number;
  /** 直接子项目数 */
  childCount: number;
}

/**
 * 项目树的查询。
 *
 * `tree` 这个递归 CTE 把每个项目映射到它的根（root, id），
 * 于是"含子项目的素材数"可以在同一条 SQL 里算出来，
 * 不必在应用层递归发 N 次查询。
 */
const PROJECT_SELECT = `
WITH RECURSIVE tree(root, id) AS (
  SELECT id, id FROM project
  UNION ALL
  SELECT t.root, c.id FROM project c JOIN tree t ON c.parent_id = t.id
)
SELECT p.id, p.name, p.description, COALESCE(p.color, 'project-1') AS color,
       COALESCE(p.modality, 'mixed') AS modality, p.parent_id AS parentId,
       (SELECT COUNT(*) FROM project_asset pa JOIN asset a ON a.id = pa.asset_id
         WHERE pa.project_id = p.id AND a.deleted_at IS NULL) AS count,
       (SELECT COUNT(DISTINCT pa.asset_id) FROM project_asset pa JOIN asset a ON a.id = pa.asset_id
         JOIN tree t ON t.id = pa.project_id
         WHERE t.root = p.id AND a.deleted_at IS NULL) AS totalCount,
       (SELECT COUNT(*) FROM project_asset pa JOIN asset a ON a.id = pa.asset_id
         WHERE pa.project_id = p.id AND a.deleted_at IS NOT NULL) AS trashCount,
       (SELECT COUNT(*) FROM project c2 WHERE c2.parent_id = p.id) AS childCount
  FROM project p ORDER BY p.id`;

export function listProjects(db: DatabaseSync): ProjectRow[] {
  return db.prepare(PROJECT_SELECT).all() as unknown as ProjectRow[];
}

/**
 * 一个项目及其所有后代的 id（含自身）。
 * 选中父项目时用它把子项目的素材一起查出来——否则"父项目看起来是空的"，
 * 和"分了小项目"这个用法直接冲突。
 */
export function projectScopeIds(db: DatabaseSync, id: number): number[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM project WHERE id = ?
         UNION ALL SELECT c.id FROM project c JOIN tree t ON c.parent_id = t.id
       )
       SELECT id FROM tree`,
    )
    .all(id) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * 重命名项目：只改名字 —— 不动素材、不动归属、不写回收站、不碰 display_path（那是来源路径）。
 * 项目名在库里是全局唯一，因此空名/超长/重名都拒绝并给出可读原因。
 */
export function renameProject(db: DatabaseSync, id: number, rawName: string): { id: number; oldName: string; name: string } {
  const name = rawName.trim();
  if (!name) throw new Error('项目名称不能为空');
  if (name.length > 60) throw new Error('项目名称最多 60 个字');
  const current = db.prepare('SELECT id, name FROM project WHERE id = ?').get(id) as { id: number; name: string } | undefined;
  if (!current) throw new Error('项目不存在');
  if (current.name === name) return { id, oldName: current.name, name };
  const clash = db.prepare('SELECT id FROM project WHERE name = ? AND id <> ?').get(name, id) as { id: number } | undefined;
  if (clash) throw new Error(`已有同名项目：${name}`);
  db.prepare('UPDATE project SET name = ? WHERE id = ?').run(name, id);
  return { id, oldName: current.name, name };
}

export function createProject(
  db: DatabaseSync,
  input: { name: string; description?: string; color?: string; modality?: Modality; parentId?: number | null },
): ProjectRow {
  const name = input.name.trim();
  if (!name) throw new Error('项目名称不能为空');
  const color = PROJECT_COLORS.includes(input.color ?? '') ? (input.color as string) : PROJECT_COLORS[0]!;
  const modality = input.modality ?? 'mixed';
  const parentId = input.parentId ?? null;
  if (parentId !== null) {
    const parent = db.prepare('SELECT id FROM project WHERE id = ?').get(parentId) as { id: number } | undefined;
    if (!parent) throw new Error('上级项目不存在');
  }
  const res = db
    .prepare('INSERT INTO project (name, description, color, modality, parent_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, input.description?.trim() ?? '', color, modality, parentId);
  const id = Number(res.lastInsertRowid);
  const found = listProjects(db).find((project) => project.id === id);
  if (!found) throw new Error('创建项目后未能读回');
  return found;
}

/**
 * 删除项目：项目连同它的所有子项目一起删，**项目里的素材全部移入回收站**。
 *
 * 为什么素材要进回收站而不是"变成未归档"：用户对"删掉这个项目"的心智是
 * "这个项目连同它的东西一起先收起来"，所以必须可恢复。因此这里复用 trashAsset——
 * 托管对象移到 trash/，引用型素材只摘索引、磁盘原文件一律不动。
 */
export function deleteProject(
  db: DatabaseSync,
  id: number,
): { removed: number; removedChildren: number; trashedAssets: number; movedObjects: number; referencedLeftAlone: number } {
  const ids = projectScopeIds(db, id);
  if (ids.length === 0) throw new Error('项目不存在');
  const placeholders = ids.map(() => '?').join(',');

  // 先把"这个项目原本是什么样、装了哪些素材"记下来，才能整项目恢复
  // （素材自己只知道被删了，不知道原来挂在哪个项目下）
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.color, p.modality, p.parent_id, parent.name AS parent_name
         FROM project p LEFT JOIN project parent ON parent.id = p.parent_id
        WHERE p.id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
      id: number; name: string; description: string | null; color: string | null;
      modality: string | null; parent_id: number | null; parent_name: string | null;
    }>;
  const now = new Date().toISOString();
  for (const project of projects) {
    const members = db
      .prepare('SELECT asset_id FROM project_asset WHERE project_id = ?')
      .all(project.id) as Array<{ asset_id: number }>;
    const res = db
      .prepare(
        `INSERT INTO trash_project (project_id, name, description, color, modality, parent_name, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project.id, project.name, project.description, project.color, project.modality, project.parent_name, now);
    const trashId = Number(res.lastInsertRowid);
    for (const member of members) {
      db.prepare('INSERT OR IGNORE INTO trash_project_asset (trash_project_id, asset_id) VALUES (?, ?)')
        .run(trashId, member.asset_id);
    }
  }

  const rows = db
    .prepare(`SELECT DISTINCT asset_id AS id FROM project_asset WHERE project_id IN (${placeholders})`)
    .all(...ids) as Array<{ id: number }>;

  let trashedAssets = 0;
  let movedObjects = 0;
  let referencedLeftAlone = 0;
  for (const row of rows) {
    const report = trashAsset(db, row.id);
    if (report.alreadyTrashed) continue;
    trashedAssets++;
    movedObjects += report.movedObjects.length;
    referencedLeftAlone += report.referencedLeftAlone;
  }

  db.prepare(`DELETE FROM project_asset WHERE project_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM project WHERE id IN (${placeholders})`).run(...ids);
  // removed 用 ids.length 而不是 run().changes：
  // parent_id 上的 ON DELETE CASCADE 会在删父项目时先把子项目带走，
  // 于是那条 DELETE 自己只"亲自"删掉了 1 行，changes 会低报（实测踩到）。
  return { removed: ids.length, removedChildren: ids.length - 1, trashedAssets, movedObjects, referencedLeftAlone };
}

export interface TrashProjectRow {
  trashId: number;
  name: string;
  color: string;
  modality: string;
  parentName: string | null;
  deletedAt: string;
  /** 记下来的成员总数 */
  total: number;
  /** 其中仍在回收站里、可以恢复的件数 */
  restorable: number;
}

/** 回收站里可以整项目恢复的项目（按删除时间倒序） */
export function listTrashProjects(db: DatabaseSync): TrashProjectRow[] {
  const rows = db
    .prepare(
      `SELECT t.id AS trashId, t.name, COALESCE(t.color, 'project-1') AS color, COALESCE(t.modality, 'mixed') AS modality,
              t.parent_name AS parentName, t.deleted_at AS deletedAt,
              (SELECT COUNT(*) FROM trash_project_asset ta WHERE ta.trash_project_id = t.id) AS total,
              (SELECT COUNT(*) FROM trash_project_asset ta JOIN asset a ON a.id = ta.asset_id
                WHERE ta.trash_project_id = t.id AND a.deleted_at IS NOT NULL) AS restorable
         FROM trash_project t ORDER BY t.deleted_at DESC, t.id DESC`,
    )
    .all() as TrashProjectRow[];
  return rows;
}

/**
 * 整项目恢复：把项目重建出来、把还在回收站里的素材恢复并挂回去。
 * 已经不在回收站里的（用户单独恢复过、或清空回收站时删了）跳过，不去猜。
 */
export function restoreTrashProject(
  db: DatabaseSync,
  trashId: number,
): { projectId: number; name: string; restored: number; skipped: number } {
  const project = db
    .prepare('SELECT id, name, description, color, modality FROM trash_project WHERE id = ?')
    .get(trashId) as { id: number; name: string; description: string | null; color: string | null; modality: string | null } | undefined;
  if (!project) throw new Error('这条可恢复项目记录不存在');

  const created = createProject(db, {
    name: project.name,
    description: project.description ?? undefined,
    color: project.color ?? undefined,
    modality: (project.modality ?? 'mixed') as Modality,
  });

  const members = db
    .prepare('SELECT asset_id FROM trash_project_asset WHERE trash_project_id = ?')
    .all(trashId) as Array<{ asset_id: number }>;
  let restored = 0;
  let skipped = 0;
  for (const member of members) {
    const row = db.prepare('SELECT deleted_at FROM asset WHERE id = ?').get(member.asset_id) as
      | { deleted_at: string | null }
      | undefined;
    if (!row) { skipped++; continue; }
    if (row.deleted_at !== null) {
      restoreAsset(db, member.asset_id);
      restored++;
    } else {
      skipped++;
    }
    setAssetProject(db, member.asset_id, created.id);
  }
  db.prepare('DELETE FROM trash_project WHERE id = ?').run(trashId);
  return { projectId: created.id, name: created.name, restored, skipped };
}

/** 一个素材只属于一个项目：先清掉旧关系再挂新的；projectId 为 null 表示移出项目 */
export function setAssetProject(db: DatabaseSync, assetId: number, projectId: number | null): { projectId: number | null } {
  db.prepare('DELETE FROM project_asset WHERE asset_id = ?').run(assetId);
  if (projectId !== null) {
    const project = db.prepare('SELECT id FROM project WHERE id = ?').get(projectId) as { id: number } | undefined;
    if (!project) throw new Error('项目不存在');
    db.prepare('INSERT INTO project_asset (project_id, asset_id, role, added_at) VALUES (?, ?, ?, ?)').run(
      projectId, assetId, 'member', new Date().toISOString(),
    );
  }
  return { projectId };
}

/** 标注生成模型；索引同步更新，保证能按模型搜到 */
export interface AssetMetaInput {
  model?: string;
  /** 提示词正文（适合没存成文本文件的图/视频） */
  prompt?: string;
  /** 来源标记：ai = AI 生成，real = 非 AI（实拍/素材站等），other = 其他；空串表示清除 */
  origin?: string;
  /** 关联一件作为提示词的文本素材（0 或 null 表示清除关联） */
  promptAssetId?: number | null;
  /** 生成参数（种子/步数/参考图等，自由文本，按行写） */
  params?: string;
  /** 只对调用方有效：把这次改动应用到同一组的其他成员（一次生成的同批内容） */
  applyToBundle?: boolean;
}

/** 更新素材的生成信息：模型、提示词、来源标记、关联提示词素材 */
export function updateAssetMeta(db: DatabaseSync, assetId: number, input: AssetMetaInput): AssetMetaInput {
  const row = db
    .prepare(
      `SELECT a.title, a.kind, a.note, COALESCE(a.display_path, '') AS display_path
         FROM asset a WHERE a.id = ?`,
    )
    .get(assetId) as { title: string; kind: string; note: string | null; display_path: string } | undefined;
  if (!row) throw new Error('素材不存在');

  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const out: AssetMetaInput = {};

  if (input.model !== undefined) {
    const value = input.model.trim();
    sets.push('model = ?'); values.push(value || null); out.model = value;
  }
  if (input.prompt !== undefined) {
    const value = input.prompt.trim();
    sets.push('prompt = ?'); values.push(value || null); out.prompt = value;
  }
  if (input.origin !== undefined) {
    const value = input.origin.trim();
    sets.push('origin = ?'); values.push(value || null); out.origin = value;
  }
  if (input.params !== undefined) {
    const value = input.params.trim();
    sets.push('params = ?'); values.push(value || null); out.params = value;
  }
  if (input.promptAssetId !== undefined) {
    let value: number | null = input.promptAssetId && input.promptAssetId > 0 ? Number(input.promptAssetId) : null;
    if (value !== null) {
      const exists = db.prepare('SELECT id FROM asset WHERE id = ?').get(value) as { id: number } | undefined;
      if (!exists) throw new Error('要关联的提示词素材不存在');
      if (value === assetId) throw new Error('不能把素材关联到它自己');
    }
    sets.push('prompt_asset_id = ?'); values.push(value); out.promptAssetId = value;
  }
  if (sets.length === 0) return out;

  db.prepare(`UPDATE asset SET ${sets.join(', ')} WHERE id = ?`).run(...values, assetId);
  // 提示词与来源要能被搜到：重新写一遍全文索引（upsertFts 会从库里读最新值）
  upsertFts(db, assetId, row.title, row.display_path, row.note ?? '', out.model ?? '', row.kind);
  return out;
}

/** 把同一组的成员一起应用这次生成信息（一次生成的多件内容共享提示词/参数/来源） */
export function updateAssetMetaForBundle(db: DatabaseSync, assetId: number, input: AssetMetaInput): { updated: number } {
  const member = db.prepare('SELECT bundle_id FROM bundle_member WHERE asset_id = ?').get(assetId) as
    | { bundle_id: number }
    | undefined;
  const result = updateAssetMeta(db, assetId, input);
  if (!member) return { updated: result ? 1 : 0 };
  const members = db.prepare('SELECT asset_id FROM bundle_member WHERE bundle_id = ? AND asset_id <> ?')
    .all(member.bundle_id, assetId) as Array<{ asset_id: number }>;
  const shared: AssetMetaInput = { prompt: input.prompt, origin: input.origin, params: input.params, model: input.model };
  for (const row of members) updateAssetMeta(db, row.asset_id, shared);
  return { updated: members.length + 1 };
}

/** 只改生成模型（保留旧入口，内部走 updateAssetMeta） */
export function updateAssetModel(db: DatabaseSync, assetId: number, model: string): { model: string } {
  const result = updateAssetMeta(db, assetId, { model });
  return { model: result.model ?? '' };
}

export interface ImportExternalResult {
  assetId: number;
  hash: string;
  kind: string;
  deduped: boolean;
  title: string;
}

/**
 * 把一个外部文件（浏览器上传的临时文件，或一段写出来的文本）收进库。
 * 走的是和 importToLibrary 完全相同的落地方式：内容寻址 + sidecar + 缩略图，
 * 所以上传进来的素材和扫描进来的素材此后没有区别。
 */
export async function importExternalFile(
  db: DatabaseSync,
  cfg: LibraryConfig,
  input: {
    tempPath: string; originalName: string; title?: string; model?: string; projectId?: number | null;
    /** 人能认出来的来源路径（浏览模式导入时给绝对路径，比文件名有用） */
    displayPath?: string;
    /** 浏览模式导入：额外把原文件记成一条引用型文件行，这样浏览器里能显示"已在库内" */
    trackSourcePath?: boolean;
  },
): Promise<ImportExternalResult> {
  ensureLibraryLayout();
  loadLibraryMeta();
  const managedRootId = ensureRoot(db, OBJECTS_DIR, 'managed');

  const ext = extname(input.originalName).toLowerCase();
  const base = basename(input.originalName, extname(input.originalName));
  const title = (input.title ?? '').trim() || base;
  const hash = await hashFile(input.tempPath);
  if (!hash) throw new Error('无法计算文件哈希（文件为空或过大）');

  let kind = classify(input.originalName);
  let metaJson: string | null = null;
  let capturedAt: string | null = null;
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'music') {
    const probed = await probe(input.tempPath, cfg.ffmpegDir);
    if (probed) {
      kind = refineKind(kind, probed);
      capturedAt = probed.tags['creation_time'] ?? probed.tags['date'] ?? null;
      metaJson = JSON.stringify({
        durationSec: probed.durationSec, width: probed.width, height: probed.height,
        videoCodec: probed.videoCodec, audioCodec: probed.audioCodec, bitrate: probed.bitrate,
        formatName: probed.formatName, tags: probed.tags,
      });
    }
  }
  const excerpt = isTextExt(ext) ? readExcerpt(input.tempPath) : null;

  const { copied, objectPath } = copyIntoLibrary(input.tempPath, hash, ext);
  const objectSize = existsSync(objectPath) ? statSync(objectPath).size : 0;
  if (copied) {
    writeSidecar(sidecarPathOf(objectPath), {
      schema: 1, hash, hashAlgo: 'sha256', ext, kind, title,
      size: objectSize,
      capturedAt, importedAt: new Date().toISOString(), rating: null, note: '',
      tags: [], projects: [], meta: metaJson ? (JSON.parse(metaJson) as unknown) : null,
      source: { rootPath: '(上传)', relPath: input.originalName },
      model: input.model?.trim() || null,
      excerpt,
    });
  }

  const relPath = objectRelPath(hash, ext);
  const existing = db.prepare('SELECT id FROM asset WHERE hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as
    | { id: number }
    | undefined;

  let assetId: number;
  if (existing) {
    assetId = existing.id;
  } else {
    const res = db
      .prepare(
        `INSERT INTO asset (kind, title, ext, size, hash, hash_algo, captured_at, imported_at, meta_json, display_path, model, excerpt)
         VALUES (?, ?, ?, ?, ?, 'sha256', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind, title, ext, objectSize, hash, capturedAt,
        new Date().toISOString(), metaJson, input.displayPath ?? input.originalName, input.model?.trim() || null, excerpt,
      );
    assetId = Number(res.lastInsertRowid);
  }

  const already = db.prepare('SELECT id FROM file WHERE source_root_id = ? AND rel_path = ?').get(managedRootId, relPath) as
    | { id: number }
    | undefined;
  if (!already) {
    db.prepare(
      `INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, size, mtime, status, thumb_at, probed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?)`,
    ).run(
      assetId, managedRootId, relPath, objectPath, objectSize,
      statSync(objectPath).mtime.toISOString(), null, new Date().toISOString(),
    );
  }

  // 缩略图（图片/视频）
  if (kind === 'image' || kind === 'video') {
    const thumbPath = thumbPathForHash(hash);
    if (!existsSync(thumbPath)) {
      if (!existsSync(join(LIBRARY_DIR, 'derived', 'thumbs'))) mkdirSync(join(LIBRARY_DIR, 'derived', 'thumbs'), { recursive: true });
      const ok = kind === 'image'
        ? await makeImageThumb(objectPath, thumbPath, cfg.ffmpegDir)
        : await makeVideoThumb(objectPath, thumbPath, cfg.ffmpegDir);
      if (ok) db.prepare('UPDATE file SET thumb_at = ? WHERE asset_id = ?').run(new Date().toISOString(), assetId);
    } else {
      db.prepare('UPDATE file SET thumb_at = ? WHERE asset_id = ?').run(new Date().toISOString(), assetId);
    }
  }

  const modelRow = db.prepare('SELECT model FROM asset WHERE id = ?').get(assetId) as { model: string | null } | undefined;
  upsertFts(db, assetId, title, input.displayPath ?? input.originalName, '', modelRow?.model ?? '', kind);

  // 浏览模式导入的：把"原文件"也记成一条引用型文件行。
  // 不记的话浏览器那边就永远显示"未入库"（索引里根本没有那个路径），
  // 而且用户在原目录里看到的东西和库里的关联就断了。扫描进来的素材本来就是这么记的。
  if (input.trackSourcePath && isAbsolute(input.tempPath) && existsSync(input.tempPath)) {
    const dir = dirname(input.tempPath);
    const rootId = ensureRoot(db, dir, 'referenced');
    const relName = basename(input.tempPath);
    const alreadyRef = db
      .prepare('SELECT id FROM file WHERE source_root_id = ? AND rel_path = ?')
      .get(rootId, relName) as { id: number } | undefined;
    if (!alreadyRef) {
      const st = statSync(input.tempPath);
      db.prepare(
        `INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, size, mtime, status, thumb_at, probed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'present', NULL, ?)`,
      ).run(assetId, rootId, relName, input.tempPath, st.size, st.mtime.toISOString(), new Date().toISOString());
    }
  }

  if (input.projectId) setAssetProject(db, assetId, input.projectId);

  return { assetId, hash, kind, deduped: Boolean(existing) || !copied, title };
}

/** 把一段文本/代码收进库（"添加素材"里直接粘贴内容的路径） */
export async function importTextAsset(
  db: DatabaseSync,
  cfg: LibraryConfig,
  input: { title: string; body: string; ext?: string; model?: string; projectId?: number | null; modality?: Modality },
): Promise<ImportExternalResult> {
  const title = input.title.trim();
  if (!title) throw new Error('标题不能为空');
  const body = input.body ?? '';
  if (!body.trim()) throw new Error('内容不能为空');
  const ext = input.ext ?? (input.modality === 'code' ? '.txt' : '.md');
  const tmpDir = join(LIBRARY_DIR, '.tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tempPath = join(tmpDir, `${Date.now()}-${Buffer.from(title).toString('hex').slice(0, 24)}${ext}`);
  writeFileSync(tempPath, body, 'utf8');
  try {
    return await importExternalFile(db, cfg, {
      tempPath,
      originalName: `${title}${ext}`,
      title,
      model: input.model,
      projectId: input.projectId,
    });
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export interface SaveTextResult {
  assetId: number;
  hash: string;
  size: number;
  /** 保存后一共有几个版本（含当前） */
  versions: number;
  /** 是否把内容同时写回了磁盘上的原文件 */
  wroteOriginal: boolean;
  /** 原文件写回失败时的原因（库内新版本已经存好了） */
  originalError: string | null;
}

/**
 * 保存文本/代码的编辑结果。
 *
 * 语义（用户确认过）：**默认存成新版本**——用新内容生成一个新对象（内容寻址天然去重），
 * 把当前托管文件行指向它，旧内容记进 asset_version 留着可回退。
 * 这样"对象路径 = 内容哈希"的契约不会被原地改写破坏。
 *
 * 「写回原文件」是**可选**的：只在素材存在引用型文件行时才有意义，
 * 顺序上先落库内新版本、再写原文件——即使写原文件失败，库里也已经有新版本了。
 */
export async function saveTextVersion(
  db: DatabaseSync,
  cfg: LibraryConfig,
  input: { assetId: number; body: string; writeOriginal?: boolean },
): Promise<SaveTextResult> {
  const asset = db
    .prepare('SELECT id, title, ext, hash, size, kind, display_path FROM asset WHERE id = ? AND deleted_at IS NULL')
    .get(input.assetId) as
    | { id: number; title: string; ext: string | null; hash: string | null; size: number | null; kind: Kind; display_path: string | null }
    | undefined;
  if (!asset) throw new Error('素材不存在或已在回收站');
  const ext = asset.ext ?? '.txt';
  if (!isTextExt(ext)) throw new Error(`这个类型不支持在软件内编辑：${ext}`);

  ensureLibraryLayout();
  loadLibraryMeta();
  const managedRootId = ensureRoot(db, OBJECTS_DIR, 'managed');

  const tmpDir = join(LIBRARY_DIR, '.tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const tempPath = join(tmpDir, `edit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`);
  writeFileSync(tempPath, input.body, 'utf8');

  let hash: string;
  let objectPath: string;
  try {
    const computed = await hashFile(tempPath);
    if (!computed) throw new Error('无法计算内容哈希');
    hash = computed;
    const copied = copyIntoLibrary(tempPath, hash, ext);
    objectPath = copied.objectPath;
  } finally {
    rmSync(tempPath, { force: true });
  }

  const size = existsSync(objectPath) ? statSync(objectPath).size : Buffer.byteLength(input.body, 'utf8');
  const previousHash = asset.hash;
  const previousSize = asset.size;
  const now = new Date().toISOString();

  // 旧内容进版本表（当前内容也记一条，便于回退时知道有哪些内容可选）
  const remember = (value: string | null, valueSize: number | null): void => {
    if (!value) return;
    db.prepare(
      `INSERT OR IGNORE INTO asset_version (asset_id, hash, ext, size, saved_at, note) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(asset.id, value, ext, valueSize, now, null);
  };
  remember(previousHash, previousSize);

  const relPath = objectRelPath(hash, ext);

  // 当前托管文件行指向新对象；没有托管行（纯引用型素材）就补一条
  const managedRow = db
    .prepare(
      `SELECT f.id FROM file f JOIN source_root sr ON sr.id = f.source_root_id
        WHERE f.asset_id = ? AND sr.mode = 'managed' AND f.status = 'present' ORDER BY f.id DESC LIMIT 1`,
    )
    .get(asset.id) as { id: number } | undefined;
  const mtime = statSync(objectPath).mtime.toISOString();
  if (managedRow) {
    db.prepare('UPDATE file SET rel_path = ?, abs_path = ?, size = ?, mtime = ? WHERE id = ?')
      .run(relPath, objectPath, size, mtime, managedRow.id);
  } else {
    db.prepare(
      `INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, size, mtime, status, thumb_at, probed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'present', NULL, ?)`,
    ).run(asset.id, managedRootId, relPath, objectPath, size, mtime, now);
  }

  // sidecar 跟着新对象写一份（下次 rebuild 能从它恢复出这条素材）
  writeSidecar(sidecarPathOf(objectPath), {
    schema: 1, hash, hashAlgo: 'sha256', ext, kind: asset.kind, title: asset.title, size,
    capturedAt: null, importedAt: now, rating: null, note: '',
    tags: [], projects: [], meta: null,
    source: { rootPath: '(编辑保存)', relPath: asset.display_path ?? `${asset.title}${ext}` },
    model: (db.prepare('SELECT model FROM asset WHERE id = ?').get(asset.id) as { model: string | null } | undefined)?.model ?? null,
    excerpt: readExcerpt(objectPath),
  });

  const excerpt = readExcerpt(objectPath);
  db.prepare('UPDATE asset SET hash = ?, size = ?, excerpt = ? WHERE id = ?').run(hash, size, excerpt, asset.id);
  remember(hash, size);
  // 只保留上一版：删冗余的当前版与更老的历史版，并回收无人引用的对象
  pruneVersions(db, asset.id);
  const kindRow = db.prepare('SELECT kind, note, model FROM asset WHERE id = ?').get(asset.id) as { kind: Kind; note: string | null; model: string | null };
  upsertFts(db, asset.id, asset.title, asset.display_path ?? '', kindRow.note ?? '', kindRow.model ?? '', kindRow.kind);

  // 可选：写回磁盘上的原文件（放在库内新版本之后，失败也不影响已经保存的新版本）
  let wroteOriginal = false;
  let originalError: string | null = null;
  if (input.writeOriginal) {
    const referenced = db
      .prepare(
        `SELECT f.id, f.abs_path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
          WHERE f.asset_id = ? AND sr.mode = 'referenced' AND f.status = 'present' ORDER BY f.id LIMIT 1`,
      )
      .get(asset.id) as { id: number; abs_path: string } | undefined;
    if (!referenced) {
      originalError = '这条素材没有引用型原文件（只有库内托管副本），没有可以写回的文件';
    } else {
      try {
        writeFileSync(referenced.abs_path, input.body, 'utf8');
        const st = statSync(referenced.abs_path);
        db.prepare('UPDATE file SET size = ?, mtime = ? WHERE id = ?').run(st.size, st.mtime.toISOString(), referenced.id);
        wroteOriginal = true;
      } catch (err) {
        originalError = (err as Error).message;
      }
    }
  }

  const versions = (db.prepare('SELECT COUNT(*) AS c FROM asset_version WHERE asset_id = ?').get(asset.id) as { c: number }).c;
  return { assetId: asset.id, hash, size, versions, wroteOriginal, originalError };
}

/**
 * 版本保留策略：**每个素材只保留上一版**（用户要求）。
 *  - 先删掉"当前内容"那条冗余版本行（当前内容就是素材本身，不必再存一份）；
 *  - 再只留最近 1 条历史版本，更老的版本行删除；
 *  - 被删版本的对象若已无人引用（不是任何素材的当前内容、不在任何版本行、不在任何文件行），
 *    就连同 sidecar 一起回收 —— 内容寻址下同一份内容只存一份，所以这里必须按哈希判断，不能盲删。
 */
export function pruneVersions(db: DatabaseSync, assetId: number, keep = 1): { dropped: number; removedObjects: number } {
  const current = (db.prepare('SELECT hash FROM asset WHERE id = ?').get(assetId) as { hash: string | null } | undefined)?.hash ?? null;
  if (current) db.prepare('DELETE FROM asset_version WHERE asset_id = ? AND hash = ?').run(assetId, current);
  const rows = db.prepare('SELECT id, hash, ext FROM asset_version WHERE asset_id = ? ORDER BY saved_at DESC, id DESC').all(assetId) as Array<{ id: number; hash: string; ext: string | null }>;
  const drop = rows.slice(Math.max(keep, 0));
  let removedObjects = 0;
  for (const row of drop) {
    db.prepare('DELETE FROM asset_version WHERE id = ?').run(row.id);
    const usedByAsset = db.prepare('SELECT 1 AS ok FROM asset WHERE hash = ? LIMIT 1').get(row.hash);
    const usedByVersion = db.prepare('SELECT 1 AS ok FROM asset_version WHERE hash = ? LIMIT 1').get(row.hash);
    const usedByFile = db.prepare('SELECT 1 AS ok FROM file WHERE abs_path LIKE ? LIMIT 1').get('%' + row.hash + '%');
    if (usedByAsset || usedByVersion || usedByFile) continue;
    const objectPath = join(OBJECTS_DIR, objectRelPath(row.hash, row.ext ?? '.txt'));
    const sidecar = sidecarPathOf(objectPath);
    try { if (existsSync(objectPath)) { rmSync(objectPath, { force: true }); removedObjects += 1; } if (existsSync(sidecar)) rmSync(sidecar, { force: true }); } catch { /* 回收失败不影响保存 */ }
  }
  return { dropped: drop.length, removedObjects };
}

/** 版本历史（新的在前），含"哪一版是当前内容" */
export function listAssetVersions(
  db: DatabaseSync,
  assetId: number,
): Array<{ hash: string; size: number | null; savedAt: string; current: boolean }> {
  const currentHash = (db.prepare('SELECT hash FROM asset WHERE id = ?').get(assetId) as { hash: string | null } | undefined)?.hash ?? null;
  const rows = db
    .prepare('SELECT hash, size, saved_at FROM asset_version WHERE asset_id = ? ORDER BY saved_at DESC, id DESC')
    .all(assetId) as Array<{ hash: string; size: number | null; saved_at: string }>;
  return rows.map((row) => ({ hash: row.hash, size: row.size, savedAt: row.saved_at, current: row.hash === currentHash }));
}

export function modalityCounts(db: DatabaseSync): Array<{ modality: Modality; count: number }> {  const rows = db
    .prepare('SELECT kind, COUNT(*) AS count FROM asset WHERE deleted_at IS NULL GROUP BY kind')
    .all() as Array<{ kind: Kind; count: number }>;
  const totals = new Map<Modality, number>();
  for (const row of rows) {
    const modality = modalityOf(row.kind);
    totals.set(modality, (totals.get(modality) ?? 0) + row.count);
  }
  return [...totals.entries()].map(([modality, count]) => ({ modality, count }));
}

/**
 * 回填文本/代码摘要。
 * 为什么需要单独做：增量扫描会跳过"大小与 mtime 未变"的文件，
 * 所以后来才加的 excerpt 字段不会因为重扫而补齐。
 */
export function backfillExcerpts(db: DatabaseSync): { checked: number; filled: number } {
  const rows = db
    .prepare(
      `SELECT a.id, a.ext, f.abs_path
         FROM asset a
         JOIN file f ON f.id = (
           SELECT f2.id FROM file f2 JOIN source_root sr2 ON sr2.id = f2.source_root_id
            WHERE f2.asset_id = a.id AND f2.status = 'present'
            ORDER BY CASE WHEN sr2.mode = 'managed' THEN 0 ELSE 1 END, f2.id LIMIT 1
         )
        WHERE a.deleted_at IS NULL AND a.excerpt IS NULL`,
    )
    .all() as Array<{ id: number; ext: string; abs_path: string }>;

  let filled = 0;
  const update = db.prepare('UPDATE asset SET excerpt = ? WHERE id = ?');
  for (const row of rows) {
    if (!isTextExt(row.ext) || !existsSync(row.abs_path)) continue;
    const excerpt = readExcerpt(row.abs_path);
    if (excerpt) {
      update.run(excerpt, row.id);
      filled++;
    }
  }
  return { checked: rows.length, filled };
}
