// Befehle. Mensch, KI und externe Entscheidungsmodelle verändern das Spiel
// ausschließlich über diese Aktionen.

import {
  ALL_RES, BUILD_QUEUE_LIMIT, BUILD_REFUND, BUILDINGS, CATEGORY_RES, FACTORY_SPEEDUP, HOUR, OFFICE_SPEEDUP, QUEUE_LIMIT, RES_NAMES, UNITS,
  type Building, type Category, type Cost, type Res, type UnitType,
} from './balance.ts';
import { validShares } from './economy.ts';
import { atWar, relation, relationRank, RELATION_NAMES, setRelation } from './diplomacy.ts';
import { isSea } from './graph.ts';
import type { MapData, Resource } from './mapdata.ts';
import { acceptOffer, cancelOffer, postOffer } from './market.ts';
import {
  inMelee, isNaval, mergeArmies, nearestNode, planMove, startMove, unitCount, unitTypes, type MilitaryContext,
} from './military.ts';
import type { GameState, ProvinceState, Relation, Stock } from './types.ts';

export type ProvinceAction =
  | { type: 'build'; province: number; building: Building }
  /** laufenden Bau abbrechen (50 % Erstattung); der nächste geplante startet */
  | { type: 'cancelBuild'; province: number }
  /** geplantes Gebäude aus der Bauschleife nehmen (noch nicht bezahlt) */
  | { type: 'dequeueBuild'; province: number; index: number }
  | { type: 'enqueue'; province: number; unit: UnitType }
  | { type: 'dequeue'; province: number; index: number }
  | { type: 'setRepeat'; province: number; repeat: boolean };

export type ArmyAction =
  /** Marsch zu einem Knoten (Provinz oder Seegebiet P + Index) */
  | { type: 'move'; army: number; to: number }
  | { type: 'stop'; army: number }
  /** Fernkampfziel setzen (null = aufheben) */
  | { type: 'attack'; army: number; target: number | null }
  /** Einheiten in eine neue Armee am selben Ort abspalten */
  | { type: 'split'; army: number; units: Partial<Record<UnitType, number>> }
  | { type: 'merge'; army: number; into: number };

export type DiplomacyAction =
  | { type: 'declareWar'; nation: string }
  /** einseitig verschlechtern (Embargo, Durchmarsch entziehen, Karte nicht mehr teilen) */
  | { type: 'downgrade'; nation: string; to: Relation }
  /** bessere Beziehung anbieten (Frieden, Durchmarschrecht, geteilte Karte) */
  | { type: 'propose'; nation: string; kind: Relation }
  | { type: 'answer'; nation: string; accept: boolean };

export type MarketAction =
  | { type: 'postOffer'; side: 'sell' | 'buy'; res: Resource; amount: number; price: number }
  | { type: 'cancelOffer'; id: number }
  | { type: 'acceptOffer'; id: number; amount: number };

export type EconomyAction =
  /** Verbrauchsregler einer Kategorie: ganze Prozent je Rohstoff, Summe 100 */
  | { type: 'setConsumption'; category: Category; shares: Partial<Record<Resource, number>> };

export type Action = ProvinceAction | ArmyAction | DiplomacyAction | MarketAction | EconomyAction;

export type ActionResult = { ok: true } | { ok: false; error: string };

export type ActionContext = MilitaryContext;

export function canAfford(stock: Stock, cost: Cost): boolean {
  return ALL_RES.every((r) => (stock[r] ?? 0) >= (cost[r] ?? 0) - 1e-9);
}

export function missing(stock: Stock, cost: Cost): string {
  return ALL_RES.filter((r) => (stock[r] ?? 0) < (cost[r] ?? 0) - 1e-9).map((r) => RES_NAMES[r]).join(', ');
}

export function pay(stock: Stock, cost: Cost, factor = 1): void {
  for (const r of Object.keys(cost) as Res[]) stock[r] -= (cost[r] ?? 0) * factor;
}

export function refund(stock: Stock, cost: Cost): void {
  for (const r of Object.keys(cost) as Res[]) stock[r] += (cost[r] ?? 0) * BUILD_REFUND;
}

export interface BuildCheck {
  ok: boolean;
  error?: string;
  level: number;
  cost: Cost;
  hours: number;
  /** wird in die Bauschleife gestellt statt sofort begonnen */
  queued: boolean;
}

/** Gebäudestufen einschließlich laufendem Bau und Bauschleife */
export function plannedBuildings(ps: ProvinceState): Record<Building, number> {
  const out = { ...ps.buildings };
  if (ps.construction) out[ps.construction.building] = Math.max(out[ps.construction.building], ps.construction.level);
  for (const b of ps.buildQueue ?? []) out[b]++;
  return out;
}

/** Bauzeit in Stunden; ein Bauamt in der Provinz verkürzt sie */
export function buildHours(ps: ProvinceState, building: Building, level: number): number {
  const h = BUILDINGS[building].hours(level);
  return building !== 'office' && ps.buildings.office > 0 ? h * (1 - OFFICE_SPEEDUP) : h;
}

/** Hindernis für den Bau der nächsten Stufe auf Grundlage der angegebenen Stufen (null = möglich) */
export function buildBlocker(map: MapData, province: number, building: Building, levels: Record<Building, number>): string | null {
  const def = BUILDINGS[building];
  if (levels[building] + 1 > def.maxLevel) return 'Höchste Stufe erreicht';
  if (def.coastal && !map.provinces[province].coastal) return 'Nur in Küstenprovinzen';
  for (const [b, lvl] of Object.entries(def.requires ?? {}) as [Building, number][]) {
    if (levels[b] < lvl) return `Benötigt ${BUILDINGS[b].name}`;
  }
  for (const b of def.excludes ?? []) if (levels[b] > 0) return `Nicht zusammen mit ${BUILDINGS[b].name}`;
  return null;
}

/**
 * Bauen: ist nichts im Bau, beginnt der Bau sofort (muss bezahlbar sein), sonst kommt das Gebäude
 * in die Bauschleife und wird beim Start bezahlt. Stufe, Voraussetzungen und Ausschlüsse zählen
 * geplante Gebäude mit.
 */
export function checkBuild(state: GameState, map: MapData, nation: string, province: number, building: Building): BuildCheck {
  const ps = state.provinces[province];
  const def = BUILDINGS[building];
  const planned = ps ? plannedBuildings(ps) : null;
  const level = (planned?.[building] ?? 0) + 1;
  const queued = !!ps && (!!ps.construction || ps.buildQueue.length > 0);
  const res = (error?: string): BuildCheck => ({
    ok: !error, error, level, queued,
    cost: level <= def.maxLevel ? def.cost(level) : {},
    hours: ps && level <= def.maxLevel ? buildHours(ps, building, level) : 0,
  });
  if (!ps || ps.owner !== nation) return res('Provinz gehört nicht dir');
  const blocker = buildBlocker(map, province, building, planned!);
  if (blocker) return res(blocker);
  if (queued) {
    if (ps.buildQueue.length >= BUILD_QUEUE_LIMIT) return res(`Höchstens ${BUILD_QUEUE_LIMIT} geplante Gebäude`);
    return res();
  }
  const cost = def.cost(level);
  if (!canAfford(state.nations[nation].stock, cost)) return res(`Zu wenig ${missing(state.nations[nation].stock, cost)}`);
  return res();
}

export interface ProduceCheck {
  ok: boolean;
  error?: string;
  hours: number;
}

/** Bauzeit: Startwert auf der Mindest-Fabrikstufe, je weitere Stufe −25 % des Startwerts */
export function unitHours(state: GameState, province: number, unit: UnitType): number {
  const min = UNITS[unit].requires.factory ?? 1;
  const level = state.provinces[province]?.buildings.factory ?? min;
  const extra = Math.max(0, level - min);
  return UNITS[unit].hours * Math.max(FACTORY_SPEEDUP, 1 - FACTORY_SPEEDUP * extra);
}

export function requirementsMet(state: GameState, map: MapData, province: number, unit: UnitType): string | null {
  const ps = state.provinces[province];
  const req = UNITS[unit].requires;
  for (const b of Object.keys(req) as Building[]) {
    if (ps.buildings[b] < req[b]!) return `Benötigt ${BUILDINGS[b].name}${BUILDINGS[b].maxLevel > 1 ? ' Stufe ' + req[b] : ''}`;
  }
  if (UNITS[unit].naval && !map.provinces[province].coastal) return 'Nur in Küstenprovinzen';
  return null;
}

export function checkProduce(state: GameState, map: MapData, nation: string, province: number, unit: UnitType): ProduceCheck {
  const ps = state.provinces[province];
  const hours = ps ? unitHours(state, province, unit) : 0;
  if (!ps || ps.owner !== nation) return { ok: false, error: 'Provinz gehört nicht dir', hours };
  if (UNITS[unit].auto) return { ok: false, error: 'Infanterie stellen Wehramt und Kaserne automatisch auf', hours };
  const req = requirementsMet(state, map, province, unit);
  if (req) return { ok: false, error: req, hours };
  if (ps.queue.length >= QUEUE_LIMIT) return { ok: false, error: `Höchstens ${QUEUE_LIMIT} Aufträge`, hours };
  return { ok: true, hours };
}

export function applyAction(ctx: ActionContext, nation: string, action: Action): ActionResult {
  if ('army' in action) return applyArmyAction(ctx, nation, action);
  if (action.type === 'postOffer') return postOffer(ctx, nation, action.side, action.res, action.amount, action.price);
  if (action.type === 'cancelOffer') return cancelOffer(ctx, nation, action.id);
  if (action.type === 'acceptOffer') return acceptOffer(ctx, nation, action.id, action.amount);
  if (action.type === 'setConsumption') {
    if (!(action.category in CATEGORY_RES) || !validShares(action.category, action.shares)) {
      return { ok: false, error: 'Ungültige Verteilung: ganze Prozent, zusammen 100' };
    }
    const n = ctx.state.nations[nation];
    for (const r of CATEGORY_RES[action.category]) n.consumption[r] = action.shares[r] ?? 0;
    ctx.invalidate();
    return { ok: true };
  }
  if (!('province' in action)) return applyDiplomacy(ctx, nation, action);
  const { state, map } = ctx;
  const ps = state.provinces[action.province];
  if (!ps || ps.owner !== nation) return { ok: false, error: 'Provinz gehört nicht dir' };
  const stock = state.nations[nation].stock;

  switch (action.type) {
    case 'build': {
      const chk = checkBuild(state, map, nation, action.province, action.building);
      if (!chk.ok) return { ok: false, error: chk.error! };
      if (chk.queued) ps.buildQueue.push(action.building);
      else {
        pay(stock, chk.cost);
        ps.construction = { building: action.building, level: chk.level, start: state.time, end: state.time + Math.round(chk.hours * HOUR) };
      }
      ctx.invalidate();
      return { ok: true };
    }
    case 'cancelBuild': {
      if (!ps.construction) return { ok: false, error: 'Kein Bauauftrag' };
      refund(stock, BUILDINGS[ps.construction.building].cost(ps.construction.level));
      ps.construction = null;
      ctx.invalidate();
      return { ok: true };
    }
    case 'dequeueBuild': {
      if (action.index < 0 || action.index >= ps.buildQueue.length) return { ok: false, error: 'Geplantes Gebäude nicht gefunden' };
      ps.buildQueue.splice(action.index, 1);
      return { ok: true };
    }
    case 'enqueue': {
      const chk = checkProduce(state, map, nation, action.province, action.unit);
      if (!chk.ok) return { ok: false, error: chk.error! };
      ps.queue.push({ unit: action.unit });
      ctx.invalidate();
      return { ok: true };
    }
    case 'dequeue': {
      const o = ps.queue[action.index];
      if (!o) return { ok: false, error: 'Auftrag nicht gefunden' };
      if (o.start !== undefined) refund(stock, UNITS[o.unit].cost);
      ps.queue.splice(action.index, 1);
      ctx.invalidate();
      return { ok: true };
    }
    case 'setRepeat': {
      ps.repeat = action.repeat;
      return { ok: true };
    }
  }
}

function applyArmyAction(ctx: ActionContext, nation: string, action: ArmyAction): ActionResult {
  const { state, map } = ctx;
  const a = state.armies.find((x) => x.id === action.army);
  if (!a || a.owner !== nation) return { ok: false, error: 'Armee gehört nicht dir' };
  switch (action.type) {
    case 'move': {
      if (inMelee(state, a)) return { ok: false, error: 'Im Nahkampf gebunden – erst nach Kampfende beweglich' };
      const from = nearestNode(map, a, state.time);
      const plan = planMove(state, map, a, from, action.to);
      if (!plan) return { ok: false, error: 'Kein Weg dorthin' };
      a.node = from;
      a.target = null;
      a.autoTarget = false;
      startMove(ctx, a, plan.path, plan.then);
      ctx.invalidate();
      return { ok: true };
    }
    case 'stop': {
      if (a.move) {
        a.node = nearestNode(map, a, state.time);
        a.move = null;
      }
      a.target = null;
      ctx.invalidate();
      return { ok: true };
    }
    case 'attack': {
      if (action.target === null) {
        a.target = null;
        return { ok: true };
      }
      const t = state.armies.find((x) => x.id === action.target);
      if (!t) return { ok: false, error: 'Ziel nicht gefunden' };
      if (!atWar(state, nation, t.owner)) return { ok: false, error: 'Kein Krieg mit diesem Ziel' };
      if (!unitTypes(a).some((u) => UNITS[u].range > 0)) return { ok: false, error: 'Keine Fernkampfeinheiten' };
      a.target = t.id;
      a.autoTarget = false;
      ctx.invalidate();
      return { ok: true };
    }
    case 'split': {
      if (a.move) return { ok: false, error: 'Nur im Stand möglich' };
      const units: Partial<Record<UnitType, number>> = {};
      let n = 0;
      for (const u of Object.keys(action.units) as UnitType[]) {
        const k = Math.floor(action.units[u] ?? 0);
        if (k <= 0) continue;
        if (k > (a.units[u] ?? 0)) return { ok: false, error: 'So viele Einheiten hat die Armee nicht' };
        units[u] = k;
        n += k;
      }
      if (n === 0 || n >= unitCount(a)) return { ok: false, error: 'Ungültige Aufteilung' };
      for (const u of Object.keys(units) as UnitType[]) {
        a.units[u] = a.units[u]! - units[u]!;
        if (!a.units[u]) delete a.units[u];
      }
      state.armies.push({ id: ctx.newArmyId(), owner: nation, node: a.node, units });
      ctx.invalidate();
      return { ok: true };
    }
    case 'merge': {
      const into = state.armies.find((x) => x.id === action.into);
      if (!into || into.owner !== nation || into === a) return { ok: false, error: 'Zielarmee nicht gefunden' };
      if (a.move || into.move || a.node !== into.node) return { ok: false, error: 'Beide Armeen müssen am selben Ort stehen' };
      // Truppen gehen nur auf See an Bord einer Flotte
      if (isNaval(a) !== isNaval(into) && !isSea(map, a.node)) return { ok: false, error: 'Truppen steigen nur auf See zu einer Flotte' };
      mergeArmies(state, into, a);
      ctx.invalidate();
      return { ok: true };
    }
  }
}

function applyDiplomacy(ctx: ActionContext, nation: string, action: DiplomacyAction): ActionResult {
  const { state, map } = ctx;
  const other = state.nations[action.nation];
  if (!other || action.nation === nation) return { ok: false, error: 'Unbekannte Nation' };
  if (!other.alive) return { ok: false, error: 'Diese Nation existiert nicht mehr' };
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  const current = relation(state, nation, action.nation);
  switch (action.type) {
    case 'declareWar': {
      if (current === 'war') return { ok: false, error: 'Bereits im Krieg' };
      setRelation(state, nation, action.nation, 'war');
      ctx.log(`${name(nation)} erklärt ${name(action.nation)} den Krieg!`);
      ctx.invalidate();
      return { ok: true };
    }
    case 'downgrade': {
      // einseitig: Embargo verhängen, Durchmarschrecht entziehen, Karte nicht mehr teilen
      if (action.to === 'war') return { ok: false, error: 'Krieg bitte ausdrücklich erklären' };
      if (relationRank(action.to) >= relationRank(current)) return { ok: false, error: 'Nur eine schlechtere Beziehung lässt sich einseitig setzen' };
      setRelation(state, nation, action.nation, action.to);
      ctx.log(action.to === 'embargo'
        ? `${name(nation)} verhängt ein Handelsembargo gegen ${name(action.nation)}.`
        : `${name(nation)} stuft die Beziehung zu ${name(action.nation)} auf ${RELATION_NAMES[action.to]} herab.`);
      ctx.invalidate();
      return { ok: true };
    }
    case 'propose': {
      if (relationRank(action.kind) <= relationRank(current)) return { ok: false, error: 'Diese Beziehung besteht bereits' };
      if (action.kind !== 'peace' && relationRank(current) < relationRank('peace')) return { ok: false, error: 'Zuerst Frieden schließen' };
      if (state.proposals.some((p) => p.from === nation && p.to === action.nation)) return { ok: false, error: 'Angebot liegt bereits vor' };
      state.proposals.push({ from: nation, to: action.nation, kind: action.kind, time: state.time });
      ctx.log(`${name(nation)} bietet ${RELATION_NAMES[action.kind]} an.`, action.nation);
      ctx.log(`Angebot (${RELATION_NAMES[action.kind]}) an ${name(action.nation)} gesendet.`, nation);
      return { ok: true };
    }
    case 'answer': {
      const p = state.proposals.find((x) => x.from === action.nation && x.to === nation);
      if (!p) return { ok: false, error: 'Kein Angebot' };
      state.proposals = state.proposals.filter((x) => x !== p);
      if (!action.accept) {
        ctx.log(`${name(nation)} lehnt ${RELATION_NAMES[p.kind]} ab.`, action.nation);
        return { ok: true };
      }
      setRelation(state, nation, action.nation, p.kind);
      if (current === 'war') {
        // Märsche in das Gebiet des bisherigen Feindes enden
        for (const a of state.armies) {
          if (a.owner !== nation && a.owner !== action.nation) continue;
          if (a.move && a.move.path.some((n) => !isSea(map, n) && state.provinces[n].owner !== a.owner)) a.move = null;
        }
        ctx.log(`Frieden zwischen ${name(nation)} und ${name(action.nation)}.`);
      } else {
        ctx.log(`${name(nation)} und ${name(action.nation)} vereinbaren: ${RELATION_NAMES[p.kind]}.`);
      }
      ctx.invalidate();
      return { ok: true };
    }
  }
}
