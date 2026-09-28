import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { api, type AssetListItem } from '../api.ts';
import { MODALITY_META, type Modality } from '../modality.tsx';
import { ModalityIcon } from './ModalityBadge.tsx';
import { IconButton } from './Icon.tsx';
import ImageViewer from './ImageViewer.tsx';
import VideoStage from './VideoStage.tsx';
import MixedFocus from './MixedFocus.tsx';

/**
 * 编辑器连同它的 11 个语法包有 ~900KB（gzip 后 ~300KB），
 * 按需加载：只有真的要编辑文本/代码时才去取，主包维持在原体积。
 * 本地服务取这个分块是瞬间的，但没必要让所有页面都背上它。
 */
const TextFocus = lazy(() => import('./TextFocus.tsx'));

interface Props {
  /** 当前视图里的素材（内部只挑同模态的来翻页） */
  items: AssetListItem[];
  startId: number;
  onClose: () => void;
  onChangeItem?: (item: AssetListItem) => void;
  onError: (message: string) => void;
  /** 专注模式里改了内容（例如编辑器保存）之后，通知外层刷新列表与详情 */
  onSaved?: (message: string) => void;
}

/**
 * 专注模式：所有类型共用的一个全屏浮层，按模态换主体。
 *
 * 图片沿用已有的看图器（它本身就是完整的专注形态，有缩放/平移/旋转/翻页）；
 * 声音/音乐用真实波形播放器；视频、文本/代码、综合的主体在下一步接进来。
 */
export default function FocusOverlay({ items, startId, onClose, onChangeItem, onError, onSaved }: Props) {
  const [currentId, setCurrentId] = useState(startId);
  const asset = useMemo(
    () => items.find((item) => item.id === currentId) ?? items.find((item) => item.id === startId) ?? null,
    [items, currentId, startId],
  );

  // 翻页只在同一模态内进行：从一首歌翻到一张图没有意义
  const siblings = useMemo(
    () => (asset ? items.filter((item) => item.modality === asset.modality) : []),
    [items, asset],
  );
  const index = asset ? siblings.findIndex((item) => item.id === asset.id) : -1;

  const go = (delta: number): void => {
    if (index < 0 || siblings.length < 2) return;
    const next = siblings[(index + delta + siblings.length) % siblings.length];
    if (!next) return;
    setCurrentId(next.id);
    onChangeItem?.(next);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      else if (event.key === '[') go(-1);
      else if (event.key === ']') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!asset) return null;

  // 图片：直接交给看图器（它已经是完整的专注形态，不再套一层外壳）
  if (asset.modality === 'image') {
    return (
      <ImageViewer
        items={items}
        startId={asset.id}
        onClose={onClose}
        onChangeItem={onChangeItem}
        onError={onError}
      />
    );
  }

  const modality = (asset.modality ?? 'mixed') as Modality;

  return (
    <div className="focus" role="dialog" aria-modal="true" aria-label={`专注模式 · ${MODALITY_META[modality].label}`}>
      <div className="focus-bar">
        <div className="focus-title">
          <ModalityIcon modality={modality} size={14} />
          <strong>{asset.title}</strong>
          <span className="focus-path" title={asset.sourcePath}>{asset.sourcePath}</span>
        </div>
        <div className="focus-tools">
          <button type="button" onClick={() => go(-1)} disabled={siblings.length < 2} title="上一件（[）">‹</button>
          <span className="focus-counter">{index >= 0 ? index + 1 : 1} / {Math.max(1, siblings.length)}</span>
          <button type="button" onClick={() => go(1)} disabled={siblings.length < 2} title="下一件（]）">›</button>
          <span className="focus-sep" />
          <IconButton
            name="external"
            label="用系统默认程序打开"
            onClick={() => { void api.openWithSystem(asset.id).catch((err: unknown) => onError((err as Error).message)); }}
          />
          <button type="button" className="focus-close" onClick={onClose} title="关闭（Esc）">关闭</button>
        </div>
      </div>

      <div className="focus-stage">
        {modality === 'video' ? (
          <VideoStage asset={asset} onError={onError} />
        ) : modality === 'text' || modality === 'code' ? (
          <Suspense fallback={<div className="focus-todo"><p>正在加载编辑器…</p></div>}>
            <TextFocus asset={asset} onError={onError} onSaved={onSaved} />
          </Suspense>
        ) : (
          <MixedFocus asset={asset} onError={onError} />
        )}
      </div>

      <div className="focus-hint">
        <span>Esc 关闭</span>
        <span>[ ] 上一件 / 下一件</span>
        {modality === 'video' ? <span>空格 播放 · ←→ 5 秒 · , . 逐帧 · M 静音 · F 全屏</span> : null}
        {modality === 'text' || modality === 'code' ? <span>Ctrl+S 保存为新版本 · 行号/高亮/搜索来自 CodeMirror 6</span> : null}
        {modality === 'mixed' ? <span>首部字节 + 文本嗅探 · 要打开用右上角「打开方式…」</span> : null}
      </div>
    </div>
  );
}
