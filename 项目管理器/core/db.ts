import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { DB_FILE, ensureLibraryDirs } from './config.ts';

/**
 * SQLite 访问层。用 Node 22 内置的 node:sqlite，避免 better-sqlite3 的原生模块依赖
 * （打包阶段少一个 ABI 坑，见开发建议 §13.2）。
 *
 * 已知限制（写进验证记录，不隐瞒）：
 *  - node:sqlite 内置 SQLite 版本为 3.51.2，低于 WAL-reset 修复版 3.51.3。
 *    该缺陷需要「两个连接同时写/checkpoint」才会触发；本项目单进程单连接单写者，
 *    触发条件不成立。M1 若引入多进程写入，必须升级到 ≥3.51.3 或改回 better-sqlite3。
 *  - 用独立 FTS5 表（不是 external content）：M0 优先正确性，避免外部内容同步的坑；
 *    M4 再做 external content + optimize 的优化。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_root (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  mode          TEXT NOT NULL CHECK (mode IN ('managed','referenced')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_scan_at  TEXT
);

CREATE TABLE IF NOT EXISTS asset (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  ext           TEXT,
  size          INTEGER,
  hash          TEXT,
  hash_algo     TEXT,
  captured_at   TEXT,
  imported_at   TEXT NOT NULL,
  rating        INTEGER,
  note          TEXT,
  meta_json     TEXT,
  deleted_at    TEXT,
  -- 人能认出来的路径（来源相对路径）。托管对象的路径是哈希，不能拿来给人看/给人搜。
  display_path  TEXT,
  -- 生成该素材的模型（参考设计里的 model 字段：Veo / Suno / Claude / 豆包 / Seedance…）
  model         TEXT,
  -- 文本/代码类的前若干字符，供卡片预览直接展示（避免列表页发起 N 次请求）
  excerpt       TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_kind ON asset(kind);
CREATE INDEX IF NOT EXISTS idx_asset_hash ON asset(hash);

CREATE TABLE IF NOT EXISTS file (
  id             INTEGER PRIMARY KEY,
  asset_id       INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  source_root_id INTEGER REFERENCES source_root(id),
  rel_path       TEXT NOT NULL,
  abs_path       TEXT NOT NULL,
  volume_id      TEXT,
  file_id        TEXT,
  size           INTEGER NOT NULL,
  mtime          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'present',
  thumb_at       TEXT,
  probed_at      TEXT,
  UNIQUE(source_root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_file_asset ON file(asset_id);
CREATE INDEX IF NOT EXISTS idx_file_abs ON file(abs_path);

CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  title, path_text, note, bigram, kind UNINDEXED, tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS tag (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES tag(id),
  color     TEXT
);

CREATE TABLE IF NOT EXISTS asset_tag (
  asset_id   INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  source     TEXT,
  confidence REAL,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE TABLE IF NOT EXISTS project (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  -- 子项目：指向父项目；NULL 表示顶层项目。删除父项目时子项目一并删除（见 deleteProject）
  parent_id      INTEGER REFERENCES project(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active',
  cover_asset_id INTEGER REFERENCES asset(id),
  started_at     TEXT,
  due_at         TEXT,
  progress       INTEGER,
  note           TEXT,
  description    TEXT,
  color          TEXT,
  modality       TEXT
);

CREATE TABLE IF NOT EXISTS project_asset (
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  asset_id   INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  role       TEXT,
  sort_key   REAL,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);

CREATE TABLE IF NOT EXISTS smart_collection (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  query_ast TEXT NOT NULL
);

-- 编辑文本/代码时保存出的历史版本。
-- 为什么不直接改写托管对象：对象路径由内容哈希推导，"原地改"会破坏"路径=内容"的契约；
-- 所以每次保存都生成一个新对象，旧内容留在这里（verify 会把这些哈希算作"已索引"）。
CREATE TABLE IF NOT EXISTS asset_version (
  id       INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  hash     TEXT NOT NULL,
  hash_algo TEXT NOT NULL DEFAULT 'sha256',
  ext      TEXT,
  size     INTEGER,
  saved_at TEXT NOT NULL,
  note     TEXT,
  UNIQUE(asset_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_asset_version_asset ON asset_version(asset_id);

-- 删掉整个项目时，把项目本身记在这里。
-- 为什么需要：素材进回收站只记住"哪些素材被删了"，不记"它们原本属于哪个项目"，
-- 于是用户没法把"一整个项目"恢复回来（只能一件件恢复素材，归属就丢了）。
CREATE TABLE IF NOT EXISTS trash_project (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  modality    TEXT,
  parent_name TEXT,
  deleted_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trash_project_asset (
  trash_project_id INTEGER NOT NULL REFERENCES trash_project(id) ON DELETE CASCADE,
  asset_id         INTEGER NOT NULL,
  PRIMARY KEY (trash_project_id, asset_id)
);

-- 组（bundle）：一次加入的一批内容本来就是一个单元（例如"综合"里同时收的图+音+文）。
-- 为什么要单独一层：项目回答"属于哪个工程"、标签是横切面，而"这批东西是一组"是内容本身的完整性。
-- 成员仍然是一等素材：能单独搜索、单独挂项目、单独进专注模式。
CREATE TABLE IF NOT EXISTS bundle (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  note           TEXT,
  cover_asset_id INTEGER REFERENCES asset(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bundle_member (
  bundle_id INTEGER NOT NULL REFERENCES bundle(id) ON DELETE CASCADE,
  asset_id  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  sort_key  REAL,
  PRIMARY KEY (bundle_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_bundle_member_asset ON bundle_member(asset_id);

-- 整理项目库时的"记账本"：记下每个素材改动前的标题与归属，
-- 这样整理可以整体撤销（整理只动元数据，绝不动磁盘文件）。
CREATE TABLE IF NOT EXISTS tidy_journal (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
`;

/** 轻量迁移：老库补列，避免为了加一个字段就重建资料库 */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'asset', column: 'display_path', ddl: 'ALTER TABLE asset ADD COLUMN display_path TEXT' },
  { table: 'asset', column: 'model', ddl: 'ALTER TABLE asset ADD COLUMN model TEXT' },
  { table: 'asset', column: 'excerpt', ddl: 'ALTER TABLE asset ADD COLUMN excerpt TEXT' },
  { table: 'project', column: 'description', ddl: 'ALTER TABLE project ADD COLUMN description TEXT' },
  { table: 'project', column: 'color', ddl: 'ALTER TABLE project ADD COLUMN color TEXT' },
  { table: 'project', column: 'modality', ddl: 'ALTER TABLE project ADD COLUMN modality TEXT' },
  {
    table: 'project',
    column: 'parent_id',
    ddl: 'ALTER TABLE project ADD COLUMN parent_id INTEGER REFERENCES project(id) ON DELETE CASCADE',
  },
];

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  title, path_text, note, model, bigram, kind UNINDEXED, tokenize='unicode61'
);
`;

function applyMigrations(db: DatabaseSync): void {
  // v0.12 起：素材可以带提示词、来源标记，并能关联一件作为提示词的文本素材（提示词 ↔ 产物）
  const assetCols = new Set(
    (db.prepare("PRAGMA table_info(asset)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const addColumn = (name: string, ddl: string): void => {
    if (!assetCols.has(name)) db.exec('ALTER TABLE asset ADD COLUMN ' + ddl);
  };
  addColumn('prompt', 'prompt TEXT');
  addColumn('origin', "origin TEXT");
  addColumn('prompt_asset_id', 'prompt_asset_id INTEGER');
  addColumn('params', 'params TEXT');
  // 素材的一句话描述（MiMo 生成，供按意思检索；派生数据，可清空重跑）
  addColumn('caption', 'caption TEXT');
  addColumn('caption_model', 'caption_model TEXT');
  addColumn('captioned_at', 'captioned_at TEXT');
  // 关键词标签（JSON 数组文本，从描述提炼，供精确筛选）
  addColumn('tags', 'tags TEXT');
  // 谁（人或 agent）在什么时候改了什么：写操作的审计记录
  db.exec(`CREATE TABLE IF NOT EXISTS agent_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    asset_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL
  );`);

  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === migration.column)) db.exec(migration.ddl);
  }

  // 全文索引缺 model 列时重建。索引是纯派生数据，重建没有风险；
  // 重建后由 reindexFts()（服务启动/扫描时自愈）从 asset 表把内容填回来。
  const ftsColumns = db.prepare('PRAGMA table_info(asset_fts)').all() as Array<{ name: string }>;
  if (ftsColumns.length > 0 && !ftsColumns.some((column) => column.name === 'model')) {
    db.exec('DROP TABLE asset_fts');
    db.exec(FTS_SCHEMA);
  }
}

export function openDb(file: string = DB_FILE): DatabaseSync {
  ensureLibraryDirs();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

export function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  return row.v;
}

export function ensureRoot(db: DatabaseSync, path: string, mode: 'managed' | 'referenced'): number {
  const found = db.prepare('SELECT id FROM source_root WHERE path = ?').get(path) as { id: number } | undefined;
  if (found) return found.id;
  const res = db
    .prepare('INSERT INTO source_root (path, mode, enabled) VALUES (?, ?, 1)')
    .run(path, mode);
  return Number(res.lastInsertRowid);
}

export function dbExists(file: string = DB_FILE): boolean {
  return existsSync(file);
}
