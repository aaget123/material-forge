import { useEffect, useState } from 'react';
import { api, mediaSrc, type AssetListItem } from '../api.ts';
import { MODALITY_META, formatClock, type Modality } from '../modality.tsx';

interface Props {
  asset: AssetListItem;
  onError: (message: string) => void;
}

const HEAD_BYTES = 4096;
const HEX_BYTES = 512;

/**
 * 综合 / 其他类型的专注模式：文件检视。
 *
 * 这类素材没法"播放"，专业做法是把"这是什么文件"讲清楚：
 * 元数据 + 首部字节（hex）+ 文本嗅探（像文本就直接显示原文），
 * 实在看不懂的才给"交给系统默认程序"这一个兜底动作。
 * PDF 例外：它有完整的阅读器，直接整窗嵌进来。
 */
export default function MixedFocus({ asset, onError }: Props) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ sizeHuman: string; sources: number } | null>(null);

  const isPdf = asset.ext.toLowerCase() === '.pdf';

  useEffect(() => {
    setBytes(null);
    setError(null);
    if (isPdf) return;
    let cancelled = false;
    // 用 Range 只取文件头：几 GB 的文件也不需要读进来
    void fetch(mediaSrc(asset.id), { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } })
      .then(async (res) => {
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (!cancelled) setBytes(new Uint8Array(buffer));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message);
        onError(`读取文件头失败：${(err as Error).message}`);
      });
    void api
      .asset(asset.id)
      .then((d) => { if (!cancelled) setDetail({ sizeHuman: d.sizeHuman, sources: d.sources.length }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [asset.id, isPdf, onError]);

  const sniff = sniffText(bytes);
  const modality = (asset.modality ?? 'mixed') as Modality;

  return (
    <div className="mixed">
      {isPdf ? (
        <iframe className="mixed-pdf" src={mediaSrc(asset.id)} title={asset.title} />
      ) : (
        <>
          <div className="mixed-meta">
            <div><span>类型</span><span>{MODALITY_META[modality].label} · {asset.ext || '无后缀'}</span></div>
            <div><span>大小</span><span>{detail?.sizeHuman ?? `${Math.round(asset.size / 1024)} KB`}</span></div>
            {asset.width && asset.height ? <div><span>尺寸</span><span>{asset.width} × {asset.height}</span></div> : null}
            {asset.durationSec ? <div><span>时长</span><span>{formatClock(asset.durationSec)}</span></div> : null}
            <div><span>库内</span><span>{asset.trashed ? '托管副本在回收站' : asset.inLibrary ? '有托管副本' : '仅引用'}</span></div>
            <div><span>来源路径</span><span className="mono">{asset.sourcePath}</span></div>
            <div><span>文件头</span><span>{bytes ? describeMagic(bytes) : '读取中…'}</span></div>
          </div>

          {sniff.isText ? (
            <div className="mixed-block">
              <h3>文本嗅探：这个文件看起来就是文本</h3>
              <pre className="mixed-text">{sniff.text}</pre>
              <p className="muted">它没有按文本类型入库（后缀不在文本白名单里），所以卡片上没有文本预览；内容本身可以直接读。</p>
            </div>
          ) : (
            <div className="mixed-block">
              <h3>首部字节（前 {HEX_BYTES} 字节）</h3>
              {error ? <p className="muted">读不到文件头：{error}</p> : null}
              <pre className="mixed-hex">{bytes ? hexDump(bytes, HEX_BYTES) : '读取中…'}</pre>
              <p className="muted">
                二进制内容不在本工具里预览；要打开就用右上角的「外部打开」交给系统默认程序。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 判断文件头像不像文本：能按 UTF-8 解出来、且控制字符很少 */
function sniffText(bytes: Uint8Array | null): { isText: boolean; text: string } {
  if (!bytes || bytes.length === 0) return { isText: false, text: '' };
  let control = 0;
  for (const byte of bytes) {
    if (byte === 0) return { isText: false, text: '' }; // 有 NUL 基本可以断定是二进制
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  if (control / bytes.length > 0.05) return { isText: false, text: '' };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.includes('\uFFFD')) {
    // 有替换字符说明不是干净的 UTF-8；替换占比很低时仍然当文本看待
    const bad = (text.match(/\uFFFD/g) ?? []).length;
    if (bad / Math.max(1, text.length) > 0.02) return { isText: false, text: '' };
  }
  return { isText: true, text };
}

/** 认几个常见的文件头，认不出就老实说认不出 */
function describeMagic(bytes: Uint8Array): string {
  const hex = [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...bytes.subarray(0, 4)].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  const known: Array<[string, string]> = [
    ['50 4b 03 04', 'ZIP 容器（zip/docx/xlsx/odt…）'],
    ['25 50 44 46', 'PDF'],
    ['89 50 4e 47', 'PNG'],
    ['ff d8 ff', 'JPEG'],
    ['47 49 46 38', 'GIF'],
    ['52 61 72 21', 'RAR'],
    ['37 7a bc af', '7z'],
    ['1f 8b', 'gzip'],
    ['42 4d', 'BMP'],
    ['38 42 50 53', 'Photoshop PSD'],
    ['7b 5c 72 74 66', 'RTF'],
    ['00 01 00 00', 'TrueType 字体'],
  ];
  for (const [prefix, label] of known) {
    if (hex.startsWith(prefix)) return `${label}（${hex}）`;
  }
  return `未知（${hex}｜ASCII "${ascii}"）`;
}

function hexDump(bytes: Uint8Array, limit: number): string {
  const slice = bytes.subarray(0, Math.min(limit, bytes.length));
  const lines: string[] = [];
  for (let offset = 0; offset < slice.length; offset += 16) {
    const row = slice.subarray(offset, offset + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(16 * 3 - 1, ' ');
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}
