import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api, mediaSrc, type AssetListItem } from '../api.ts';

interface Props {
  /** 当前视图里的素材（可能含非图片，内部只挑图片来翻页） */
  items: AssetListItem[];
  startId: number;
  onClose: () => void;
  /** 翻页时同步右侧详情，关闭后不会跳到别的素材 */
  onChangeItem?: (item: AssetListItem) => void;
  onError: (message: string) => void;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const ZOOM_STEP = 1.25;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * 专门的看图模式：全屏浮层 + 自由缩放。
 *
 * 交互（全部手写，不引第三方库）：
 *  - 滚轮：以**光标位置**为中心缩放（不是以画面中心，所以放大后能直接看想看的地方）
 *  - 拖拽：平移；双击：在"适应窗口"与"100%"之间切换
 *  - 键盘：Esc 关闭 / ←→ 翻页 / +− 缩放 / 0 适应窗口 / 1 实际大小 / R 旋转
 */
export default function ImageViewer({ items, startId, onClose, onChangeItem, onError }: Props) {
  const images = useMemo(
    () => items.filter((item) => item.kind === 'image' && item.status !== 'missing'),
    [items],
  );
  const [index, setIndex] = useState(() => {
    const found = images.findIndex((item) => item.id === startId);
    return found >= 0 ? found : 0;
  });
  const current: AssetListItem | undefined = images[index];

  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [rotate, setRotate] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [mode, setMode] = useState<'fit' | 'free'>('fit');
  const [loadError, setLoadError] = useState<string | null>(null);
  // 拖拽中要改样式，所以必须是 state（ref 不会触发重渲染）
  const [dragging, setDragging] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const rotateRef = useRef(rotate);
  rotateRef.current = rotate;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const rotated = rotate % 180 !== 0;

  const applyScale = useCallback((nextScale: number, focusX: number, focusY: number): void => {
    const { scale, tx, ty } = viewRef.current;
    const clamped = Math.min(Math.max(nextScale, MIN_SCALE), MAX_SCALE);
    const k = clamped / scale;
    // 让光标下的那个点在缩放前后停在同一处
    const nextTx = focusX - (focusX - tx) * k;
    const nextTy = focusY - (focusY - ty) * k;
    setView({ scale: clamped, tx: nextTx, ty: nextTy });
    setMode('free');
  }, []);

  const fitToWindow = useCallback((): void => {
    const el = viewportRef.current;
    const nat = naturalRef.current;
    if (!el || !nat) return;
    const w = rotateRef.current % 180 === 0 ? nat.w : nat.h;
    const h = rotateRef.current % 180 === 0 ? nat.h : nat.w;
    const scale = Math.min(el.clientWidth / w, el.clientHeight / h, 1);
    setView({ scale, tx: 0, ty: 0 });
    setMode('fit');
  }, []);

  const zoomTo = useCallback((scale: number): void => {
    setView({ scale: Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE), tx: 0, ty: 0 });
    setMode('free');
  }, []);

  const step = useCallback((factor: number): void => {
    const el = viewportRef.current;
    // 按钮缩放以视口中心为焦点；滚轮缩放才跟随光标
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    applyScale(viewRef.current.scale * factor, cx, cy);
  }, [applyScale]);

  const go = useCallback((delta: number): void => {
    setIndex((prev) => {
      const next = prev + delta;
      if (next < 0 || next >= images.length) return prev;
      return next;
    });
  }, [images.length]);

  // 换图：重置缩放与旋转，等 onLoad 再算适应尺寸
  useEffect(() => {
    setNatural(null);
    setLoadError(null);
    setRotate(0);
    setMode('fit');
    setView({ scale: 1, tx: 0, ty: 0 });
    const item = images[index];
    if (item && onChangeItem) onChangeItem(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images]);

  // 滚轮缩放（必须 passive:false 才能阻止页面滚动）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const focusX = event.clientX - rect.left - rect.width / 2;
      const focusY = event.clientY - rect.top - rect.height / 2;
      const factor = Math.pow(1.0015, -event.deltaY);
      applyScale(viewRef.current.scale * factor, focusX, focusY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyScale]);

  // 窗口尺寸变化：仍处于"适应窗口"时跟着重算
  useEffect(() => {
    const onResize = (): void => {
      if (modeRef.current === 'fit') fitToWindow();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitToWindow]);

  // 键盘
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape': onClose(); break;
        case 'ArrowLeft': case 'PageUp': go(-1); break;
        case 'ArrowRight': case 'PageDown': go(1); break;
        case '+': case '=': step(ZOOM_STEP); break;
        case '-': case '_': step(1 / ZOOM_STEP); break;
        case '0': fitToWindow(); break;
        case '1': zoomTo(1); break;
        case 'r': case 'R': setRotate((prev) => (prev + 90) % 360); setMode('free'); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, go, step, fitToWindow, zoomTo]);

  // 拖拽平移
  const drag = useRef<{ active: boolean; startX: number; startY: number; tx: number; ty: number }>({
    active: false, startX: 0, startY: 0, tx: 0, ty: 0,
  });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.button !== 1) return;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    drag.current = {
      active: true, startX: event.clientX, startY: event.clientY,
      tx: viewRef.current.tx, ty: viewRef.current.ty,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current.active) return;
    const dx = event.clientX - drag.current.startX;
    const dy = event.clientY - drag.current.startY;
    setView((prev) => ({ ...prev, tx: drag.current.tx + dx, ty: drag.current.ty + dy }));
    if (modeRef.current === 'fit') setMode('free');
  };

  const endDrag = (): void => {
    drag.current.active = false;
    setDragging(false);
  };

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el) el.focus();
  }, []);

  if (!current) return null;

  const percent = Math.round(view.scale * 100);
  const displayW = natural ? (rotated ? natural.h : natural.w) : null;
  const displayH = natural ? (rotated ? natural.w : natural.h) : null;

  const onOpenExternal = async (): Promise<void> => {
    try {
      const res = await api.openWithSystem(current.id);
      if (!res.ok) onError(res.error ?? '打开失败');
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="大图查看">
      <div className="viewer-bar">
        <div className="viewer-title">
          <strong>{current.title}</strong>
          <span className="viewer-path" title={current.sourcePath}>{current.sourcePath}</span>
        </div>
        <div className="viewer-tools">
          <button onClick={() => go(-1)} disabled={index === 0} title="上一张（←）">‹</button>
          <span className="viewer-counter">{index + 1} / {images.length}</span>
          <button onClick={() => go(1)} disabled={index >= images.length - 1} title="下一张（→）">›</button>
          <span className="viewer-sep" />
          <button onClick={() => step(1 / ZOOM_STEP)} title="缩小（-）">−</button>
          <span className="viewer-zoom" title="当前缩放">{percent}%</span>
          <button onClick={() => step(ZOOM_STEP)} title="放大（+）">＋</button>
          <button onClick={fitToWindow} title="适应窗口（0）">适应窗口</button>
          <button onClick={() => zoomTo(1)} title="实际大小（1）">100%</button>
          <button onClick={() => { setRotate((prev) => (prev + 90) % 360); setMode('free'); }} title="旋转 90°（R）">旋转</button>
          <span className="viewer-sep" />
          <button onClick={() => void onOpenExternal()} title="用系统默认程序打开">外部打开</button>
          <button className="primary" onClick={onClose} title="关闭（Esc）">关闭</button>
        </div>
      </div>

      <div
        className={`viewer-stage${dragging ? ' dragging' : ''}`}
        ref={viewportRef}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (mode === 'fit' ? zoomTo(1) : fitToWindow())}
      >
        {loadError ? (
          <div className="viewer-error">无法加载图片：{loadError}</div>
        ) : (
          <img
            src={mediaSrc(current.id)}
            alt={current.title}
            draggable={false}
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale}) rotate(${rotate}deg)`,
              visibility: natural ? 'visible' : 'hidden',
            }}
            onLoad={(event) => {
              const img = event.currentTarget;
              const next = { w: img.naturalWidth, h: img.naturalHeight };
              naturalRef.current = next;
              setNatural(next);
              const el = viewportRef.current;
              if (el) {
                const scale = Math.min(el.clientWidth / next.w, el.clientHeight / next.h, 1);
                setView({ scale, tx: 0, ty: 0 });
              }
            }}
            onError={() => setLoadError('文件可能已被移动或删除')}
          />
        )}
      </div>

      <div className="viewer-hint">
        <span>滚轮缩放（跟随光标）</span>
        <span>拖拽平移</span>
        <span>双击 适应/100%</span>
        <span>← → 翻页</span>
        <span>0 适应 · 1 实际大小 · R 旋转 · Esc 关闭</span>
        {displayW && displayH ? <span className="viewer-dim">{displayW} × {displayH}</span> : null}
      </div>
    </div>
  );
}
