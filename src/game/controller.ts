// Schnittstelle für Entscheider. Jede Nation wird von genau einem Controller
// gesteuert: Mensch (über die Oberfläche), eingebaute KI oder ein externes
// Entscheidungsmodell. Alle sehen dieselbe Beobachtung und liefern Aktionen.

import type { Action } from './actions.ts';
import { ALL_RES } from './balance.ts';
import { netRate, type NationRates } from './economy.ts';
import type { MapData } from './mapdata.ts';
import { canTrade, enemiesOf, relation } from './diplomacy.ts';
import type { GameState, Relation } from './types.ts';
import { armyVisible, visibleNodes } from './visibility.ts';

export interface NationView {
  readonly state: Readonly<GameState>;
  readonly map: MapData;
  readonly nation: string;
  readonly rates: NationRates;
  /** Deterministischer Zufall aus dem Spielstand */
  random(): number;
}

export interface Controller {
  readonly name: string;
  /** Wird stündlich (Spielzeit) aufgerufen, gestaffelt je Nation. */
  decide(view: NationView): Action[];
}

/**
 * Controller für externe Modelle: Aktionen werden von außen (z. B. per
 * WebSocket oder aus einem Trainingslauf) eingereiht und beim nächsten
 * Entscheidungszeitpunkt ausgeführt.
 */
export class QueuedController implements Controller {
  readonly name = 'extern';
  private pending: Action[] = [];
  onObserve?: (obs: Observation) => void;

  push(...actions: Action[]): void {
    this.pending.push(...actions);
  }

  decide(view: NationView): Action[] {
    this.onObserve?.(observe(view));
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/** Kompakte, serialisierbare Beobachtung für externe Modelle. */
export interface Observation {
  time: number;
  nation: string;
  stock: Record<string, number>;
  /** Tagesbilanz je Rohstoff (Produktion minus Unterhalt minus Anteil am Provinzunterhalt) */
  ratesPerDay: Record<string, number>;
  /** Verbrauchsregler (Prozent je Rohstoff, je Kategorie Summe 100) */
  consumption: Record<string, number>;
  /** Provinzunterhalt je Kategorie und Tag */
  provinceUpkeep: number;
  /** Kriegsgegner */
  enemies: string[];
  /** eingegangene Friedensangebote (Absender) */
  peaceOffers: string[];
  /** Beziehung zu jeder anderen Nation */
  relations: Record<string, Relation>;
  /** eingegangene Angebote aller Art */
  proposals: { from: string; kind: Relation }[];
  /** Siegpunkte (Stand letzter Tageswechsel) und lebende Nationen */
  points: Record<string, number>;
  alive: string[];
  /** offene Börsenangebote, mit denen diese Nation handeln darf, und eigene */
  offers: { id: number; nation: string; side: 'buy' | 'sell'; res: string; amount: number; price: number }[];
  provinces: {
    id: number;
    owner: string;
    visible: boolean;
    /** nur für eigene Provinzen */
    morale?: number;
    resource: string;
    buildings?: Record<string, number>;
    constructing?: string | null;
    /** Bauschleife (geplante Gebäude in Reihenfolge) */
    buildQueue?: string[];
    queue?: string[];
    neighbors: number[];
    seas: number[];
  }[];
  /** sichtbare Armeen; node = Provinz (0..P-1) oder Seegebiet (P + Index) */
  armies: {
    id: number; owner: string; node: number; moving: boolean; units: Record<string, number>;
    /** nur eigene: Zielknoten des Marsches, Fernkampfziel */
    to?: number; target?: number | null;
  }[];
}

export function observe(view: NationView): Observation {
  const { state, map, nation, rates } = view;
  const ratesPerDay: Record<string, number> = {};
  for (const r of ALL_RES) ratesPerDay[r] = netRate(rates, r);
  const vis = visibleNodes(state as GameState, map, nation);
  return {
    time: state.time,
    nation,
    stock: { ...state.nations[nation].stock },
    ratesPerDay,
    consumption: { ...state.nations[nation].consumption },
    provinceUpkeep: rates.upkeep,
    enemies: enemiesOf(state as GameState, nation),
    peaceOffers: state.proposals.filter((p) => p.to === nation && p.kind === 'peace').map((p) => p.from),
    relations: Object.fromEntries(map.nations.filter((n) => n.id !== nation).map((n) => [n.id, relation(state as GameState, nation, n.id)])),
    proposals: state.proposals.filter((p) => p.to === nation).map((p) => ({ from: p.from, kind: p.kind })),
    points: Object.fromEntries(map.nations.map((n) => [n.id, Math.round(state.nations[n.id].points)])),
    alive: map.nations.filter((n) => state.nations[n.id].alive).map((n) => n.id),
    offers: state.market.offers
      .filter((o) => o.nation === nation || canTrade(state as GameState, nation, o.nation))
      .map((o) => ({ id: o.id, nation: o.nation, side: o.side, res: o.res, amount: o.amount, price: o.price })),
    provinces: state.provinces.map((ps, id) => {
      const own = ps.owner === nation;
      return {
        id,
        owner: ps.owner,
        visible: vis.has(id),
        morale: own ? ps.morale : undefined,
        resource: map.provinces[id].resource,
        buildings: own ? { ...ps.buildings } : undefined,
        constructing: own ? ps.construction?.building ?? null : undefined,
        buildQueue: own ? [...ps.buildQueue] : undefined,
        queue: own ? ps.queue.map((o) => o.unit) : undefined,
        neighbors: map.provinces[id].neighbors,
        seas: map.provinces[id].seas,
      };
    }),
    armies: state.armies.filter((a) => armyVisible(state as GameState, map, nation, a, vis))
      .map((a) => ({
        id: a.id, owner: a.owner, node: a.node, moving: !!a.move, units: { ...a.units } as Record<string, number>,
        ...(a.owner === nation ? { to: a.move ? a.move.path[a.move.path.length - 1] : a.node, target: a.target ?? null } : {}),
      })),
  };
}
