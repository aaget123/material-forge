/**
 * 纯 CSS 画的图标（不引图标字体、不复用 lucide）。
 *
 * 为什么自己画：用户明确要求"用 CSS 画一个图标放在合适的位置"。
 * 做法是每个图标一个 24×24 的等比盒子，内部全部用百分比坐标，
 * 所以父级给任何尺寸都不会变形；线条统一 1.5px、颜色一律 currentColor，
 * 保证和现有的 lucide 图标视觉重量一致（lucide 用的是 24 格 / 2px 线）。
 */
export type IconName =
  | 'copy'
  | 'trash'
  | 'restore'
  | 'external'
  | 'focus'
  | 'edit'
  | 'close'
  | 'panel-left'
  | 'panel-right'
  | 'plus'
  | 'folder';

interface Props {
  name: IconName;
  /** 盒子边长（px） */
  size?: number;
  className?: string;
}

export default function Icon({ name, size = 16, className }: Props): React.ReactElement {
  // 外层只管尺寸，内层 .pmi-b 承担全部图形几何：
  // 第一版把形状画在外层，结果被 inline 的 width/height 覆盖，桶身直接撑出盒子（实测踩到）。
  return (
    <span className={`pmi pmi--${name}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} aria-hidden>
      <i className="pmi-b" />
    </span>
  );
}

/** 图标按钮：图标 + 悬停说明 + 无障碍名（title 与 aria-label 用同一句话，避免两处说法不一致） */
export function IconButton({
  name, label, onClick, disabled = false, tone, size = 16, className,
}: {
  name: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** danger：危险动作用红色悬停；primary：主操作用实心底 */
  tone?: 'default' | 'danger' | 'primary';
  size?: number;
  /** 额外类名（例如内联在文字后面的小图标 icon-btn--inline） */
  className?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`icon-btn${tone && tone !== 'default' ? ` icon-btn--${tone}` : ''}${className ? ` ${className}` : ''}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={name} size={size} />
    </button>
  );
}
