import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** 超过这个大小不做全量哈希（M0 实测最大的 mp4 也在阈值内）；
 *  留这个上限是为了以后导入几十 GB 的视频时不阻塞流水线。 */
export const HASH_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 内容哈希（BLAKE3 的替代：Node 内置 sha256）。
 * 用途：M1 按内容去重、库搬家后按哈希自动重链（relink）。
 * 流式计算，避免把大文件读进内存。
 */
export function hashFile(filePath: string, maxBytes = HASH_MAX_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    const h = createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let read = 0;
    stream.on('data', (chunk) => {
      read += chunk.length;
      if (read > maxBytes) {
        stream.destroy();
        resolve(null);
        return;
      }
      h.update(chunk);
    });
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}
