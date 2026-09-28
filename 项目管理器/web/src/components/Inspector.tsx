import { useEffect, useMemo, useState } from 'react';
import { thumbSrc, api, mediaSrc, type AssetDetail, type AssetListItem, type ProjectRow  } from '../api.ts';
import { MODALITY_META, formatClock, formatDay, type Modality } from '../modality.tsx';
import { buildProjectTree, projectLabel } from '../projects.ts';
import { ModalityIcon } from './ModalityBadge.tsx';
import { IconButton } from './Icon.tsx';
import OpenWithDialog from './OpenWithDialog.tsx';

interface Props {
  asset: AssetListItem | null;
  trashed?: boolean;
  projects: ProjectRow[];
  onError: (message: string) => void;
  /** 用文件查看器打开磁盘上的某个文件（默认只读） */
  onOpenPath?: (path: string) => void;
  /** 轻量成功提示（例如"已用 X 打开"） */
  onNotice: (message: string) => void;
  onChanged: () => void;
  /** 进入专注模式：七类模态都有主体了，所以是必填 */
  onOpenFocus: () => void;
  /** 关掉右侧详情栏（顶栏也有一模一样的开关） */
  onClose?: () => void;
}

export default function Inspector({ asset, trashed = false, projects, onError, onNotice, onChanged, onOpenFocus, onClose, onOpenPath }: Props) {
  const [text, setText] = useState<{ body: string; truncated: boolean } | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [modelDraft, setModelDraft] = useState('');
  const [paramsDraft, setParamsDraft] = useState('');
  const [openWithOpen, setOpenWithOpen] = useState(false);

  const id = asset?.id ?? null;
  const detail = asset && 'sources' in asset ? (asset as AssetDetail) : null;
  const ext = asset?.ext ?? '';
  const projectOptions = useMemo(() => buildProjectTree(projects), [projects]);

  useEffect(() => {
    setConfirmingTrash(false);
    setModelDraft(asset?.model ?? '');
    setParamsDraft(asset?.params ?? '');
  }, [id, asset?.model]);

  // 文本/代码按需取前 64KB（回收站里的也能读）
  useEffect(() => {
    setText(null);
    setTextError(null);
    if (id === null) return;
    const isText = asset?.modality === 'text' || asset?.modality === 'code' || asset?.excerpt;
    if (!isText) return;
    let cancelled = false;
    void api
      .text(id, 65536, trashed)
      .then((result) => { if (!cancelled) setText(result); })
      .catch((err: unknown) => { if (!cancelled) setTextError((err as Error).message); });
    return () => { cancelled = true; };
  }, [id, asset?.modality, asset?.excerpt, trashed]);

  if (!asset) {
    return (
      <aside className="inspector">
        <div className="inspector-head">
          <div className="inspector-head-text">
            <h2>素材详情</h2>
            <div className="path">未选中任何素材</div>
          </div>
          {onClose ? <IconButton name="close" label="收起详情栏（Ctrl+I）" onClick={onClose} /> : null}
        </div>
        <div className="empty" />
      </aside>
    );
  }

  const modality = (asset.modality ?? 'mixed') as Modality;
  const duration = formatClock(asset.durationSec);
  const isPdf = ext.toLowerCase() === '.pdf';
  const managed = detail?.sources.find((source) => source.mode === 'managed');
  const referenced = detail?.sources.find((source) => source.mode === 'referenced');

  const run = async (action: () => Promise<unknown>, failMessage: string): Promise<void> => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(`${failMessage}：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveModel = async (): Promise<void> => {
    if ((asset.model ?? '') === modelDraft.trim()) return;
    try {
      await api.updateMeta(asset.id, { model: modelDraft });
      onChanged();
    } catch (err) {
      onError(`保存模型失败：${(err as Error).message}`);
    }
  };

  /** 生成参数失焦即保存 */
  const saveParams = async (): Promise<void> => {
    if (!asset) return;
    if ((asset.params ?? '') === paramsDraft) return;
    await run(() => api.updateMeta(asset.id, { params: paramsDraft }), '保存生成参数失败');
  };

  /** 一次生成的多件共享同一批生成参数：应用到同组其他成员 */
  const applyToBundle = async (): Promise<void> => {
    if (!asset) return;
    await run(
      () => api.updateMeta(asset.id, { params: paramsDraft, applyToBundle: true }),
      '应用到同组失败',
    );
    onNotice('已应用到同一组的其他成员');
  };

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div className="inspector-head-text">
          <h2>{asset.title}</h2>
          <div className="path">{asset.sourcePath}</div>
        </div>
        {onClose ? <IconButton name="close" label="收起详情栏（Ctrl+I）" onClick={onClose} /> : null}
      </div>

      {trashed ? (
        <div className="trash-banner">已在回收站 · 库内副本位于 trash\，原目录里的文件没有任何改动</div>
      ) : null}

      {/* 点预览图直接进专注模式（图片/视频/音频/文本都行） */}
      <div
        className={`preview${modality === 'mixed' ? '' : ' preview--clickable'}`}
        onClick={modality === 'mixed' ? undefined : onOpenFocus}
        title={modality === 'mixed' ? undefined : '单击进入专注模式'}
      >
        {modality === 'image' && <img src={mediaSrc(asset.id)} alt={asset.title} />}
        {/* 视频用缩略图当封面：<video> 默认显示第 0 帧，开头是黑底标题卡的片子整块看着就是黑屏
            （缩略图是从第 1 秒截的，比第 0 帧有代表性），并在拿到元数据后跳到 1 秒 */}
        {modality === 'video' && (
          <video
            src={mediaSrc(asset.id)}
            poster={asset.thumbAt ? thumbSrc(asset.id) : undefined}
            controls
            preload="metadata"
            onLoadedMetadata={(event) => {
              const el = event.currentTarget;
              if (el.currentTime === 0 && Number.isFinite(el.duration) && el.duration > 2) el.currentTime = 1;
            }}
          />
        )}
        {(modality === 'music' || modality === 'voice') && <audio src={mediaSrc(asset.id)} controls preload="metadata" />}
        {isPdf && <iframe src={mediaSrc(asset.id)} title={asset.title} style={{ width: '100%', height: '100%', border: 0 }} />}
        {(modality === 'text' || modality === 'code') && text && <pre>{text.body}{text.truncated ? '\n\n…（已截断，仅显示前 64KB）' : ''}</pre>}
        {(modality === 'text' || modality === 'code') && !text && !textError && <div className="no-preview">读取中…</div>}
        {(modality === 'text' || modality === 'code') && textError && <div className="no-preview">无法预览：{textError}</div>}
        {modality === 'mixed' && !isPdf && (
          <div className="no-preview">该类型暂不做页面内预览（{ext || '未知后缀'}）<br />用下方按钮交给系统默认程序</div>
        )}
      </div>

      <div className="meta-table">
        <div><span>类型</span><span><ModalityIcon modality={modality} size={12} /> {MODALITY_META[modality].label} · {ext || '无后缀'}</span></div>
        <div><span>大小</span><span>{detail?.sizeHuman ?? `${Math.round(asset.size / 1024)} KB`}</span></div>
        {asset.width && asset.height ? <div><span>尺寸</span><span>{asset.width} × {asset.height}</span></div> : null}
        {duration ? <div><span>时长</span><span>{duration}</span></div> : null}
        <div>
          <span>库内</span>
          <span>{asset.trashed ? '托管副本在回收站' : asset.inLibrary ? '有托管副本' : '仅引用（未导入）'}</span>
        </div>
        <div>
          <span>项目</span>
          <span>
            <select
              className="select"
              style={{ height: 28, fontSize: 12 }}
              value={asset.projectId ?? ''}
              disabled={trashed}
              onChange={(event) => {
                const value = event.target.value;
                void run(() => api.setAssetProject(asset.id, value ? Number(value) : null), '设置项目失败');
              }}
            >
              <option value="">未归档</option>
              {projectOptions.map((node) => (
                <option key={node.project.id} value={node.project.id}>{projectLabel(node)}</option>
              ))}
            </select>
          </span>
        </div>
        <div>
          <span>生成模型</span>
          <span>
            <input
              className="input"
              style={{ height: 28, fontSize: 12 }}
              value={modelDraft}
              placeholder="未标注"
              disabled={trashed}
              onChange={(event) => setModelDraft(event.target.value)}
              onBlur={() => void saveModel()}
              onKeyDown={(event) => { if (event.key === 'Enter') void saveModel(); }}
            />
          </span>
        </div>
        <div>
          <span>来源</span>
          <span>
            <select
              className="select"
              style={{ height: 28, fontSize: 12, width: '100%' }}
              value={asset.origin ?? ''}
              disabled={trashed}
              onChange={(event) => void run(() => api.updateMeta(asset.id, { origin: event.target.value }), '标注来源失败')}
            >
              <option value="">未标注</option>
              <option value="ai">AI 生成</option>
              <option value="real">非 AI（实拍/素材站等）</option>
              <option value="other">其他</option>
            </select>
          </span>
        </div>

        <div className="meta-prompt">
          <span>生成参数</span>
          <span>
            <textarea
              className="textarea"
              rows={2}
              style={{ fontSize: 12 }}
              value={paramsDraft}
              placeholder="种子 / 步数 / 参考图等，按行写"
              disabled={trashed}
              onChange={(event) => setParamsDraft(event.target.value)}
              onBlur={() => void saveParams()}
            />
            {asset.bundleId !== null && asset.bundleCount > 1 ? (
              <button type="button" className="btn btn--outline btn--sm" style={{ marginTop: 4 }} onClick={() => void applyToBundle()}>
                应用到同一组（{asset.bundleCount} 件）
              </button>
            ) : null}
          </span>
        </div>

        <div><span>采集</span><span>{formatDay(asset.capturedAt)}</span></div>
        <div><span>入库</span><span>{formatDay(asset.importedAt)}</span></div>
        {asset.caption ? (
          /* AI 生成的一句话描述：只读、可复制，方便按内容找素材 */
          <div className="meta-prompt">
            <span>描述</span>
            <span className="path-with-copy" style={{ alignItems: "flex-start" }}>
              <span>{asset.caption}</span>
              <IconButton
                name="copy"
                size={12}
                label="复制描述"
                className="icon-btn--inline"
                onClick={() => void navigator.clipboard.writeText(asset.caption ?? "").catch(() => onError("复制失败"))}
              />
            </span>
          </div>
        ) : null}
        <div>
          <span>来源路径</span>
          <span className="path-with-copy">
            <span className="mono">{asset.sourcePath}</span>
          </span>
        </div>
        {managed ? (
          <div>
            <span>库内对象</span>
            <span className="path-with-copy">
              <span className="mono">{managed.absPath}</span>
              {/* 每件素材都能用文件查看器打开它对应的文件（默认只读） */}
              {onOpenPath ? (
                <IconButton
                  name="edit"
                  size={12}
                  label="用文件查看器打开"
                  className="icon-btn--inline"
                  onClick={() => onOpenPath(managed.absPath)}
                />
              ) : null}
              {/* 按用户要求：复制来源路径的按钮放在「库内对象」这一行之后 */}
              {!referenced ? (
                <IconButton
                  name="copy"
                  size={12}
                  label="复制来源路径"
                  className="icon-btn--inline"
                  onClick={() => void navigator.clipboard.writeText(asset.sourcePath).catch(() => onError('复制失败'))}
                />
              ) : null}
            </span>
          </div>
        ) : null}
        {referenced ? (
          <div>
            <span>原始文件</span>
            <span className="path-with-copy">
              <span className="mono">{referenced.absPath}</span>
              {/* 素材详情里也能直接用文件查看器打开（默认只读） */}
              {onOpenPath ? (
                <IconButton
                  name="edit"
                  size={12}
                  label="用文件查看器打开原文件"
                  className="icon-btn--inline"
                  onClick={() => onOpenPath(referenced.absPath)}
                />
              ) : null}
              <IconButton
                name="copy"
                size={12}
                label="复制原文件完整路径"
                className="icon-btn--inline"
                onClick={() => void navigator.clipboard.writeText(referenced.absPath).catch(() => onError('复制失败'))}
              />
            </span>
          </div>
        ) : null}
        <div>
          <span>打开方式</span>
          <span>
            <button
              type="button"
              className="vstage-btn"
              style={{ height: 24, fontSize: 11 }}
              title="挑一个程序打开（本机可用程序列表）"
              onClick={() => setOpenWithOpen(true)}
            >
              选择程序…
            </button>
          </span>
        </div>
      </div>

      {/* 用户要求：底部的两个图标删掉。素材的删除改成卡片右下角那个按钮，
          进入专注模式改成点预览图 / 标题栏；这里只在回收站里留一个"恢复"入口。*/}
      {trashed ? (
        <div className="actions">
          <IconButton name="restore" label="从回收站恢复" disabled={busy} onClick={() => void run(() => api.restore(asset.id), '恢复失败')} />
        </div>
      ) : null}
      {openWithOpen ? (
        <OpenWithDialog
          assetId={asset.id}
          title={asset.title}
          onClose={() => setOpenWithOpen(false)}
          onError={onError}
          onNotice={onNotice}
        />
      ) : null}    </aside>
  );
}