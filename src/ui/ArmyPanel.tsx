import { useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { HOUR, UNIT_ORDER, UNITS, type UnitType } from '../game/balance.ts';
import { atWar } from '../game/diplomacy.ts';
import { isSea, nodeName } from '../game/graph.ts';
import type { MapData } from '../game/mapdata.ts';
import {
  armyPosition, armyPower, armySpeed, isNaval, maxRange, segmentHours, unitCount,
} from '../game/military.ts';
import { REBELS, type Army, type GameState } from '../game/types.ts';
import { Bar, Swatch, Window } from './common.tsx';
import { fmtDuration } from './format.ts';

interface Props {
  map: MapData;
  state: GameState;
  army: Army;
  /** sichtbare Armeen (für Ziele und Zusammenlegen) */
  armies: Army[];
  act(a: Action): Promise<ActionResult>;
  onSelectArmy(id: number): void;
  onClose(): void;
}

/** Restliche Marschzeit in Spielstunden. */
function remainingHours(state: GameState, map: MapData, a: Army): number {
  const m = a.move;
  if (!m) return 0;
  let h = Math.max(0, m.segEnd - state.time) / HOUR;
  for (let k = m.seg + 1; k + 1 < m.path.length; k++) h += segmentHours(state, map, a, m.path[k], m.path[k + 1]);
  return h;
}

export function ArmyPanel({ map, state, army: a, armies, act, onSelectArmy, onClose }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  const own = a.owner === state.playerNation;
  const nation = map.nations.find((n) => n.id === a.owner);
  const ownerName = a.owner === REBELS ? 'Aufständische' : nation?.name ?? a.owner;
  const color = a.owner === REBELS ? '#4a4540' : nation?.color ?? '#999';
  const run = async (action: Action) => {
    const r = await act(action);
    setMsg(r.ok ? null : r.error);
  };
  const real = (gameHours: number) => (state.paused ? 'pausiert' : fmtDuration((gameHours * HOUR) / state.speed));

  const here = a.move ? null : a.node;
  const hostileHere = here === null ? [] : armies.filter((b) => b.node === here && !b.move && atWar(state, a.owner, b.owner));
  const target = a.target != null ? armies.find((b) => b.id === a.target) : undefined;
  const range = maxRange(a);
  const pos = armyPosition(map, a, state.time);
  const targets = range > 0
    ? armies.filter((b) => atWar(state, a.owner, b.owner) && unitCount(b) > 0).map((b) => {
      const p = armyPosition(map, b, state.time);
      return { b, d: Math.hypot(p[0] - pos[0], p[1] - pos[1]) };
    }).filter((x) => x.d <= range * 3).sort((x, y) => x.d - y.d).slice(0, 6)
    : [];
  const atSea = isSea(map, a.node);
  // auf See dürfen Truppen zu einer Flotte steigen, an Land nur gleiche Art
  const mergeable = own && !a.move
    ? armies.filter((b) => b !== a && b.owner === a.owner && b.node === a.node && !b.move && (atSea || isNaval(b) === isNaval(a)))
    : [];
  const ships: Partial<Record<UnitType, number>> = {};
  for (const u of UNIT_ORDER) if (UNITS[u].naval && a.units[u]) ships[u] = a.units[u];
  const carrying = isNaval(a) && UNIT_ORDER.some((u) => !UNITS[u].naval && a.units[u]);

  let status: string;
  if (a.move) {
    const dest = a.move.path[a.move.path.length - 1];
    status = `Marsch nach ${nodeName(map, dest)} – Ankunft in ${real(remainingHours(state, map, a))}`;
  } else if (hostileHere.length) status = `Im Kampf bei ${nodeName(map, a.node)}`;
  else status = `Steht in ${nodeName(map, a.node)}`;

  const half: Partial<Record<UnitType, number>> = {};
  for (const u of UNIT_ORDER) if ((a.units[u] ?? 0) >= 2) half[u] = Math.floor(a.units[u]! / 2);
  const canSplit = unitCount(a) >= 2 && !a.move;

  return (
    <Window title={`Armee ${a.id}`} onClose={onClose} className="province-panel">
      <div className="prov-head">
        <Swatch color={color} />
        <div>
          <div className="prov-owner">{ownerName}</div>
          <div className="muted">
            {carrying ? 'Flotte mit Truppen an Bord' : isNaval(a) ? 'Flotte' : atSea ? 'Truppen eingeschifft' : 'Landtruppen'} · Stärke {Math.round(armyPower(a))}
          </div>
        </div>
      </div>
      <p className="army-status">{status}</p>
      {target && <p className="small">Fernkampf auf Armee {target.id} ({nodeName(map, target.node)})</p>}

      <h4>Einheiten</h4>
      <table className="table">
        <thead><tr><th>Typ</th><th>Anzahl</th><th>Zustand</th></tr></thead>
        <tbody>
          {UNIT_ORDER.filter((u) => a.units[u]).map((u) => {
            const n = a.units[u]!;
            const health = 1 - (a.wounds?.[u] ?? 0) / (n * UNITS[u].hp);
            return (
              <tr key={u}>
                <td>{UNITS[u].name}</td>
                <td>{n}</td>
                <td><Bar value={health} color={health < 0.5 ? '#a33' : '#5d8a3a'} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="muted small">
        Tempo {Math.round(armySpeed(a))} km/h{range > 0 ? ` · Reichweite ${range} km` : ''}
      </div>

      {own && (
        <>
          <h4>Befehle</h4>
          <p className="muted small">Klicke auf die Karte, um ein Marschziel zu setzen (Rechtsklick hebt die Auswahl auf).</p>
          <div className="btn-row">
            <button className="btn small" disabled={!a.move && a.target == null} onClick={() => run({ type: 'stop', army: a.id })}>Halt</button>
            <button className="btn small" disabled={!canSplit} onClick={() => run({ type: 'split', army: a.id, units: Object.keys(half).length ? half : { [UNIT_ORDER.find((u) => a.units[u])!]: 1 } })}>
              Teilen
            </button>
          </div>
          {carrying && !a.move && (
            <div className="btn-row">
              <button className="btn small" onClick={() => run({ type: 'split', army: a.id, units: ships })}
                title="Die Schiffe bilden eine eigene Flotte; die Truppen können danach anlanden.">
                Schiffe abtrennen
              </button>
            </div>
          )}
          {mergeable.length > 0 && (
            <div className="btn-row">
              {mergeable.map((b) => (
                <button key={b.id} className="btn small" onClick={() => run({ type: 'merge', army: b.id, into: a.id })}>
                  Armee {b.id} eingliedern ({unitCount(b)})
                </button>
              ))}
            </div>
          )}
          {range > 0 && (
            <>
              <h4>Fernkampf</h4>
              {targets.length === 0 ? <div className="muted small">Kein Feind in der Nähe.</div> : targets.map(({ b, d }) => (
                <div key={b.id} className="army-row">
                  <Swatch color={map.nations.find((n) => n.id === b.owner)?.color ?? '#4a4540'} />
                  <span>Armee {b.id} · {unitCount(b)} Einh. · {Math.round(d)} km{d > range ? ' (heranrücken)' : ''}</span>
                  <button className="btn small" onClick={() => run({ type: 'attack', army: a.id, target: b.id })}>Beschießen</button>
                </div>
              ))}
            </>
          )}
          {msg && <div className="error">{msg}</div>}
        </>
      )}

      {hostileHere.length > 0 && (
        <>
          <h4>Gegner am Ort</h4>
          {hostileHere.map((b) => (
            <div key={b.id} className="army-row link" onClick={() => onSelectArmy(b.id)}>
              <Swatch color={map.nations.find((n) => n.id === b.owner)?.color ?? '#4a4540'} />
              Armee {b.id}: {UNIT_ORDER.filter((u) => b.units[u]).map((u) => `${b.units[u]}× ${UNITS[u].short}`).join(', ')}
            </div>
          ))}
        </>
      )}
    </Window>
  );
}
