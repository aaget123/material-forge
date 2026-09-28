/**
 * 整理项目库的小工具（我用来出方案 / 执行 / 撤销）。
 *
 * 用法（在 项目管理器 目录下）：
 *   node --no-warnings tools/tidy.ts plan                 # 只读：打印方案
 *   node --no-warnings tools/tidy.ts apply --parent 3     # 应用（parent 3 = 建成它的子项目）
 *   node --no-warnings tools/tidy.ts undo --journal 1     # 撤销某一次整理
 */
import { openDb } from '../core/db.ts';
import { applyTidy, planTidy, undoTidy } from '../core/tidy.ts';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | null => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] ?? null : null;
};

const db = openDb();

if (command === 'plan' || command === undefined) {
  const parent = flag('parent');
  const plan = planTidy(db, {
    parentProjectId: parent ? Number(parent) : null,
    fallbackName: flag('fallback') ?? undefined,
    prefixTitleWithGroup: flag('no-prefix') === null,
  });
  console.log(`素材 ${plan.assets} 件 → 分组 ${plan.groups.length} 个`);
  console.log(`建成：${plan.createAsSubProject ? `「${plan.parentProjectName}」的子项目` : '顶层项目'}｜兜底分组名：${plan.fallbackName}`);
  console.log('\n分组：');
  for (const group of plan.groups) {
    const exts = Object.entries(group.byExt).map(([ext, count]) => `${ext}×${count}`).join(' ');
    console.log(`  ${group.name}  ${group.assetIds.length} 件  ${(group.bytes / 1048576).toFixed(1)} MB  ${exts}`);
  }
  console.log(`\n标题会改的：${plan.renames.length} 件`);
  for (const rename of plan.renames.slice(0, 12)) console.log(`  #${rename.assetId}「${rename.from}」→「${rename.to}」`);
  if (plan.renames.length > 12) console.log(`  …… 还有 ${plan.renames.length - 12} 件`);
} else if (command === 'apply') {
  const parent = flag('parent');
  const only = flag('only');
  const plan = planTidy(db, {
    parentProjectId: parent ? Number(parent) : null,
    fallbackName: flag('fallback') ?? undefined,
    prefixTitleWithGroup: flag('no-prefix') === null,
  });
  const result = applyTidy(db, plan, only ? { only: only.split(',') } : {});
  console.log(`已应用（记账号 #${result.journalId}）：新建/复用项目 ${result.createdProjects.length} 个，涉及素材 ${result.linkedAssets} 件，改标题 ${result.renamed} 件`);
  for (const project of result.createdProjects) console.log(`  项目 #${project.id} ${project.name}（${project.assets} 件）`);
  console.log('要撤销就运行：node --no-warnings tools/tidy.ts undo --journal ' + result.journalId);
} else if (command === 'undo') {
  const journal = Number(flag('journal'));
  if (!journal) throw new Error('需要 --journal <记账号>');
  const result = undoTidy(db, journal);
  console.log(`已撤销 #${journal}：恢复标题 ${result.restoredTitles} 件，删除整理时新建的空项目 ${result.removedProjects} 个`);
} else {
  console.log('未知命令。可用：plan / apply / undo');
}
db.close();
