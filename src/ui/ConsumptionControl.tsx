import { useEffect, useRef, useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { CATEGORIES, CATEGORY_NAMES, CATEGORY_RES, RES_NAMES, type Category } from '../game/balance.ts';
import type { NationRates } from '../game/economy.ts';
import type { Resource } from '../game/mapdata.ts';
import type { GameState } from '../game/types.ts';
import { fmtNum } from './format.ts';
import { ResIcon } from './icons.tsx';

type Shares = Partial<Record<Resource, number>>;

/** Schrittweite der Regler (Prozent) */
const STEP = 2;

/**
 * Einen Rohstoff auf `value` setzen; der Rest verteilt sich im bisherigen Verhältnis auf die übrigen.
 * Ein gesperrter Rohstoff (`locked`) bleibt unverändert – dann gleichen nur die übrigen aus.
 */
function rebalance(cat: Category, current: Shares, res: Resource, value: number, locked: Resource | null = null): Shares {
  const lock = locked && locked !== res && CATEGORY_RES[cat].includes(locked) ? locked : null;
  const lockValue = lock ? current[lock] ?? 0 : 0;
  value = Math.min(value, 100 - lockValue);
  const others = CATEGORY_RES[cat].filter((r) => r !== res && r !== lock);
  const rest = 100 - value - lockValue;
  let w = others.map((r) => current[r] ?? 0);
  if (w.reduce((a, b) => a + b, 0) <= 0) w = others.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (x / sum) * rest);
  const out = raw.map(Math.floor);
  let left = rest - out.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => left-- > 0 && out[i]++);
  return { [res]: value, ...(lock ? { [lock]: lockValue } : {}), ...Object.fromEntries(others.map((r, i) => [r, out[i]])) };
}

/**
 * Verbrauchsregler: Verteilung des Provinzunterhalts je Kategorie auf ihre Rohstoffe.
 * Rohstoffe auf 0 % werden nur noch durch den festen Unterhalt von Einheiten und Gebäuden verbraucht.
 */
export function ConsumptionControl({ state, rates, act }: { state: GameState; rates: NationRates; act(a: Action): Promise<ActionResult> }) {
  const nation = state.nations[state.playerNation];
  const saved = nation.consumption;
  const focus = nation.consumptionFocus ?? {};
  const [draft, setDraft] = useState<Record<Category, Shares> | null>(null);
  /** gesperrter Regler (bei Kategorien mit drei Rohstoffen, z. B. Energie): bleibt beim Verschieben der anderen stehen */
  const [locked, setLocked] = useState<Resource | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // Entwurf erst verwerfen, wenn der gespeicherte Stand ihn übernommen hat (sonst springt der Regler kurz zurück)
  useEffect(() => {
    if (!draft) return;
    const open = (Object.keys(draft) as Category[]).filter((c) => CATEGORY_RES[c].some((r) => (draft[c][r] ?? 0) !== (saved[r] ?? 0)));
    if (open.length !== Object.keys(draft).length) {
      setDraft(open.length ? (Object.fromEntries(open.map((c) => [c, draft[c]])) as Record<Category, Shares>) : null);
    }
  }, [saved, draft]);

  const value = (cat: Category, r: Resource) => draft?.[cat]?.[r] ?? saved[r] ?? 0;
  const change = (cat: Category, r: Resource, v: number) => {
    const current = Object.fromEntries(CATEGORY_RES[cat].map((x) => [x, value(cat, x)])) as Shares;
    const shares = rebalance(cat, current, r, v, locked);
    setDraft((d) => ({ ...(d ?? {}), [cat]: shares }) as Record<Category, Shares>);
    // erst nach kurzer Pause senden, damit beim Ziehen nicht jede Stufe gespeichert wird
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await act({ type: 'setConsumption', category: cat, shares });
      // abgelehnt: Entwurf verwerfen, damit der gespeicherte Stand wieder gilt
      if (!r.ok) {
        setDraft((d) => {
          if (!d) return d;
          const next = { ...d };
          delete next[cat];
          return Object.keys(next).length ? next : null;
        });
      }
    }, 350);
  };

  return (
    <div className="consumption">
      {CATEGORIES.map((cat) => {
        const f = focus[cat] ?? null;
        const three = CATEGORY_RES[cat].length > 2;
        return (
          <div key={cat} className="consumption-cat">
            <div className="consumption-head">
              {CATEGORY_NAMES[cat]} <span className="muted small">{fmtNum(rates.upkeep)}/Tag</span>
              <label className="consumption-focus small" title="Fokus: von diesem Rohstoff bleibt möglichst viel übrig. Die anderen tragen so viel Provinzunterhalt, wie ihr laufender Überschuss hergibt – sie geraten nie ins Minus, der Unterhalt bleibt gedeckt; der Fokus-Rohstoff zahlt nur den Rest. Stündlich neu eingestellt. Ohne Fokus gilt der Regler von Hand.">
                Fokus{' '}
                <select value={f ?? ''} onChange={(e) => void act({ type: 'setConsumptionFocus', category: cat, resource: (e.target.value || null) as Resource | null })}>
                  <option value="">von Hand</option>
                  {CATEGORY_RES[cat].map((r) => <option key={r} value={r}>{RES_NAMES[r]}</option>)}
                </select>
              </label>
            </div>
            {CATEGORY_RES[cat].map((r) => {
              const v = value(cat, r);
              const isLocked = !f && three && locked === r;
              return (
                <label key={r} className="consumption-row" title={`${RES_NAMES[r]}: ${v} % des Provinzunterhalts${f ? ' (automatisch: Fokus ' + RES_NAMES[f] + ')' : ''}`}>
                  <ResIcon res={r} size={16} />
                  <span className="consumption-name">{RES_NAMES[r]}</span>
                  <input type="range" min={0} max={100} step={STEP} value={v} disabled={!!f || isLocked}
                    onChange={(e) => change(cat, r, Number(e.target.value))} />
                  <span className="consumption-pct">{v} %</span>
                  <span className="consumption-amount muted small">{fmtNum((rates.upkeep * v) / 100)}</span>
                  {three && !f && (
                    <button type="button" className={'btn small consumption-lock' + (isLocked ? ' active' : '')}
                      title={isLocked ? 'Sperre lösen' : 'Sperren: dieser Regler bleibt stehen, die beiden anderen gleichen sich aus'}
                      onClick={(e) => { e.preventDefault(); setLocked(isLocked ? null : r); }}>
                      {isLocked ? '🔒' : '🔓'}
                    </button>
                  )}
                </label>
              );
            })}
            {f && <div className="muted small">Automatisch eingestellt (Fokus {RES_NAMES[f]}).</div>}
          </div>
        );
      })}
    </div>
  );
}
