import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

/**
 * 直接读写磁盘上的文本文件（"在文件里打开项目里的任何文件"）。
 *
 * 与库内素材的区别：这里不动库、不建索引，读写的就是磁盘上那个文件本身。
 * 因此边界必须写清楚：
 *  - 只接受**本地绝对路径**（拒绝 UNC/相对路径，避免被当成网络位置或相对到别的目录）；
 *  - 只读文本，超过上限只返回前一段并标 truncated（避免编辑器被大文件卡死）；
 *  - 保存**默认不做**，只有在界面上显式点过"编辑"并二次确认后才会调用写接口。
 */

export interface FileTextInfo {
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: string;
  /** utf8 / utf8-bom / gbk / binary */
  encoding: string;
  /** LF / CRLF */
  eol: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  lines: number;
  /** 只读（权限或系统属性导致） */
  readOnly: boolean;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function assertLocalPath(rawPath: string): string {
  if (!rawPath || !isAbsolute(rawPath)) throw new Error('需要一个绝对路径');
  if (rawPath.startsWith('\\\\')) throw new Error('不支持网络路径');
  if (!/^[A-Za-z]:[\\/]/.test(rawPath)) throw new Error('只支持本地盘符路径');
  return rawPath;
}

/** GBK 解码器：中文文本文件在 Windows 上很常见（Node 自带 full ICU，可以直接解） */
const gbkDecoder = ((): TextDecoder | null => {
  try {
    return new TextDecoder('gbk');
  } catch {
    return null;
  }
})();

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

export function readTextFile(rawPath: string): FileTextInfo {
  const path = assertLocalPath(rawPath);
  if (!existsSync(path)) throw new Error('文件不存在（可能已被移动或删除）');
  const stat = statSync(path);
  if (stat.isDirectory()) throw new Error('这是一个文件夹，不是文件');

  const size = stat.size;
  const head = readFileSync(path, { flag: 'r' }).subarray(0, Math.min(size, 4));
  // 先判二进制，避免把图片/视频当文本读进来
  const probe = size > MAX_TEXT_BYTES ? readFileSync(path).subarray(0, 4096) : readFileSync(path);
  const binary = looksBinary(probe);
  const whole = size > MAX_TEXT_BYTES ? readFileSync(path).subarray(0, MAX_TEXT_BYTES) : readFileSync(path);

  let encoding = 'utf8';
  let text: string;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    encoding = 'utf8-bom';
    text = whole.subarray(3).toString('utf8');
  } else if (binary) {
    encoding = 'binary';
    text = '';
  } else {
    // 先按 UTF-8 试解：出现替换字符就说明不是 UTF-8，退回 GBK
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(whole);
    if (utf8.includes('\uFFFD') && gbkDecoder) {
      encoding = 'gbk';
      text = gbkDecoder.decode(whole);
    } else {
      text = utf8;
    }
  }

  const eol = text.includes('\r\n') ? 'CRLF' : 'LF';
  return {
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    ext: extname(path).toLowerCase(),
    size,
    mtime: stat.mtime.toISOString(),
    encoding,
    eol,
    text: binary ? '' : text,
    truncated: size > MAX_TEXT_BYTES,
    binary,
    lines: binary ? 0 : text.split('\n').length,
    // 写不进去的常见原因：只读属性。界面上按只读处理，保存时再报错
    readOnly: (stat.mode & 0o200) === 0,
  };
}

export interface FileWriteReport {
  path: string;
  bytes: number;
  mtime: string;
  /** 保存前是否留了一份 .bak（默认留，磁盘文件没有版本历史） */
  backupPath: string | null;
}

export function writeTextFile(rawPath: string, body: string, options: { backup?: boolean } = {}): FileWriteReport {
  const path = assertLocalPath(rawPath);
  if (!existsSync(path)) throw new Error('文件不存在（可能已被移动或删除）');
  const stat = statSync(path);
  if (stat.isDirectory()) throw new Error('这是一个文件夹，不是文件');

  // 保持原来的换行风格与 BOM：不要因为一次编辑就悄悄改掉整个文件的格式
  const previous = readFileSync(path);
  const hasBom = previous[0] === 0xef && previous[1] === 0xbb && previous[2] === 0xbf;
  const hadCrlf = previous.includes(Buffer.from('\r\n', 'utf8'));
  let text = body.replace(/\r\n/g, '\n');
  if (hadCrlf) text = text.replace(/\n/g, '\r\n');

  let backupPath: string | null = null;
  if (options.backup !== false) {
    backupPath = `${path}.bak`;
    try {
      writeFileSync(backupPath, previous);
    } catch {
      backupPath = null; // 备份失败不阻断保存，报告里如实体现
    }
  }

  const payload = hasBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8');
  try {
    writeFileSync(path, payload);
  } catch (err) {
    const message = (err as Error).message;
    throw new Error(`写不进去：${message}（文件可能被占用或只读）`);
  }
  return { path, bytes: payload.length, mtime: statSync(path).mtime.toISOString(), backupPath };
}
