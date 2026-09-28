import { MODALITY_META, type Modality } from '../modality.tsx';

export function ModalityIcon({ modality, size = 14 }: { modality: Modality; size?: number }): React.ReactElement {
  const Icon = MODALITY_META[modality].icon;
  return <Icon size={size} aria-hidden />;
}

/** 类型徽章：图标 + 中文标签 +（有模型时）· 模型名 */
export function ModalityBadge({ modality, model }: { modality: Modality; model?: string | null }): React.ReactElement {
  return (
    <span className="badge">
      <ModalityIcon modality={modality} size={12} />
      <span style={{ flexShrink: 0 }}>{MODALITY_META[modality].label}</span>
      {model ? (
        <>
          <span className="badge-sep" aria-hidden>·</span>
          <span className="badge-model truncate">{model}</span>
        </>
      ) : null}
    </span>
  );
}
