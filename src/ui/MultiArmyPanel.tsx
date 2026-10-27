import { useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { UNIT_ORDER, UNITS } from '../game/balance.ts';
import { isSea, nodeName } from '../game/graph.ts';
import type { MapData } from '../game/mapdata.ts';
import { armyPower, isNaval, meleePower, rangedPower, samePlace, unitCount } from '../game/military.ts';
import { armyName } from '../game/names.ts';
import type { Army, GameState } from '../game/types.ts';
import { Window } from './common.tsx';
import { Flag } from './Flag.tsx';

/** Mehrere ausgewählte Armeen (z. B. per Lasso): Übersicht, gemeinsame Befehle. */
export function MultiArmyPanel({ map, state, armies, act, onSelectArmy, onClose }: {
  map: MapData;
  state: GameState;
  armies: Army[];
  act(a: Action): Promise<ActionResult>;
  onSelectArmy(id: number): void;
  onClose(): void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const own = armies.filter((a) => a.owner === state.playerNation);
  const totals: Partial<Record<string, number>> = {};
  for (const a of own) for (const u of UNIT_ORDER) if (a.units[u]) totals[u] = (totals[u] ?? 0) + a.units[u]!;
  // aktuelle Kampfkraft je Runde (Nahkampf im Angriff, dazu Fernkampf), wie im Armeefenster
  const power = own.reduce((t, a) => t + meleePower(a, map, false, isSea(map, a.node)) + rangedPower(a, map), 0);

  const runAll = async (actions: Action[]) => {
    const errors: string[] = [];
    for (const a of actions) {
      const r = await act(a);
      if (!r.ok) errors.push(r.error);
    }
    setMsg(errors.length ? errors[0] : null);
  };
  /** Armeen am selben Ort in die jeweils stärkste eingliedern */
  const mergeAll = () => {
    const actions: Action[] = [];
    const rest = own.filter((a) => !a.move);
    while (rest.length) {
      const head = rest.shift()!;
      const group = [head, ...rest.filter((b) => samePlace(b, head) && isNaval(b) === isNaval(head))];
      for (const g of group.slice(1)) rest.splice(rest.indexOf(g), 1);
      const into = group.reduce((x, y) => (armyPower(y) > armyPower(x) ? y : x));
      for (const g of group) if (g !== into) actions.push({ type: 'merge', army: g.id, into: into.id });
    }
    return actions;
  };
  const merges = mergeAll();

  return (
    <Window title={`${armies.length} Armeen ausgewählt`} onClose={onClose} className="province-panel">
      <p className="muted small">
        Zusammen {Object.entries(totals).map(([u, n]) => `${n}× ${UNITS[u as keyof typeof UNITS].short}`).join(', ') || '–'} · Kampfkraft {power.toLocaleString('de-DE', { maximumFractionDigits: 1 })} je Runde.
        Rechtsklick auf die Karte schickt alle ausgewählten Armeen los.
      </p>
      <div className="btn-row">
        <button className="btn small" disabled={!own.some((a) => a.move || a.target != null)}
          onClick={() => runAll(own.map((a) => ({ type: 'stop', army: a.id })))}>Alle anhalten</button>
        <button className="btn small" disabled={!merges.length} title="Armeen am selben Ort zusammenlegen" onClick={() => runAll(merges)}>
          Zusammenlegen
        </button>
      </div>
      {msg && <div className="error">{msg}</div>}
      <table className="table">
        <thead><tr><th>Armee</th><th>Einheiten</th><th>Ort</th></tr></thead>
        <tbody>
          {armies.map((a) => (
            <tr key={a.id} className="link" onClick={() => onSelectArmy(a.id)}>
              <td><Flag nation={a.owner} height={11} /> {armyName(a)}</td>
              <td className="small">{unitCount(a)} · {UNIT_ORDER.filter((u) => a.units[u]).map((u) => `${a.units[u]}× ${UNITS[u].short}`).join(', ')}</td>
              <td className="small">{a.move ? `→ ${a.move.endFrac !== undefined && a.move.endFrac < 1 ? 'Weg ' + nodeName(map, a.move.path[a.move.path.length - 2]) + ' – ' : ''}${nodeName(map, a.move.path[a.move.path.length - 1])}` : a.pos ? `Weg ${nodeName(map, a.pos.a)} – ${nodeName(map, a.pos.b)}` : nodeName(map, a.node)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Window>
  );
}
