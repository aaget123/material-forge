import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * 读取文本/代码文件的开头，供卡片直接展示摘要。
 * 好处是列表页不用为每张卡片再发一次请求（参考设计里卡片正文要显示 excerpt）。
 */
export function readExcerpt(filePath: string, maxBytes = 8192, maxChars = 600): string | null {
  try {
    const size = statSync(filePath).size;
    const length = Math.min(maxBytes, size);
    if (length === 0) return null;
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, 0);
    } finally {
      closeSync(fd);
    }
    const text = buffer
      .toString('utf8')
      .replace(/\u0000/g, '')       // 二进制尾巴里的空字节
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!text) return null;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return null;
  }
}
