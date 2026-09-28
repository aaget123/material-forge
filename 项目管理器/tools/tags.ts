/**
 * 从已有的"画面描述"提炼关键词标签。
 *
 * 为什么：描述是一句话，适合人读；标签是一小组词，适合精确筛选（"标签含 水母"）。
 * 做法：把每件素材的 caption 交给同一个 MiMo 模型，要求只返回 JSON 数组（3-6 个中文词）。
 * 标签写进 asset.tags（JSON 数组文本）并**并入全文索引**，所以既可按标签精确匹配、也能被搜索命中。
 *
 * 用法：
 *   node --no-warnings tools/tags.ts --dry-run --limit 3
 *   node --no-warnings tools/tags.ts --limit 200          # 批量（跳过已有的，可断点续跑）
 *   node --no-warnings tools/tags.ts --id 3 --force
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openDb } from '../core/db.ts';
import { upsertFts } from '../core/maintenance.ts';
import { LIBRARY_DIR } from '../core/config.ts';
import { loadAnalysisConfig, chatText } from './caption.ts';

const PROMPT = [
  '下面是一张素材图片的描述。请提炼 3-6 个中文关键词标签，用于检索。',
  '要求：每个标签 2-6 个字；优先主体、场景、风格、动作；不要编号、不要解释。',
  '只输出 JSON 数组，例如 ["猫耳少女","白色背景","动漫风格"]。',
].join('');

const argv = process.argv.slice(2);
const flag = (n: string): string | null => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] ?? null : null; };
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const limit = Number(flag('limit') ?? 100);

const cfg = loadAnalysisConfig();
console.log(`模型 ${cfg.model} ｜ 地址 ${cfg.base} ｜ 密钥 ${cfg.key ? '已读到' : '缺失'}`);
if (!cfg.key) { console.error('没有读到密钥：AI_EDITOR_VISION_KEY 或 ai-editor\\.mimo_key'); process.exit(1); }

const db: DatabaseSync = openDb();
console.log(`库：${LIBRARY_DIR}`);

const idArg = flag('id');
const rows = (idArg
  ? db.prepare("SELECT id, title, caption FROM asset WHERE id = ?").all(Number(idArg))
  : db.prepare(
    `SELECT id, title, caption FROM asset
      WHERE deleted_at IS NULL AND caption IS NOT NULL AND caption <> ''
        ${force ? '' : "AND (tags IS NULL OR tags = '' OR tags = '[]')"}
      ORDER BY id LIMIT ?`,
  ).all(limit)) as Array<{ id: number; title: string; caption: string }>;

console.log(`待打标签 ${rows.length} 件${dryRun ? '（dry-run，不调用接口）' : ''}`);
const save = db.prepare('UPDATE asset SET tags = ? WHERE id = ?');
let done = 0;
let failed = 0;

for (const row of rows) {
  if (dryRun) { console.log(`  将打标签 #${row.id}「${row.title}」 依据: ${row.caption.slice(0, 40)}…`); continue; }
  try {
    const raw = await chatText(cfg, `${PROMPT}\n\n描述：${row.caption}`, 200);
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    let tags: string[] = [];
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
        if (Array.isArray(parsed)) tags = parsed.map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
      } catch { /* 不是 JSON，退回按分隔符切 */ }
    }
    if (tags.length === 0) tags = raw.replace(/[[\]"']/g, '').split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 6);
    if (tags.length === 0) throw new Error('模型没给出可用标签: ' + raw.slice(0, 120));
    save.run(JSON.stringify(tags), row.id);
    const full = db.prepare('SELECT title, note, model, kind, display_path AS dp FROM asset WHERE id = ?').get(row.id) as { title: string; note: string | null; model: string | null; kind: string; dp: string | null };
    upsertFts(db, row.id, full.title, full.dp ?? '', full.note ?? '', full.model ?? '', full.kind);
    done += 1;
    console.log(`  #${row.id}「${row.title}」 → ${tags.join(' / ')}`);
  } catch (error) {
    failed += 1;
    console.log(`  #${row.id}「${row.title}」 失败: ${(error as Error).message}`);
  }
}
console.log(`完成 ${done} 件，失败 ${failed} 件`);
void existsSync;
db.close();
