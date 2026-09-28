/**
 * 把"引用型"素材提升为"库内副本"。
 *
 * 场景：素材当初是**扫描目录**进来的（库里只有索引与缩略图，真正的文件在磁盘上）。
 * 如果你打算删掉那些原目录，就必须先把内容复制进库，否则素材会变成打不开的空壳。
 *
 * 做法（每一件都先按内容哈希核对，绝不盲信）：
 *  1. 读原文件、算 sha256，与库里记的哈希核对；不一致就跳过并报出来（说明原文件被改过）；
 *  2. 复制到 `objects/<h2>/<h2b>/<哈希><后缀>`（已存在就复用，天然去重），并写 sidecar；
 *  3. 写入一条"库内托管"文件行，删掉原来的引用行（保留 display_path，界面上来源路径依旧可读）；
 *  4. 改动记进 tidy_journal，可整体撤销。
 *
 * 用法：
 *   node --no-warnings tools/promote.ts plan     # 只读：列出会复制多少件、多少体积、有没有哈希不一致的
 *   node --no-warnings tools/promote.ts apply    # 执行
 *   node --no-warnings tools/promote.ts undo --journal N
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { DB_FILE, LIBRARY_DIR } from '../core/config.ts';

const OBJECTS = join(LIBRARY_DIR, 'objects');

interface Row {
  fileId: number;
  assetId: number;
  title: string;
  ext: string | null;
  size: number | null;
  hash: string | null;
  absPath: string;
  relPath: string;
  displayPath: string | null;
  kind: string;
}

function sha256(p: string): string {
  const h = createHash('sha256');
  const fd = openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(buf.subarray(0, n)); }
  } finally { closeSync(fd); }
  return h.digest('hex');
}

function loadReferenced(db: DatabaseSync): Row[] {
  return db
    .prepare(
      `SELECT f.id AS fileId, f.asset_id AS assetId, f.abs_path AS absPath, f.rel_path AS relPath,
              a.title, a.ext, a.size, a.hash, a.display_path AS displayPath, a.kind
         FROM file f JOIN asset a ON a.id = f.asset_id
         JOIN source_root sr ON sr.id = f.source_root_id
        WHERE sr.mode = 'referenced' AND a.deleted_at IS NULL
        ORDER BY a.id`,
    )
    .all() as Row[];
}

function planAll(db: DatabaseSync): { rows: Row[]; missing: Row[]; mismatch: Row[]; bytes: number } {
  const rows = loadReferenced(db).filter((row) => !row.absPath.includes('\\objects\\'));
  const missing: Row[] = [];
  const mismatch: Row[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (!existsSync(row.absPath)) { missing.push(row); continue; }
    const actual = sha256(row.absPath);
    if (row.hash && actual !== row.hash) { mismatch.push({ ...row }); continue; }
    bytes += statSync(row.absPath).size;
  }
  return { rows, missing, mismatch, bytes };
}

function writeSidecar(objectPath: string, row: Row, hash: string, size: number): void {
  const meta = {
    schema: 1,
    hash,
    hashAlgo: 'sha256',
    ext: row.ext ?? extname(row.absPath),
    kind: row.kind,
    title: row.title,
    size,
    capturedAt: null,
    importedAt: new Date().toISOString(),
    rating: null,
    note: '',
    tags: [],
    projects: [],
    meta: { durationSec: null, width: null, height: null, videoCodec: null, audioCodec: null, bitrate: null, formatName: null, tags: {} },
    source: { rootPath: dirname(row.absPath), relPath: row.displayPath ?? row.relPath },
    model: null,
    excerpt: null,
  };
  writeFileSync(objectPath.replace(/\.[^.]+$/, '') + '.json', JSON.stringify(meta, null, 2), 'utf8');
}

const command = process.argv[2] ?? 'plan';
const flag = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};
const db = new DatabaseSync(DB_FILE);
const managedRoot = db.prepare("SELECT id FROM source_root WHERE mode = 'managed' LIMIT 1").get() as { id: number } | undefined;
if (!managedRoot) throw new Error('库里没有找到托管根');

if (command === 'plan') {
  const result = planAll(db);
  console.log(`引用型素材 ${result.rows.length} 件：可复制 ${result.rows.length - result.missing.length - result.mismatch.length} 件`
    + `、原文件已丢失 ${result.missing.length} 件、内容与库里记的哈希不一致 ${result.mismatch.length} 件`);
  console.log(`需要复制约 ${(result.bytes / 1048576).toFixed(1)} MB`);
  for (const row of result.mismatch.slice(0, 5)) console.log(`  哈希不一致 #${row.assetId}「${row.title}」 ${row.absPath}`);
  for (const row of result.missing.slice(0, 5)) console.log(`  原文件丢失 #${row.assetId}「${row.title}」 ${row.absPath}`);
} else if (command === 'apply') {
  const result = planAll(db);
  const previous: Array<Record<string, unknown>> = [];
  let promoted = 0;
  let reused = 0;
  let skipped = 0;
  let bytes = 0;

  for (const row of result.rows) {
    if (!existsSync(row.absPath)) { skipped += 1; continue; }
    const hash = row.hash ?? sha256(row.absPath);
    const actual = row.hash ? row.hash : hash;
    if (actual !== hash) { skipped += 1; continue; }
    if (row.hash && sha256(row.absPath) !== row.hash) { skipped += 1; continue; }

    const ext = row.ext ?? extname(row.absPath);
    const rel = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${ext}`;
    const objectPath = join(OBJECTS, rel.replace(/\//g, '\\'));
    const existed = existsSync(objectPath);
    const size = statSync(row.absPath).size;
    if (!existed) {
      mkdirSync(dirname(objectPath), { recursive: true });
      copyFileSync(row.absPath, objectPath);
      writeSidecar(objectPath, row, hash, size);
      bytes += size;
    } else {
      reused += 1;
    }

    previous.push({
      fileId: row.fileId,
      assetId: row.assetId,
      absPath: row.absPath,
      relPath: row.relPath,
      createdObject: existed ? null : objectPath.replace(/\\/g, '/'),
    });
    // 加托管行（已存在就不重复加）
    const hasManaged = db
      .prepare("SELECT 1 AS ok FROM file WHERE asset_id = ? AND source_root_id = ? LIMIT 1")
      .get(row.assetId, managedRoot.id) as { ok: number } | undefined;
    if (!hasManaged) {
      db.prepare('INSERT INTO file (asset_id, source_root_id, rel_path, abs_path, status) VALUES (?, ?, ?, ?, ?)')
        .run(row.assetId, managedRoot.id, rel, objectPath, 'present');
    }
    // 去掉引用行：原文件即将被用户删除，留着只会变成断链
    db.prepare('DELETE FROM file WHERE id = ?').run(row.fileId);
    db.prepare('UPDATE asset SET hash = ?, size = ?, display_path = COALESCE(display_path, ?) WHERE id = ?')
      .run(hash, size, row.relPath, row.assetId);
    promoted += 1;
  }

  const res = db
    .prepare('INSERT INTO tidy_journal (kind, payload_json, created_at) VALUES (?, ?, ?)')
    .run('promote', JSON.stringify({ previous }), new Date().toISOString());
  console.log(`已把 ${promoted} 件转成库内副本（复用已有对象 ${reused} 件，跳过 ${skipped} 件，新复制 ${(bytes / 1048576).toFixed(1)} MB）`);
  console.log(`记账 #${res.lastInsertRowid}；撤销：node --no-warnings tools/promote.ts undo --journal ${res.lastInsertRowid}`);
} else if (command === 'undo') {
  const journal = Number(flag('journal'));
  const row = db.prepare('SELECT payload_json FROM tidy_journal WHERE id = ?').get(journal) as { payload_json: string } | undefined;
  if (!row) throw new Error('找不到这次记录');
  const payload = JSON.parse(row.payload_json) as { previous: Array<{ fileId: number; assetId: number; absPath: string; relPath: string; createdObject: string | null }> };
  let restored = 0;
  for (const entry of payload.previous) {
    db.prepare('DELETE FROM file WHERE asset_id = ? AND abs_path LIKE ?').run(entry.assetId, '%\\objects\\%');
    db.prepare('INSERT OR IGNORE INTO file (id, asset_id, source_root_id, rel_path, abs_path, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.fileId, entry.assetId, db.prepare("SELECT id FROM source_root WHERE mode='referenced' LIMIT 1").get().id, entry.relPath, entry.absPath, 'present');
    if (entry.createdObject && existsSync(entry.createdObject)) {
      rmSync(entry.createdObject, { force: true });
      rmSync(entry.createdObject.replace(/\.[^.]+$/, '') + '.json', { force: true });
    }
    restored += 1;
  }
  db.prepare('DELETE FROM tidy_journal WHERE id = ?').run(journal);
  console.log(`已撤销 #${journal}：恢复 ${restored} 条引用行，并清掉本次新建的库内对象`);
} else {
  console.log('未知命令。可用：plan / apply / undo');
}
db.close();
