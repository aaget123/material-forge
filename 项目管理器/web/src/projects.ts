/**
 * 项目树的前端组装。
 *
 * 后端已经把 parentId 和"含子项目的素材数"（totalCount）算好，
 * 这里只负责把扁平的列表排成树、算缩进深度、生成下拉框里的层级标签。
 * 三处 UI（侧栏、详情栏的项目下拉、添加素材的项目下拉）共用同一份顺序，
 * 避免"侧栏是树、下拉是乱的"这种不一致。
 */
import type { ProjectRow } from './api.ts';

export interface ProjectNode {
  project: ProjectRow;
  depth: number;
}

/** 缩进上限：层级再深也不再往右推，否则窄侧栏会被挤没 */
const MAX_INDENT = 2;

export function buildProjectTree(projects: ProjectRow[]): ProjectNode[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const childrenOf = new Map<number | null, ProjectRow[]>();
  for (const project of projects) {
    // 父项目不存在（比如数据被手工改过）时按顶层处理，不能让它从列表里消失
    const parent = project.parentId !== null && byId.has(project.parentId) ? project.parentId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(project);
    else childrenOf.set(parent, [project]);
  }

  const nodes: ProjectNode[] = [];
  const visited = new Set<number>();
  const walk = (parent: number | null, depth: number): void => {
    for (const project of childrenOf.get(parent) ?? []) {
      // 环保护：parent_id 若被改成环，这里会停下来而不是无限递归
      if (visited.has(project.id)) continue;
      visited.add(project.id);
      nodes.push({ project, depth });
      walk(project.id, depth + 1);
    }
  };
  walk(null, 0);

  // 环里的项目到不了根，兜底附在末尾，保证"一个都不少"
  for (const project of projects) {
    if (!visited.has(project.id)) nodes.push({ project, depth: 1 });
  }
  return nodes;
}

/**
 * 下拉框里的层级标签：只用全角空格缩进表达层级。
 * 原先在名字前加 `└ `，在等宽字体里看着就是多出来的一个 "L"（用户反馈），
 * 而且"多一个符号"本身也是界面上多余的字；层级用缩进表达即可，任何 `<option>` 都能显示。
 */
export function projectLabel(node: ProjectNode): string {
  const indent = '　'.repeat(Math.min(node.depth, MAX_INDENT));
  return `${indent}${node.project.name}`;
}

export function indentOf(depth: number): number {
  return Math.min(depth, MAX_INDENT) * 12;
}

/**
 * 一个项目及其所有后代的 id（含自身）。
 * 用于"删掉的项目正好是当前选中的那个"时把视图退回全部内容——
 * 不能靠"列表里找不到就清空选中"这种副作用式判断：
 * 新建项目的那一刻列表还没刷新，会把刚刚选中的新项目立刻取消掉（实测踩到）。
 */
export function subtreeIds(projects: ProjectRow[], id: number): number[] {
  const result = new Set<number>([id]);
  let frontier = [id];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const project of projects) {
      if (project.parentId === null || !frontier.includes(project.parentId)) continue;
      if (result.has(project.id)) continue;
      result.add(project.id);
      next.push(project.id);
    }
    frontier = next;
  }
  return [...result];
}
