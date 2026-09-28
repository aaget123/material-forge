import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PEAKS_DIR } from './config.ts';
import { ffmpegBin, probe } from './ffmpeg.ts';

/**
 * 真实音频波形数据（peaks）。
 *
 * 为什么不交给浏览器解码：Web Audio 的 decodeAudioData 会把整段音频解成裸 PCM，
 * 60 分钟立体声轻易超过 500MB（wavesurfer.js 官方性能文档明确写了这条）。
 * 这里改在服务端用本机已有的 ffmpeg 降到 8kHz 单声道流式读出来，
 * 边读边按桶取 min/max，内存只与桶数有关，与音频长度无关。
 *
 * 缓存按**内容哈希**命名（与缩略图同一套纪律）：内容不变就不用重算，
 * 库重建、搬家、多份索引都能复用。
 */

/** 波形点数：每声道 1000–2000 点足够（wavesurfer 文档给的经验值），这里取 1600 */
export const PEAK_BUCKETS = 1600;

/** 解码采样率。8kHz 足够画波形，数据量是 44.1kHz 的 1/5.5 */
const SAMPLE_RATE = 8000;

export interface Peaks {
  durationSec: number;
  sampleRate: number;
  /** 归一化到 -1..1 的峰值包络 */
  points: number[];
  source: 'cache' | 'ffmpeg';
}

export function peaksPathForHash(hash: string): string {
  return join(PEAKS_DIR, `${hash}.json`);
}

/** 读缓存（命中就直接用，不启动 ffmpeg） */
export function readCachedPeaks(hash: string): Peaks | null {
  const file = peaksPathForHash(hash);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Omit<Peaks, 'source'>;
    if (!Array.isArray(parsed.points) || parsed.points.length === 0) return null;
    return { ...parsed, source: 'cache' };
  } catch {
    return null;
  }
}

/**
 * 用 ffmpeg 解码成 8kHz 单声道 s16le，从 stdout 流式读出算峰值。
 * 桶宽由 ffprobe 给的时长推出来；实际样本数与估计不符时，多出来的样本并进最后一个桶。
 */
export async function buildPeaks(absPath: string, ffmpegDir?: string): Promise<Peaks | null> {
  const info = await probe(absPath, ffmpegDir);
  const durationSec = info?.durationSec ?? null;
  if (!info?.hasAudio) return null;

  const { ffmpeg } = ffmpegBin(ffmpegDir);
  const estimatedSamples = durationSec ? Math.max(1, Math.round(durationSec * SAMPLE_RATE)) : SAMPLE_RATE * 60;
  const samplesPerBucket = Math.max(1, Math.floor(estimatedSamples / PEAK_BUCKETS));

  return await new Promise<Peaks | null>((resolve) => {
    const child = spawn(
      ffmpeg,
      ['-v', 'error', '-i', absPath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
      { windowsHide: true },
    );

    const points: number[] = [];
    let peak = 0;
    let count = 0;
    let totalSamples = 0;
    let carry: Buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (value: Peaks | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      // 半个样本会跨 chunk，先拼上上次的残留
      const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      carry = usable === buf.length ? Buffer.alloc(0) : buf.subarray(usable);
      for (let i = 0; i < usable; i += 2) {
        const sample = buf.readInt16LE(i) / 32768;
        const abs = sample < 0 ? -sample : sample;
        if (abs > peak) peak = abs;
        count++;
        totalSamples++;
        if (count >= samplesPerBucket) {
          points.push(Number(peak.toFixed(4)));
          peak = 0;
          count = 0;
        }
      }
    });

    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (count > 0) points.push(Number(peak.toFixed(4)));
      if (code !== 0 || points.length === 0) return finish(null);
      const actualDuration = totalSamples / SAMPLE_RATE;
      const normalized = normalize(points);
      const result: Peaks = {
        durationSec: Number(actualDuration.toFixed(3)),
        sampleRate: SAMPLE_RATE,
        points: normalized,
        source: 'ffmpeg',
      };
      finish(result);
    });
  });
}

/** 归一化到 -1..1：不同响度的音频画出来才都看得清 */
function normalize(points: number[]): number[] {
  let max = 0;
  for (const p of points) if (p > max) max = p;
  if (max <= 0) return points.map(() => 0);
  return points.map((p) => Number((p / max).toFixed(4)));
}

export function writePeaksCache(hash: string, peaks: Peaks): void {
  if (!existsSync(PEAKS_DIR)) mkdirSync(PEAKS_DIR, { recursive: true });
  const { source: _source, ...rest } = peaks;
  writeFileSync(peaksPathForHash(hash), JSON.stringify(rest), 'utf8');
}
