import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  /** 说明要用什么方式、影响多少东西，别只说"确定吗" */
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认弹窗。
 * 不用 window.confirm：在 Electron/自动化环境里会直接卡住渲染进程（M1 实测踩过）。
 */
export default function ConfirmDialog({ open, title, children, confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  if (!open) return null;
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialog dialog--sm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className="dialog-head">
          <h2 className="dialog-title" id="confirm-dialog-title">{title}</h2>
        </div>
        <div className="dialog-body">
          <div className="dialog-text">{children}</div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn--outline" onClick={onCancel}>取消</button>
          <button type="button" className="btn btn--destructive" disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
