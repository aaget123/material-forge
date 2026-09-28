import type { AssetListItem } from '../api.ts';
import { formatClock, formatDay, projectDotClass } from '../modality.tsx';
import { ModalityBadge, ModalityIcon } from './ModalityBadge.tsx';

interface Props {
  items: AssetListItem[];
  selectedId: number | null;
  onSelect: (item: AssetListItem) => void;
  onActivate: (item: AssetListItem) => void;
}

/** 列表视图：行高约 56px，左侧类型图标块，右侧时长或日期 */
export default function ContentList({ items, selectedId, onSelect, onActivate }: Props): React.ReactElement {
  return (
    <ul className="content-list">
      {items.map((item) => (
        <li
          key={item.id}
          className={selectedId === item.id ? 'is-selected' : undefined}
          onClick={() => onSelect(item)}
          onDoubleClick={() => onActivate(item)}
        >
          <span className="list-icon"><ModalityIcon modality={item.modality} size={16} /></span>
          <div className="list-main">
            <p className="list-title truncate">{item.title}</p>
            {item.excerpt ? <p className="list-excerpt truncate">{item.excerpt.replace(/\n/g, ' ')}</p> : null}
          </div>
          <span className="list-badge"><ModalityBadge modality={item.modality} model={item.model} /></span>
          {item.projectName ? (
            <span className="list-project">
              <span className={projectDotClass(item.projectColor)} aria-hidden />
              <span className="truncate">{item.projectName}</span>
            </span>
          ) : null}
          <span className="list-tail">{formatClock(item.durationSec) ?? formatDay(item.capturedAt ?? item.importedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
