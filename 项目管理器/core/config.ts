import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 代码与数据分开：数据默认放在**程序目录下的 素材库/**（可用环境变量 PM_LIBRARY 指向别处）。
 */
export const LIBRARY_DIR = process.env['PM_LIBRARY'] ?? join(process.cwd(), '素材库');
export const DB_FILE = join(LIBRARY_DIR, 'index.db');
export const DERIVED_DIR = join(LIBRARY_DIR, 'derived');
export const THUMB_DIR = join(DERIVED_DIR, 'thumbs');
/** 音频波形缓存：同样按内容哈希命名（见 core/peaks.ts） */
export const PEAKS_DIR = join(DERIVED_DIR, 'peaks');
export const CONFIG_FILE = join(LIBRARY_DIR, 'config.json');
export const RUNTIME_FILE = join(LIBRARY_DIR, 'runtime.json');

/**
 * 缩略图按**内容哈希**命名，而不是按 asset.id。
 * 原因：asset.id 会在"删库重建"后重新分配，按 id 命名的缓存会整批失效；
 * 内容寻址的缓存与 objects/ 一致，库重建、搬家、多份索引都能复用。
 */
export function thumbPathForHash(hash: string): string {
  return join(THUMB_DIR, `${hash}.webp`);
}

/** M0 的默认扫描目标：113 个真实文件，含 mp4 与 png */
export const DEFAULT_SCAN_DIR = '';

export type RootMode = 'managed' | 'referenced';

export interface RootConfig {
  path: string;
  mode: RootMode;
  enabled: boolean;
}

export interface LibraryConfig {
  version: number;
  libraryId: string;
  roots: RootConfig[];
  ignoreDirs: string[];
  ignoreExts: string[];
  server: { port: number };
  ffmpegDir: string;
}

/** 依赖与构建产物目录：本机 3.46GB 里约 1.5GB 是这类文件，必须默认挡住 */
const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out',
  '.next', '.cache', '.turbo', 'coverage', '.idea', '.vscode', '.workbuddy', 'ffmpeg-9.0-full_build',
];

const DEFAULT_IGNORE_EXTS = [
  '.pyc', '.pyo', '.map', '.pak', '.pyd', '.lib', '.obj', '.o', '.so', '.dll', '.tmp', '.log', '.lock',
];

export const DEFAULT_FFMPEG_DIR = '';

export function ensureLibraryDirs(): void {
  for (const dir of [LIBRARY_DIR, DERIVED_DIR, THUMB_DIR, PEAKS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function defaultConfig(): LibraryConfig {
  return {
    version: 1,
    libraryId: randomUUID(),
    roots: [{ path: DEFAULT_SCAN_DIR, mode: 'referenced', enabled: true }],
    ignoreDirs: [...DEFAULT_IGNORE_DIRS],
    ignoreExts: [...DEFAULT_IGNORE_EXTS],
    server: { port: 8756 },
    ffmpegDir: process.env['PM_FFMPEG_DIR'] ?? DEFAULT_FFMPEG_DIR,
  };
}

/** 读取库配置；缺失时创建默认配置（M0 只有一个引用型根目录，不搬动任何原文件） */
export function loadConfig(): LibraryConfig {
  ensureLibraryDirs();
  if (!existsSync(CONFIG_FILE)) {
    const cfg = defaultConfig();
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
  }
  const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<LibraryConfig>;
  const base = defaultConfig();
  return {
    ...base,
    ...parsed,
    roots: parsed.roots ?? base.roots,
    ignoreDirs: parsed.ignoreDirs ?? base.ignoreDirs,
    ignoreExts: parsed.ignoreExts ?? base.ignoreExts,
    server: { ...base.server, ...(parsed.server ?? {}) },
  };
}

export function saveConfig(cfg: LibraryConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
