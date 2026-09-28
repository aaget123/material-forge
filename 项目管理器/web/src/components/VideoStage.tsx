import { useEffect, useRef, useState } from 'react';
import { mediaSrc, type AssetListItem } from '../api.ts';
import { formatClock } from '../modality.tsx';

interface Props {
  asset: AssetListItem;
  onError: (message: string) => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * 视频的专注模式：专心播放。
 *
 * 按用户反馈去掉了"放大"（缩放/平移）——看视频要的是安静地看，不是拿着放大镜找像素。
 * 保留的是播放真正用得上的：播放/暂停、进度、倍速、音量、静音、逐帧、系统全屏。
 */
export default function VideoStage({ asset, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(asset.durationSec);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(
    asset.width && asset.height ? { w: asset.width, h: asset.height } : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    setTime(0);
    setPlaying(false);
  }, [asset.id]);

  const toggle = (): void => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch((err: unknown) => onError(`播放失败：${(err as Error).message}`));
    else el.pause();
  };

  const seek = (delta: number): void => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || duration || 0, el.currentTime + delta));
    setTime(el.currentTime);
  };

  const seekTo = (ratio: number): void => {
    const el = videoRef.current;
    const total = el?.duration && Number.isFinite(el.duration) ? el.duration : duration;
    if (!el || !total) return;
    el.currentTime = Math.max(0, Math.min(1, ratio)) * total;
    setTime(el.currentTime);
  };

  const toggleFullscreen = (): void => {
    const el = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => onError('浏览器拒绝了全屏请求'));
  };

  useEffect(() => {
    const el = videoRef.current;
    if (el) { el.playbackRate = speed; el.volume = volume; el.muted = muted; }
  }, [speed, volume, muted, asset.id]);

  // 键盘：空格播放、←→ 5 秒、,/. 逐帧、↑↓ 音量、M 静音、F 全屏
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      if (event.key === ' ') { event.preventDefault(); toggle(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(-5); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(5); }
      else if (event.key === ',') { event.preventDefault(); seek(-1 / 30); }
      else if (event.key === '.') { event.preventDefault(); seek(1 / 30); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setVolume((v) => Math.min(1, Number((v + 0.1).toFixed(2)))); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setVolume((v) => Math.max(0, Number((v - 0.1).toFixed(2)))); }
      else if (event.key === 'm' || event.key === 'M') { event.preventDefault(); setMuted((m) => !m); }
      else if (event.key === 'f' || event.key === 'F') { event.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  const progress = duration && duration > 0 ? Math.min(1, time / duration) : 0;

  return (
    <div className="vstage">
      <div className="vstage-stage">
        <video
          ref={videoRef}
          className="vstage-video"
          src={mediaSrc(asset.id)}
          preload="metadata"
          playsInline
          onLoadedMetadata={(event) => {
            const el = event.currentTarget;
            if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
            if (el.videoWidth) setSize({ w: el.videoWidth, h: el.videoHeight });
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onError={() => setLoadError('浏览器无法播放这个视频（可能是 MKV/HEVC 等编码）')}
          onDoubleClick={toggleFullscreen}
        />
        {loadError ? <div className="vstage-error">{loadError}<br /><span className="muted">可以用右上角的「打开方式…」交给系统播放器。</span></div> : null}
      </div>

      <div className="vstage-transport">
        <button type="button" className="wave-play" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="wave-time tabular">
          {formatClock(time) ?? '0:00'} <span className="muted">/ {formatClock(duration) ?? '--:--'}</span>
        </span>
        <input
          className="wave-seek"
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          aria-label="播放进度"
          onChange={(event) => seekTo(Number(event.target.value) / 1000)}
        />
        <label className="wave-field">
          <span className="sr-only">倍速</span>
          <select className="select" style={{ height: 28, fontSize: 12, width: 82 }} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <label className="wave-field">
          <span className="sr-only">音量</span>
          <input type="range" min={0} max={100} value={Math.round(volume * 100)} aria-label="音量" onChange={(event) => setVolume(Number(event.target.value) / 100)} />
        </label>
        <button type="button" className="vstage-btn" onClick={() => setMuted((m) => !m)} title="静音（M）">{muted ? '🔇' : '🔊'}</button>
        <button type="button" className="vstage-btn" onClick={toggleFullscreen} title="全屏（F，也可以双击画面）">全屏</button>
      </div>

      <p className="wave-note">
        {size ? `${size.w} × ${size.h} · ` : ''}
        空格 播放/暂停 · ←→ 5 秒 · <kbd>,</kbd> <kbd>.</kbd> 逐帧 · ↑↓ 音量 · M 静音 · F 全屏
      </p>
    </div>
  );
}
