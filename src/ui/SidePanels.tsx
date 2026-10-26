import type { Action, ActionResult } from '../game/actions.ts';
import { ALL_RES, BUILDINGS, CATEGORY_NAMES, PROVINCE, RES_NAMES, VICTORY_SHARE, type Building, type Category } from '../game/balance.ts';
import { netRate, totalUse, type NationRates } from '../game/economy.ts';
import type { MapData } from '../game/mapdata.ts';
import type { GameState } from '../game/types.ts';
import { Swatch, Window } from './common.tsx';
import { ConsumptionControl } from './ConsumptionControl.tsx';
import { fmtGameTime, fmtNum, fmtPercent, fmtSigned } from './format.ts';
import { ResIcon } from './icons.tsx';

export type SidePanel = 'provinces' | 'economy' | 'ranking' | 'events' | 'diplomacy' | 'newspaper' | 'market' | 'control';

interface Props {
  map: MapData;
  state: GameState;
  rates: NationRates;
  onSelect(id: number): void;
  onClose(): void;
}

export function netPerDay(rates: NationRates, r: (typeof ALL_RES)[number]): number {
  return netRate(rates, r);
}

export function EconomyPanel({ state, rates, act, onClose }: Props & { act(a: Action): Promise<ActionResult> }) {
  const n = state.nations[state.playerNation];
  const provinces = state.provinces.filter((p) => p.owner === state.playerNation).length;
  return (
    <Window title="Wirtschaft" onClose={onClose} className="side-panel">
      <table className="table">
        <thead>
          <tr><th>Rohstoff</th><th>Bestand</th><th>Produktion</th><th>Verbrauch</th><th>Bilanz/Tag</th></tr>
        </thead>
        <tbody>
          {ALL_RES.map((r) => {
            const cons = totalUse(rates, r);
            const net = netPerDay(rates, r);
            return (
              <tr key={r}>
                <td><ResIcon res={r} size={16} /> {RES_NAMES[r]}</td>
                <td>{fmtNum(n.stock[r])}</td>
                <td>{fmtNum(rates.prod[r])}</td>
                <td>{fmtNum(cons)}</td>
                <td className={net < 0 ? 'neg' : 'pos'}>{fmtSigned(net)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h4>Verbrauchsregler</h4>
      <p className="muted small">
        Provinzunterhalt: {provinces} Provinzen × {PROVINCE.upkeep} = {fmtNum(rates.upkeep)} je Kategorie und Tag.
        Der Regler legt fest, aus welchen Rohstoffen er gedeckt wird; fehlt einer, springen die anderen
        eingestellten ein. Rohstoffe auf 0 % verbrauchen nur Einheiten und Gebäude (fester Unterhalt).
      </p>
      <ConsumptionControl state={state} rates={rates} act={act} />
      <p className="muted small">Engpässe senken am Tageswechsel die Moral in allen Provinzen.</p>
      <h4>Engpässe heute</h4>
      <div className="muted small">
        {(Object.keys(n.shortage) as Category[]).filter((c) => n.shortage[c]).map((c) => CATEGORY_NAMES[c]).join(', ') || 'keine'}
      </div>
    </Window>
  );
}

export function RankingPanel({ map, state, onClose }: Props) {
  const rows = map.nations.map((n) => ({
    n,
    points: state.nations[n.id].points,
    provinces: state.provinces.filter((p) => p.owner === n.id).length,
  })).sort((a, b) => b.points - a.points);
  return (
    <Window title="Rangliste" onClose={onClose} className="side-panel">
      <table className="table">
        <thead><tr><th>#</th><th>Nation</th><th>Siegpunkte</th><th>Provinzen</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.n.id} className={r.n.id === state.playerNation ? 'me' : ''}>
              <td>{i + 1}</td>
              <td><Swatch color={r.n.color} /> {r.n.name}</td>
              <td>{Math.round(r.points)}</td>
              <td>{r.provinces}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Siegpunkte werden am Tageswechsel aus Provinzen, Moral und Gebäuden berechnet; Armeen zählen nicht.
        Wer {Math.round(VICTORY_SHARE * 100)} % aller Siegpunkte hält ({Math.ceil(VICTORY_SHARE * rows.reduce((t, r) => t + r.points, 0))} von {Math.round(rows.reduce((t, r) => t + r.points, 0))}) oder als letzte Großmacht übrig bleibt, gewinnt.
      </p>
    </Window>
  );
}

export function EventsPanel({ map, state, onSelect, onClose }: Props) {
  const events = state.events.filter((e) => !e.nation || e.nation === state.playerNation).slice().reverse();
  return (
    <Window title="Ereignisse" onClose={onClose} className="side-panel">
      <ul className="events">
        {events.map((e, i) => (
          <li key={i} className={e.province !== undefined ? 'link' : ''} onClick={() => e.province !== undefined && onSelect(e.province)}>
            <span className="muted small">{fmtGameTime(e.time)}</span>
            <span>{e.text}</span>
          </li>
        ))}
        {events.length === 0 && <li className="muted">Noch keine Ereignisse.</li>}
      </ul>
      <p className="muted small">{map.name}</p>
    </Window>
  );
}

const SHORT: Record<Building, string> = { railroad: 'B', harbor: 'H', factory: 'F', manufactory: 'M', barracks: 'K', recruitment: 'W', office: 'BA', fortress: 'Fe' };

export function ProvincesPanel({ map, state, onSelect, onClose }: Props) {
  const own = state.provinces.map((ps, i) => ({ ps, mp: map.provinces[i], i })).filter((x) => x.ps.owner === state.playerNation)
    .sort((a, b) => Number(b.mp.capital) - Number(a.mp.capital) || Number(b.mp.city) - Number(a.mp.city) || a.mp.name.localeCompare(b.mp.name));
  return (
    <Window title={`Provinzen (${own.length})`} onClose={onClose} className="side-panel">
      <table className="table clickable">
        <thead><tr><th>Provinz</th><th></th><th>Moral</th><th title="B Eisenbahn, H Hafen, F Fabrik, K Kaserne, W Wehramt, Fe Festung">Gebäude</th><th>Bau</th></tr></thead>
        <tbody>
          {own.map(({ ps, mp, i }) => (
            <tr key={i} onClick={() => onSelect(i)}>
              <td>{mp.capital ? '★ ' : mp.city ? '■ ' : ''}{mp.name}</td>
              <td><ResIcon res={mp.resource} size={14} /></td>
              <td className={ps.morale < 0.33 ? 'neg' : ''}>{fmtPercent(ps.morale)}</td>
              <td className="small">
                {(Object.keys(SHORT) as Building[]).filter((b) => ps.buildings[b] > 0)
                  .map((b) => SHORT[b] + (BUILDINGS[b].maxLevel > 1 ? ps.buildings[b] : '')).join(' ')}
              </td>
              <td className="small">{ps.construction ? BUILDINGS[ps.construction.building].name : ps.queue.length ? `${ps.queue.length} Auftr.` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Window>
  );
}
