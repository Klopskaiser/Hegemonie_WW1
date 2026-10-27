// Vereinfachte Flaggen um 1914 als SVG (Seitenverhältnis 3:2).

import type { ReactNode } from 'react';

const W = 30, H = 20;

const h3 = (a: string, b: string, c: string) => (
  <>
    <rect width={W} height={H / 3 + 0.1} fill={a} />
    <rect y={H / 3} width={W} height={H / 3 + 0.1} fill={b} />
    <rect y={(2 * H) / 3} width={W} height={H / 3} fill={c} />
  </>
);
const v3 = (a: string, b: string, c: string) => (
  <>
    <rect width={W / 3 + 0.1} height={H} fill={a} />
    <rect x={W / 3} width={W / 3 + 0.1} height={H} fill={b} />
    <rect x={(2 * W) / 3} width={W / 3} height={H} fill={c} />
  </>
);
/** Skandinavisches Kreuz */
const nordic = (bg: string, cross: string, inner?: string) => (
  <>
    <rect width={W} height={H} fill={bg} />
    <rect x={8} width={inner ? 6 : 4} height={H} fill={cross} />
    <rect y={inner ? 7 : 8} width={W} height={inner ? 6 : 4} fill={cross} />
    {inner && <><rect x={9.5} width={3} height={H} fill={inner} /><rect y={8.5} width={W} height={3} fill={inner} /></>}
  </>
);
/** Halbmond mit Stern */
const crescent = (x: number, y: number, r: number, bg: string, fg = '#fff') => (
  <>
    <circle cx={x} cy={y} r={r} fill={fg} />
    <circle cx={x + r * 0.28} cy={y} r={r * 0.8} fill={bg} />
    <polygon fill={fg} transform={`translate(${x + r * 0.95} ${y}) scale(${r * 0.32})`}
      points="0,-1 0.29,-0.4 0.95,-0.31 0.47,0.15 0.59,0.81 0,0.5 -0.59,0.81 -0.47,0.15 -0.95,-0.31 -0.29,-0.4" />
  </>
);

const FLAGS: Record<string, ReactNode> = {
  DE: h3('#111', '#fff', '#d21b1b'),
  AU: (
    <>
      <rect width={W / 2} height={H} fill="#fff" />
      <rect width={W / 2} height={H / 3} fill="#c8102e" />
      <rect y={(2 * H) / 3} width={W / 2} height={H / 3} fill="#c8102e" />
      <rect x={W / 2} width={W / 2} height={H} fill="#fff" />
      <rect x={W / 2} width={W / 2} height={H / 3} fill="#c8102e" />
      <rect x={W / 2} y={(2 * H) / 3} width={W / 2} height={H / 3} fill="#3a7d3a" />
    </>
  ),
  FR: v3('#0f3c96', '#fff', '#d32030'),
  GB: (
    <>
      <rect width={W} height={H} fill="#012169" />
      <path d="M0,0 L30,20 M30,0 L0,20" stroke="#fff" strokeWidth={4} />
      <path d="M0,0 L30,20 M30,0 L0,20" stroke="#c8102e" strokeWidth={1.4} />
      <path d="M15,0 V20 M0,10 H30" stroke="#fff" strokeWidth={6} />
      <path d="M15,0 V20 M0,10 H30" stroke="#c8102e" strokeWidth={3.4} />
    </>
  ),
  IT: (
    <>
      {v3('#1d8a3c', '#fff', '#ce2b37')}
      <rect x={13} y={7} width={4} height={6} fill="#ce2b37" stroke="#1f4fa0" strokeWidth={0.6} />
      <path d="M15,7.6 V12.4 M13.6,9.8 H16.4" stroke="#fff" strokeWidth={0.9} />
    </>
  ),
  RU: h3('#fff', '#1c3f94', '#d52b1e'),
  OT: <><rect width={W} height={H} fill="#d01c22" />{crescent(13, 10, 5, '#d01c22')}</>,
  ES: (
    <>
      <rect width={W} height={H} fill="#c60b1e" />
      <rect y={5} width={W} height={10} fill="#ffc400" />
    </>
  ),
  SE: nordic('#1f5aa6', '#fecc00'),
  RO: v3('#1f3c8c', '#fcd116', '#ce1126'),
  MG: (
    <>
      <rect width={W} height={H} fill="#b8202a" />
      <polygon points="15,4.5 16.6,9.4 21.6,9.4 17.5,12.4 19.1,17.2 15,14.2 10.9,17.2 12.5,12.4 8.4,9.4 13.4,9.4"
        fill="none" stroke="#1f6b35" strokeWidth={1.1} />
    </>
  ),
  LY: <><rect width={W} height={H} fill="#111" />{crescent(13, 10, 5, '#111')}</>,
  EG: (
    <>
      <rect width={W} height={H} fill="#c8102e" />
      {crescent(9, 10, 3.2, '#c8102e')}
      {crescent(17, 5.5, 3.2, '#c8102e')}
      {crescent(17, 14.5, 3.2, '#c8102e')}
    </>
  ),
  NL: h3('#ae1c28', '#fff', '#21468b'),
  BE: v3('#111', '#fdda24', '#ef3340'),
  CH: (
    <>
      <rect width={W} height={H} fill="#d52b1e" />
      <rect x={13} y={4} width={4} height={12} fill="#fff" />
      <rect x={9} y={8} width={12} height={4} fill="#fff" />
    </>
  ),
  DK: nordic('#c8102e', '#fff'),
  NO: nordic('#ba0c2f', '#fff', '#00205b'),
  PT: (
    <>
      <rect width={12} height={H} fill="#046a38" />
      <rect x={12} width={18} height={H} fill="#da291c" />
      <circle cx={12} cy={10} r={4} fill="none" stroke="#ffe900" strokeWidth={1.4} />
    </>
  ),
  SR: h3('#c6363c', '#0c4076', '#fff'),
  MN: (
    <>
      <rect width={W} height={H} fill="#e8c55c" />
      <rect x={1.5} y={1.5} width={W - 3} height={H - 3} fill="#c40308" />
      <path d="M11,7 L15,10 L19,7 L18,13 L15,15 L12,13 Z" fill="#e8c55c" />
    </>
  ),
  AL: (
    <>
      <rect width={W} height={H} fill="#e41e20" />
      <path d="M15,4 L17,7 L21,6 L19,9.5 L22,12 L18,12.5 L17,16 L15,13.5 L13,16 L12,12.5 L8,12 L11,9.5 L9,6 L13,7 Z" fill="#111" />
    </>
  ),
  GR: (
    <>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => <rect key={k} y={(k * H) / 9} width={W} height={H / 9 + 0.05} fill={k % 2 ? '#fff' : '#0d5eaf'} />)}
      <rect width={(5 * H) / 9} height={(5 * H) / 9} fill="#0d5eaf" />
      <rect x={(2 * H) / 9} width={H / 9} height={(5 * H) / 9} fill="#fff" />
      <rect y={(2 * H) / 9} width={(5 * H) / 9} height={H / 9} fill="#fff" />
    </>
  ),
  BG: h3('#fff', '#00966e', '#d62612'),
  // neue Kleinstaaten (frei gestaltet, angelehnt an Flaggen ab 1918)
  FI: nordic('#fff', '#1d4f91'),
  BA: h3('#9e3039', '#fff', '#9e3039'),
  NR: (
    <>
      <rect width={W} height={H} fill="#fff" />
      <path d={`M0,0 L${W},${H} M${W},0 L0,${H}`} stroke="#1c57a5" strokeWidth={3.5} />
    </>
  ),
  JS: (
    <>
      <rect width={W} height={H} fill="#a8161f" />
      <rect width={7} height={H} fill="#fff" />
    </>
  ),
  SH: (
    <>
      <rect width={W} height={H} fill="#2f6b3a" />
      {crescent(13, 10, 5.5, '#2f6b3a')}
    </>
  ),
  REB: (
    <>
      <rect width={W} height={H} fill="#3d3833" />
      <path d="M4,16 L26,4" stroke="#b33" strokeWidth={2} />
    </>
  ),
};

/** Flagge einer Nation; unbekannte Nationen erhalten ein Feld in ihrer Kartenfarbe */
export function Flag({ nation, color, height = 14, title }: { nation: string; color?: string; height?: number; title?: string }) {
  const body = FLAGS[nation] ?? <rect width={W} height={H} fill={color ?? '#999'} />;
  return (
    <svg className="flag" viewBox={`0 0 ${W} ${H}`} width={(height * W) / H} height={height} role="img" aria-label={title ?? nation}>
      {title && <title>{title}</title>}
      {body}
      <rect width={W} height={H} fill="none" stroke="rgba(40,25,10,0.55)" strokeWidth={0.8} />
    </svg>
  );
}
