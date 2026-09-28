import { AudioLines, Code2, FileText, Film, Image as ImageIcon, Layers, Music, type LucideIcon } from 'lucide-react';

export type Modality = 'text' | 'code' | 'image' | 'video' | 'music' | 'voice' | 'mixed';

export const MODALITY_META: Record<Modality, { label: string; icon: LucideIcon }> = {
  text: { label: '文本', icon: FileText },
  code: { label: '代码', icon: Code2 },
  image: { label: '图片', icon: ImageIcon },
  video: { label: '视频', icon: Film },
  music: { label: '音乐', icon: Music },
  voice: { label: '声音', icon: AudioLines },
  mixed: { label: '综合', icon: Layers },
};

export const MODALITY_ORDER: Modality[] = ['text', 'code', 'image', 'video', 'music', 'voice', 'mixed'];

export const PROJECT_COLORS = ['project-1', 'project-2', 'project-3', 'project-4'] as const;

export function projectColorOf(color: string | null | undefined): string {
  return PROJECT_COLORS.includes((color ?? '') as (typeof PROJECT_COLORS)[number]) ? (color as string) : PROJECT_COLORS[0];
}

export function projectDotClass(color: string | null | undefined): string {
  return `project-dot dot-${projectColorOf(color)}`;
}

/** 参考设计的日期格式：9月26日 */
export function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 参考设计的时长格式：3:12 */
export function formatClock(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
