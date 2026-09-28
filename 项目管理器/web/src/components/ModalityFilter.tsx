import { MODALITY_META, MODALITY_ORDER, type Modality } from '../modality.tsx';
import { ModalityIcon } from './ModalityBadge.tsx';

interface Props {
  counts: Array<{ modality: Modality; count: number }>;
  total: number;
  value: Modality | null;
  onChange: (modality: Modality | null) => void;
}

/** 类型筛选药丸：全部类型 + 7 类（带计数）；再点已选项回到"全部类型" */
export default function ModalityFilter({ counts, total, value, onChange }: Props): React.ReactElement {
  const countOf = (modality: Modality): number =>
    counts.find((entry) => entry.modality === modality)?.count ?? 0;

  return (
    <div className="chip-row" role="group" aria-label="按内容类型筛选">
      <button type="button" className={`chip${value === null ? ' is-active' : ''}`} aria-pressed={value === null} onClick={() => onChange(null)}>
        全部类型
        <span className="chip-count">{total}</span>
      </button>
      {MODALITY_ORDER.map((modality) => (
        <button
          key={modality}
          type="button"
          className={`chip${value === modality ? ' is-active' : ''}`}
          aria-pressed={value === modality}
          onClick={() => onChange(value === modality ? null : modality)}
        >
          <ModalityIcon modality={modality} size={13} />
          {MODALITY_META[modality].label}
          <span className="chip-count">{countOf(modality)}</span>
        </button>
      ))}
    </div>
  );
}
