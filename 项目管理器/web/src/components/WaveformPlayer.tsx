import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, mediaSrc, type AssetListItem } from '../api.ts';
import { formatClock } from '../modality.tsx';

interface Props {
  asset: AssetListItem;
  onError: (message: string) => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * 声音/音乐的专注模式：真实波形 + 播放控制。
 *
 * 波形数据来自服务端 peaks（ffmpeg 现算 + 按内容哈希缓存），
 * 这里**不**用 Web Audio 解码整段音频——那会把整段裸 PCM 塞进内存
 * （60 分钟立体声可超 500MB）。播放交给 <audio>，浏览器自己流式处理。
 */
export default function WaveformPlayer({ asset, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const [points, setPoints] = useState<number[] | null>(null);
  const [duration, setDuration] = useState<number | null>(asset.durationSec);
  const [peaksSource, setPeaksSource] = useState<'cache' | 'ffmpeg' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  const active = asset.modality === 'music' || asset.modality === 'voice';

  // 波形（按素材 id 变化重新取；服务端缓存命中时几乎瞬时）
  useEffect(() => {
    setPoints(null);
    setLoadError(null);
    setTime(0);
    setPlaying(false);
    if (!active) return;
    let cancelled = false;
    void api
      .peaks(asset.id)
      .then((result) => {
        if (cancelled) return;
        setPoints(result.points);
        setPeaksSource(result.source);
        setDuration((prev) => (prev && prev > 0 ? prev : result.durationSec));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError((err as Error).message);
        onError(`波形加载失败：${(err as Error).message}`);
      });
    return () => { cancelled = true; };
  }, [asset.id, active, onError]);

  // 容器宽度（面板缩放/窗口变化都要重画）
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = (): void => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const progress = duration && duration > 0 ? Math.min(1, time / duration) : 0;

  // 画波形：以中线为轴的对称条，已播放部分用主色
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const style = getComputedStyle(canvas);
    const playedColor = style.getPropertyValue('--primary').trim() || '#111';
    const restColor = style.getPropertyValue('--border').trim() || '#ddd';

    if (!points || points.length === 0) {
      ctx.fillStyle = restColor;
      ctx.fillRect(0, mid - 1, width, 2);
      return;
    }
    // 每个点画一条竖线；点比像素多时按像素合并，点比像素少时线宽 >1
    const bars = Math.min(points.length, Math.max(1, Math.floor(width)));
    const perBar = points.length / bars;
    const barWidth = width / bars;
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      const from = Math.floor(i * perBar);
      const to = Math.min(points.length, Math.floor((i + 1) * perBar));
      for (let j = from; j < to; j++) if (points[j]! > peak) peak = points[j]!;
      const h = Math.max(1, peak * (height * 0.46) * 2);
      ctx.fillStyle = i / bars <= progress ? playedColor : restColor;
      ctx.fillRect(i * barWidth, mid - h / 2, Math.max(0.6, barWidth - 0.5), h);
    }
  }, [points, width, progress]);

  // 播放中按帧推进播放头
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = (): void => {
      const el = audioRef.current;
      if (el) setTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seekTo = useCallback((ratio: number): void => {
    const el = audioRef.current;
    const total = el?.duration && Number.isFinite(el.duration) ? el.duration : duration;
    if (!el || !total) return;
    const target = Math.max(0, Math.min(1, ratio)) * total;
    el.currentTime = target;
    setTime(target);
  }, [duration]);

  const ratioFromEvent = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) / rect.width;
  };

  const toggle = (): void => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch((err: unknown) => onError(`播放失败：${(err as Error).message}`));
    else el.pause();
  };

  const nudge = (delta: number): void => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || duration || 0, el.currentTime + delta));
    setTime(el.currentTime);
  };

  // 键盘：空格播放/暂停、←/→ 5 秒、↑/↓ 音量、0 回到开头。
  // 依赖里故意不放 toggle/nudge：它们只碰 ref 和 setState，不依赖渲染期状态；
  // 若不加依赖数组，播放时每帧都会重挂监听（实测过这个坑）。
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      if (event.key === ' ') { event.preventDefault(); toggle(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(-5); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(5); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setVolume((v) => Math.min(1, Number((v + 0.1).toFixed(2)))); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setVolume((v) => Math.max(0, Number((v - 0.1).toFixed(2)))); }
      else if (event.key === '0') { event.preventDefault(); seekTo(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, seekTo, duration]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) { el.playbackRate = speed; el.volume = volume; }
  }, [speed, volume]);

  const shownTime = duration && duration > 0 && time > duration ? duration : time;

  return (
    <div className="wave">
      <div className="wave-stage" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="wave-canvas"
          onPointerDown={(event) => {
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
            seekTo(ratioFromEvent(event.clientX));
          }}
          onPointerMove={(event) => { if (dragging) seekTo(ratioFromEvent(event.clientX)); }}
          onPointerUp={(event) => {
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => setDragging(false)}
        />
        {!points && !loadError ? <div className="wave-hint">正在读取波形…</div> : null}
        {loadError ? <div className="wave-hint">波形不可用：{loadError}</div> : null}
      </div>

      <div className="wave-transport">
        <button type="button" className="wave-play" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="wave-time tabular">
          {formatClock(shownTime) ?? '0:00'} <span className="muted">/ {formatClock(duration) ?? '--:--'}</span>
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
          <select className="select" style={{ height: 28, fontSize: 12, width: 76 }} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <label className="wave-field">
          <span className="sr-only">音量</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            aria-label="音量"
            onChange={(event) => setVolume(Number(event.target.value) / 100)}
          />
        </label>
      </div>

      <audio
        ref={audioRef}
        src={mediaSrc(asset.id)}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const d = event.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onError={() => setLoadError('浏览器无法播放这个音频格式')}
      />

      <p className="wave-note">
        波形是服务端用 ffmpeg 算出的<strong>峰值包络</strong>
        （{points ? points.length : 0} 个点，{peaksSource === 'cache' ? '本次命中缓存' : peaksSource === 'ffmpeg' ? '本次现算' : '读取中'}），
        不是把整段音频解码进浏览器内存；点击或拖动波形可跳转。
      </p>
    </div>
  );
}
