/**
 * 诊断工具：只看扫描器"会索引什么"，不写数据库。
 * 用来验证忽略规则是否真的挡住了依赖目录与构建产物。
 *
 *   node tools/walk-check.ts <内容目录>\岸宝桌宠
 */
import { loadConfig } from '../core/config.ts';
import { buildIgnore, walk } from '../core/scan.ts';

const target = process.argv[2];
if (!target) {
  console.error('用法: node tools/walk-check.ts <目录>');
  process.exit(1);
}

const cfg = loadConfig();
const ignore = buildIgnore(cfg.ignoreDirs, cfg.ignoreExts);
const started = Date.now();
const result = walk(target, ignore);
const elapsed = Date.now() - started;

const byKind = new Map<string, number>();
let bytes = 0;
for (const file of result.files) {
  byKind.set(file.kind, (byKind.get(file.kind) ?? 0) + 1);
  bytes += file.size;
}

console.log(`目录        : ${target}`);
console.log(`将索引      : ${result.files.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${elapsed}ms`);
console.log(`忽略目录    : ${result.skippedDirs} 个`);
console.log(`忽略后缀    : ${result.skippedExts} 个`);
console.log(`按类型      : ${[...byKind.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`读取错误    : ${result.errors.length}`);
for (const err of result.errors.slice(0, 5)) console.log(`  ! ${err}`);
