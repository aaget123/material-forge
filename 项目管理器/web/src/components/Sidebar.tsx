import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, LayoutGrid, Plus, Settings, Trash2 } from 'lucide-react';
import { projectDotClass, type Modality } from '../modality.tsx';
import { ModalityIcon } from './ModalityBadge.tsx';
import { buildProjectTree, indentOf } from '../projects.ts';
import type { ProjectRow } from '../api.ts';

export type SideView = 'all' | 'trash';

interface Props {
  projects: ProjectRow[];
  assetCount: number;
  trashCount: number;
  librarySize: string;
  view: SideView;
  selectedProject: number | null;
  onSelectAll: () => void;
  onSelectTrash: () => void;
  onSelectProject: (id: number) => void;
  onCreateProject: () => void;
  onCreateSubProject: (parentId: number) => void;
  onDeleteProject: (project: ProjectRow) => void;
  /** 双击项目名就地重命名（可选：不传就只是不能改名） */
  onRenameProject?: (project: ProjectRow, name: string) => Promise<void> | void;
  onOpenLibrary: () => void;
}

export default function Sidebar({
  projects, assetCount, trashCount, librarySize,
  view, selectedProject, onSelectAll, onSelectTrash, onSelectProject,
  onCreateProject, onCreateSubProject, onDeleteProject, onRenameProject, onOpenLibrary,
}: Props): React.ReactElement {
  // 默认全部展开：子项目是被用户主动分出来的，藏起来反而像是丢了
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const nodes = useMemo(() => buildProjectTree(projects), [projects]);
  const parentsWithChildren = useMemo(
    () => new Set(nodes.filter((node) => node.project.childCount > 0).map((node) => node.project.id)),
    [nodes],
  );

  // 折叠一个项目时，它的整棵子树都要跟着隐藏，所以按深度逐层过滤
  const visibleNodes = useMemo(() => {
    const hidden = new Set<number>();
    const result: typeof nodes = [];
    for (const node of nodes) {
      if (node.project.parentId !== null && hidden.has(node.project.parentId)) {
        hidden.add(node.project.id);
        continue;
      }
      if (collapsed.has(node.project.id)) hidden.add(node.project.id);
      result.push(node);
    }
    return result;
  }, [nodes, collapsed]);

  const toggleCollapsed = (id: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">素</div>
        <span className="brand-name">素材工坊</span>
      </div>

      <nav className="side-nav" aria-label="主导航">
        <button
          type="button"
          className={`side-item${view === 'all' && selectedProject === null ? ' is-active' : ''}`}
          aria-current={view === 'all' && selectedProject === null ? 'page' : undefined}
          onClick={onSelectAll}
        >
          <span className="side-item-icon"><LayoutGrid size={16} /></span>
          <span className="side-item-label truncate">全部内容</span>
          {assetCount > 0 ? <span className="side-item-count">{assetCount}</span> : null}
        </button>
        <button
          type="button"
          className={`side-item${view === 'trash' ? ' is-active' : ''}`}
          aria-current={view === 'trash' ? 'page' : undefined}
          onClick={onSelectTrash}
        >
          <span className="side-item-icon"><Inbox size={16} /></span>
          <span className="side-item-label truncate">回收站</span>
          {trashCount > 0 ? <span className="side-item-count">{trashCount}</span> : null}
        </button>
      </nav>

      <div className="side-group-head">
        <span>我的项目</span>
        <button type="button" className="btn btn--ghost btn--icon-sm" aria-label="新建项目" title="新建项目" onClick={onCreateProject}>
          <Plus size={16} />
        </button>
      </div>
      <ul className="side-list">
        {visibleNodes.map((node) => {
          const { project, depth } = node;
          const active = view === 'all' && selectedProject === project.id;
          const hasChildren = parentsWithChildren.has(project.id);
          const isCollapsed = collapsed.has(project.id);
          const countHint = project.childCount > 0 ? '（含子项目）' : '';
          return (
            <li key={project.id} className="side-row" style={{ paddingLeft: indentOf(depth) }}>
              {hasChildren ? (
                <button
                  type="button"
                  className="side-twisty"
                  aria-label={isCollapsed ? `展开 ${project.name} 的子项目` : `折叠 ${project.name} 的子项目`}
                  aria-expanded={!isCollapsed}
                  onClick={(event) => { event.stopPropagation(); toggleCollapsed(project.id); }}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="side-twisty side-twisty--empty" aria-hidden />
              )}
              <button
                type="button"
                className={`side-item side-item--tree${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={`${project.name}：本项目 ${project.count} 件${countHint}`}
                onClick={() => onSelectProject(project.id)}
                  onDoubleClick={() => { if (!onRenameProject) return; setEditingId(project.id); setDraft(project.name); }}
              >
                <span className="side-item-icon">
                  <ModalityIcon modality={(project.modality ?? 'mixed') as Modality} size={15} />
                  <span className={projectDotClass(project.color)} aria-hidden />
                </span>
                {editingId === project.id ? (
                    <input
                      className="side-rename-input"
                      value={draft}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          const name = draft;
                          setEditingId(null);
                          void onRenameProject?.(project, name);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => setEditingId(null)}
                    />
                  ) : (
                    <span className="side-item-label truncate">{project.name}</span>
                  )}
                {project.totalCount > 0 ? <span className="side-item-count">{project.totalCount}</span> : null}
              </button>
              <span className="side-row-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--icon-sm"
                  aria-label={`在 ${project.name} 下新建子项目`}
                  title="新建子项目"
                  onClick={(event) => { event.stopPropagation(); onCreateSubProject(project.id); }}
                >
                  <Plus size={13} />
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon-sm"
                  aria-label={`删除项目 ${project.name}`}
                  title="删除项目"
                  onClick={(event) => { event.stopPropagation(); onDeleteProject(project); }}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </li>
          );
        })}
        {projects.length === 0 ? (
          <li><p className="muted" style={{ margin: '4px 8px', fontSize: 12 }}>还没有项目，点右上 + 新建</p></li>
        ) : null}
      </ul>

      <div className="side-footer">
        <div className="avatar">我</div>
        <div className="side-footer-text">
          <p className="side-footer-name">个人空间</p>
          <p className="side-footer-sub truncate">{librarySize}</p>
        </div>
        <button type="button" className="btn btn--ghost btn--icon-sm" aria-label="库信息与完整性核对" title="库信息与完整性核对" onClick={onOpenLibrary}>
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}
