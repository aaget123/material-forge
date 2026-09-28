/**
 * 重新链接的小工具（我用来出方案 / 执行 / 撤销）。
 *
 * 用法（在 项目管理器 目录下）：
 *   node --no-warnings tools/relink.ts health                 # 体检：引用型记录多少条有效、多少条断了
 *   node --no-warnings tools/relink.ts plan --roots <内容目录>\<个人素材目录>   # 只读：扫描并列出能找回/找不回的
 *   node --no-warnings tools/relink.ts apply --roots ...      # 执行（记进 tidy_journal，可撤销）
 *   node --no-warnings tools/relink.ts undo --journal 2       # 撤销
 */
import { openDb } from '../core/db.ts';
import { applyRelink, planRelink, relinkHealth, undoRelink } from '../core/relink.ts';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | null => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] ?? null : null;
};
const roots = (flag('roots') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
// 库自己的目录永远不扫，避免把库内对象当成"磁盘上的源文件"
const skip = [...(flag('skip')?.split(',') ?? []), 'D:\\素材库'];

const db = openDb();

if (command === 'health' || command === undefined) {
  const health = relinkHealth(db);
  console.log(`引用型记录 ${health.referenced} 条，其中磁盘上找不到的 ${health.broken} 条`);
} else if (command === 'plan') {
  const plan = planRelink(db, roots, { skip });
  console.log(`扫描 ${plan.roots.join('、')}：${plan.scannedFiles} 个文件，其中算了哈希的 ${plan.hashedFiles} 个`);
  console.log(`断掉的引用 ${plan.broken.length} 条 → 能按内容找回 ${plan.matches.length} 条，找不回 ${plan.unmatched.length} 条`);
  for (const match of plan.matches.slice(0, 10)) {
    console.log(`  找回 #${match.assetId}「${match.title}」\n    旧: ${match.oldPath}\n    新: ${match.newPath}`);
  }
  if (plan.matches.length > 10) console.log(`  …… 还有 ${plan.matches.length - 10} 条`);
  for (const miss of plan.unmatched.slice(0, 10)) {
    console.log(`  找不回 #${miss.assetId}「${miss.title}」 原位置: ${miss.oldPath}`);
  }
} else if (command === 'apply') {
  const plan = planRelink(db, roots, { skip });
  if (plan.matches.length === 0) {
    console.log('没有可重新链接的文件，未做任何改动');
  } else {
    const result = applyRelink(db, plan);
    console.log(`已重新链接 ${result.relinked} 条（记账 #${result.journalId}）`);
    console.log(`撤销：node --no-warnings tools/relink.ts undo --journal ${result.journalId}`);
  }
} else if (command === 'undo') {
  const journal = Number(flag('journal'));
  if (!journal) throw new Error('需要 --journal <记账号>');
  const result = undoRelink(db, journal);
  console.log(`已撤销 #${journal}：恢复 ${result.restored} 条引用`);
} else {
  console.log('未知命令。可用：health / plan / apply / undo');
}
db.close();
