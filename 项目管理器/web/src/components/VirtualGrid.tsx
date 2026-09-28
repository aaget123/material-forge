import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Props<T> {
  items: T[];
  keyOf: (item: T) => number | string;
  render: (item: T, size: { width: number; height: number; previewHeight: number }) => ReactNode;
  onSelect: (item: T) => void;
  /** 双击：打开看图模式等"激活"行为 */
  onActivate?: (item: T) => void;
  selectedKey: number | number | null;
  /** 会改变可用宽度的事件计数：面板开合、选中变化时 +1，用来在过渡结束后补测宽度 */
  revision?: number;
  minCardWidth?: number;
  /** 预览区宽高比（参考设计是 4/3），行高由它和正文高度算出来 */
  previewAspect?: number;
  /** 卡片正文部分固定高度（标题 + 徽章行 + 项目行 + 上下内边距） */
  bodyHeight?: number;
  /** 变化时把网格滚回顶部（切换项目/筛选/搜索后不该停在旧位置） */
  resetKey?: string;
  gap?: number;
}

/**
 * 极简虚拟滚动网格：万级素材时必须的（开发建议 §3.2）。
 * 只渲染视口内的行，滚动容器高度按总行数撑开。
 */
export default function VirtualGrid<T>({
  items, keyOf, render, onSelect, onActivate, selectedKey, resetKey,
  revision = 0, minCardWidth = 240, previewAspect = 4 / 3, bodyHeight = 98, gap = 16,
}: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = (): void => {
      setWidth(el.clientWidth);
      setViewportHeight(el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // 面板开合改的是**父容器**的宽度；只观察自身在某些时序下会漏掉，于是网格会一直用旧宽度排布
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  /**
   * 兜底自校正：面板开合、窗口缩放、滚动条出现/消失都会改变可用宽度，
   * 只要测到的宽度和当前真实宽度不一致就立刻纠正一次。
   * 没有这一步时，列数是按"上一次的宽度"算的，右侧会多排一列被裁掉（用户截图反馈的遮挡）。
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (width !== el.clientWidth) setWidth(el.clientWidth);
    if (viewportHeight !== el.clientHeight) setViewportHeight(el.clientHeight);
  });

  /**
   * 面板开合是有过渡动画的，动画期间宽度在变；只靠上面那两条可能在"最后一拍"漏掉，
   * 于是仍按旧宽度排了多一列、被详情栏压住（用户第二次反馈的遮挡就是这个）。
   * 这里在 revision 变化后再补测几次，确保过渡结束后一定用的是最终宽度。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      setWidth(el.clientWidth);
      setViewportHeight(el.clientHeight);
    };
    // 连续补测（含动画最后一拍）：面板开合后按帧补几次，直到宽度稳定为止
    const timers = [0, 120, 320, 620].map((delay) => window.setTimeout(measure, delay));
    let frames = 0;
    let raf = 0;
    const tick = (): void => {
      measure();
      frames += 1;
      if (frames < 20 && el.clientWidth !== width) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
    };
  }, [revision, width]);

  /**
   * 布局一律用"当下真实宽度"算：状态里的 width 是异步更新的，面板开合的那一两帧里可能还是旧值，
   * 于是按旧宽度排出的列会超出容器、右列与右上角按钮被切掉（用户截图反馈）。
   * 直接读 clientWidth 就把这个竞态窗口彻底消掉。
   */
  const liveWidth = scrollRef.current ? scrollRef.current.clientWidth : width;
  const usable = Math.max(liveWidth - gap, 0);
  const columns = Math.max(1, Math.floor(usable / (minCardWidth + gap)));
  const cardWidth = columns > 0 ? usable / columns - gap : minCardWidth;
  const previewHeight = Math.round(cardWidth / previewAspect);
  // 卡片高度 = 预览 + 正文 + 上下边框
  const rowHeight = previewHeight + bodyHeight + 2;
  const rows = Math.ceil(items.length / columns);
  const totalHeight = rows * (rowHeight + gap) + gap;
  const overscan = 3;
  const firstRow = Math.max(0, Math.floor(scrollTop / (rowHeight + gap)) - overscan);
  const lastRow = Math.min(rows - 1, Math.ceil((scrollTop + viewportHeight) / (rowHeight + gap)) + overscan);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const visible: ReactNode[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      const item = items[index];
      if (!item) continue;
      const key = keyOf(item);
      visible.push(
        <div
          key={key}
          className={`card-slot${selectedKey === key ? ' selected' : ''}`}
          style={{
            left: col * (cardWidth + gap) + gap / 2,
            top: row * (rowHeight + gap) + gap / 2,
            width: cardWidth,
            height: rowHeight,
          }}
          onClick={() => onSelect(item)}
          onDoubleClick={() => onActivate?.(item)}
          title="双击查看大图"
        >
          {render(item, { width: cardWidth, height: rowHeight, previewHeight })}
        </div>,
      );
    }
  }

  return (
    <div className="grid-scroll" ref={scrollRef}>
      <div className="grid-inner" style={{ height: totalHeight }}>
        {visible}
      </div>
    </div>
  );
}
