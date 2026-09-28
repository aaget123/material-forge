import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import Icon from './Icon.tsx';

interface Candidate {
  id: string;
  label: string;
  exe: string;
  args: string[];
  isDefault: boolean;
}

interface Props {
  assetId: number;
  title: string;
  onClose: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

const REMEMBER_KEY = 'pm-open-with';

/**
 * 自建的「打开方式」选择器（用户要求：不要用系统那个对话框，样式要跟当前前端一致）。
 *
 * 候选程序来自服务端读注册表（`/api/open-with/:id`），这里只负责：
 *  - 列表 + 上次用过的标记（记在浏览器里，下次默认选中）
 *  - 定位不到的程序会说明"还有 N 个"，并给一个"更多程序…"的兜底（那一个才用系统对话框）
 */
export default function OpenWithDialog({ assetId, title, onClose, onError, onNotice }: Props) {
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [unresolved, setUnresolved] = useState(0);
  const [ext, setExt] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [remember, setRemember] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(REMEMBER_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    void api
      .openWithList(assetId)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setUnresolved(result.unresolved);
        setExt(result.ext);
        const last = remember[result.ext];
        setPicked(result.items.find((item) => item.id === last)?.id ?? result.items[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onError(`读取「打开方式」候选失败：${(err as Error).message}`);
        setItems([]);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const launch = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.openWithUse(assetId, id);
      const next = { ...remember, [ext]: id };
      setRemember(next);
      window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(next));
      onNotice(`已用「${result.label ?? id}」打开`);
      onClose();
    } catch (err) {
      onError(`打开失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="openwith-title">
        <div className="dialog-head">
          <div>
            <h2 className="dialog-title" id="openwith-title">打开方式</h2>
            <p className="dialog-desc truncate" title={title}>
              {title}{ext ? ` · ${ext}` : ''}
            </p>
          </div>
          <button type="button" className="btn btn--ghost btn--icon-sm" aria-label="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="dialog-body">
          {items === null ? <p className="muted">正在读取本机可用的程序…</p> : null}
          {items && items.length === 0 ? (
            <p className="muted">没能在注册表里定位到这个类型的程序。可以用下面的「更多程序…」从系统列表里挑一个。</p>
          ) : null}

          <div className="openwith-list" role="radiogroup" aria-label="选择程序">
            {items?.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={picked === item.id}
                className={`openwith-row${picked === item.id ? ' is-active' : ''}`}
                onClick={() => setPicked(item.id)}
                onDoubleClick={() => void launch(item.id)}
              >
                <span className="openwith-icon" aria-hidden><Icon name="external" size={14} /></span>
                <span className="openwith-text">
                  <span className="openwith-label truncate">{item.label}</span>
                  <span className="openwith-path truncate" title={item.exe}>{item.exe}</span>
                </span>
                {item.isDefault ? <span className="browse-badge">系统默认</span> : null}
                {remember[ext] === item.id ? <span className="browse-badge is-in-library">上次用的</span> : null}
              </button>
            ))}
          </div>

          {unresolved > 0 ? (
            <p className="field-hint">
              还有 {unresolved} 个注册表里提到、但没能定位到可执行文件的程序（大多是卸载残留或需要 AppID 启动的）。
            </p>
          ) : null}
        </div>

        <div className="dialog-foot">
          <button
            type="button"
            className="btn btn--outline"
            disabled={busy}
            title="从系统里挑任意程序（这一项才用 Windows 自己的对话框）"
            onClick={() => {
              void api.openWithSystemDialog(assetId)
                .then(() => { onNotice('已打开系统的「打开方式」对话框'); onClose(); })
                .catch((err: unknown) => onError(`打开失败：${(err as Error).message}`));
            }}
          >
            更多程序…
          </button>
          <span className="browse-spacer" />
          <button type="button" className="btn btn--outline" onClick={onClose}>取消</button>
          <button type="button" className="btn btn--default" disabled={busy || !picked} onClick={() => picked && void launch(picked)}>
            {busy ? '打开中…' : '用它打开'}
          </button>
        </div>
      </div>
    </div>
  );
}
