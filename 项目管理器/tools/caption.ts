/**
 * 给素材生成"一句话描述"（caption），并让它参与检索。
 *
 * 为什么要：素材库现在只能按标题/文件名找；AI 想"按意思找"（例如"海边的逆光少女"）就需要一层
 * 对画面的自然语言描述。这一步不建向量库 —— 描述写进素材 + 全文索引，检索立刻可用；
 * 以后要向量检索，把这一列换成向量列即可（索引是派生的）。
 *
 * 复用你现有的 MiMo 配置（与 ai-editor 的 lib/vision.py 同一套取值顺序）：
 *   地址：AI_EDITOR_VISION_BASE → ai-editor/capabilities.yaml 的 vars.vision.api_base → 默认官方地址
 *   密钥：AI_EDITOR_VISION_KEY / AI_EDITOR_MIMO_KEY → ai-editor/.mimo_key
 *   模型：AI_EDITOR_VISION_MODEL → capabilities.yaml → 默认 mimo-v2.6-flash
 *
 * 已知坑（来自你自己的实测记录，已内建处理）：
 *   ① 2.6 系 thinking 默认开启，图片/短输入容易被思考吃光 token 导致 content 为空 → 显式 thinking={type:disabled}；
 *   ② 回复可能带前言（"根据您提供的图片…"）→ 解析前先抠第一个 { 到最后一个 }，取不到再退回纯文本；
 *   ③ reasoning_content 绝不当正文。
 *
 * 用法：
 *   node --no-warnings tools/caption.ts --dry-run --limit 3
 *   node --no-warnings tools/caption.ts --kind image --limit 50
 *   node --no-warnings tools/caption.ts --id 220 --force
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../core/db.ts';
import { upsertFts } from '../core/maintenance.ts';
import { LIBRARY_DIR } from '../core/config.ts';

const AI_EDITOR = 'D:\\内容\\shipingchuli\\ai-editor';
const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2.6-flash';

const PROMPT = [
  '你看的是一张素材图片。用一句中文（30-60 字）描述它，供日后检索使用。',
  '必须包含：主体是谁/是什么、在什么场景、什么风格或画风。有文字或对白可以点出。',
  '不要评价、不要寒暄、不要分点，只输出这一句。',
].join('');

/**
 * 视频分析的接口来源（用户指定）：<接口配置目录> 下的百炼(阿里云) key CSV。
 * 地址取 CSV 的 openAiCompatible（OpenAI 兼容），密钥取 apiKey；模型默认 qwen3.8-omni-flash（实测该 key 只放行部分模型），
 * 可用 PM_VIDEO_MODEL 覆盖；PM_VIDEO_BASE / PM_VIDEO_KEY 优先级最高，便于临时切换。
 * CSV 在仓库之外、不会被 git 跟踪；代码里也不写死密钥。
 */
export function loadVideoConfig(): Cfg {
  let base = process.env['PM_VIDEO_BASE'] ?? '';
  let key = process.env['PM_VIDEO_KEY'] ?? '';
  const model = process.env['PM_VIDEO_MODEL'] ?? 'qwen3.8-omni-flash'; // 这把百炼 key 只放行部分模型，实测 qwen3.8-omni-flash 可用
  try {
    const dir = 'D:\\内容\\api';
    const found = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => String(f).toLowerCase().endsWith('.csv'));
    if (found.length > 0) {
      const text = readFileSync(join(dir, String(found[0])), 'utf8');
      const pick = (name: string): string => (text.match(new RegExp('^' + name + ',(.*)', 'm')) || [])[1] || '';
      base = base || pick('openAiCompatible').trim();
      key = key || pick('apiKey').trim();
    }
  } catch { /* 目录不在就只用环境变量 */ }
  return { base: base.replace(/\/+$/, ''), key, model };
}

interface Cfg { base: string; key: string; model: string }


/** 与 ai-editor/lib/vision.py 同源的取值顺序 */
/** 所有分析（图/视频/标签）统一走这条：优先百炼（D:\\内容\\api 的 CSV），CSV 不可用时回落 MiMo */
export function loadAnalysisConfig(): Cfg {
  const qwen = loadVideoConfig();
  if (qwen.base && qwen.key) return qwen;
  return loadMiMoConfig();
}

function loadMiMoConfig(): Cfg {
  const yamlText = existsSync(join(AI_EDITOR, 'capabilities.yaml')) ? readFileSync(join(AI_EDITOR, 'capabilities.yaml'), 'utf8') : '';
  const pick = (re: RegExp): string => (yamlText.match(re)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  const yamlBase = pick(/api_base:\s*"?([^"\n]*)"?/);
  const yamlModel = pick(/model:\s*"?([^"\n]*)"?/);
  const keyFile = join(AI_EDITOR, '.mimo_key');
  const key = process.env['AI_EDITOR_VISION_KEY'] || process.env['AI_EDITOR_MIMO_KEY']
    || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
  return {
    base: (process.env['AI_EDITOR_VISION_BASE'] || yamlBase || DEFAULT_BASE).replace(/\/+$/, ''),
    key,
    model: process.env['AI_EDITOR_VISION_MODEL'] || yamlModel || DEFAULT_MODEL,
  };
}

/** 从可能带前言的回复里取出正文 */
function pickText(content: string): string {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
      for (const k of ['desc', 'description', 'caption', 'text']) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    } catch { /* 不是 JSON，按纯文本处理 */ }
  }
  return content.trim();
}

/** 纯文本问答（标签等场景复用；同样显式关闭 thinking 并兼容回复带前言） */
export async function chatText(cfg: Cfg, prompt: string, maxTokens = 300): Promise<string> {
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, thinking: { type: 'disabled' }, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  return parsed.choices?.[0]?.message?.content?.trim() ?? '';
}

/** 视频抽 3 帧（约 10%、50%、90% 处），走已验证的图片通道，避免依赖视频载荷细节 */
function videoFrames(absPath: string): string[] {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', absPath], { encoding: 'utf8' });
  const duration = Number((probe.stdout ?? '').trim()) || 0;
  if (!duration) return [];
  const dir = mkdtempSync(join(tmpdir(), 'pm-frames-'));
  const out: string[] = [];
  for (const ratio of [0.1, 0.5, 0.9]) {
    const t = Math.max(0.1, duration * ratio);
    const file = join(dir, 'f' + Math.round(t * 100) + '.jpg');
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', absPath, '-frames:v', '1', '-vf', 'scale=640:-1', file], { encoding: 'utf8' });
    if (r.status === 0 && existsSync(file)) out.push(file);
  }
  return out;
}

async function describe(cfg: Cfg, absPath: string, ext: string): Promise<string> {
  if (/^\.(wav|mp3)$/i.test(ext)) {
    const acfg = loadVideoConfig();
    if (!acfg.base || !acfg.key) throw new Error('音频分析接口没配置：检查 D:\\内容\\api 下的 CSV');
    const fmt = ext.toLowerCase() === '.mp3' ? 'mp3' : 'wav';
    const ares = await fetch(acfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acfg.key },
      body: JSON.stringify({
        model: acfg.model, temperature: 0, max_tokens: 400,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT.replace('你看的是一张素材图片', '你听到的是一段音频素材') },
          // 百炼网关要的是完整 data URL（实测：只给裸 base64 会报 'provided URL ... not valid'）
          { type: 'input_audio', input_audio: { data: 'data:audio/' + fmt + ';base64,' + readFileSync(absPath).toString('base64'), format: fmt } },
        ] }],
      }),
    });
    const atext = await ares.text();
    if (!ares.ok) throw new Error('HTTP ' + ares.status + ': ' + atext.slice(0, 200));
    const aparsed = JSON.parse(atext) as { choices?: Array<{ message?: { content?: string } }> };
    const abody = aparsed.choices?.[0]?.message?.content ?? '';
    if (!abody.trim()) throw new Error('模型没给内容: ' + atext.slice(0, 160));
    return pickText(abody).replace(/\s+/g, ' ').slice(0, 200);
  }
  if (/^\.(mp4|mov|mkv|webm|avi)$/i.test(ext)) {
    const frames = videoFrames(absPath);
    if (frames.length === 0) throw new Error('抽帧失败（ffmpeg/ffprobe 不可用或时长读不到）');
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: PROMPT.replace('一张素材图片', '一段视频的若干画面（按时间顺序）') }];
    for (const f of frames) content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + readFileSync(f).toString('base64') } });
    const vcfg = loadVideoConfig();
    if (!vcfg.base || !vcfg.key) throw new Error('视频分析接口没配置：检查 D:\\内容\\api 下的 CSV，或设 PM_VIDEO_BASE / PM_VIDEO_KEY');
    const res = await fetch(vcfg.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vcfg.key },
      body: JSON.stringify({ model: vcfg.model, temperature: 0, max_tokens: 400, messages: [{ role: 'user', content }] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 200));
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const body = parsed.choices?.[0]?.message?.content ?? '';
    if (!body.trim()) throw new Error('模型没给内容: ' + text.slice(0, 160));
    return pickText(body).replace(/\s+/g, ' ').slice(0, 200);
  }
  const bytes = readFileSync(absPath);
  const mime = /\.png$/i.test(ext) ? 'image/png'
    : /\.(jpg|jpeg)$/i.test(ext) ? 'image/jpeg'
      : /\.webp$/i.test(ext) ? 'image/webp'
        : /\.gif$/i.test(ext) ? 'image/gif' : 'application/octet-stream';
  const body = {
    model: cfg.model,
    // ① 显式关掉思考，避免 2.6 系把 token 花在思考上导致 content 为空
    thinking: { type: 'disabled' },
    temperature: 0,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
      ],
    }],
  };
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { throw new Error(`返回不是 JSON: ${text.slice(0, 200)}`); }
  const content = parsed.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new Error(`模型没给内容（thinking 吃 token？）: ${text.slice(0, 200)}`);
  return pickText(content).replace(/\s+/g, ' ').slice(0, 200);
}

const argv = process.argv.slice(2);
const flag = (n: string): string | null => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] ?? null : null; };
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const limit = Number(flag('limit') ?? 20);

/** 只有"直接运行本文件"时才执行主流程：tools/tags.ts 会 import 这里的配置加载与 chatText */
const runAsScript = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('tools/caption.ts');
if (runAsScript) {
  const cfg = loadAnalysisConfig();
  console.log(`模型 ${cfg.model} ｜ 地址 ${cfg.base} ｜ 密钥 ${cfg.key ? '已读到（' + cfg.key.slice(0, 8) + '…）' : '缺失'}`);
  if (!cfg.key) { console.error('没有读到密钥：请确认 AI_EDITOR_VISION_KEY 或 ai-editor\\.mimo_key'); process.exit(1); }

  const db: DatabaseSync = openDb();
  console.log(`库：${LIBRARY_DIR}`);

  const idArg = flag('id');
  const kind = flag('kind');
  const rows = (idArg
    ? db.prepare("SELECT a.id, a.title, a.ext, a.kind, f.abs_path AS p FROM asset a JOIN file f ON f.asset_id=a.id JOIN source_root sr ON sr.id=f.source_root_id WHERE a.id=? AND sr.mode='managed'").all(Number(idArg))
    : db.prepare(
      `SELECT a.id, a.title, a.ext, a.kind, f.abs_path AS p
         FROM asset a JOIN file f ON f.asset_id=a.id JOIN source_root sr ON sr.id=f.source_root_id
        WHERE a.deleted_at IS NULL AND sr.mode='managed'
          ${kind ? 'AND a.kind = ?' : ''} ${force ? '' : 'AND (a.caption IS NULL OR a.caption = \'\')'}
        ORDER BY a.id LIMIT ?`,
    ).all(...(kind ? [kind, limit] : [limit]))) as Array<{ id: number; title: string; ext: string; kind: string; p: string }>;

  console.log(`待处理 ${rows.length} 件${dryRun ? '（dry-run，不调用接口、不写库）' : ''}`);
  const setCaption = db.prepare('UPDATE asset SET caption = ?, caption_model = ?, captioned_at = ? WHERE id = ?');
  let done = 0;
  let failed = 0;

  for (const row of rows) {
    if (!existsSync(row.p)) { console.log(`  跳过 #${row.id}（对象文件不在）`); continue; }
    if (!['image', 'video', 'audio', 'music'].includes(row.kind)) {
      console.log(`  跳过 #${row.id} ${row.title}（当前支持图片/视频/音频/音乐，${row.kind} 不属于分析对象）`);
      continue;
    }
    if (dryRun) {
      console.log(`  将描述 #${row.id}「${row.title}」 ${row.p}（${(readFileSync(row.p).length / 1024).toFixed(0)} KB）`);
      continue;
    }
    try {
      const isAv = /^\.(mp4|mov|mkv|webm|avi|wav|mp3)$/i.test(row.ext ?? '');
    const usedModel = isAv ? loadVideoConfig().model : cfg.model;
    const caption = await describe(cfg, row.p, row.ext ?? '');
      setCaption.run(caption, usedModel, new Date().toISOString(), row.id);
      // 让描述立刻可检索（upsertFts 现在会把 caption 一起索引）
      const full = db.prepare('SELECT a.title, a.note, a.model, a.kind, a.display_path AS dp FROM asset a WHERE a.id = ?').get(row.id) as { title: string; note: string | null; model: string | null; kind: string; dp: string | null };
      upsertFts(db, row.id, full.title, full.dp ?? '', full.note ?? '', full.model ?? '', full.kind);
      done += 1;
      console.log(`  #${row.id}「${row.title}」 → ${caption}`);
    } catch (error) {
      failed += 1;
      console.log(`  #${row.id}「${row.title}」 失败: ${(error as Error).message}`);
    }
  }
  console.log(`完成 ${done} 件，失败 ${failed} 件`);
  void dirname; void writeFileSync;
  db.close();
}