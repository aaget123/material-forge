/**
 * 访问本地服务的唯一入口。
 *
 * 两种带 token 的方式，原因是真实存在的浏览器限制：
 *  - fetch 可以带自定义头 → 用 x-pm-token；
 *  - <img src> / <video src> 无法带自定义头 → 用 ?token=（M0 实测踩到的点）。
 * 开发模式下页面里的占位符不会被替换，此时由 Vite 代理代填请求头（见 vite.config.ts）。
 */

const metaToken = document.querySelector('meta[name="pm-token"]')?.getAttribute('content') ?? '';
export const token = metaToken.includes('__PM_TOKEN__') ? '' : metaToken;

export type Modality = 'text' | 'code' | 'image' | 'video' | 'music' | 'voice' | 'mixed';

function withToken(url: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${token}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (token) headers['x-pm-token'] = token;
  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    // 服务每次启动都会换新 token，久置的标签页会立刻失效。
    // 刷新一次即可从页面里拿到新 token（服务端注入），别让用户面对一个看不懂的 401。
    if (!sessionStorage.getItem('pm-token-refreshed')) {
      sessionStorage.setItem('pm-token-refreshed', '1');
      window.location.reload();
      throw new Error('本地服务已重启，正在刷新页面以获取新凭据…');
    }
    throw new Error('凭据失效：请关闭本页重新打开 http://127.0.0.1:' + window.location.port);
  }
  if (res.ok) sessionStorage.removeItem('pm-token-refreshed');

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface AssetListItem {
  id: number;
  kind: string;
  /** 面向界面的 7 类模态 */
  modality: Modality;
  title: string;
  ext: string;
  size: number;
  hash: string | null;
  capturedAt: string | null;
  importedAt: string;
  /** 人能认出来的来源路径 */
  sourcePath: string;
  /** 当前代表文件在库内的相对路径（托管对象是哈希路径） */
  relPath: string;
  absPath: string;
  thumbAt: string | null;
  status: string;
  inLibrary: boolean;
  /** 在回收站视图下为 true */
  trashed?: boolean;
  /** 所属组（bundle）：一次加入的一批内容 */
  bundleId: number | null;
  bundleTitle: string | null;
  bundleCount: number;
  /** 是不是这个组的封面（画廊里默认只用封面那张当代表卡） */
  bundleCover: boolean;
  /** 生成该素材的模型（可空） */
  model: string | null;
  /** 提示词正文（适合没存成文本文件的图/视频） */
  prompt: string | null;
  /** 来源标记：ai / real / other / null（未标注） */
  origin: string | null;
  /** 关联的"作为提示词"的文本素材 id */
  promptAssetId: number | null;
  /** 这件素材作为提示词被多少件素材引用 */
  promptOutputs: number;
  /** 生成参数（种子/步数/参考图等，自由文本） */
  params: string | null;
  /** AI 生成的一句话描述（MiMo），参与检索；为空表示还没生成 */
  caption: string | null;
  /** 文本/代码摘要 */
  excerpt: string | null;
  projectId: number | null;
  projectName: string | null;
  projectColor: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

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

export interface DeleteProjectResult {
  removed: number;
  removedChildren: number;
  trashedAssets: number;
  movedObjects: number;
  referencedLeftAlone: number;
}

export interface AssetSource {
  mode: string;
  status: string;
  relPath: string;
  absPath: string;
  size: number;
}

export interface AssetDetail extends AssetListItem {
  meta: unknown;
  sizeHuman: string;
  sources: AssetSource[];
  trashable: boolean;
  trashed: boolean;
  deletedAt: string | null;
}

export interface FsTextInfo {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: string;
  encoding: string;
  eol: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  lines: number;
  readOnly: boolean;
}

export interface TrashProjectRow {
  trashId: number;
  name: string;
  color: string;
  modality: Modality;
  parentName: string | null;
  deletedAt: string;
  /** 记下来的成员总数 */
  total: number;
  /** 其中仍在回收站里、可以恢复的件数 */
  restorable: number;
}

export interface BundleRow {
  id: number;
  title: string;
  note: string | null;
  coverAssetId: number | null;
  createdAt: string;
  count: number;
  modalities: Modality[];
}

export interface VerifyReport {
  assets: number;
  files: number;
  managedFiles: number;
  referencedFiles: number;
  trashedAssets: number;
  thumbnails: number;
  objectsOnDisk: number;
  sidecarsOnDisk: number;
  objectsWithoutDbRow: number;
  dbRowsWithoutObject: number;
  assetsWithoutSidecar: number;
  duplicateHashGroups: number;
  managedPathsStale: number;
  managedFilesMissing: number;
  thumbFilesOnDisk: number;
  orphanThumbs: number;
}

export interface SearchResult {
  total: number;
  items: AssetListItem[];
  strategy: 'fts' | 'like' | 'none';
  ftsQuery: string | null;
}

export interface Stats {
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
  byKind: Array<{ kind: string; label: string; count: number; bytes: number }>;
  byModality: Array<{ modality: Modality; count: number }>;
}

export interface ScanState {
  running: boolean;
  phase: string;
  processed: number;
  total: number;
  current: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  last: { added: number; updated: number; unchanged: number; thumbnails: number; durationMs: number } | null;
}

export interface ImportState {
  running: boolean;
  processed: number;
  total: number;
  current: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  last: {
    copied: number; dedupedByHash: number; sidecarsWritten: number;
    managedFilesCreated: number; mergedAssets: number; bytesCopied: number; durationMs: number;
  } | null;
}

export interface Ping {
  ok: boolean;
  libraryDir: string;
  sqliteVersion: string;
  roots: Array<{ path: string; mode: string }>;
  ffmpegDir: string;
}

export const api = {
  ping: () => request<Ping>('/api/ping'),
  stats: () => request<Stats>('/api/stats'),
  assets: (params: { q?: string; kind?: string; project?: number; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.kind) sp.set('kind', params.kind);
    if (typeof params.project === 'number') sp.set('project', String(params.project));
    sp.set('limit', String(params.limit ?? 500));
    sp.set('offset', String(params.offset ?? 0));
    return request<SearchResult>(`/api/assets?${sp.toString()}`);
  },
  projects: () => request<{ items: ProjectRow[] }>('/api/projects'),
  createProject: (input: { name: string; description?: string; color?: string; modality?: Modality; parentId?: number | null }) =>
    request<ProjectRow>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  /** 重命名项目（空名/重名由后端拒绝） */
  renameProject: (projectId: number, name: string): Promise<{ id: number; oldName: string; name: string }> =>
    request(`/api/projects/${projectId}`, { method: 'POST', body: JSON.stringify({ name }) }),

  /** 删除项目：项目连同子项目一起删除，项目里的素材全部移入回收站（可恢复） */
  deleteProject: (id: number) => request<DeleteProjectResult>(`/api/projects/${id}`, { method: 'DELETE' }),
  setAssetProject: (assetId: number, projectId: number | null) =>
    request<{ projectId: number | null }>(`/api/assets/${assetId}/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }),
  /** 生成信息：模型 / 提示词 / 来源标记 / 关联提示词素材（部分字段更新） */
  updateMeta: (
    assetId: number,
    input: {
      model?: string; prompt?: string; origin?: string; params?: string;
      promptAssetId?: number | null; applyToBundle?: boolean;
    },
  ) => request<{ model?: string; prompt?: string; origin?: string; promptAssetId?: number | null }>(
    `/api/assets/${assetId}/meta`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
  ),
  /** 上传素材：文件字节直接放进请求体，元信息走请求头（服务端不需要 multipart 解析） */
  upload: async (
    file: File,
    meta: { title?: string; model?: string; projectId?: number | null },
  ): Promise<{ assetId: number; title: string; deduped: boolean }> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    };
    if (token) headers['x-pm-token'] = token;
    if (meta.title) headers['x-title'] = encodeURIComponent(meta.title);
    if (meta.model) headers['x-model'] = encodeURIComponent(meta.model);
    if (meta.projectId) headers['x-project'] = String(meta.projectId);
    const res = await fetch('/api/upload', { method: 'POST', headers, body: file });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as { assetId: number; title: string; deduped: boolean };
  },
  createTextAsset: (input: {
    title: string; body: string; ext?: string; model?: string; projectId?: number | null; modality?: Modality;
  }) =>
    request<{ assetId: number; title: string }>('/api/text-asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  asset: (id: number, includeTrashed = false) =>
    request<AssetDetail>(`/api/assets/${id}${includeTrashed ? '?trashed=1' : ''}`),
  /** 音频波形峰值包络（服务端用 ffmpeg 算好、按内容哈希缓存） */
  peaks: (id: number) =>
    request<{ durationSec: number; points: number[]; source: 'cache' | 'ffmpeg' }>(`/api/peaks/${id}`),
  trashList: () => request<{ items: AssetListItem[]; projects: TrashProjectRow[] }>('/api/trash'),
  /** 组（bundle）：一次加入的一批内容算一个单元 */
  bundles: () => request<{ items: BundleRow[] }>('/api/bundles'),
  createBundle: (title: string, assetIds: number[]) =>
    request<BundleRow>('/api/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, assetIds }),
    }),
  expandBundle: (id: number) =>
    request<{ members: number }>(`/api/bundles/${id}/expand`, { method: 'POST' }),
  /** 整项目恢复：把删掉的项目重建出来，并把它还在回收站里的素材恢复且挂回去 */
  restoreTrashProject: (trashId: number) =>
    request<{ projectId: number; name: string; restored: number; skipped: number }>(
      `/api/trash/project/${trashId}/restore`,
      { method: 'POST' },
    ),
  /** 不带 ids = 清空回收站；带 ids = 彻底删除所选（不可恢复） */
  purgeTrash: (ids?: number[]) =>
    request<{
      assets: number; removedObjects: number; removedThumbs: number; removedPeaks: number; keptOriginalFiles: number;
    }>('/api/trash/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
    }),
  trash: (id: number) => request<{ movedObjects: string[]; referencedLeftAlone: number }>(`/api/trash/${id}`, { method: 'POST' }),
  restore: (id: number) => request<{ restored: number }>(`/api/restore/${id}`, { method: 'POST' }),
  verify: (hash = false) => request<VerifyReport>(`/api/verify${hash ? '?hash=1' : ''}`),
  text: async (id: number, max = 65536, includeTrashed = false) => {
    const headers: Record<string, string> = token ? { 'x-pm-token': token } : {};
    const res = await fetch(`/api/text/${id}?max=${max}${includeTrashed ? '&trashed=1' : ''}`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return { body: await res.text(), truncated: res.headers.get('X-Truncated') === 'true' };
  },
  /** 编辑用：取全文（上限与服务端一致），不是预览用的前 64KB */
  readFullText: (id: number) => api.text(id, 8 * 1024 * 1024),
  saveText: (id: number, body: string, writeOriginal = false) =>
    request<{
      assetId: number; hash: string; size: number; versions: number;
      wroteOriginal: boolean; originalError: string | null;
    }>(`/api/assets/${id}/save-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, writeOriginal }),
    }),
  versions: (id: number) =>
    request<{ items: Array<{ hash: string; size: number | null; savedAt: string; current: boolean }> }>(
      `/api/assets/${id}/versions`,
    ),
  scanStatus: () => request<ScanState>('/api/scan/status'),
  startScan: (dir?: string) =>
    request<{ started: boolean; target: string | null }>('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    }),
  importStatus: () => request<ImportState>('/api/import/status'),
  startImport: () =>
    request<{ started: boolean }>('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  openWithSystem: (id: number) => request<{ ok: boolean; error?: string }>(`/api/open/${id}`, { method: 'POST' }),
  /** 打开"打开方式"对话框（仅在用户点「更多程序…」时用） */
  openAs: (id: number) => request<{ ok: boolean; error?: string }>(`/api/open-as/${id}`, { method: 'POST' }),
  /** 本机能打开这个类型、且能被定位到的程序（自建选择器用它） */
  openWithList: (id: number) =>
    request<{
      ext: string;
      items: Array<{ id: string; label: string; exe: string; args: string[]; isDefault: boolean }>;
      unresolved: number;
    }>(`/api/open-with/${id}`),
  openWithUse: (id: number, candidateId: string) =>
    request<{ ok: boolean; label?: string }>(`/api/open-with/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: candidateId }),
    }),
  openWithSystemDialog: (id: number) =>
    request<{ ok: boolean }>(`/api/open-with/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useSystemDialog: true }),
    }),
  /** 文件浏览模式：按层列举目录、列出可浏览的起点、导入某个路径、在资源管理器中定位 */
  /** 直接读磁盘上的文本文件（默认只读；保存是显式动作，服务端会先留 .bak） */
  fsText: (path: string) => request<FsTextInfo>(`/api/fs/text?path=${encodeURIComponent(path)}`),
  fsWriteText: (path: string, body: string) =>
    request<{ path: string; bytes: number; mtime: string; backupPath: string | null }>('/api/fs/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, body }),
    }),
};

export const thumbSrc = (id: number): string => withToken(`/thumb/${id}`);
export const mediaSrc = (id: number): string => withToken(`/media/${id}`);
export const rawMediaSrc = (id: number): string => withToken(`/media/${id}`);
