import { Play } from 'lucide-react';
import { thumbSrc, mediaSrc, type AssetListItem } from '../api.ts';
import { formatClock, formatDay, projectDotClass } from '../modality.tsx';
import { ModalityBadge } from './ModalityBadge.tsx';
import Icon from './Icon.tsx';

interface Props {
  item: AssetListItem;
  previewHeight: number;
  selected: boolean;
  /** 卡片右下角的删除：用户要求不进详情栏也能删 */
  onTrash?: (item: AssetListItem) => void;
  /** 已经进入"再点一次确认"的状态 */
  armed?: boolean;
  /** 回收站视图里：按钮变成「恢复」（恢复是安全动作，一点即走） */
  onRestore?: (item: AssetListItem) => void;
  /** 组（bundle）：一次加入的一批内容 */
  bundle?: { title: string; count: number; expanded: boolean } | null;
  onToggleBundle?: () => void;
  /** 回收站里可勾选，用于"恢复所选"这类批量动作 */
  selectable?: boolean;
  checked?: boolean;
  onToggleSelect?: (item: AssetListItem) => void;
  /** 回收站里的单件"彻底删除"（不可恢复，两步确认） */
  onPurge?: (item: AssetListItem) => void;
  purgeArmed?: boolean;
}

export default function ContentCard({ item, previewHeight, selected, onTrash, onRestore, armed = false, bundle = null, onToggleBundle, selectable = false, checked = false, onToggleSelect, onPurge, purgeArmed = false }: Props): React.ReactElement {
  const duration = formatClock(item.durationSec);

  return (
    <article className={`card${selected ? ' is-selected' : ''}${checked ? ' is-checked' : ''}`}>
      <div className="card-preview" style={{ height: previewHeight }}>
        <Preview item={item} duration={duration} />
        {selectable ? (
          <button
            type="button"
            className={`card-check${checked ? ' is-checked' : ''}`}
            title={checked ? '取消选择' : '选择这一件'}
            aria-label={checked ? '取消选择' : '选择这一件'}
            aria-pressed={checked}
            onClick={(event) => { event.stopPropagation(); onToggleSelect?.(item); }}
          />
        ) : null}
        {bundle && onToggleBundle ? (
          <button
            type="button"
            className={`card-bundle${bundle.expanded ? ' is-open' : ''}`}
            title={bundle.expanded ? `收起「${bundle.title}」这一组` : `「${bundle.title}」共 ${bundle.count} 件，点击展开`}
            onClick={(event) => { event.stopPropagation(); onToggleBundle(); }}
          >
            <Icon name={bundle.expanded ? 'close' : 'folder'} size={12} />
            <span>{bundle.expanded ? '收起这一组' : `一组 ${bundle.count} 件`}</span>
          </button>
        ) : null}
        {onRestore ? (
          <button
            type="button"
            className="card-trash is-restore"
            title="从回收站恢复到库里"
            aria-label="从回收站恢复"
            onClick={(event) => { event.stopPropagation(); onRestore(item); }}
          >
            <Icon name="restore" size={14} />
          </button>
        ) : onTrash ? (
          <button
            type="button"
            className={`card-trash${armed ? ' is-armed' : ''}`}
            title={armed ? '再点一次：移入回收站' : '移入回收站'}
            aria-label={armed ? '再点一次确认移入回收站' : '移入回收站'}
            onClick={(event) => { event.stopPropagation(); onTrash(item); }}
          >
            <Icon name={armed ? 'close' : 'trash'} size={14} />
          </button>
        ) : null}
        {/* 回收站里的单件彻底删除：放左下角（右下角已经是"恢复"），不可恢复所以要再点一次 */}
        {onPurge ? (
          <button
            type="button"
            className={`card-purge${purgeArmed ? ' is-armed' : ''}`}
            title={purgeArmed ? '再点一次：彻底删除（不可恢复）' : '彻底删除（不可恢复）'}
            aria-label={purgeArmed ? '再点一次确认彻底删除' : '彻底删除'}
            onClick={(event) => { event.stopPropagation(); onPurge(item); }}
          >
            <Icon name={purgeArmed ? 'close' : 'trash'} size={14} />
          </button>
        ) : null}
      </div>
      <div className="card-body">
        <h3 className="card-title truncate" title={item.title}>{item.title}</h3>
        <div className="card-meta">
          <ModalityBadge modality={item.modality} model={item.model} />
          <span className="card-date">{formatDay(item.capturedAt ?? item.importedAt)}</span>
        </div>
        {item.projectName ? (
          <span className="card-project">
            <span className={projectDotClass(item.projectColor)} aria-hidden />
            <span className="truncate">{item.projectName}</span>
          </span>
        ) : (
          <span className="card-project"><span className="truncate">{item.sourcePath.split('/')[0] ?? ''}</span></span>
        )}
      </div>
    </article>
  );
}

/** 预览优先级：图片/视频缩略图 > 音频播放器 > 代码摘要 > 文本摘要 > 占位 */
function Preview({ item, duration }: { item: AssetListItem; duration: string | null }): React.ReactElement {

  if ((item.modality === 'video' || item.modality === 'mixed') && item.thumbAt) {
    return (
      <>
        <img src={thumbSrc(item.id)} alt={item.title} loading="lazy" />
        <span className="card-play"><span><Play size={16} fill="currentColor" style={{ transform: 'translateX(1px)' }} /></span></span>
        {duration ? <span className="card-duration">{duration}</span> : null}
      </>
    );
  }

  if ((item.modality === 'music' || item.modality === 'voice')) {
    return (
      <div className="card-preview-center" style={{ flexDirection: 'column', gap: 10, padding: '0 14px' }}>
        {/* 播放器是真的；真实波形要等 M2 用 ffmpeg 预计算 peaks 之后再画，不画假波浪 */}
        <audio src={mediaSrc(item.id)} controls preload="none" style={{ width: '100%', height: 32 }} />
        {duration ? <span className="muted tabular" style={{ fontSize: 12 }}>{duration}</span> : null}
      </div>
    );
  }

  if (item.modality === 'image' && item.thumbAt) {
    return <img src={thumbSrc(item.id)} alt={item.title} loading="lazy" />;
  }

  if (item.modality === 'code') {
    return <pre className="card-preview-code">{item.excerpt ?? '（没有可显示的代码摘要）'}</pre>;
  }

  if (item.modality === 'text') {
    return <p className="card-preview-text line-clamp-5">{item.excerpt ?? '（空文本）'}</p>;
  }

  return (
    <div className="card-preview-center">
      <span className="file-ext" style={{ width: 44, height: 24 }}>{item.ext.replace('.', '') || '?'}</span>
    </div>
  );
}
/** 没有缩略图时的占位（按后缀给个可读的标记），未入库文件与不支持的格式都用它 */
function ExtPlaceholder({ item }: { item: AssetListItem }): React.ReactElement {
  const label = (item.ext || '').replace(/^\./, '').toUpperCase() || '文件';
  return (
    <div className="card-preview-center">
      <div className="file-placeholder">
        <span className="file-placeholder-ext">{label}</span>
        <span className="file-placeholder-name truncate" title={item.title}>{item.title}</span>
      </div>
    </div>
  );
}