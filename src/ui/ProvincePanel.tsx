import { useState } from 'react';
import { checkBuild, checkCapitalMove, checkProduce, missing, plannedBuildings, requirementsMet, type Action, type ActionResult, checkRepair } from '../game/actions.ts';
import {
  BUILDING_ORDER, BUILDINGS, CAPITAL_MOVE, DEFECTION, MILITARY, RES_NAMES, UNIT_ORDER, UNITS, type UnitType, buildingLives, siteAllows } from '../game/balance.ts';
import { activeCapital, moraleTarget, provinceOutput, provincePoints, recruitHours } from '../game/economy.ts';
import type { MapData } from '../game/mapdata.ts';
import { defectionChance, garrisonStrength } from '../game/military.ts';
import { armyName } from '../game/names.ts';
import type { Army, GameState } from '../game/types.ts';
import { Bar, CostList, Swatch, Window } from './common.tsx';
import { fmtDuration, fmtNum, fmtPercent } from './format.ts';
import { ResIcon } from './icons.tsx';
import { buildingImage, Picture, unitImage } from './Picture.tsx';

interface Props {
  map: MapData;
  state: GameState;
  id: number;
  /** sichtbare Armeen */
  armies: Army[];
  act(a: Action): Promise<ActionResult>;
  onSelectArmy(id: number): void;
  onClose(): void;
}

export function ProvincePanel({ map, state, id, armies: visibleArmies, act, onSelectArmy, onClose }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  const ps = state.provinces[id];
  const mp = map.provinces[id];
  const owner = map.nations.find((n) => n.id === ps.owner)!;
  const own = ps.owner === state.playerNation;
  const out = provinceOutput(map, ps, id);
  const planned = plannedBuildings(ps);
  const mt = moraleTarget(state, map, id);
  const stock = state.nations[state.playerNation].stock;
  const remaining = (end: number) => (state.paused ? 'pausiert' : fmtDuration((end - state.time) / state.speed));
  /** Spielstunden als Echtzeit */
  const remainingHours = (h: number) => (state.paused ? `${Math.round(h)} h Spielzeit` : fmtDuration((h * 3600_000) / state.speed));
  const infantryHours = recruitHours(ps, mp.double);

  const run = async (a: Action) => {
    const r = await act(a);
    setMsg(r.ok ? null : r.error);
  };

  const armies = visibleArmies.filter((a) => a.node === id && !a.move);
  const isCapital = activeCapital(state, map, ps.owner) === id;
  const nationState = state.nations[state.playerNation];
  const capMove = nationState.capitalMove;
  const capChk = checkCapitalMove(state, map, state.playerNation, id);
  const tags = [isCapital ? 'Hauptstadt' : mp.city ? 'Stadt' : 'Land', mp.coastal ? 'Küste' : null, mp.nation !== ps.owner ? 'besetzt' : null]
    .filter(Boolean).join(' · ');

  return (
    <Window title={mp.name} onClose={onClose} className="province-panel">
      <div className="prov-head">
        <Swatch color={owner.color} />
        <div>
          <div className="prov-owner">{owner.name}</div>
          <div className="muted">{tags}</div>
        </div>
        <div className="prov-points" title="Siegpunkte dieser Provinz">{provincePoints(map, ps, id).toFixed(1)} SP</div>
      </div>

      <h4>Moral</h4>
      <div className="morale-row">
        <Bar value={ps.morale} marker={mt.target} color={ps.morale < 0.33 ? '#a33' : ps.morale < 0.6 ? '#c9952f' : '#5d8a3a'} />
        <span>{fmtPercent(ps.morale)}</span>
      </div>
      <div className="muted small">Ziel {fmtPercent(mt.target)} – die Moral nähert sich ihm zum Tageswechsel.</div>
      <ul className="morale-parts small">
        {mt.parts.map((p) => (
          <li key={p.label}>
            <span>{p.label}</span>
            <span className={p.value < 0 ? 'neg' : 'pos'}>{p.value >= 0 ? '+' : '−'}{Math.round(Math.abs(p.value) * 100)} %</span>
          </li>
        ))}
      </ul>
      <div className="muted small">
        Einmalig: eroberte Provinzen beginnen bei {Math.round(MILITARY.conquestMorale * 100)} % (Rückeroberung am selben Tag {Math.round(DEFECTION.morale * 100)} %); fällt eine Hauptstadt,
        bekommt der Eroberer +{Math.round(MILITARY.capitalMoraleBonus * 100)} %, der Verlierer −{Math.round(MILITARY.capitalMoralePenalty * 100)} % in allen Provinzen.
      </div>
      {ps.morale < DEFECTION.threshold && (
        <div className="error small">
          ✊ Unruhen: Die Provinz kann zum Tageswechsel zu einer anderen Macht überlaufen
          (Wahrscheinlichkeit {Math.round(defectionChance(ps.morale, garrisonStrength(state, id)) * 100)} %;
          je 5 Kampfstärke Besatzung 1 Prozentpunkt weniger).
        </div>
      )}

      {own && (
        <>
          <h4>Hauptstadt</h4>
          {isCapital ? (
            <div className="muted small">Hier ist die Hauptstadt: kein Entfernungsabzug bei der Moral.</div>
          ) : capMove?.province === id ? (
            <div className="progress-row">
              <span className="small">Verlegung läuft</span>
              <Bar value={(state.time - capMove.start) / (capMove.end - capMove.start)} />
              <span className="small">{remaining(capMove.end)}</span>
              <button className="btn small" onClick={() => run({ type: 'cancelCapitalMove' })} title="Abbrechen (Kosten kommen zurück)">✕</button>
            </div>
          ) : (
            <div className="progress-row">
              <CostList cost={CAPITAL_MOVE.cost} stock={stock} />
              <span className="small muted">{fmtDuration((CAPITAL_MOVE.hours * 3600_000) / state.speed)}</span>
              <button className="btn small" disabled={!capChk.ok} title={capChk.error ?? 'Die bisherige Hauptstadt verliert ihren Status, sobald die Verlegung fertig ist'}
                onClick={() => run({ type: 'moveCapital', province: id })}>Hauptstadt hierher</button>
            </div>
          )}
          {capMove && capMove.province !== id && <div className="muted small">Die Hauptstadt wird gerade nach {map.provinces[capMove.province].name} verlegt.</div>}
        </>
      )}

      <h4>Produktion pro Tag</h4>
      <div className="prod-row">
        <span><ResIcon res={mp.resource} /> {fmtNum(out.amount)} {RES_NAMES[mp.resource]}{mp.double ? ' (doppelt)' : ''}</span>
        <span><ResIcon res="money" /> {fmtNum(out.money)}</span>
      </div>
      {out.bonus > 0 && <div className="muted small">Gebäudebonus +{Math.round(out.bonus * 100)} %</div>}

      {own && (
        <>
          <h4>Gebäude</h4>
          <div className="build-list">
            {BUILDING_ORDER.filter((b) => siteAllows(b, mp.coastal)).map((b) => {
              const def = BUILDINGS[b];
              const level = ps.buildings[b];
              const c = ps.construction?.building === b ? ps.construction : null;
              const chk = checkBuild(state, map, state.playerNation, id, b);
              const plannedLevel = planned[b];
              const waiting = ps.buildQueue.filter((x) => x === b).length;
              const excluded = (def.excludes ?? []).some((x) => planned[x] > 0);
              return (
                <div key={b} className={'build-item' + (excluded ? ' excluded' : '')}>
                  <Picture src={buildingImage(b)} label={def.name} size={40} className="build-pic" />
                  <div className="build-name">
                    <b>{def.name}</b>
                    <span className="muted">
                      {def.maxLevel > 1 ? `Stufe ${level}/${def.maxLevel}` : level ? 'vorhanden' : '—'}
                      {waiting > 0 ? ` · ${waiting} geplant` : ''}
                      {level > 0 && ps.off?.[b] ? ' · abgeschaltet' : ''}
                      {ps.damage?.[b] ? ` · beschädigt (${buildingLives(b) - ps.damage[b]!}/${buildingLives(b)} Leben)` : ''}
                    </span>
                    {def.switchable && level > 0 && (
                      <button className={'btn small' + (ps.off?.[b] ? ' active' : '')}
                        title={ps.off?.[b] ? 'Wieder einschalten: Unterhalt und Wirkung kehren zurück' : 'Abschalten: kein Unterhalt, aber auch keine Wirkung'}
                        onClick={() => run({ type: 'switchBuilding', province: id, building: b, on: !!ps.off?.[b] })}>
                        {ps.off?.[b] ? 'Einschalten' : 'Abschalten'}
                      </button>
                    )}
                  </div>
                  <div className="muted small">{def.describe(Math.min(def.maxLevel, Math.max(1, plannedLevel < def.maxLevel ? plannedLevel + 1 : plannedLevel)))}</div>
                  {ps.damage?.[b] ? (() => {
                    const rep = checkRepair(state, state.playerNation, id, b);
                    return (
                      <div className="progress-row">
                        <CostList cost={rep.cost} stock={stock} />
                        <button className="btn small" disabled={!rep.ok} title={rep.error ?? 'Sofort reparieren – das Gebäude wirkt wieder'}
                          onClick={() => run({ type: 'repair', province: id, building: b })}>Reparieren</button>
                      </div>
                    );
                  })() : null}
                  {c && (
                    <div className="progress-row">
                      <Bar value={(state.time - c.start) / (c.end - c.start)} />
                      <span className="small">{remaining(c.end)}</span>
                      <button className="btn small" onClick={() => run({ type: 'cancelBuild', province: id })} title="Abbrechen (Kosten kommen zurück)">✕</button>
                    </div>
                  )}
                  {plannedLevel < def.maxLevel && !excluded && (
                    <div className="progress-row">
                      <CostList cost={chk.cost} stock={stock} />
                      <span className="small muted">{fmtDuration((chk.hours * 3600_000) / state.speed)}</span>
                      <button className="btn small" disabled={!chk.ok} title={chk.error ?? (chk.queued ? 'In die Bauschleife stellen – bezahlt wird beim Baubeginn' : '')}
                        onClick={() => run({ type: 'build', province: id, building: b })}>
                        {chk.queued ? '+ Planen' : plannedLevel === 0 ? 'Bauen' : `Stufe ${plannedLevel + 1}`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {ps.buildQueue.length > 0 && (
            <>
              <div className="muted small">Bauschleife – startet nacheinander, bezahlt wird beim Baubeginn:</div>
              <ol className="queue">
                {ps.buildQueue.map((b, i) => {
                  const lvl = ps.buildings[b] + (ps.construction?.building === b ? 1 : 0) + ps.buildQueue.slice(0, i + 1).filter((x) => x === b).length;
                  return (
                    <li key={i}>
                      <span>{BUILDINGS[b].name}{BUILDINGS[b].maxLevel > 1 ? ` Stufe ${lvl}` : ''}</span>
                      <span className="small muted">{i === 0 && !ps.construction ? `wartet auf ${missing(stock, BUILDINGS[b].cost(ps.buildings[b] + 1)) || 'Start'}` : 'geplant'}</span>
                      <button className="btn small" onClick={() => run({ type: 'dequeueBuild', province: id, index: i })} title="Aus der Bauschleife nehmen">✕</button>
                    </li>
                  );
                })}
              </ol>
            </>
          )}

          <h4>Infanterie</h4>
          {infantryHours === null ? (
            <div className="muted small">
              {ps.revolt ? 'Aufstand – keine Infanterie.' : 'Kein Wehramt und keine Kaserne – es entsteht keine Infanterie.'}
            </div>
          ) : (
            <div className="infantry-row">
              <Bar value={ps.recruit} />
              <span className="small">
                nächste in <b>{remainingHours((1 - ps.recruit) * infantryHours)}</b> · je Infanterie {remainingHours(infantryHours)}
              </span>
            </div>
          )}
          <div className="muted small">Wehramt und Kaserne stellen Infanterie kostenlos auf; je höher die Moral, desto schneller.</div>

          <h4>Fertigung</h4>
          <div className="unit-grid">
            {UNIT_ORDER.filter((u) => !UNITS[u].auto).map((u) => {
              const chk = checkProduce(state, map, state.playerNation, id, u);
              return (
                <button key={u} className="unit-btn" disabled={!chk.ok} title={chk.error ?? `${UNITS[u].name} in Auftrag geben`}
                  onClick={() => run({ type: 'enqueue', province: id, unit: u })}>
                  <Picture src={unitImage(u)} label={UNITS[u].name} size={44} />
                  <b>{UNITS[u].name}</b>
                  <CostList cost={UNITS[u].cost} stock={stock} />
                  <span className="small muted">{fmtDuration((chk.hours * 3600_000) / state.speed)}</span>
                </button>
              );
            })}
          </div>
          <label className="repeat">
            <input type="checkbox" checked={ps.repeat} onChange={(e) => run({ type: 'setRepeat', province: id, repeat: e.target.checked })} />
            Fertigungsschleife: fertige Aufträge automatisch wiederholen
          </label>
          {ps.queue.length > 0 && (
            <ol className="queue">
              {ps.queue.map((o, i) => (
                <li key={i}>
                  <span>{UNITS[o.unit].name}</span>
                  {o.start !== undefined && o.end !== undefined ? (
                    <>
                      <Bar value={(state.time - o.start) / (o.end - o.start)} />
                      <span className="small">{remaining(o.end)}</span>
                    </>
                  ) : (
                    <span className="small muted">{i === 0 ? waitingReason(state, map, id, o.unit) : 'wartet'}</span>
                  )}
                  <button className="btn small" onClick={() => run({ type: 'dequeue', province: id, index: i })} title="Entfernen">✕</button>
                </li>
              ))}
            </ol>
          )}
          {msg && <div className="error">{msg}</div>}
        </>
      )}

      <h4>Truppen</h4>
      {armies.length === 0 ? <div className="muted small">Keine Truppen.</div> : armies.map((a) => (
        <div key={a.id} className="army-row link" onClick={() => onSelectArmy(a.id)} title="Armee auswählen">
          <Swatch color={map.nations.find((n) => n.id === a.owner)?.color ?? '#4a4540'} />
          <b>{armyName(a)}</b>:{' '}
          {UNIT_ORDER.filter((u) => a.units[u]).map((u) => `${a.units[u]}× ${UNITS[u].name}`).join(', ')}
        </div>
      ))}
    </Window>
  );
}

function waitingReason(state: GameState, map: MapData, id: number, unit: UnitType): string {
  const req = requirementsMet(state, map, id, unit);
  return req ?? 'wartet auf Rohstoffe';
}
