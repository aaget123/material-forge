import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
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
import { api, type AssetListItem } from '../api.ts';
import { IconButton } from './Icon.tsx';

interface Props {
  asset: AssetListItem;
  onError: (message: string) => void;
  /** 保存成功后通知外层刷新（摘要/大小/版本都要跟着变） */
  onSaved?: (message: string) => void;
}

/** 按后缀挑语法高亮；挑不到就纯文本（不硬塞一个错的语法） */
function languageFor(ext: string): ReturnType<typeof javascript> | null {
  const e = ext.toLowerCase();
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(e)) return javascript({ jsx: true });
  if (['.ts', '.mts', '.cts'].includes(e)) return javascript({ typescript: true });
  if (e === '.tsx') return javascript({ typescript: true, jsx: true });
  if (e === '.json' || e === '.jsonc') return json();
  if (['.md', '.markdown'].includes(e)) return markdown();
  if (['.py', '.pyi'].includes(e)) return python();
  if (['.html', '.htm'].includes(e)) return html();
  if (['.css', '.scss', '.less'].includes(e)) return css();
  if (e === '.sql') return sql();
  if (e === '.rs') return rust();
  if (['.c', '.h', '.cc', '.cpp', '.hpp', '.cs'].includes(e)) return cpp();
  if (e === '.java') return java();
  if (['.yaml', '.yml'].includes(e)) return yaml();
  return null;
}

/**
 * 文本/代码的专注模式：可编辑的代码编辑器。
 *
 * 编辑器的能力来自 CodeMirror 6（行号、语法高亮、括号匹配、搜索替换、折叠、多光标），
 * 不引 Monaco：这里要的是"能好好改文本与代码"，不是 IDE（真需要类型提示时再换实现）。
 *
 * 保存语义（用户确认过）：**默认存成新版本**——服务端用新内容生成新对象、旧内容留在版本表里；
 * 「同时写回原文件」是可选动作，需要二次确认，因为那会真的改磁盘上的文件。
 */
export default function TextFocus({ asset, onError, onSaved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedRef = useRef('');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [armedWriteBack, setArmedWriteBack] = useState(false);
  const [versionCount, setVersionCount] = useState<number | null>(null);
  const [stats, setStats] = useState({ lines: 0, chars: 0 });
  const [copied, setCopied] = useState(false);

  const language = useMemo(() => languageFor(asset.ext), [asset.ext]);
  const editable = asset.modality === 'text' || asset.modality === 'code';

  // 载入全文 + 建立编辑器
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDirty(false);
    setArmedWriteBack(false);
    viewRef.current?.destroy();
    viewRef.current = null;
    if (!editable) { setLoading(false); return; }

    void api
      .readFullText(asset.id)
      .then((text) => {
        if (cancelled) return;
        savedRef.current = text.body;
        setStats(countStats(text.body));
        setLoading(false);
        const host = hostRef.current;
        if (!host) return;
        const view = new EditorView({
          state: EditorState.create({
            doc: text.body,
            extensions: [
              basicSetup,
              ...(language ? [language] : []),
              EditorView.lineWrapping,
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                const value = update.state.doc.toString();
                setDirty(value !== savedRef.current);
                setStats(countStats(value));
              }),
            ],
          }),
          parent: host,
        });
        viewRef.current = view;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError((err as Error).message);
        setLoading(false);
      });

    void api.versions(asset.id).then((r) => setVersionCount(r.items.length)).catch(() => setVersionCount(null));
    return () => { cancelled = true; };
  }, [asset.id, asset.ext, editable, language]);

  useEffect(() => () => { viewRef.current?.destroy(); }, []);

  const save = async (writeOriginal: boolean): Promise<void> => {
    const view = viewRef.current;
    if (!view || saving) return;
    const body = view.state.doc.toString();
    setSaving(true);
    try {
      const result = await api.saveText(asset.id, body, writeOriginal);
      savedRef.current = body;
      setDirty(false);
      setArmedWriteBack(false);
      setVersionCount(result.versions);
      const bits = [`已保存为新版本（第 ${result.versions} 版）`];
      if (writeOriginal) {
        bits.push(result.wroteOriginal ? '并已写回原文件' : `原文件未写入：${result.originalError ?? '未知原因'}`);
      }
      onSaved?.(bits.join(' · '));
      void api.versions(asset.id).then((r) => setVersionCount(r.items.length)).catch(() => undefined);
    } catch (err) {
      onError(`保存失败：${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // Ctrl+S 保存；编辑器里 Ctrl+S 不该触发浏览器保存网页
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, asset.id]);

  const reload = (): void => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: savedRef.current } });
    setDirty(false);
  };

  if (!editable) {
    return (
      <div className="focus-todo">
        <p>这个类型不在编辑器里打开（{asset.ext || '无后缀'}）。</p>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="editor-file mono">{asset.ext || '纯文本'}</span>
        {dirty ? <span className="editor-dirty" title="有未保存的修改">● 未保存</span> : <span className="muted">已保存</span>}
        <span className="muted tabular">{stats.lines} 行 · {stats.chars} 字符</span>
        {versionCount !== null ? <span className="muted tabular">版本 {versionCount}</span> : null}
        <span className="editor-bar-right">
          {/* 一键复制全文：查看器最常见的一个动作 */}
          <button
            type="button"
            className="vstage-btn"
            title="把当前内容复制到剪贴板"
            onClick={() => {
              void navigator.clipboard
                .writeText(viewRef.current?.state.doc.toString() ?? '')
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => onError('复制失败'));
            }}
          >
            {copied ? '已复制' : '复制全文'}
          </button>
          <button type="button" className="vstage-btn" disabled={!dirty || saving} onClick={reload}>放弃修改</button>
          {armedWriteBack ? (
            <>
              <button type="button" className="btn btn--destructive btn--sm" disabled={saving} onClick={() => void save(true)}>
                确认写回原文件
              </button>
              <button type="button" className="vstage-btn" onClick={() => setArmedWriteBack(false)}>取消</button>
            </>
          ) : (
            <button type="button" className="vstage-btn" disabled={saving} title="把内容写回磁盘上的原文件（本工具不做备份）" onClick={() => setArmedWriteBack(true)}>
              写回原文件…
            </button>
          )}
          <button type="button" className="btn btn--default btn--sm" disabled={!dirty || saving} onClick={() => void save(false)}>
            {saving ? '保存中…' : '保存为新版本'}
          </button>
          <IconButton name="close" label="关闭编辑器（Esc）" onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))} />
        </span>
      </div>

      {loading ? <div className="editor-host editor-loading">正在读取…</div> : null}
      {loadError ? <div className="editor-host editor-loading">无法读取：{loadError}</div> : null}
      <div ref={hostRef} className="editor-host" style={{ display: loading || loadError ? 'none' : undefined }} />

      <p className="wave-note">
        保存不会原地改写库内对象（对象路径 = 内容哈希，改了就不成立）：每次保存都生成一个新版本，旧内容留在版本表里。
        <kbd>Ctrl</kbd>+<kbd>S</kbd> 也可以保存。
      </p>
    </div>
  );
}

function countStats(text: string): { lines: number; chars: number } {
  return { lines: text.length === 0 ? 1 : text.split('\n').length, chars: text.length };
}
