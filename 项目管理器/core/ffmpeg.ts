import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_FFMPEG_DIR } from './config.ts';

const run = promisify(execFile);

/** 复用本机已有的 ffmpeg 9.0 full build（开发建议 §2.1），不额外下载依赖 */
export function ffmpegBin(dir: string = DEFAULT_FFMPEG_DIR): { ffmpeg: string; ffprobe: string } {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const local = join(dir, `ffmpeg${exe}`);
  const localProbe = join(dir, `ffprobe${exe}`);
  if (existsSync(local) && existsSync(localProbe)) return { ffmpeg: local, ffprobe: localProbe };
  return { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}` };
}

export interface ProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  hasImage: boolean;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  formatName: string | null;
  tags: Record<string, string>;
  raw: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
}

/** 读取真实元数据；失败返回 null，由调用方决定降级（不抛出中断整批索引） */
export async function probe(filePath: string, ffmpegDir?: string): Promise<ProbeResult | null> {
  const { ffprobe } = ffmpegBin(ffmpegDir);
  try {
    const { stdout } = await run(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    const data = JSON.parse(stdout) as FfprobeOutput;
    const streams = data.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const durationRaw = data.format?.duration ?? video?.duration ?? null;
    const bitrateRaw = data.format?.bit_rate ?? null;
    return {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      hasImage: Boolean(video && video.codec_name && IMAGE_CODECS.has(video.codec_name)),
      durationSec: durationRaw ? Number(durationRaw) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      bitrate: bitrateRaw ? Number(bitrateRaw) : null,
      formatName: data.format?.format_name ?? null,
      tags: data.format?.tags ?? {},
      raw: stdout,
    };
  } catch {
    return null;
  }
}

const IMAGE_CODECS = new Set([
  'png', 'apng', 'mjpeg', 'jpeg2000', 'webp', 'bmp', 'gif', 'tiff', 'hevc', 'h264', 'av1', 'vp8', 'vp9',
]);

export const THUMB_SIZE = 480;

/** 图片缩略图：只取第一帧（apng/gif 也只取一帧） */
export async function makeImageThumb(src: string, out: string, ffmpegDir?: string): Promise<boolean> {
  const { ffmpeg } = ffmpegBin(ffmpegDir);
  const filter = `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=decrease`;
  try {
    await run(
      ffmpeg,
      ['-y', '-v', 'error', '-i', src, '-vf', filter, '-frames:v', '1', '-f', 'webp', '-quality', '78', out],
      { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return existsSync(out);
  } catch {
    return false;
  }
}

/** 视频缩略图：默认取第 1 秒的帧；视频太短则退回第 0 帧 */
export async function makeVideoThumb(src: string, out: string, ffmpegDir?: string, atSec = 1): Promise<boolean> {
  const { ffmpeg } = ffmpegBin(ffmpegDir);
  const filter = `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=decrease`;
  const build = (seek: number): string[] => [
    '-y', '-v', 'error', '-ss', String(seek), '-i', src, '-vf', filter,
    '-frames:v', '1', '-f', 'webp', '-quality', '78', out,
  ];
  for (const seek of [atSec, 0]) {
    try {
      await run(ffmpeg, build(seek), { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      if (existsSync(out)) return true;
    } catch {
      /* 换下一个时间点重试 */
    }
  }
  return false;
}

export const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.mts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.png': 'image/png', '.apng': 'image/apng', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
};

export function mimeOf(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}
