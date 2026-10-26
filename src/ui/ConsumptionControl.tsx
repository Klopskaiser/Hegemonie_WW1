import { useEffect, useRef, useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { CATEGORIES, CATEGORY_NAMES, CATEGORY_RES, RES_NAMES, type Category } from '../game/balance.ts';
import type { NationRates } from '../game/economy.ts';
import type { Resource } from '../game/mapdata.ts';
import type { GameState } from '../game/types.ts';
import { fmtNum } from './format.ts';
import { ResIcon } from './icons.tsx';

type Shares = Partial<Record<Resource, number>>;

/** Einen Rohstoff auf `value` setzen; der Rest verteilt sich im bisherigen Verhältnis auf die übrigen. */
function rebalance(cat: Category, current: Shares, res: Resource, value: number): Shares {
  const others = CATEGORY_RES[cat].filter((r) => r !== res);
  const rest = 100 - value;
  let w = others.map((r) => current[r] ?? 0);
  if (w.reduce((a, b) => a + b, 0) <= 0) w = others.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (x / sum) * rest);
  const out = raw.map(Math.floor);
  let left = rest - out.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => left-- > 0 && out[i]++);
  return { [res]: value, ...Object.fromEntries(others.map((r, i) => [r, out[i]])) };
}

/**
 * Verbrauchsregler: Verteilung des Provinzunterhalts je Kategorie auf ihre Rohstoffe.
 * Rohstoffe auf 0 % werden nur noch durch den festen Unterhalt von Einheiten und Gebäuden verbraucht.
 */
export function ConsumptionControl({ state, rates, act }: { state: GameState; rates: NationRates; act(a: Action): Promise<ActionResult> }) {
  const saved = state.nations[state.playerNation].consumption;
  const [draft, setDraft] = useState<Record<Category, Shares> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const value = (cat: Category, r: Resource) => draft?.[cat]?.[r] ?? saved[r] ?? 0;
  const change = (cat: Category, r: Resource, v: number) => {
    const current = Object.fromEntries(CATEGORY_RES[cat].map((x) => [x, value(cat, x)])) as Shares;
    const shares = rebalance(cat, current, r, v);
    setDraft((d) => ({ ...(d ?? {}), [cat]: shares }) as Record<Category, Shares>);
    // erst nach kurzer Pause senden, damit beim Ziehen nicht jede Stufe gespeichert wird
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await act({ type: 'setConsumption', category: cat, shares });
      setDraft((d) => {
        if (!d) return d;
        const next = { ...d };
        delete next[cat];
        return Object.keys(next).length ? next : null;
      });
    }, 350);
  };

  return (
    <div className="consumption">
      {CATEGORIES.map((cat) => (
        <div key={cat} className="consumption-cat">
          <div className="consumption-head">{CATEGORY_NAMES[cat]} <span className="muted small">{fmtNum(rates.upkeep)}/Tag</span></div>
          {CATEGORY_RES[cat].map((r) => {
            const v = value(cat, r);
            return (
              <label key={r} className="consumption-row" title={`${RES_NAMES[r]}: ${v} % des Provinzunterhalts`}>
                <ResIcon res={r} size={16} />
                <span className="consumption-name">{RES_NAMES[r]}</span>
                <input type="range" min={0} max={100} step={5} value={v} onChange={(e) => change(cat, r, Number(e.target.value))} />
                <span className="consumption-pct">{v} %</span>
                <span className="consumption-amount muted small">{fmtNum((rates.upkeep * v) / 100)}</span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
