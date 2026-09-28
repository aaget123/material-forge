import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, type Ping, type Stats, type VerifyReport } from '../api.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  ping: Ping | null;
  stats: Stats | null;
  onError: (message: string) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 库信息 + 完整性核对（把 CLI 的 verify 变成界面里可点的动作） */
export default function LibraryDialog({ open, onClose, ping, stats, onError }: Props) {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setReport(null);
  }, [open]);

  if (!open) return null;

  const verify = async (hash: boolean): Promise<void> => {
    setBusy(true);
    try {
      setReport(await api.verify(hash));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog dialog--sm" role="dialog" aria-modal="true" aria-labelledby="library-dialog-title">
        <div className="dialog-head">
          <div>
            <h2 className="dialog-title" id="library-dialog-title">库信息</h2>
            <p className="dialog-desc">数据与代码分离存放，数据库可整库重建。</p>
          </div>
          <button type="button" className="btn btn--ghost btn--icon-sm" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="dialog-body">
          <div className="meta-table" style={{ padding: 0 }}>
            <div><span>库目录</span><span className="mono">{ping?.libraryDir ?? '…'}</span></div>
            <div><span>SQLite</span><span>{ping?.sqliteVersion ?? '…'}</span></div>
            <div><span>素材</span><span>{stats?.assets ?? 0} 个 · {formatBytes(stats?.bytes ?? 0)}</span></div>
            <div><span>文件行</span><span>托管 {stats?.managedFiles ?? 0} · 引用 {stats?.referencedFiles ?? 0}</span></div>
            <div><span>缩略图</span><span>{stats?.thumbnails ?? 0} 张</span></div>
            <div><span>项目</span><span>{stats?.projects ?? 0} 个</span></div>
            <div><span>回收站</span><span>{stats?.trashed ?? 0} 项</span></div>
            <div><span>媒体工具</span><span className="mono">{ping?.ffmpegDir ?? '…'}</span></div>
          </div>

          {report ? (
            <div className="meta-table" style={{ padding: 0 }}>
              <div><span>库内对象</span><span>{report.objectsOnDisk} 个 · sidecar {report.sidecarsOnDisk} 个</span></div>
              <div><span>对象无索引</span><span>{report.objectsWithoutDbRow}</span></div>
              <div><span>索引无对象</span><span>{report.dbRowsWithoutObject}</span></div>
              <div><span>同内容多素材</span><span>{report.duplicateHashGroups}</span></div>
              <div><span>路径过期</span><span>{report.managedPathsStale}（不为 0 时跑一次 relink）</span></div>
              <div><span>缩略图缓存</span><span>{report.thumbFilesOnDisk} 个（孤儿 {report.orphanThumbs}）</span></div>
              <div>
                <span>结论</span>
                <span style={{ color: report.objectsWithoutDbRow + report.dbRowsWithoutObject + report.duplicateHashGroups + report.managedPathsStale === 0 ? 'var(--success)' : 'var(--destructive)' }}>
                  {report.objectsWithoutDbRow + report.dbRowsWithoutObject + report.duplicateHashGroups + report.managedPathsStale === 0 ? '一致（无异常）' : '有异常，见上表'}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void verify(false)}>完整性核对</button>
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void verify(true)}>核对并重算哈希</button>
          <button type="button" className="btn btn--default" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
