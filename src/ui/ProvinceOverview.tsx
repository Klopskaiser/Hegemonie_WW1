// Provinzübersicht im Vollbild: alle eigenen Provinzen mit Gebäuden, Schaltern, Bau- und Fertigungsaufträgen.

import { useState } from 'react';
import { checkBuild, checkProduce, plannedBuildings, type Action, type ActionResult } from '../game/actions.ts';
import { BUILDING_ORDER, BUILDINGS, buildingLives, RES_NAMES, UNIT_ORDER, UNITS, type Building, type UnitType, siteAllows } from '../game/balance.ts';
import { activeCapital, provinceOutput } from '../game/economy.ts';
import type { MapData } from '../game/mapdata.ts';
import type { GameState } from '../game/types.ts';
import { Bar, Window } from './common.tsx';
import { fmtDuration, fmtNum, fmtPercent } from './format.ts';
import { ResIcon } from './icons.tsx';
import { buildingImage, Picture } from './Picture.tsx';

/** Gebäude, die sich ein- und ausschalten lassen, mit Kurzname */
const SWITCHES: [Building, string][] = [['recruitment', 'Wehramt'], ['barracks', 'Kaserne'], ['railroad', 'Bahn']];

interface Props {
  map: MapData;
  state: GameState;
  act(a: Action): Promise<ActionResult>;
  /** Provinz auf der Karte zeigen */
  onSelect(id: number): void;
  onClose(): void;
}

export function ProvinceOverview({ map, state, act, onSelect, onClose }: Props) {
  const me = state.playerNation;
  const [build, setBuild] = useState<Record<number, Building>>({});
  const [unit, setUnit] = useState<Record<number, UnitType>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stock = state.nations[me].stock;
  const capital = activeCapital(state, map, me);
  const remaining = (end: number) => (state.paused ? 'pausiert' : fmtDuration((end - state.time) / state.speed));

  const own = state.provinces.map((ps, i) => ({ ps, mp: map.provinces[i], i })).filter((x) => x.ps.owner === me)
    .sort((a, b) => Number(b.i === capital) - Number(a.i === capital) || Number(b.mp.city) - Number(a.mp.city) || a.mp.name.localeCompare(b.mp.name));

  const run = async (a: Action) => {
    const r = await act(a);
    setMsg(r.ok ? null : r.error);
    return r.ok;
  };
  /** mehrere Aufträge nacheinander; meldet, wie viele geklappt haben */
  const runAll = async (list: Action[], what: string) => {
    if (!list.length) return;
    setBusy(true);
    let ok = 0;
    for (const a of list) if ((await act(a)).ok) ok++;
    setBusy(false);
    setMsg(`${what}: ${ok} von ${list.length}`);
  };

  const recruitTargets = own.filter(({ i }) => checkBuild(state, map, me, i, 'recruitment').ok);
  const barracksOn = own.filter(({ ps }) => ps.buildings.barracks > 0 && ps.off?.barracks);
  const barracksOff = own.filter(({ ps }) => ps.buildings.barracks > 0 && !ps.off?.barracks);

  return (
    <Window title={`Provinzübersicht (${own.length})`} onClose={onClose} className="overview-panel">
      <div className="overview-scroll">
        <table className="table overview-table">
          <thead>
            <tr>
              <th>Provinz</th><th>Ertrag/Tag</th><th>Moral</th><th>Gebäude</th><th>Schalter</th><th>Bauen</th><th>Technik in Auftrag geben</th>
            </tr>
          </thead>
          <tbody>
            {own.map(({ ps, mp, i }) => {
              const out = provinceOutput(map, ps, i);
              const planned = plannedBuildings(ps);
              const buildable = BUILDING_ORDER.filter((b) => siteAllows(b, mp.coastal) && planned[b] < BUILDINGS[b].maxLevel)
                .map((b) => ({ b, chk: checkBuild(state, map, me, i, b) }));
              const pickB = buildable.find((x) => x.b === build[i]) ?? buildable.find((x) => x.chk.ok) ?? buildable[0];
              const units = UNIT_ORDER.filter((u) => !UNITS[u].auto).map((u) => ({ u, chk: checkProduce(state, map, me, i, u) }));
              const pickU = units.find((x) => x.u === unit[i]) ?? units.find((x) => x.chk.ok);
              return (
                <tr key={i}>
                  <td>
                    <button className="link-btn" title="Auf der Karte zeigen" onClick={() => { onSelect(i); onClose(); }}>
                      {i === capital ? '★ ' : mp.city ? '■ ' : ''}{mp.name}
                    </button>
                  </td>
                  <td className="small"><ResIcon res={mp.resource} size={14} /> {fmtNum(out.amount)}{mp.double ? ' (×2)' : ''}</td>
                  <td className="overview-morale">
                    <Bar value={ps.morale} color={ps.morale < 0.33 ? '#a33' : ps.morale < 0.6 ? '#c9952f' : '#5d8a3a'} />
                    <span className="small">{fmtPercent(ps.morale)}</span>
                  </td>
                  <td>
                    <div className="overview-buildings">
                      {BUILDING_ORDER.filter((b) => ps.buildings[b] > 0).map((b) => {
                        const off = !!ps.off?.[b], dmg = ps.damage?.[b] ?? 0;
                        const note = off ? ' · abgeschaltet' : dmg ? ` · beschädigt (${buildingLives(b) - dmg}/${buildingLives(b)} Leben)` : '';
                        return (
                          <span key={b} className={'ov-building' + (off ? ' off' : '') + (dmg ? ' damaged' : '')}
                            title={`${BUILDINGS[b].name}${BUILDINGS[b].maxLevel > 1 ? ` Stufe ${ps.buildings[b]}` : ''}${note}`}>
                            <Picture src={buildingImage(b)} label={BUILDINGS[b].name.slice(0, 3)} size={26} />
                            {BUILDINGS[b].maxLevel > 1 && <span className="ov-level">{ps.buildings[b]}</span>}
                          </span>
                        );
                      })}
                    </div>
                    {ps.construction && (
                      <div className="small muted">⚒ {BUILDINGS[ps.construction.building].name} {ps.construction.level > 1 ? `Stufe ${ps.construction.level}` : ''} – {remaining(ps.construction.end)}
                        {ps.buildQueue.length ? ` · +${ps.buildQueue.length} geplant` : ''}</div>
                    )}
                  </td>
                  <td>
                    <div className="overview-switches">
                      {SWITCHES.filter(([b]) => ps.buildings[b] > 0).map(([b, label]) => {
                        const on = !ps.off?.[b];
                        return (
                          <button key={b} className={'btn small' + (on ? '' : ' off-btn')} title={on ? `${label} abschalten` : `${label} einschalten`}
                            onClick={() => run({ type: 'switchBuilding', province: i, building: b, on: !on })}>
                            {label} {on ? 'an' : 'aus'}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td>
                    {pickB ? (
                      <div className="overview-order">
                        <select value={pickB.b} onChange={(e) => setBuild({ ...build, [i]: e.target.value as Building })}>
                          {buildable.map(({ b, chk }) => (
                            <option key={b} value={b} disabled={!chk.ok}>
                              {BUILDINGS[b].name}{BUILDINGS[b].maxLevel > 1 ? ` ${chk.level}` : ''}{chk.ok ? '' : ` – ${chk.error}`}
                            </option>
                          ))}
                        </select>
                        <button className="btn small" disabled={!pickB.chk.ok}
                          title={pickB.chk.error ?? `${costText(pickB.chk.cost)} · ${fmtDuration((pickB.chk.hours * 3600_000) / state.speed)}${pickB.chk.queued ? ' · kommt in die Bauschleife' : ''}`}
                          onClick={() => run({ type: 'build', province: i, building: pickB.b })}>
                          {pickB.chk.queued ? 'Planen' : 'Bauen'}
                        </button>
                      </div>
                    ) : <span className="small muted">alles gebaut</span>}
                  </td>
                  <td>
                    {pickU ? (
                      <div className="overview-order">
                        <select value={pickU.u} onChange={(e) => setUnit({ ...unit, [i]: e.target.value as UnitType })}>
                          {units.map(({ u, chk }) => (
                            <option key={u} value={u} disabled={!chk.ok}>{UNITS[u].name}{chk.ok ? '' : ` – ${chk.error}`}</option>
                          ))}
                        </select>
                        <button className="btn small" disabled={!pickU.chk.ok}
                          title={pickU.chk.error ?? `${costText(UNITS[pickU.u].cost)} · ${fmtDuration((pickU.chk.hours * 3600_000) / state.speed)}`}
                          onClick={() => run({ type: 'enqueue', province: i, unit: pickU.u })}>In Auftrag</button>
                        {ps.queue.length > 0 && <span className="small muted"> {ps.queue.length} Auftr.</span>}
                      </div>
                    ) : <span className="small muted">keine Fabrik</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="overview-actions">
        <button className="btn" disabled={busy || !recruitTargets.length}
          title="In allen Provinzen ohne Wehramt eins bauen bzw. einplanen (wo es möglich und bezahlbar ist)"
          onClick={() => runAll(recruitTargets.map(({ i }) => ({ type: 'build', province: i, building: 'recruitment' })), 'Wehrämter in Auftrag')}>
          Überall Wehrämter bauen ({recruitTargets.length})
        </button>
        <button className="btn" disabled={busy || !barracksOn.length}
          onClick={() => runAll(barracksOn.map(({ i }) => ({ type: 'switchBuilding', province: i, building: 'barracks', on: true })), 'Kasernen aktiviert')}>
          Alle Kasernen aktivieren ({barracksOn.length})
        </button>
        <button className="btn" disabled={busy || !barracksOff.length}
          onClick={() => runAll(barracksOff.map(({ i }) => ({ type: 'switchBuilding', province: i, building: 'barracks', on: false })), 'Kasernen deaktiviert')}>
          Alle Kasernen deaktivieren ({barracksOff.length})
        </button>
        <span className="small muted">Vorrat: {fmtNum(stock.money)} Geld · {fmtNum(stock.grain)} {RES_NAMES.grain}</span>
        {msg && <span className="small overview-msg">{msg}</span>}
      </div>
    </Window>
  );
}

function costText(cost: Partial<Record<string, number>>): string {
  return Object.entries(cost).filter(([, v]) => (v ?? 0) > 0)
    .map(([r, v]) => `${fmtNum(v!)} ${RES_NAMES[r as keyof typeof RES_NAMES] ?? r}`).join(', ');
}
