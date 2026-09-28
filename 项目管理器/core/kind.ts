/** 素材大类。M0 只做分类与索引，去重合并留给 M1。 */
export type Kind = 'image' | 'video' | 'audio' | 'music' | 'document' | 'code' | 'note' | 'other';

export const ALL_KINDS: Kind[] = ['image', 'video', 'audio', 'music', 'document', 'code', 'note', 'other'];

export const KIND_LABEL: Record<Kind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  music: '音乐',
  document: '文档',
  code: '代码',
  note: '笔记',
  other: '其他',
};

const EXT_KIND: Record<string, Kind> = {};

function put(kind: Kind, exts: string[]): void {
  for (const e of exts) EXT_KIND[e] = kind;
}

put('image', [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.apng',
  '.svg', '.psd', '.raw', '.cr2', '.nef', '.arw', '.dng', '.ico', '.jfif',
]);
put('video', [
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.rmvb', '.3gp', '.vob',
]);
put('audio', ['.wav', '.aac', '.ogg', '.opus', '.amr', '.aiff', '.aif', '.wma', '.pcm', '.caf']);
put('music', ['.mp3', '.flac', '.m4a', '.ape', '.wv', '.tta', '.dsf', '.mid', '.midi']);
put('document', [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.rtf', '.epub', '.mobi', '.odt', '.ods',
]);
put('note', ['.md', '.markdown', '.txt', '.text', '.rst', '.org']);
put('code', [
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.pyi', '.java', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.sql', '.yaml', '.yml',
  '.toml', '.ini', '.json', '.jsonc', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte',
  '.lua', '.kt', '.kts', '.swift', '.dart', '.r', '.pl', '.f90', '.f95', '.f', '.for', '.asm', '.s', '.gradle',
]);

export function extOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('\\') + 1).split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function classify(filePath: string): Kind {
  return EXT_KIND[extOf(filePath)] ?? 'other';
}

/** `.mts` / `.ts` 既可能是 TypeScript 模块，也可能是 MPEG-TS 视频。
 *  用 ffprobe 结果校正：探到视频流就按视频算（M0 用真实文件验证过这个歧义）。 */
export function refineKind(initial: Kind, probe: { hasVideo: boolean; hasAudio: boolean } | null): Kind {
  if (!probe) return initial;
  if (probe.hasVideo && (initial === 'code' || initial === 'other')) return 'video';
  return initial;
}

export function isProbablyText(kind: Kind): boolean {
  return kind === 'code' || kind === 'note' || kind === 'document';
}

/** 可直接按文本预览的扩展名（PDF/Office 这类二进制文档不算） */
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst', '.org', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.csv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts',
  '.mts', '.cts', '.tsx', '.py', '.pyi', '.java', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.go', '.rs',
  '.rb', '.php', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.sql', '.vue', '.svelte', '.lua', '.kt', '.kts',
  '.swift', '.dart', '.r', '.pl', '.f90', '.f95', '.f', '.for', '.asm', '.gradle',
]);

export function isTextExt(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

/** 能算波形、能走音频专注模式的扩展名 */
const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif', '.ape', '.wv', '.amr',
]);

export function isAudioExt(ext: string): boolean {
  return AUDIO_EXTS.has(ext.toLowerCase());
}

/**
 * 面向界面的"模态"分类（对齐参考设计的 7 类）。
 * 与内部 kind 的区别：kind 按文件类型分 8 类，modality 按用户认知分 7 类，
 * 其中 note + document 合并为「文本」，audio 叫「声音」，无法归类的算「综合」。
 */
export type Modality = 'text' | 'code' | 'image' | 'video' | 'music' | 'voice' | 'mixed';

export const MODALITY_ORDER: Modality[] = ['text', 'code', 'image', 'video', 'music', 'voice', 'mixed'];

export const MODALITY_LABEL: Record<Modality, string> = {
  text: '文本',
  code: '代码',
  image: '图片',
  video: '视频',
  music: '音乐',
  voice: '声音',
  mixed: '综合',
};

export function modalityOf(kind: Kind): Modality {
  switch (kind) {
    case 'note':
    case 'document':
      return 'text';
    case 'code':
      return 'code';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'music':
      return 'music';
    case 'audio':
      return 'voice';
    default:
      return 'mixed';
  }
}
