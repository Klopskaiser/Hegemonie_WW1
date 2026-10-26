import type { ReactNode } from 'react';
import { ALL_RES, RES_NAMES, type Cost } from '../game/balance.ts';
import type { Stock } from '../game/types.ts';
import { fmtNum } from './format.ts';
import { ResIcon } from './icons.tsx';

export function Window(props: { title: ReactNode; onClose?: () => void; className?: string; children: ReactNode }) {
  return (
    <section className={'window ' + (props.className ?? '')}>
      <header className="window-title">
        <span>{props.title}</span>
        {props.onClose && (
          <button className="window-close" onClick={props.onClose} title="Schließen" aria-label="Schließen">
            ×
          </button>
        )}
      </header>
      <div className="window-body">{props.children}</div>
    </section>
  );
}

export function CostList({ cost, stock }: { cost: Cost; stock?: Stock }) {
  return (
    <span className="cost">
      {ALL_RES.filter((r) => (cost[r] ?? 0) > 0).map((r) => (
        <span key={r} className={'cost-item' + (stock && stock[r] < cost[r]! ? ' lacking' : '')} title={RES_NAMES[r]}>
          <ResIcon res={r} size={14} />
          {fmtNum(cost[r]!)}
        </span>
      ))}
    </span>
  );
}

export function Bar({ value, marker, color }: { value: number; marker?: number; color?: string }) {
  return (
    <div className="bar">
      <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
      {marker !== undefined && <div className="bar-marker" style={{ left: `${Math.max(0, Math.min(1, marker)) * 100}%` }} />}
    </div>
  );
}

export function Swatch({ color }: { color: string }) {
  return <span className="swatch" style={{ background: color }} />;
}
