/**
 * 库的物理布局与 sidecar。
 *
 *   D:\素材库\
 *     library.json                 库标识
 *     index.db                     索引（可删除、可重建）
 *     objects\ab\cd\<hash>.png     内容寻址的托管副本
 *     objects\ab\cd\<hash>.png.json  sidecar：标签/项目/备注/评级/来源
 *     trash\                       回收站（软删除）
 *     manifests\                   校验和清单
 *
 * 为什么内容寻址 + sidecar（开发建议 D2/D3）：
 *  - 对象路径由内容哈希推导，所以库目录整体改名/搬家后引用不会断（relink 一步修好）；
 *  - 元数据同时落在对象旁边，数据库只是索引：删掉 index.db 也能凭 objects/*.json 重建。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIBRARY_DIR } from './config.ts';

export const LIBRARY_META_FILE = join(LIBRARY_DIR, 'library.json');
export const OBJECTS_DIR = join(LIBRARY_DIR, 'objects');
export const TRASH_DIR = join(LIBRARY_DIR, 'trash');
export const MANIFESTS_DIR = join(LIBRARY_DIR, 'manifests');

export interface LibraryMeta {
  version: number;
  libraryId: string;
  createdAt: string;
}

export function ensureLibraryLayout(): void {
  for (const dir of [OBJECTS_DIR, TRASH_DIR, MANIFESTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function loadLibraryMeta(): LibraryMeta {
  ensureLibraryLayout();
  if (existsSync(LIBRARY_META_FILE)) {
    return JSON.parse(readFileSync(LIBRARY_META_FILE, 'utf8')) as LibraryMeta;
  }
  const meta: LibraryMeta = { version: 1, libraryId: randomUUID(), createdAt: new Date().toISOString() };
  writeFileSync(LIBRARY_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** objects\ab\cd\<hash><ext> 中的相对部分（相对 objects 目录） */
export function objectRelPath(hash: string, ext: string): string {
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${ext}`;
}

export function objectAbsPath(hash: string, ext: string): string {
  return join(OBJECTS_DIR, objectRelPath(hash, ext));
}

export function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface SidecarSource {
  rootPath: string;
  relPath: string;
}

/** sidecar 必须足以重建数据库：一个素材行 + 一个托管文件行 */
export interface Sidecar {
  schema: 1;
  hash: string;
  hashAlgo: 'sha256';
  ext: string;
  kind: string;
  title: string;
  size: number;
  capturedAt: string | null;
  importedAt: string;
  rating: number | null;
  note: string;
  tags: string[];
  projects: string[];
  meta: unknown;
  source: SidecarSource | null;
  /** 生成该素材的模型（可空，用户可后改） */
  model?: string | null;
  /** 文本/代码摘要，便于脱离数据库也能看到内容线索 */
  excerpt?: string | null;
}

export function sidecarPathOf(objectPath: string): string {
  return `${objectPath}.json`;
}

export function readSidecar(sidecarPath: string): Sidecar | null {
  try {
    return JSON.parse(readFileSync(sidecarPath, 'utf8')) as Sidecar;
  } catch {
    return null;
  }
}

export function writeSidecar(sidecarPath: string, data: Sidecar): void {
  ensureDirFor(sidecarPath);
  writeFileSync(sidecarPath, JSON.stringify(data, null, 2), 'utf8');
}

export function objectExists(hash: string, ext: string): boolean {
  return existsSync(objectAbsPath(hash, ext));
}

export interface ObjectEntry {
  objectPath: string;
  sidecarPath: string;
  relPath: string;
  hash: string;
  ext: string;
  size: number;
  sidecar: Sidecar | null;
}

/** 遍历 objects 下的所有对象（含没有 sidecar 的，便于完整性核对） */
export function listObjects(): ObjectEntry[] {
  const out: ObjectEntry[] = [];
  if (!existsSync(OBJECTS_DIR)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.json')) continue;
      const relPath = abs.slice(OBJECTS_DIR.length + 1).replace(/\\/g, '/');
      const sidecarPath = sidecarPathOf(abs);
      const dot = entry.name.lastIndexOf('.');
      out.push({
        objectPath: abs,
        relPath,
        sidecarPath,
        hash: dot > 0 ? entry.name.slice(0, dot) : entry.name,
        ext: dot > 0 ? entry.name.slice(dot) : '',
        size: statSync(abs).size,
        sidecar: existsSync(sidecarPath) ? readSidecar(sidecarPath) : null,
      });
    }
  };
  walk(OBJECTS_DIR);
  return out;
}

/** 把原文件复制成托管对象；已存在同内容对象时返回 false（即命中哈希去重） */
export function copyIntoLibrary(sourcePath: string, hash: string, ext: string): { copied: boolean; objectPath: string } {
  const target = objectAbsPath(hash, ext);
  if (existsSync(target)) return { copied: false, objectPath: target };
  ensureDirFor(target);
  copyFileSync(sourcePath, target);
  return { copied: true, objectPath: target };
}

/** 库内总占用（objects + trash） */
export function libraryUsage(): { objects: number; objectsBytes: number; trash: number; trashBytes: number } {
  const count = (dir: string): { count: number; bytes: number } => {
    if (!existsSync(dir)) return { count: 0, bytes: 0 };
    let n = 0;
    let b = 0;
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const abs = join(d, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && !entry.name.endsWith('.json')) {
          n++;
          b += statSync(abs).size;
        }
      }
    };
    walk(dir);
    return { count: n, bytes: b };
  };
  const obj = count(OBJECTS_DIR);
  const tr = count(TRASH_DIR);
  return { objects: obj.count, objectsBytes: obj.bytes, trash: tr.count, trashBytes: tr.bytes };
}
