import type { DatabaseSync } from 'node:sqlite';

/**
 * 整理项目库：按来源文件夹把素材归到「项目 + 子项目」，并给出标题可读化建议。
 *
 * 设计原则（对着 协作规则.md 与用户要求）：
 *  1. **先出方案再动手**：`planTidy` 只读，把要建哪些项目、哪些素材会挂进去、哪些标题会被改列清楚；
 *  2. **可撤销**：`applyTidy` 之前把每个素材原来的归属与标题记进 `tidy_journal`，
 *     `undoTidy` 能原样退回去——整理是元数据操作，绝不动磁盘文件；
 *  3. **不删除**：这里只创建项目与归属、改标题，任何删除都留给单独的人工确认。
 */

export interface TidyGroup {
  /** 分组名（来源文件夹顶层目录名，或兜底名） */
  name: string;
  assetIds: number[];
  byExt: Record<string, number>;
  bytes: number;
  /** 是否兜底分组（没有来源路径的那些） */
  fallback: boolean;
}

export interface TidyRename {
  assetId: number;
  from: string;
  to: string;
}

export interface TidyPlan {
  groups: TidyGroup[];
  renames: TidyRename[];
  /** 会被挂进项目的素材总数 */
  assets: number;
  fallbackName: string;
  parentProjectId: number | null;
  parentProjectName: string | null;
  createAsSubProject: boolean;
  prefixTitleWithGroup: boolean;
}

export interface TidyOptions {
  /** 建成这个项目的子项目；给 null 就都建成顶层项目 */
  parentProjectId?: number | null;
  fallbackName?: string;
  /** 标题是否加"分组名 · "前缀（「1」→「开头 · 1」） */
  prefixTitleWithGroup?: boolean;
}

interface AssetRow {
  id: number;
  title: string;
  ext: string | null;
  size: number | null;
  dp: string | null;
  refPath: string | null;
  refRoot: string | null;
}

/** 素材在磁盘上的可读来源路径（优先用户给的 display_path，其次引用型文件行） */
function sourceOf(row: AssetRow): string {
  return (row.dp || row.refPath || '').replace(/\\/g, '/');
}

/**
 * 分组名 = 素材所在目录名。
 * 关键是**相对哪个根**：直接按绝对路径切第一段会得到「C:」或「D:」这种没用的名字，
 * 所以先找它属于哪个已配置的来源根（取最长匹配），取根下面第一层目录；
 * 不在任何根下的，再退回"去掉盘符后的第一层目录"。
 */
function groupNameOf(row: AssetRow, fallbackName: string, knownRoots: string[]): string {
  const source = sourceOf(row);
  if (!source) return fallbackName;

  let relative = source;
  for (const root of knownRoots) {
    const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (source.toLowerCase().startsWith(normalized.toLowerCase() + '/')) {
      relative = source.slice(normalized.length + 1);
      break;
    }
  }
  if (relative === source) {
    // 不在任何根下：去掉盘符/开头的斜杠，避免把「C:」当目录名
    relative = relative.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
  }
  const segments = relative.split('/').filter(Boolean);
  if (segments.length <= 1) return fallbackName;
  return segments[0];
}

/** 标题是否"没有信息量"：纯数字、或就是文件名的通用词 */
function isWeakTitle(title: string): boolean {
  const clean = title.trim();
  if (clean === '') return true;
  if (/^\d+$/.test(clean)) return true;
  return ['场景', '对话概述', '完整', '图片', '视频', '未命名', '文档', '素材'].includes(clean);
}

export function planTidy(db: DatabaseSync, options: TidyOptions = {}): TidyPlan {
  const fallbackName = options.fallbackName?.trim() || '未分类';
  const parentProjectId = options.parentProjectId ?? null;
  const prefixTitleWithGroup = options.prefixTitleWithGroup !== false;

  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.ext, a.size, a.display_path AS dp,
              (SELECT sr.path || '/' || f.rel_path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
                WHERE f.asset_id = a.id AND sr.mode = 'referenced' LIMIT 1) AS refPath,
              (SELECT sr.path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
                WHERE f.asset_id = a.id AND sr.mode = 'referenced' LIMIT 1) AS refRoot
         FROM asset a WHERE a.deleted_at IS NULL
        ORDER BY a.id`,
    )
    .all() as AssetRow[];

  // 分组要"相对哪个根"才算得对：取最长匹配的已配置来源根，最短的放最后
  const knownRoots = (
    db.prepare("SELECT path FROM source_root WHERE mode = 'referenced' ORDER BY length(path) DESC").all() as Array<{ path: string }>
  ).map((entry) => entry.path);

  const groups = new Map<string, TidyGroup>();
  for (const row of rows) {
    const name = groupNameOf(row, fallbackName, knownRoots);
    let group = groups.get(name);
    if (!group) {
      group = { name, assetIds: [], byExt: {}, bytes: 0, fallback: name === fallbackName };
      groups.set(name, group);
    }
    group.assetIds.push(row.id);
    const ext = row.ext ?? '无后缀';
    group.byExt[ext] = (group.byExt[ext] ?? 0) + 1;
    group.bytes += row.size ?? 0;
  }

  const renames: TidyRename[] = [];
  if (prefixTitleWithGroup) {
    for (const row of rows) {
      if (!isWeakTitle(row.title)) continue;
      const name = groupNameOf(row, fallbackName, knownRoots);
      const next = `${name} · ${row.title.trim()}`;
      if (next !== row.title) renames.push({ assetId: row.id, from: row.title, to: next });
    }
  }

  const parent = parentProjectId
    ? (db.prepare('SELECT id, name FROM project WHERE id = ?').get(parentProjectId) as { id: number; name: string } | undefined)
    : undefined;

  return {
    groups: [...groups.values()].sort((a, b) => b.assetIds.length - a.assetIds.length),
    renames,
    assets: rows.length,
    fallbackName,
    parentProjectId,
    parentProjectName: parent?.name ?? null,
    createAsSubProject: parentProjectId !== null,
    prefixTitleWithGroup,
  };
}

export interface TidyResult {
  journalId: number;
  createdProjects: Array<{ id: number; name: string; parentId: number | null; assets: number }>;
  linkedAssets: number;
  renamed: number;
}

/**
 * 应用方案。写入前把"每个素材原来的归属与标题"记进 `tidy_journal`，所以可以整体撤销。
 * 只动元数据：不删除素材、不动磁盘文件。
 */
export function applyTidy(db: DatabaseSync, plan: TidyPlan, options: { only?: string[] } = {}): TidyResult {
  const now = new Date().toISOString();
  const picked = options.only ? plan.groups.filter((group) => options.only!.includes(group.name)) : plan.groups;
  if (picked.length === 0) throw new Error('没有选中任何分组');
  // 父项目必须真的存在：否则插入时会撞外键，报出来的是 "FOREIGN KEY constraint failed"（实测踩到，
  // 而且那次是误跑到了真实库上——虽然有外键挡着没写进去，但必须先自己校验并说人话）
  if (plan.parentProjectId !== null) {
    const parent = db.prepare('SELECT id, name FROM project WHERE id = ?').get(plan.parentProjectId) as
      | { id: number; name: string }
      | undefined;
    if (!parent) throw new Error(`父项目 #${plan.parentProjectId} 不存在，请先确认要挂到哪个项目下`);
  }

  const previous = new Map<number, { title: string; projects: number[] }>();
  for (const group of picked) {
    for (const assetId of group.assetIds) {
      if (previous.has(assetId)) continue;
      const row = db.prepare('SELECT title FROM asset WHERE id = ?').get(assetId) as { title: string } | undefined;
      const links = db.prepare('SELECT project_id FROM project_asset WHERE asset_id = ?').all(assetId) as Array<{ project_id: number }>;
      previous.set(assetId, { title: row?.title ?? '', projects: links.map((link) => link.project_id) });
    }
  }

  const insertProject = db.prepare(
    'INSERT INTO project (name, description, color, modality, parent_id, status, progress) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const created: TidyResult['createdProjects'] = [];
  let renamed = 0;

  for (const group of picked) {
    // 项目名在库里是全局唯一的（UNIQUE 索引）：先按名字找，找到就复用。
    // 早先只按"同名且同父级"找，遇到"同名但挂在不同父级下"就会硬插一条，
    // 结果撞 UNIQUE 报错（实测踩到）。
    const existing = db
      .prepare('SELECT id, parent_id AS parentId FROM project WHERE name = ?')
      .get(group.name) as { id: number; parentId: number | null } | undefined;
    let projectId: number;
    if (existing) {
      projectId = existing.id;
    } else {
      const res = insertProject.run(
        group.name,
        `由来源文件夹「${group.name}」自动归类（整理工具生成）`,
        'project-1',
        'mixed',
        plan.parentProjectId,
        now,
      );
      projectId = Number(res.lastInsertRowid);
    }
    for (const assetId of group.assetIds) {
      // 不覆盖已有归属：整理只负责把"没归属的"放进去，已有归属的补一层
      db.prepare('INSERT OR IGNORE INTO project_asset (project_id, asset_id, role, added_at) VALUES (?, ?, ?, ?)')
        .run(projectId, assetId, 'member', now);
    }
    created.push({ id: projectId, name: group.name, parentId: plan.parentProjectId, assets: group.assetIds.length });
  }

  for (const rename of plan.renames) {
    const inPicked = picked.some((group) => group.assetIds.includes(rename.assetId));
    if (!inPicked) continue;
    db.prepare('UPDATE asset SET title = ? WHERE id = ?').run(rename.to, rename.assetId);
    renamed += 1;
  }

  const journal = JSON.stringify({
    previous: [...previous.entries()].map(([assetId, value]) => ({ assetId, ...value })),
    createdProjects: created.map((project) => project.id),
  });
  const res = db.prepare('INSERT INTO tidy_journal (kind, payload_json, created_at) VALUES (?, ?, ?)')
    .run('tidy', journal, now);

  return { journalId: Number(res.lastInsertRowid), createdProjects: created, linkedAssets: previous.size, renamed };
}

/** 撤销一次整理：删掉当时新建的项目与归属，把标题改回去（不动素材本身） */
export function undoTidy(db: DatabaseSync, journalId: number): { restoredTitles: number; removedProjects: number } {
  const row = db.prepare('SELECT payload_json FROM tidy_journal WHERE id = ?').get(journalId) as
    | { payload_json: string }
    | undefined;
  if (!row) throw new Error('找不到这次整理的记录');
  const payload = JSON.parse(row.payload_json) as {
    previous: Array<{ assetId: number; title: string; projects: number[] }>;
    createdProjects: number[];
  };

  let restoredTitles = 0;
  for (const entry of payload.previous) {
    db.prepare('UPDATE asset SET title = ? WHERE id = ?').run(entry.title, entry.assetId);
    restoredTitles += 1;
  }
  let removedProjects = 0;
  for (const projectId of payload.createdProjects) {
    // 先把这次加进去的归属摘掉，再删项目（项目下若还有别的素材就保留项目）
    const links = db.prepare('SELECT asset_id FROM project_asset WHERE project_id = ?').all(projectId) as Array<{ asset_id: number }>;
    const touched = new Set(payload.previous.map((entry) => entry.assetId));
    for (const link of links) {
      if (touched.has(link.asset_id)) {
        db.prepare('DELETE FROM project_asset WHERE project_id = ? AND asset_id = ?').run(projectId, link.asset_id);
      }
    }
    const left = (db.prepare('SELECT COUNT(*) AS c FROM project_asset WHERE project_id = ?').get(projectId) as { c: number }).c;
    const children = (db.prepare('SELECT COUNT(*) AS c FROM project WHERE parent_id = ?').get(projectId) as { c: number }).c;
    if (left === 0 && children === 0) {
      db.prepare('DELETE FROM project WHERE id = ?').run(projectId);
      removedProjects += 1;
    }
  }
  db.prepare('DELETE FROM tidy_journal WHERE id = ?').run(journalId);
  return { restoredTitles, removedProjects };
}
