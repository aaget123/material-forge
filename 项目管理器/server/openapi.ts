/**
 * 接口自描述：给"机器/AI 直接用"的清单。
 *
 * 为什么需要：界面是给人点的，Agent 要自己摸索接口就得先有一份**准确的**清单 ——
 * 哪条路、要什么参数、返回什么、要不要 token。这里不追求 OpenAPI 的全量规范，
 * 只保证"写下来的都是真的"（宁可少写，不可写错）。
 *
 * 访问：GET /api/openapi.json（本机、无需 token，因为它不含任何库内数据）
 */

export const API_VERSION = '1.0';

/** 需要 token 的接口：请求头 x-pm-token（token 在库目录的 runtime.json 里） */
export const AUTH_HEADER = 'x-pm-token';

/** 写操作不走 HTTP，走命令行（带审计）；见 tools/pm.ts */
export const WRITE_NOTES = '写操作（打标签/改元数据/归项目）请用命令行：node --no-warnings tools/pm.ts tag|meta|project …，都会写入 agent_audit 审计表；HTTP 目前只读。';

export interface EndpointDoc {
  method: string;
  path: string;
  summary: string;
  auth: boolean;
  params?: Record<string, string>;
  returns?: string;
}

export const ENDPOINTS: EndpointDoc[] = [
  { method: 'GET', path: '/api/health', summary: '存活与版本、库路径、SQLite 版本', auth: false, returns: '{ok, libraryDir, sqliteVersion}' },
  { method: 'GET', path: '/api/openapi.json', summary: '本清单（自描述）', auth: false, returns: '{apiVersion, authHeader, endpoints[]}' },
  { method: 'GET', path: '/api/stats', summary: '库统计（素材数/回收站/项目/字节/缩略图）', auth: true, returns: 'Stats' },
  { method: 'GET', path: '/api/verify', summary: '体检：对象数、sidecar、文件行、孤儿缩略图、库外对象、同内容多素材', auth: true, returns: 'VerifyReport' },
  {
    method: 'GET',
    path: '/api/assets',
    summary: '检索素材（列表）',
    auth: true,
    params: { q: '关键词（标题/路径/模型/备注；支持中文子串）', kind: 'text|code|image|video|music|voice|mixed', project: '项目 id', limit: '1..500，默认 60', offset: '默认 0' },
    returns: '{items: AssetListItem[], total, limit, offset}',
  },
  { method: 'GET', path: '/api/assets/:id', summary: '单件素材详情（含来源行、文本内容、版本）', auth: true, returns: 'AssetDetail' },
  {
    method: 'POST',
    path: '/api/assets/:id/meta',
    summary: '改生成信息：model / origin / params / promptAssetId；applyToBundle=true 时同组一起改',
    auth: true,
    returns: '更新后的字段',
  },
  { method: 'GET', path: '/api/projects', summary: '项目树与计数', auth: true, returns: '{items: ProjectRow[]}' },
  { method: 'GET', path: '/api/bundles', summary: '组列表（一次生成/一次加入的多件）', auth: true, returns: '{items: BundleRow[]}' },
  { method: 'GET', path: '/api/bundles/:id', summary: '组内成员', auth: true, returns: '{id, title, members[]}' },
  { method: 'GET', path: '/thumb/:id', summary: '缩略图（webp）', auth: true, returns: '二进制 image/webp' },
  { method: 'GET', path: '/media/:id', summary: '原始内容（支持 Range，可直接喂多模态模型）', auth: true, returns: '原始字节 + Content-Type' },
  { method: 'GET', path: '/api/fs/text', summary: '读磁盘上的文本文件（只读，默认上限 2MB）', auth: true, params: { path: '绝对路径' }, returns: '{body, encoding, truncated, ...}' },
  { method: 'POST', path: '/api/fs/text', summary: '写回文本文件（保留 BOM/换行，写 .bak）', auth: true, returns: '{ok, backup}' },
  { method: 'POST', path: '/api/upload', summary: '上传一件素材（按内容哈希去重）', auth: true, returns: '新建或命中的素材' },
];

/** 给 Agent 看的"素材对象"字段说明（与 core/query.ts 的 SELECT_COLS 对应） */
export const ASSET_FIELDS: Record<string, string> = {
  id: '库内自增 id（本库内稳定；跨库不稳定）',
  hash: 'sha256 内容哈希 —— **跨改名/移动都稳定的引用键**，建议 AI 用它引用素材',
  title: '可读标题',
  modality: 'text|code|image|video|music|voice|mixed',
  ext: '扩展名（含点）',
  size: '字节数',
  model: '生成模型（未标注则为空）',
  origin: 'ai=AI 生成 / real=非 AI / other / 空=未标注',
  params: '生成参数（种子、步数等自由文本）',
  caption: 'AI 生成的一句话画面描述（图/视频/音频都有；参与检索）',
  tags: '关键词标签数组（从描述提炼，适合精确筛选）',
  projects: '所属项目',
  sourcePath: '可读来源路径（如 开头/开头-01.png）—— 只是给人和 AI 看的标签，不是磁盘链接',
  importedAt: '入库时间',
  thumbUrl: '/thumb/:id（需要 token）',
  contentUrl: '/media/:id（需要 token，支持 Range）',
};

export function apiDoc(): { apiVersion: string; authHeader: string; assetFields: Record<string, string>; endpoints: EndpointDoc[] } {
  return { apiVersion: API_VERSION, authHeader: AUTH_HEADER, assetFields: ASSET_FIELDS, endpoints: ENDPOINTS };
}
