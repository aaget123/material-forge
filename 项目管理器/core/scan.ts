import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classify, type Kind } from './kind.ts';

export interface ScanEntry {
  absPath: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  mtime: string;
  ext: string;
  kind: Kind;
}

export interface WalkResult {
  files: ScanEntry[];
  skippedDirs: number;
  skippedExts: number;
  errors: string[];
}

export interface IgnoreRules {
  dirs: Set<string>;
  exts: Set<string>;
}

export function buildIgnore(dirs: string[], exts: string[]): IgnoreRules {
  return {
    dirs: new Set(dirs.map((d) => d.toLowerCase())),
    exts: new Set(exts.map((e) => e.toLowerCase())),
  };
}

function extOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * 递归扫描一个目录。默认忽略依赖目录与构建产物
 * （本机 3.46GB 素材里约 1.5GB 是 exe/依赖噪音，挡不住第一版就会被淹没）。
 */
export function walk(root: string, ignore: IgnoreRules): WalkResult {
  const files: ScanEntry[] = [];
  const errors: string[] = [];
  let skippedDirs = 0;
  let skippedExts = 0;

  const visit = (dir: string, relPrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`${dir}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const abs = join(dir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;

      if (entry.isDirectory()) {
        if (ignore.dirs.has(name.toLowerCase())) {
          skippedDirs++;
          continue;
        }
        visit(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extOfName(name);
      if (ext && ignore.exts.has(ext)) {
        skippedExts++;
        continue;
      }

      let size = 0;
      let mtimeMs = 0;
      try {
        const st = statSync(abs);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch (err) {
        errors.push(`${abs}: ${(err as Error).message}`);
        continue;
      }

      files.push({
        absPath: abs,
        relPath: rel,
        size,
        mtimeMs,
        mtime: new Date(mtimeMs).toISOString(),
        ext,
        kind: classify(abs),
      });
    }
  };

  visit(root, '');
  return { files, skippedDirs, skippedExts, errors };
}
