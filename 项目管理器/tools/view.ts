/**
 * 生成素材库的"可读视图"。
 *
 * 问题：`D:\素材库\objects\` 里全是内容寻址的名字（`67\0d\670d9743….md`），
 * 在资源管理器里根本看不出哪个是哪个。
 *
 * 做法：对象库保持不动（它是内容真相、按哈希去重），另外生成
 * `D:\素材库\可读视图\<项目>\<标题>.<扩展名>`，用 **NTFS 硬链接**指向同一个对象：
 *  - 不占额外空间（同一个卷上的硬链接与源文件共享数据块）；
 *  - 删掉视图里任何东西都不影响对象库（只是少了一个链接）；
 *  - 可以随时重新生成，是纯派生目录。
 *
 * 注意：**别在视图里编辑文件**。原地编辑会改到对象本身，哈希与内容就对不上了。
 * 要改内容用应用里的「专注模式/编辑器」，或改完重新导入。
 *
 * 用法：
 *   node --no-warnings tools/view.ts build          # 生成/刷新可读视图
 *   node --no-warnings tools/view.ts list            # 只看会生成什么，不落盘
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, linkSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DB_FILE, LIBRARY_DIR } from '../core/config.ts';

const VIEW_DIR = join(LIBRARY_DIR, '可读视图');
const TYPE_VIEW_DIR = join(LIBRARY_DIR, '可读视图-按类型');
const INDEX_FILE = join(LIBRARY_DIR, '索引.md');
/** 文件名里不能出现的字符（Windows） */
const unsafe = /[\\/:*?"<>|]/g;

interface Row {
  id: number;
  title: string;
  ext: string | null;
  size: number | null;
  hash: string | null;
  projectName: string | null;
  managedPath: string | null;
}

function loadRows(db: DatabaseSync): Row[] {
  return db
    .prepare(
      `SELECT a.id, a.title, a.ext, a.size, a.hash,
              (SELECT p.name FROM project_asset pa JOIN project p ON p.id = pa.project_id
                WHERE pa.asset_id = a.id LIMIT 1) AS projectName,
              (SELECT f.abs_path FROM file f JOIN source_root sr ON sr.id = f.source_root_id
                WHERE f.asset_id = a.id AND sr.mode = 'managed' LIMIT 1) AS managedPath
         FROM asset a WHERE a.deleted_at IS NULL ORDER BY a.id`,
    )
    .all() as Row[];
}

/** 按类型分目录用的分类名 */
function typeFolder(row: Row): string {
  const ext = (row.ext ?? '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.psd'].includes(ext)) return '图片';
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) return '视频';
  if (['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'].includes(ext)) return '音频';
  if (['.md', '.txt', '.json', '.ts', '.js', '.py', '.yaml', '.yml'].includes(ext)) return '文本与提示词';
  return '其他';
}

function safeName(text: string): string {
  return text.replace(unsafe, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名';
}

function build(db: DatabaseSync, dryRun: boolean): { linked: number; skipped: number; groups: number } {
  const rows = loadRows(db);
  if (!dryRun) {
    for (const dir of [VIEW_DIR, TYPE_VIEW_DIR]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  let linked = 0;
  let skipped = 0;
  const groups = new Set<string>();
  const used = new Map<string, number>();
  const index: string[] = ['# 素材库索引', '', `生成时间：${new Date().toLocaleString('zh-CN')}`, '',
    '可读视图在 `可读视图/`（硬链接，不占空间；删掉可重新生成）。对象库 `objects/` 是内容真相，不要手改。', '',
    '| 项目 | 标题 | 类型 | 大小 | 对象（哈希路径） |', '| --- | --- | --- | --- | --- |'];

  for (const row of rows) {
    const project = safeName(row.projectName ?? '未归档');
    groups.add(project);
    const ext = row.ext ?? '';
    let base = `${safeName(row.title)}${ext}`;
    const key = project + '/' + base.toLowerCase();
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    if (seen > 0) base = `${safeName(row.title)} (${seen})${ext}`; // 同名加序号，避免互相覆盖

    const target = join(VIEW_DIR, project, base);
    index.push(
      `| ${row.projectName ?? '未归档'} | ${row.title.replace(/\|/g, '/')} | ${ext || '—'} | `
      + `${row.size ? (row.size / 1048576).toFixed(1) + ' MB' : '—'} | `
      + `${row.managedPath ? '`' + row.managedPath.replace(LIBRARY_DIR, '').replace(/^\\/, '') + '`' : '—'} |`,
    );

    if (dryRun) { linked += 1; continue; }
    if (!row.managedPath || !existsSync(row.managedPath)) { skipped += 1; continue; }
    mkdirSync(dirname(target), { recursive: true });
    try {
      linkSync(row.managedPath, target);
      linked += 1;
      // 另生成一套"按类型"的平行视图，方便按图片/视频翻
      const typeDir = join(TYPE_VIEW_DIR, typeFolder(row));
      const typeTarget = join(typeDir, base);
      mkdirSync(typeDir, { recursive: true });
      linkSync(row.managedPath, typeTarget);
    } catch {
      skipped += 1; // 跨卷之类的情况跳过，不阻断其余
    }
  }

  if (!dryRun) writeFileSync(INDEX_FILE, index.join('\n') + '\n', 'utf8');
  return { linked, skipped, groups: groups.size };
}

const command = process.argv[2] ?? 'build';
const db = new DatabaseSync(DB_FILE);
if (command === 'list') {
  const result = build(db, true);
  console.log(`会生成 ${result.groups} 个项目目录、${result.linked} 个硬链接（只读演练，未落盘）`);
} else if (command === 'build') {
  const before = existsSync(VIEW_DIR) ? statSync(VIEW_DIR).size : 0;
  const result = build(db, false);
  console.log(`可读视图已生成：${result.groups} 个项目目录、${result.linked} 个硬链接，跳过 ${result.skipped} 个`);
  console.log(`位置：${VIEW_DIR}`);
  console.log(`索引：${INDEX_FILE}`);
  void before;
} else {
  console.log('未知命令。可用：build / list');
}
db.close();
