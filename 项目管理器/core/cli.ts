/**
 * core 的命令行入口。M0 的"真实入口"之一：先把索引与检索跑准，界面只是消费者。
 *
 *   node core/cli.ts scan [目录] [--force] [--limit N]
 *   node core/cli.ts stats
 *   node core/cli.ts search <关键词> [--kind image] [--limit 20]
 *   node core/cli.ts version
 *
 * M1：
 *   node core/cli.ts import [--root <路径>] [--limit N] [--force]     复制导入 + 哈希去重 + sidecar
 *   node core/cli.ts verify [--hash]                                  索引/对象/sidecar 一致性核对
 *   node core/cli.ts relink                                           库改名或搬家后重链
 *   node core/cli.ts rebuild [--wipe-managed]                         从 sidecar 重建索引
 *   node core/cli.ts trash <素材id> / restore <素材id>                 回收站
 *   node core/cli.ts manifest                                         生成校验和清单
 */
import { LIBRARY_DIR, loadConfig } from './config.ts';
import { openDb, sqliteVersion } from './db.ts';
import { indexRoot } from './indexer.ts';
import { getStats, humanSize, searchAssets } from './query.ts';
import { importToLibrary } from './importer.ts';
import { relink, rebuildFromSidecars, restoreAsset, trashAsset, verifyLibrary, writeChecksumManifest, ftsNeedsReindex, reindexFts } from './maintenance.ts';
import { backfillExcerpts } from './organize.ts';
import { libraryUsage, loadLibraryMeta } from './library.ts';

interface Args {
  _: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      _.push(token);
    }
  }
  return { _, flags };
}

function num(flags: Args['flags'], key: string): number | undefined {
  const v = flags.get(key);
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function cmdScan(args: Args): Promise<void> {
  const cfg = loadConfig();
  const target = args._[1] ?? cfg.roots[0]?.path;
  if (!target) {
    console.error('没有可扫描的目录');
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  console.log(`库目录 : ${LIBRARY_DIR}`);
  console.log(`扫描   : ${target}`);
  console.log(`SQLite : ${sqliteVersion(db)}`);
  let lastLine = '';
  const stats = await indexRoot(db, cfg, target, {
    force: args.flags.has('force'),
    limit: num(args.flags, 'limit'),
    onProgress: (p) => {
      const line = `[${p.phase}] ${p.processed}/${p.total} ${p.current}`.slice(0, 110);
      if (line !== lastLine) {
        lastLine = line;
        process.stdout.write(`\r${line.padEnd(110)}`);
      }
    },
  });
  process.stdout.write('\n');
  console.log('—— 扫描结果 ——');
  console.log(`扫描文件数 : ${stats.scanned}`);
  console.log(`新增        : ${stats.added}`);
  console.log(`更新        : ${stats.updated}`);
  console.log(`未变(跳过)  : ${stats.unchanged}`);
  console.log(`标记缺失    : ${stats.missing}`);
  console.log(`探测元数据  : ${stats.probed}`);
  console.log(`生成缩略图  : ${stats.thumbnails}（失败 ${stats.thumbFailed}）`);
  console.log(`忽略目录/后缀: ${stats.skippedDirs} / ${stats.skippedExts}`);
  console.log(`合并重复素材: ${stats.mergedDuplicates}`);
  console.log(`耗时        : ${(stats.durationMs / 1000).toFixed(1)}s`);
  const s = getStats(db);
  console.log('—— 库统计 ——');
  console.log(`素材 ${s.assets} 个，共 ${humanSize(s.bytes)}，缩略图 ${s.thumbnails} 张`);
  for (const k of s.byKind) console.log(`  ${k.label.padEnd(4)} ${String(k.count).padStart(5)}  ${humanSize(k.bytes)}`);
  db.close();
}

function cmdStats(): void {
  const db = openDb();
  const s = getStats(db);
  console.log(`库目录   : ${LIBRARY_DIR}`);
  console.log(`SQLite   : ${sqliteVersion(db)}`);
  console.log(`最近扫描 : ${s.lastScanAt ?? '（从未）'}`);
  console.log(`素材/文件: ${s.assets} / ${s.files}（缺失 ${s.missing}）`);
  console.log(`总大小   : ${humanSize(s.bytes)}   缩略图 ${s.thumbnails} 张`);
  for (const k of s.byKind) console.log(`  ${k.label.padEnd(4)} ${String(k.count).padStart(5)}  ${humanSize(k.bytes)}`);
  db.close();
}

function cmdSearch(args: Args): void {
  const q = args._[1] ?? '';
  if (!q) {
    console.error('用法: node core/cli.ts search <关键词> [--kind image] [--limit 20]');
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  const res = searchAssets(db, {
    q,
    kind: typeof args.flags.get('kind') === 'string' ? (args.flags.get('kind') as string) : undefined,
    limit: num(args.flags, 'limit') ?? 20,
  });
  console.log(`查询「${q}」 → ${res.total} 条（路径：${res.strategy}${res.ftsQuery ? `，FTS: ${res.ftsQuery}` : ''}）`);
  for (const item of res.items) {
    console.log(`  #${String(item.id).padStart(5)} [${item.kind}] ${item.title}  (${humanSize(item.size)})  ${item.sourcePath}`);
  }
  db.close();
}

function cmdVersion(): void {
  const db = openDb();
  console.log(`SQLite ${sqliteVersion(db)} / Node ${process.version}`);
  db.close();
}

async function cmdImport(args: Args): Promise<void> {
  const cfg = loadConfig();
  const db = openDb();
  loadLibraryMeta();
  const root = typeof args.flags.get('root') === 'string' ? (args.flags.get('root') as string) : undefined;
  console.log(`库目录 : ${LIBRARY_DIR}`);
  console.log(`导入来源: ${root ?? '全部引用型根目录'}`);
  let last = '';
  const stats = await importToLibrary(db, cfg, {
    rootPath: root,
    force: args.flags.has('force'),
    limit: num(args.flags, 'limit'),
    onProgress: (p) => {
      const line = `[${p.phase}] ${p.processed}/${p.total} ${p.current}`.slice(0, 110);
      if (line !== last) {
        last = line;
        process.stdout.write(`\r${line.padEnd(110)}`);
      }
    },
  });
  process.stdout.write('\n');
  console.log('—— 导入结果 ——');
  console.log(`候选素材      : ${stats.considered}`);
  console.log(`新复制对象    : ${stats.copied}（${humanSize(stats.bytesCopied)}）`);
  console.log(`命中哈希去重  : ${stats.dedupedByHash}`);
  console.log(`写入 sidecar  : ${stats.sidecarsWritten}`);
  console.log(`新建托管文件行: ${stats.managedFilesCreated}`);
  console.log(`合并重复素材  : ${stats.mergedAssets}`);
  console.log(`来源已缺失    : ${stats.skippedMissingSource}`);
  console.log(`耗时          : ${(stats.durationMs / 1000).toFixed(1)}s`);
  for (const err of stats.errors.slice(0, 5)) console.log(`  ! ${err}`);
  const usage = libraryUsage();
  console.log(`库内对象      : ${usage.objects} 个 / ${humanSize(usage.objectsBytes)}`);
  db.close();
}

function cmdVerify(args: Args): void {
  const db = openDb();
  const withHash = args.flags.has('hash');
  const report = verifyLibrary(db, { hash: withHash });
  console.log(`素材        : ${report.assets}（回收站 ${report.trashedAssets}）`);
  console.log(`文件行      : ${report.files} = 托管 ${report.managedFiles} + 引用 ${report.referencedFiles}`);
  console.log(`缩略图      : ${report.thumbnails}`);
  console.log(`库内对象    : ${report.objectsOnDisk} 个，sidecar ${report.sidecarsOnDisk} 个`);
  console.log(`对象无索引  : ${report.objectsWithoutDbRow}`);
  console.log(`索引无对象  : ${report.dbRowsWithoutObject}`);
  console.log(`对象无sidecar: ${report.assetsWithoutSidecar}`);
  console.log(`同内容多素材: ${report.duplicateHashGroups}`);
  console.log(`托管路径过期: ${report.managedPathsStale}（库搬过家时不为 0，跑 relink 修正）`);
  console.log(`托管对象丢失: ${report.managedFilesMissing}`);
  console.log(`缩略图缓存  : ${report.thumbFilesOnDisk} 个文件（孤儿 ${report.orphanThumbs}，可安全删除）`);
  if (withHash) {
    console.log(`哈希核对    : ${report.hashChecked} 个 / ${humanSize(report.hashedBytes)}，不匹配 ${report.hashMismatch}`);
  }
  const bad =
    report.objectsWithoutDbRow + report.dbRowsWithoutObject + report.duplicateHashGroups +
    report.managedPathsStale + report.managedFilesMissing + (withHash ? report.hashMismatch : 0);
  console.log(bad === 0 ? '结论        : 一致（无异常）' : `结论        : 有 ${bad} 项异常`);
  db.close();
}

function cmdRelink(): void {
  const db = openDb();
  const report = relink(db);
  console.log(`托管根目录  : ${report.managedRootRepaired ? '已修正为当前库路径' : '无需修正'}`);
  console.log(`托管文件    : 检查 ${report.managedFilesChecked}，修正路径 ${report.managedPathsFixed}`);
  console.log(`引用文件    : 检查 ${report.referencedChecked}`);
  console.log(`找不到文件  : ${report.missing.length}`);
  for (const path of report.missing.slice(0, 10)) console.log(`  ! ${path}`);
  db.close();
}

function cmdRebuild(args: Args): void {
  const db = openDb();
  const report = rebuildFromSidecars(db, { wipeManaged: args.flags.has('wipe-managed') });
  console.log(`库内对象    : ${report.objects}（有 sidecar ${report.sidecars}，无 sidecar ${report.withoutSidecar}）`);
  if (report.wipedFiles) console.log(`先清除托管文件行: ${report.wipedFiles}`);
  console.log(`新建素材    : ${report.assetsCreated}，复用既有素材 ${report.assetsReused}`);
  console.log(`新建文件行  : ${report.filesCreated}`);
  console.log(`重建全文索引: ${report.ftsRows}`);
  for (const err of report.errors.slice(0, 5)) console.log(`  ! ${err}`);
  console.log('提示：引用型素材重跑一次 scan 即可恢复（磁盘是真相源）。');
  db.close();
}

function cmdTrash(args: Args, mode: 'trash' | 'restore'): void {
  const id = Number(args._[1]);
  if (!Number.isFinite(id)) {
    console.error(`用法: node core/cli.ts ${mode} <素材id>`);
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  if (mode === 'trash') {
    const report = trashAsset(db, id);
    console.log(`素材 #${report.assetId}「${report.title}」`);
    if (report.alreadyTrashed) {
      console.log('已在回收站中，未做任何改动。');
    } else {
      console.log(`移入回收站的对象: ${report.movedObjects.length}`);
      console.log(`标记的文件行    : ${report.markedFiles}`);
      console.log(`引用型（原文件未动）: ${report.referencedLeftAlone}`);
      console.log('说明：原目录里的文件完全没有被移动或删除。');
    }
  } else {
    const report = restoreAsset(db, id);
    console.log(`已恢复素材 #${id}，涉及文件行 ${report.restored}`);
  }
  db.close();
}

function cmdManifest(): void {
  const db = openDb();
  const result = writeChecksumManifest(db);
  console.log(`校验和清单: ${result.path}`);
  console.log(`对象 ${result.entries} 个，合计 ${humanSize(result.totalBytes)}`);
  db.close();
}

/** 全文索引是纯派生数据：结构升级后或怀疑不一致时重建即可 */
function cmdReindex(): void {
  const db = openDb();
  const before = ftsNeedsReindex(db);
  const result = reindexFts(db);
  console.log(`重建前${before ? '不一致' : '一致'}，已重建全文索引 ${result.rows} 行`);
  const backfill = backfillExcerpts(db);
  console.log(`摘要回填: 检查 ${backfill.checked} 个，补齐 ${backfill.filled} 个`);
  db.close();
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

switch (cmd) {
  case 'scan':
    await cmdScan(args);
    break;
  case 'stats':
    cmdStats();
    break;
  case 'search':
    cmdSearch(args);
    break;
  case 'version':
    cmdVersion();
    break;
  case 'import':
    await cmdImport(args);
    break;
  case 'verify':
    cmdVerify(args);
    break;
  case 'relink':
    cmdRelink();
    break;
  case 'rebuild':
    cmdRebuild(args);
    break;
  case 'trash':
    cmdTrash(args, 'trash');
    break;
  case 'restore':
    cmdTrash(args, 'restore');
    break;
  case 'manifest':
    cmdManifest();
    break;
  case 'reindex':
    cmdReindex();
    break;
  default:
    console.log('用法:');
    console.log('  M0: scan [目录] [--force] [--limit N] | stats | search <关键词> [--kind k] | version');
    console.log('  M1: import [--root <路径>] [--limit N] [--force] | verify [--hash] | relink');
    console.log('      rebuild [--wipe-managed] | trash <id> | restore <id> | manifest | reindex');
    process.exitCode = cmd ? 1 : 0;
}
