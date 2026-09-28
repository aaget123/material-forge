import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { yaml } from '@codemirror/lang-yaml';
import { api, type FsTextInfo } from '../api.ts';
import Icon from './Icon.tsx';

interface Props {
  path: string;
  onClose: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

/** 按后缀给语法高亮；认不出来的就当纯文本 */
function languageFor(ext: string): ReturnType<typeof javascript> | null {
  switch (ext) {
    case '.js': case '.jsx': case '.ts': case '.tsx': case '.mjs': case '.cjs':
      return javascript({ typescript: ext.includes('ts'), jsx: ext.includes('x') });
    case '.md': case '.markdown': return markdown();
    case '.py': return python();
    case '.html': case '.htm': case '.vue': case '.svelte': return html();
    case '.css': case '.scss': case '.less': return css();
    case '.json': case '.jsonc': return json();
    case '.sql': return sql();
    case '.rs': return rust();
    case '.c': case '.h': case '.cpp': case '.hpp': case '.cc': return cpp();
    case '.java': case '.kt': return java();
    case '.yml': case '.yaml': return yaml();
    default: return null;
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 磁盘文件的查看/编辑（文件浏览里点文件打开的就是它）。
 *
 * 默认**只读**：只有点了「编辑」才能改，改完点「保存」还要再点一次确认才会写回磁盘。
 * 磁盘文件没有版本历史，所以保存前服务端会留一份 `.bak`。
 */
export default function FileViewer({ path, onClose, onError, onNotice }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [info, setInfo] = useState<FsTextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editable, setEditable] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const language = useMemo(() => (info ? languageFor(info.ext) : null), [info]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setEditable(false);
    setDirty(false);
    setConfirmSave(false);
    setConfirmClose(false);
    void api
      .fsText(path)
      .then((result) => { if (!cancelled) setInfo(result); })
      .catch((err: unknown) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [path]);

  // 编辑器实例：editable 变了要重建（CodeMirror 的只读是编译进 state 的）
  useEffect(() => {
    if (!info || info.binary || !hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: info.text,
        extensions: [
          basicSetup,
          ...(language ? [language] : []),
          EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDirty(true);
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [info, editable, language]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); requestClose(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (editable && dirty) setConfirmSave(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, dirty]);

  const requestClose = (): void => {
    // 有未保存的修改就先问一次，别让人一点就丢
    if (dirty && !confirmClose) { setConfirmClose(true); return; }
    onClose();
  };

  const save = async (): Promise<void> => {
    const view = viewRef.current;
    if (!view || !info) return;
    setSaving(true);
    try {
      const report = await api.fsWriteText(info.path, view.state.doc.toString());
      setDirty(false);
      setConfirmSave(false);
      setInfo(await api.fsText(info.path));
      onNotice(`已保存（${humanSize(report.bytes)}${report.backupPath ? '，原文件已备份为 .bak' : ''}）`);
    } catch (err) {
      onError(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" role="presentation">
      <div className="fviewer" role="dialog" aria-modal="true" aria-label="文件查看">
        <div className="fviewer-head">
          <div className="fviewer-title">
            <strong className="truncate">{info?.name ?? path.split(/[\\/]/).pop()}</strong>
            <span className="fviewer-meta mono truncate" title={path}>{path}</span>
          </div>
          {info ? (
            <span className="fviewer-meta">
              {humanSize(info.size)} · {new Date(info.mtime).toLocaleString('zh-CN')} · {info.encoding}
              {info.eol === 'CRLF' ? ' · CRLF' : ''} · {info.lines} 行
              {info.truncated ? ' · 只读前 2MB' : ''}
            </span>
          ) : null}
          <span className="browse-spacer" />
          {dirty ? <span className="browse-badge">未保存</span> : null}
          {info && !info.binary ? (
            editable ? (
              <>
                <button type="button" className="btn btn--outline btn--sm" onClick={() => { setEditable(false); setDirty(false); setInfo({ ...info }); }}>
                  取消编辑
                </button>
                <button
                  type="button"
                  className={confirmSave ? 'btn btn--destructive btn--sm' : 'btn btn--default btn--sm'}
                  disabled={saving || !dirty}
                  onClick={() => { if (confirmSave) void save(); else setConfirmSave(true); }}
                  title={editable ? '写回磁盘原文件（会先备份 .bak）' : undefined}
                >
                  {confirmSave ? '再点一次：写回原文件' : '保存'}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setEditable(true)}>编辑</button>
            )
          ) : null}
          <button
            type="button"
            className={confirmClose ? 'btn btn--outline btn--sm' : 'btn btn--ghost btn--sm'}
            onClick={requestClose}
          >
            {confirmClose ? '再点一次：放弃修改' : '关闭'}
          </button>
        </div>

        {

        error ? <div className="notice notice-error">{error}</div> : null}
        {info?.binary ? (
          <div className="fviewer-note">
            <p>这不是文本文件（{info.ext || '无后缀'}）。</p>
            <p className="muted">要看内容可以用「打开方式」交给别的程序。</p>
          </div>
        ) : null}
        <div className="fviewer-body" ref={hostRef} />
        {!info && !error ? <div className="fviewer-note muted">读取中…</div> : null}
      </div>
    </div>
  );
}
