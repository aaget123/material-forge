import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api, type ProjectRow } from '../api.ts';
import { MODALITY_META, MODALITY_ORDER, PROJECT_COLORS, projectColorOf, type Modality } from '../modality.tsx';
import { buildProjectTree, projectLabel } from '../projects.ts';
import { ModalityIcon } from './ModalityBadge.tsx';

interface Props {
  open: boolean;
  /** 预设的上级项目：从侧栏某个项目的「+」进来时用它建子项目 */
  parentId: number | null;
  projects: ProjectRow[];
  onClose: () => void;
  onCreated: (projectId: number) => void;
  onError: (message: string) => void;
}

/** 新建项目 / 子项目：名称 / 简介 / 上级项目 / 主要类型 / 标记颜色 */
export default function ProjectDialog({ open, parentId, projects, onClose, onCreated, onError }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parent, setParent] = useState<number | null>(parentId);
  const [modality, setModality] = useState<Modality>('mixed');
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const [busy, setBusy] = useState(false);

  // 每次打开都按调用方给的 parentId 重置，避免上一次选的上项目残留
  useEffect(() => {
    if (open) setParent(parentId);
  }, [open, parentId]);

  const options = useMemo(() => buildProjectTree(projects), [projects]);

  if (!open) return null;

  const isSub = parent !== null;
  const parentName = projects.find((project) => project.id === parent)?.name ?? '';

  const reset = (): void => {
    setName('');
    setDescription('');
    setModality('mixed');
    setColor(PROJECT_COLORS[0]);
  };

  const submit = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const project = await api.createProject({ name, description, color, modality, parentId: parent });
      reset();
      onCreated(project.id);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { reset(); onClose(); } }}>
      <div className="dialog dialog--sm" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <div className="dialog-head">
          <div>
            <h2 className="dialog-title" id="project-dialog-title">{isSub ? '新建子项目' : '新建项目'}</h2>
            <p className="dialog-desc">
              {isSub ? `建在「${parentName}」下面，父项目里会同时看到它的素材。` : '为一组素材建立一个项目，项目里还可以再分小项目。'}
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--icon-sm" aria-label="关闭" onClick={() => { reset(); onClose(); }}>
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <label className="field-label" htmlFor="project-parent">上级项目</label>
            <select
              id="project-parent"
              className="select"
              value={parent ?? ''}
              onChange={(event) => setParent(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">无（顶层项目）</option>
              {options.map((node) => (
                <option key={node.project.id} value={node.project.id}>{projectLabel(node)}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="project-name">项目名称</label>
            <input
              id="project-name"
              className="input"
              autoFocus
              value={name}
              placeholder={isSub ? '例如：第一场 · 海边' : '例如：短片《潮汐》'}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="project-desc">简介</label>
            <textarea
              id="project-desc"
              className="textarea"
              rows={2}
              value={description}
              placeholder="一句话描述这个项目"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="field">
            <span className="field-label">主要类型</span>
            <div className="modality-picker" role="radiogroup" aria-label="主要类型">
              {MODALITY_ORDER.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={modality === item}
                  className={modality === item ? 'is-active' : undefined}
                  onClick={() => setModality(item)}
                >
                  <ModalityIcon modality={item} size={14} />
                  {MODALITY_META[item].label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-label">标记颜色</span>
            <div className="color-picker" role="radiogroup" aria-label="标记颜色">
              {PROJECT_COLORS.map((item, index) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={projectColorOf(color) === item}
                  aria-label={`颜色 ${index + 1}`}
                  className={projectColorOf(color) === item ? 'is-active' : undefined}
                  style={{ background: `var(--${item})` }}
                  onClick={() => setColor(item)}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn--outline" onClick={() => { reset(); onClose(); }}>取消</button>
          <button type="button" className="btn btn--default" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? '创建中…' : isSub ? '创建子项目' : '创建项目'}
          </button>
        </div>
      </div>
    </div>
  );
}
