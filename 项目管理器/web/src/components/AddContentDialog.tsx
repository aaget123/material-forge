import { useEffect, useMemo, useRef, useState } from 'react';
import { HardDriveDownload, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { api, type ProjectRow } from '../api.ts';
import { MODALITY_META, MODALITY_ORDER, type Modality } from '../modality.tsx';
import { buildProjectTree, projectLabel } from '../projects.ts';
import { ModalityIcon } from './ModalityBadge.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  projects: ProjectRow[];
  defaultProjectId: number | null;
  onAdded: (assetId: number) => void;
  onRescan: () => void;
  onImportLibrary: () => void;
  libraryBusy: boolean;
  onError: (message: string) => void;
}

const ACCEPT = 'image/*,video/*,audio/*,.txt,.md,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.css,.html,.sql,.json';
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.css', '.html', '.sql', '.json', '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.bat', '.yaml', '.yml', '.toml']);

function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index).toLowerCase() : '';
}

function modalityOfFile(file: File): Modality {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'voice';
  return CODE_EXTS.has(extOf(file.name)) ? 'code' : 'text';
}

function humanSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 追加去重用的键：同名同大小同修改时间视为同一个文件 */
function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** 添加素材：上传文件，或直接粘贴文本与代码；底部保留本工具的库操作入口 */
export default function AddContentDialog({
  open, onClose, projects, defaultProjectId, onAdded, onRescan, onImportLibrary, libraryBusy, onError,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId);
  const [modality, setModality] = useState<Modality>('image');
  const [body, setBody] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  // 每次打开按当前选中的项目重置，避免上次的归属残留
  useEffect(() => {
    if (open) setProjectId(defaultProjectId);
  }, [open, defaultProjectId]);

  const projectOptions = useMemo(() => buildProjectTree(projects), [projects]);

  if (!open) return null;

  const isMixed = modality === 'mixed';
  const isTextLike = modality === 'text' || modality === 'code';
  // 综合模式下既能收文件也能收一段文本，所以两种输入都亮出来
  const wantsBody = isTextLike || isMixed;
  const hasFiles = files.length > 0;
  const hasBody = wantsBody && body.trim().length > 0;
  // 多文件时每件用文件名当标题，一个标题管不了十件东西，所以只有"文本素材"才强制标题
  const titleNeeded = hasBody;
  const canSubmit = !busy && (hasFiles || hasBody) && (!titleNeeded || Boolean(title.trim()));

  const distinctModalities = new Set(files.map(modalityOfFile));
  /** 点一次「添加」会真正产生几件素材：每个文件一件，粘贴的文本再加一件 */
  const submitCount = files.length + (hasBody ? 1 : 0);

  const reset = (): void => {
    setFiles([]);
    setTitle('');
    setModel('');
    setBody('');
    setModality('image');
    setProjectId(defaultProjectId);
    setDragging(false);
  };

  const takeFiles = (list: FileList | null): void => {
    if (!list || list.length === 0) return;
    const incoming = [...list];
    setFiles((prev) => {
      // 追加而不是覆盖：拖两次等于选了两次，替换会把上一次的选择悄悄丢掉
      const seen = new Set(prev.map(fileKey));
      return [...prev, ...incoming.filter((file) => !seen.has(fileKey(file)))];
    });
    const kinds = new Set([...files, ...incoming].map(modalityOfFile));
    // 一次拖进来多种类型 = 用户在做「综合」这件事，替他切过去
    if (kinds.size > 1) setModality('mixed');
    else if (!isMixed && incoming[0]) setModality(modalityOfFile(incoming[0]));
    if (!title.trim() && incoming.length === 1 && incoming[0]) setTitle(incoming[0].name.replace(/\.[^.]+$/, ''));
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      let lastId = 0;
      /** 这一次加进库的素材 id（综合模式下要把它们组成一组） */
      const addedIds: number[] = [];
      if (hasFiles) {
        for (const [index, file] of files.entries()) {
          const result = await api.upload(file, {
            // 只有单文件时才用标题；多文件各用各的文件名，避免一个标题套十件东西
            title: files.length === 1 && index === 0 ? title.trim() || undefined : undefined,
            model,
            projectId,
          });
          lastId = result.assetId;
          addedIds.push(result.assetId);
        }
      }
      if (hasBody) {
        const result = await api.createTextAsset({
          title: title.trim() || '未命名文本',
          body,
          ext: modality === 'code' ? '.txt' : '.md',
          model,
          projectId,
          modality: modality === 'code' ? 'code' : 'text',
        });
        lastId = result.assetId;
        addedIds.push(result.assetId);
      }
      // 一次加进来两件以上（综合模式最常见）→ 组成一组：
      // 用户反馈"综合里加的内容被分开放了"，它们本来就是一组的。
      if (addedIds.length > 1) {
        try {
          await api.createBundle(
            title.trim() || `综合内容 · ${new Date().toLocaleDateString('zh-CN')}`,
            addedIds,
          );
        } catch (err) {
          // 建组失败不该让"素材已经进库"这件事看起来失败
          onError(`素材已入库，但组没能建起来：${(err as Error).message}`);
        }
      }
      if (lastId > 0) {
        reset();
        onAdded(lastId);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { reset(); onClose(); } }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-dialog-title">
        <div className="dialog-head">
          <div>
            <h2 className="dialog-title" id="add-dialog-title">添加素材</h2>
            
          </div>
          <button type="button" className="btn btn--ghost btn--icon-sm" aria-label="关闭" onClick={() => { reset(); onClose(); }}>
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body">
          {files.length === 0 ? (
            <div
              className={`dropzone${dragging ? ' is-over' : ''}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                takeFiles(event.dataTransfer.files);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }}
            >
              <Upload size={20} />
              <span className="dropzone-title">点击或拖拽文件到这里</span>
              <span className="dropzone-hint">支持图片、视频、音频、文本与代码文件，可多选（原文件不会被移动）</span>
            </div>
          ) : (
            <>
              {files.map((file, index) => (
                <div className="file-row" key={fileKey(file)}>
                  {file.type.startsWith('image/') ? (
                    <img className="file-thumb" src={URL.createObjectURL(file)} alt={file.name} />
                  ) : (
                    <span className="file-ext">{extOf(file.name).replace('.', '') || '?'}</span>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p className="file-name truncate">{file.name}</p>
                    <p className="file-sub">{humanSize(file.size)}</p>
                  </div>
                  <span className="file-type">{MODALITY_META[modalityOfFile(file)].label}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon-sm"
                    aria-label="移除文件"
                    onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--outline btn--sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => fileInput.current?.click()}
              >
                <Plus size={14} /> 继续添加文件
              </button>
            </>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(event) => { takeFiles(event.target.files); event.target.value = ''; }}
          />

          <div className="field">
            <label className="field-label" htmlFor="add-title">标题</label>
            <input
              id="add-title"
              className="input"
              value={title}
              placeholder={hasFiles && files.length > 1 ? '留空则用文件名' : '例如：开场海浪镜头'}
              onChange={(event) => setTitle(event.target.value)}
            />
            {hasFiles && files.length > 1 ? (
              <p className="field-hint">一次加了 {files.length} 件：每件用各自的文件名，标题只用于下面粘贴的文本。</p>
            ) : null}
          </div>

          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="add-project">所属项目</label>
              <select
                id="add-project"
                className="select"
                value={projectId ?? ''}
                onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">未归档</option>
                {projectOptions.map((node) => (
                  <option key={node.project.id} value={node.project.id}>{projectLabel(node)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="add-model">生成模型</label>
              <input
                id="add-model"
                className="input"
                value={model}
                placeholder="例如：Seedance、豆包、MiMo"
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <span className="field-label">类型</span>
            <div className="modality-picker" role="radiogroup" aria-label="内容类型">
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
            {isMixed ? (
              <p className="field-hint">
                综合 = 一次加入多种类型：可同时选图片、视频、音频、文本、代码，也可以接着粘贴一段文本。
                每件内容按它自己的后缀归类，分别成为独立素材（{distinctModalities.size > 0 ? `本次已选 ${distinctModalities.size} 种类型` : '当前还没选文件'}）。
              </p>
            ) : hasFiles ? (
              <p className="field-hint">
                文件按后缀自动归类，实际类型见每行右侧标签；这里的类型选择只影响下面粘贴的文本。
              </p>
            ) : null}
          </div>

          {wantsBody ? (
            <div className="field">
              <label className="field-label" htmlFor="add-body">内容</label>
              <textarea
                id="add-body"
                className="textarea"
                rows={4}
                value={body}
                placeholder={modality === 'code' ? '粘贴生成的代码…' : modality === 'mixed' ? '（可选）再粘贴一段文本或代码…' : '粘贴生成的文本或提示词…'}
                style={modality === 'code' ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : undefined}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
          ) : null}

          <div className="field">
            <span className="field-label">库操作</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--outline btn--sm" disabled={libraryBusy} onClick={onRescan}>
                <RefreshCw size={14} /> 重新扫描目录
              </button>
              <button type="button" className="btn btn--outline btn--sm" disabled={libraryBusy} onClick={onImportLibrary}>
                <HardDriveDownload size={14} /> 把引用素材导入到库
              </button>
            </div>
          </div>
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn--outline" onClick={() => { reset(); onClose(); }}>取消</button>
          <button type="button" className="btn btn--default" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? '添加中…' : `添加${submitCount > 1 ? `（${submitCount} 件）` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
