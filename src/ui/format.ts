import { DAY, HOUR, MINUTE } from '../game/balance.ts';

export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' Mio.';
  if (a >= 1e4) return Math.round(v / 1000) + ' Tsd.';
  return Math.round(v).toLocaleString('de-DE');
}

export function fmtSigned(v: number): string {
  return (v >= 0 ? '+' : '−') + fmtNum(Math.abs(v));
}

export function fmtGameTime(t: number): string {
  const day = Math.floor(t / DAY) + 1;
  const h = Math.floor((t % DAY) / HOUR);
  const m = Math.floor((t % HOUR) / MINUTE);
  return `Tag ${day}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function fmtDay(t: number): string {
  return `Tag ${Math.floor(t / DAY) + 1}`;
}

/** Dauer in Echtzeit (ms) als kurzer Text */
export function fmtDuration(ms: number): string {
  if (!isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function fmtPercent(v: number): string {
  return Math.round(v * 100) + ' %';
}

export function fmtSpeed(speed: number): string {
  if (speed === 1) return '1× (Tag = 24 h)';
  const minutes = (24 * 60) / speed;
  return `${speed}× (Tag = ${minutes >= 60 ? minutes / 60 + ' h' : minutes + ' min'})`;
}
