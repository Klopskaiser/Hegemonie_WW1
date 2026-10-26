import { useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { HOUR, UNIT_ORDER, UNITS, type UnitType } from '../game/balance.ts';
import { atWar } from '../game/diplomacy.ts';
import { isSea, nodeName } from '../game/graph.ts';
import type { MapData } from '../game/mapdata.ts';
import {
  armyPosition, armyPower, armySpeed, boardingWait, infantryStrength, isNaval, maxRange, samePlace, segmentHours, troopMorale, troopTarget, unitCount, unitHp,
} from '../game/military.ts';
import { armyName } from '../game/names.ts';
import { Flag } from './Flag.tsx';
import { Picture, unitImage } from './Picture.tsx';
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
  /** neue Armee nach dem Teilen (wird ausgewählt) */
  onSplit(id: number): void;
  onClose(): void;
}

/** Restliche Marschzeit in Spielstunden. */
function remainingHours(state: GameState, map: MapData, a: Army): number {
  const m = a.move;
  if (!m) return 0;
  let h = Math.max(0, m.segEnd - state.time) / HOUR;
  for (let k = m.seg + 1; k + 1 < m.path.length; k++) {
    const share = k === m.path.length - 2 ? m.endFrac ?? 1 : 1;
    h += segmentHours(state, map, a, m.path[k], m.path[k + 1]) * share;
  }
  return h;
}

export function ArmyPanel({ map, state, army: a, armies, act, onSelectArmy, onSplit, onClose }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const tt = troopTarget(state, map, a);
  const [splitting, setSplitting] = useState<Partial<Record<UnitType, number>> | null>(null);
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
  const hostileHere = here === null ? [] : armies.filter((b) => b !== a && !b.move && samePlace(a, b) && atWar(state, a.owner, b.owner));
  const target = a.target != null ? armies.find((b) => b.id === a.target) : undefined;
  const range = maxRange(a, map);
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
    ? armies.filter((b) => b !== a && b.owner === a.owner && samePlace(a, b) && !b.move && (atSea || isNaval(b) === isNaval(a)))
    : [];
  const ships: Partial<Record<UnitType, number>> = {};
  for (const u of UNIT_ORDER) if (UNITS[u].naval && a.units[u]) ships[u] = a.units[u];
  const carrying = isNaval(a) && UNIT_ORDER.some((u) => !UNITS[u].naval && a.units[u]);

  let status: string;
  const bw = boardingWait(map, a, state.time);
  if (bw) status = `${bw.landing ? 'Schifft aus' : 'Schifft ein'} – noch ${real(bw.remaining)}`;
  else if (a.move) {
    const m = a.move;
    const last = m.path[m.path.length - 1];
    const dest = m.endFrac !== undefined && m.endFrac < 1
      ? `zum Weg ${nodeName(map, m.path[m.path.length - 2])} – ${nodeName(map, last)}` : `nach ${nodeName(map, last)}`;
    status = `Marsch ${dest} – Ankunft in ${real(remainingHours(state, map, a))}`;
  } else if (hostileHere.length) status = `Im Kampf bei ${nodeName(map, a.node)}`;
  else if (a.pos) status = `Steht auf dem Weg ${nodeName(map, a.pos.a)} – ${nodeName(map, a.pos.b)}`;
  else status = `Steht in ${nodeName(map, a.node)}`;

  const half: Partial<Record<UnitType, number>> = {};
  for (const u of UNIT_ORDER) if (a.units[u]) half[u] = Math.floor(a.units[u]! / 2);
  const canSplit = unitCount(a) >= 2 && !a.move && !hostileHere.length;
  const splitTotal = splitting ? Object.values(splitting).reduce((t, n) => t + (n ?? 0), 0) : 0;
  const doSplit = async () => {
    if (!splitting) return;
    const units = Object.fromEntries(Object.entries(splitting).filter(([, n]) => (n ?? 0) > 0));
    const r = await act({ type: 'split', army: a.id, units });
    setMsg(r.ok ? null : r.error);
    if (r.ok) {
      setSplitting(null);
      if (r.army !== undefined) onSplit(r.army);
    }
  };

  return (
    <Window title={armyName(a)} onClose={onClose} className="province-panel">
      <div className="prov-head">
        {a.owner === REBELS ? <Swatch color={color} /> : <Flag nation={a.owner} height={18} />}
        <div>
          <div className="prov-owner">{ownerName}</div>
          <div className="muted">
            {carrying ? 'Flotte mit Truppen an Bord' : isNaval(a) ? 'Flotte' : atSea ? 'Truppen eingeschifft' : 'Landtruppen'} · Stärke {Math.round(armyPower(a))}
            {' '}· Abschüsse {Math.floor(a.kills ?? 0)}
          </div>
        </div>
        {own && renaming === null && (
          <button className="btn small" title="Umbenennen" onClick={() => setRenaming(a.name ?? armyName(a))}>✎</button>
        )}
      </div>
      {own && renaming !== null && (
        <form className="rename-row" onSubmit={(e) => {
          e.preventDefault();
          void act({ type: 'rename', army: a.id, name: renaming });
          setRenaming(null);
        }}>
          <input autoFocus maxLength={40} value={renaming} onChange={(e) => setRenaming(e.target.value)} placeholder="leer = automatischer Name" />
          <button className="btn small" type="submit">OK</button>
          <button className="btn small" type="button" onClick={() => setRenaming(null)}>✕</button>
        </form>
      )}
      <p className="army-status">{status}</p>
      {target && <p className="small">Fernkampf auf {armyName(target)} ({nodeName(map, target.node)})</p>}

      <h4>Einheiten</h4>
      <table className="table">
        <thead><tr><th></th><th>Typ</th><th>Anzahl</th><th>Zustand</th></tr></thead>
        <tbody>
          {UNIT_ORDER.filter((u) => a.units[u]).map((u) => {
            const n = a.units[u]!;
            const health = Math.max(0, 1 - (a.wounds?.[u] ?? 0) / (n * unitHp(a, u)));
            const machine = u !== 'infantry';
            return (
              <tr key={u}>
                <td><Picture src={unitImage(u)} label={UNITS[u].short} size={28} /></td>
                <td>{UNITS[u].name}</td>
                <td>{n}</td>
                <td>{machine
                  ? <span title="Zustand – Maschinen kämpfen trotzdem mit voller Kraft"><Bar value={health} color={health < 0.5 ? '#a33' : '#5d8a3a'} /></span>
                  : <span className="muted small">–</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(a.units.infantry ?? 0) > 0 && (
        <>
          <div className="morale-row" title="Kampfkraft und Lebenspunkte der Infanterie: linear von 0,4-fach bei 10 % Moral bis 1,2-fach bei 100 % (normal 1,0 bei 77,5 %). Sinkt im Kampf, unter Beschuss, bei Getreidemangel und in Provinzen mit niedriger Moral; steigt bei Siegen und in Provinzen mit hoher Moral.">
            <span className="small">Moral der Infanterie</span>
            <Bar value={troopMorale(a)} marker={tt.target} color={troopMorale(a) < 0.33 ? '#a33' : troopMorale(a) < 0.5 ? '#c9952f' : '#5d8a3a'} />
            <span className="small">{Math.round(troopMorale(a) * 100)} % · Stärke ×{infantryStrength(a).toFixed(2)}</span>
          </div>
          <div className="muted small">Ziel {Math.round(tt.target * 100)} % – zum Tageswechsel {tt.hungry ? 'höchstens +5 % bzw. −13 % (Getreidemangel)' : 'höchstens +10 % bzw. −8 %'}.</div>
          <ul className="morale-parts small">
            {tt.parts.map((p) => (
              <li key={p.label}>
                <span>{p.label}</span>
                <span className={p.value < 0 ? 'neg' : ''}>{p.value < 0 ? '−' : ''}{Math.round(Math.abs(p.value) * 100)} %</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="muted small">
        Tempo {Math.round(armySpeed(a))} km/h{range > 0 ? ` · Reichweite ${range} km` : ''}
      </div>

      {own && (
        <>
          <h4>Befehle</h4>
          <p className="muted small">
            Rechtsklick auf die Karte setzt ein Marschziel – auch mitten auf einem Weg. Linksklick ins Leere oder Esc hebt die Auswahl auf.
            Verlässt die letzte Armee eine eigene Stadt, bleibt eine Einheit als Besatzung zurück.
          </p>
          <div className="btn-row">
            <button className="btn small" disabled={!a.move && a.target == null} onClick={() => run({ type: 'stop', army: a.id })}>Halt</button>
            <button className={'btn small' + (splitting ? ' active' : '')} disabled={!canSplit}
              title={hostileHere.length ? 'Im Kampf nicht möglich' : 'Einheiten in eine eigene Armee abtrennen'}
              onClick={() => setSplitting(splitting ? null : half)}>
              Teilen …
            </button>
          </div>
          {splitting && canSplit && (
            <div className="split-box">
              {UNIT_ORDER.filter((u) => a.units[u]).map((u) => (
                <label key={u} className="split-row">
                  <span>{UNITS[u].name}</span>
                  <input type="range" min={0} max={a.units[u]} value={splitting[u] ?? 0}
                    onChange={(e) => setSplitting({ ...splitting, [u]: Number(e.target.value) })} />
                  <span className="split-n">{splitting[u] ?? 0} / {a.units[u]}</span>
                </label>
              ))}
              <div className="btn-row">
                <button className="btn small primary" disabled={splitTotal < 1 || splitTotal >= unitCount(a)} onClick={doSplit}>
                  {splitTotal} Einheiten abtrennen
                </button>
                <button className="btn small" onClick={() => setSplitting(null)}>Abbrechen</button>
              </div>
              <div className="muted small">
                Die neue Armee wird ausgewählt. Schickst du sie nicht los, gliedert sie sich beim Abwählen
                (spätestens nach 6 Spielstunden) wieder ein.
              </div>
            </div>
          )}
          {carrying && !a.move && (
            <div className="btn-row">
              <button className="btn small" onClick={() => run({ type: 'split', army: a.id, units: ships, rejoin: false })}
                title="Die Schiffe bilden eine eigene Flotte; die Truppen können danach anlanden.">
                Schiffe abtrennen
              </button>
            </div>
          )}
          {mergeable.length > 0 && (
            <div className="btn-row">
              {mergeable.map((b) => (
                <button key={b.id} className="btn small" onClick={() => run({ type: 'merge', army: b.id, into: a.id })}>
                  {armyName(b)} eingliedern ({unitCount(b)})
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
                  <span>{armyName(b)} · {unitCount(b)} Einh. · {Math.round(d)} km{d > range ? ' (heranrücken)' : ''}</span>
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
              {armyName(b)}: {UNIT_ORDER.filter((u) => b.units[u]).map((u) => `${b.units[u]}× ${UNITS[u].short}`).join(', ')}
            </div>
          ))}
        </>
      )}
    </Window>
  );
}
