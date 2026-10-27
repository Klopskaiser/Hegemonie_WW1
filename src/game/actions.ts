// Befehle. Mensch, KI und externe Entscheidungsmodelle verändern das Spiel
// ausschließlich über diese Aktionen.

import {
CAPITAL_MOVE, DAY, buildingLives,   ALL_RES, BUILD_QUEUE_LIMIT, BUILD_REFUND, BUILDINGS, CATEGORY_RES, FACTORY_SPEEDUP, HOUR, OFFICE_SPEEDUP, QUEUE_LIMIT, RES_NAMES, UNITS, WORKSHOP_SPEEDUP,
  type Building, type Category, type Cost, type Res, type UnitType,
} from './balance.ts';
import { validShares, activeCapital, activeLevel } from './economy.ts';
import { atWar, hasRightOfWay, relation, relationRank, RELATION_NAMES, setRelation, noteWarDeclaration } from './diplomacy.ts';
import { isSea, nodeNeighbors } from './graph.ts';
import type { MapData, Resource } from './mapdata.ts';
import { acceptOffer, cancelOffer, postOffer } from './market.ts';
import {
  armyPower, boardingWait, halt, inMelee, isNaval, mergeArmies, nearestNode, planRoute, rejoinSplits, samePlace, startMove, unitCount, unitTypes,
  type MilitaryContext, type MoveTarget,
} from './military.ts';
import type { Army, GameState, ProvinceState, Relation, Stock } from './types.ts';

export type ProvinceAction =
  | { type: 'build'; province: number; building: Building }
  /** laufenden Bau abbrechen (volle Erstattung); der nächste geplante startet */
  | { type: 'cancelBuild'; province: number }
  /** geplantes Gebäude aus der Bauschleife nehmen (noch nicht bezahlt) */
  | { type: 'dequeueBuild'; province: number; index: number }
  | { type: 'enqueue'; province: number; unit: UnitType }
  | { type: 'dequeue'; province: number; index: number }
  | { type: 'setRepeat'; province: number; repeat: boolean }
  /** Kaserne, Wehramt oder Eisenbahn ab- bzw. wieder einschalten (kein Unterhalt, keine Wirkung) */
  | { type: 'switchBuilding'; province: number; building: Building; on: boolean }
  /** beschädigtes Gebäude reparieren (Kosten: Anteil der fehlenden Leben an den Kosten der obersten Stufe) */
  | { type: 'repair'; province: number; building: Building }
  /** Hauptstadt in diese Provinz verlegen (CAPITAL_MOVE: Kosten, 48 h; je Nation eine Verlegung gleichzeitig) */
  | { type: 'moveCapital'; province: number };

export type ArmyAction =
  /**
   * Marsch zu einem Knoten (Provinz oder Seegebiet P + Index). Mit `toward` und `frac` ist das Ziel
   * ein Punkt auf dem Weg von `to` nach `toward` (Anteil 0..1 ab `to`); dort bleibt die Armee stehen.
   */
  | {
    type: 'move'; army: number; to: number; toward?: number; frac?: number;
    /** Ziel im Gebiet einer Nation, mit der Frieden herrscht: beim Betreten wird ihr der Krieg erklärt */
    declareWar?: boolean;
  }
  | { type: 'stop'; army: number }
  /** Fernkampfziel setzen (null = aufheben) */
  | { type: 'attack'; army: number; target: number | null }
  /**
   * Einheiten in eine neue Armee am selben Ort abspalten. Bleibt sie ohne Befehl am selben Ort,
   * wird sie wieder eingegliedert – außer mit `rejoin: false` (z. B. Schiffe abtrennen).
   */
  | { type: 'split'; army: number; units: Partial<Record<UnitType, number>>; rejoin?: boolean }
  | { type: 'merge'; army: number; into: number }
  /** abgetrennte Armee ohne Befehl sofort wieder eingliedern (sofern noch am selben Ort) */
  | { type: 'rejoin'; army: number }
  /** eigenen Namen setzen (leer = wieder automatisch benennen) */
  | { type: 'rename'; army: number; name: string };

export type DiplomacyAction =
  | { type: 'declareWar'; nation: string }
  /** einseitig verschlechtern (Embargo, Durchmarsch entziehen, Karte nicht mehr teilen) */
  | { type: 'downgrade'; nation: string; to: Relation }
  /** bessere Beziehung anbieten (Frieden, Durchmarschrecht, geteilte Karte), optional mit Tribut (bei Annahme gezahlt) */
  | { type: 'propose'; nation: string; kind: Relation; tribute?: Partial<Record<Res, number>> }
  | { type: 'answer'; nation: string; accept: boolean };

export type MarketAction =
  | { type: 'postOffer'; side: 'sell' | 'buy'; res: Resource; amount: number; price: number }
  | { type: 'cancelOffer'; id: number }
  | { type: 'acceptOffer'; id: number; amount: number };

export type CapitalAction =
  /** laufende Verlegung der Hauptstadt abbrechen (volle Erstattung) */
  | { type: 'cancelCapitalMove' };

export type EconomyAction =
  /** Verbrauchsregler einer Kategorie: ganze Prozent je Rohstoff, Summe 100 */
  | { type: 'setConsumption'; category: Category; shares: Partial<Record<Resource, number>> };

export type Action = ProvinceAction | ArmyAction | DiplomacyAction | MarketAction | EconomyAction | CapitalAction;

/** Ergebnis einer Aktion; beim Teilen mit der ID der neuen Armee */
export type ActionResult = { ok: true; army?: number } | { ok: false; error: string };

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
  return building !== 'office' && activeLevel(ps, 'office') > 0 ? h * (1 - OFFICE_SPEEDUP) : h;
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
  const day = Math.floor(state.time / DAY) + 1;
  if (def.fromDay && day < def.fromDay) return res(`Erst ab Tag ${def.fromDay} baubar`);
  if (ps.damage?.[building]) return res('Beschädigt – erst reparieren');
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

/** Reparatur eines beschädigten Gebäudes: Kosten anteilig zu den fehlenden Leben der obersten Stufe */
export function checkRepair(state: GameState, nation: string, province: number, building: Building): { ok: boolean; error?: string; cost: Cost } {
  const ps = state.provinces[province];
  const lost = ps?.damage?.[building] ?? 0;
  const full = BUILDINGS[building].cost(Math.max(1, ps?.buildings[building] ?? 1));
  const share = lost / buildingLives(building);
  const cost: Cost = {};
  for (const r of Object.keys(full) as Res[]) cost[r] = Math.ceil((full[r] ?? 0) * share);
  if (!ps || ps.owner !== nation) return { ok: false, error: 'Provinz gehört nicht dir', cost };
  if (!lost) return { ok: false, error: 'Nicht beschädigt', cost };
  if (state.armies.some((a) => a.node === province && !a.pos && !a.move && atWar(state, nation, a.owner) && unitCount(a) > 0)) {
    return { ok: false, error: 'Feinde in der Stadt – erst nach dem Kampf', cost };
  }
  if (!canAfford(state.nations[nation].stock, cost)) return { ok: false, error: `Zu wenig ${missing(state.nations[nation].stock, cost)}`, cost };
  return { ok: true, cost };
}

/** Kann die Hauptstadt in diese Provinz verlegt werden? */
export function checkCapitalMove(state: GameState, map: MapData, nation: string, province: number): { ok: boolean; error?: string } {
  const ps = state.provinces[province];
  const n = state.nations[nation];
  if (!ps || !n || ps.owner !== nation) return { ok: false, error: 'Provinz gehört nicht dir' };
  if (activeCapital(state, map, nation) === province) return { ok: false, error: 'Hier ist schon die Hauptstadt' };
  if (n.capitalMove) return { ok: false, error: 'Es wird schon eine Hauptstadt verlegt' };
  if (ps.revolt) return { ok: false, error: 'Aufständische halten die Provinz' };
  if (!canAfford(n.stock, CAPITAL_MOVE.cost)) return { ok: false, error: `Zu wenig ${missing(n.stock, CAPITAL_MOVE.cost)}` };
  return { ok: true };
}

export interface ProduceCheck {
  ok: boolean;
  error?: string;
  hours: number;
}

/** Bauzeit: Startwert auf der Mindest-Fabrikstufe, je weitere Stufe −25 % des Startwerts */
export function unitHours(state: GameState, province: number, unit: UnitType): number {
  const min = UNITS[unit].requires.factory ?? 1;
  const ps = state.provinces[province];
  const level = ps ? activeLevel(ps, 'factory') : min;
  const extra = Math.max(0, level - min);
  // Werkstatt: Bautempo +10 % (gilt für alle gefertigten, also mechanischen Einheiten)
  const workshop = ps && activeLevel(ps, 'workshop') > 0 ? 1 + WORKSHOP_SPEEDUP : 1;
  return (UNITS[unit].hours * Math.max(FACTORY_SPEEDUP, 1 - FACTORY_SPEEDUP * extra)) / workshop;
}

export function requirementsMet(state: GameState, map: MapData, province: number, unit: UnitType): string | null {
  const ps = state.provinces[province];
  const req = UNITS[unit].requires;
  for (const b of Object.keys(req) as Building[]) {
    if (ps.buildings[b] >= req[b]! && activeLevel(ps, b) < req[b]!) return `${BUILDINGS[b].name} ${ps.damage?.[b] ? 'beschädigt – erst reparieren' : 'abgeschaltet'}`;
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
  if (action.type === 'cancelCapitalMove') {
    const n = ctx.state.nations[nation];
    if (!n?.capitalMove) return { ok: false, error: 'Keine Verlegung der Hauptstadt im Gange' };
    refund(n.stock, CAPITAL_MOVE.cost);
    n.capitalMove = null;
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
    case 'moveCapital': {
      const chk = checkCapitalMove(state, map, nation, action.province);
      if (!chk.ok) return { ok: false, error: chk.error! };
      pay(stock, CAPITAL_MOVE.cost);
      state.nations[nation].capitalMove = { province: action.province, start: state.time, end: state.time + Math.round(CAPITAL_MOVE.hours * HOUR) };
      return { ok: true };
    }
    case 'repair': {
      const chk = checkRepair(state, nation, action.province, action.building);
      if (!chk.ok) return { ok: false, error: chk.error! };
      pay(stock, chk.cost);
      delete ps.damage![action.building];
      if (!Object.keys(ps.damage!).length) delete ps.damage;
      ctx.invalidate();
      return { ok: true };
    }
    case 'switchBuilding': {
      const def = BUILDINGS[action.building];
      if (!def?.switchable) return { ok: false, error: 'Dieses Gebäude lässt sich nicht abschalten' };
      if (ps.buildings[action.building] <= 0) return { ok: false, error: `Kein(e) ${def.name} vorhanden` };
      if (action.on) {
        if (ps.off) delete ps.off[action.building];
        if (ps.off && !Object.keys(ps.off).length) delete ps.off;
      } else (ps.off ??= {})[action.building] = true;
      ctx.invalidate();
      return { ok: true };
    }
  }
}

/** Besitzer des Zielortes (Provinz bzw. die Provinzen an beiden Enden eines Weges) */
/**
 * Nationen im Frieden (ohne Durchmarschrecht), denen bei diesem Marsch der Krieg erklärt werden müsste:
 * nur wenn das Ziel ihre Stadt ist oder der Weg zwingend durch eine ihrer Städte führt. Wege, Wegpunkte
 * und der Abzug aus ihrem Gebiet sind frei (Begegnungen mit ihren Armeen lösen weiterhin Kampf aus).
 */
export function requiredWars(state: GameState, map: MapData, a: Army, target: MoveTarget): string[] {
  const free = planRoute(state, map, { ...a, warOn: null }, state.time, target);
  if (free) return [];
  const peaceful = Object.keys(state.nations).filter((o) => o !== a.owner && state.nations[o].alive
    && !atWar(state, a.owner, o) && !hasRightOfWay(state, a.owner, o));
  const plan = planRoute(state, map, { ...a, warOn: peaceful }, state.time, target);
  if (!plan) return [];
  const nodes = [...plan.path.slice(1), ...(plan.then ?? [])].filter((n) => !isSea(map, n));
  return [...new Set(nodes.map((n) => state.provinces[n].owner))].filter((o) => peaceful.includes(o));
}

/** Tribut als Text, z. B. „20.000 Geld, 5.000 Kohle“ */
export function tributeText(t: Partial<Record<Res, number>>): string {
  return (Object.keys(t) as Res[]).filter((r) => (t[r] ?? 0) > 0)
    .map((r) => `${Math.round(t[r]!).toLocaleString('de-DE')} ${RES_NAMES[r]}`).join(', ');
}

export function targetOwners(map: MapData, state: GameState, t: MoveTarget): string[] {
  const nodes = 'node' in t ? [t.node] : [t.road.a, t.road.b];
  return [...new Set(nodes.filter((n) => !isSea(map, n)).map((n) => state.provinces[n].owner))];
}

function without(units: Army['units'], u: UnitType): Army['units'] {
  const out = { ...units };
  out[u] = (out[u] ?? 0) - 1;
  if (!out[u]) delete out[u];
  return out;
}

/**
 * Besatzungsregel: Steht eine Armee in einer eigenen Stadt (am Provinzknoten) und ist sie die
 * letzte dort, bleibt beim Abmarsch eine Einheit zurück – bevorzugt Infanterie, sonst die
 * schwächste. Besteht sie nur aus einer Einheit, darf sie nicht abziehen ('last').
 */
export function garrisonKeep(state: GameState, map: MapData, a: Army): UnitType | 'last' | null {
  if (a.move || a.pos || isNaval(a) || isSea(map, a.node)) return null;
  if (state.provinces[a.node].owner !== a.owner) return null;
  const others = state.armies.some((b) => b !== a && b.owner === a.owner && b.node === a.node && !b.move && !b.pos
    && !isNaval(b) && unitCount(b) > 0);
  if (others) return null;
  if (unitCount(a) <= 1) return 'last';
  if ((a.units.infantry ?? 0) > 0) return 'infantry';
  return unitTypes(a).sort((x, y) => armyPower({ ...a, units: { [x]: 1 } }) - armyPower({ ...a, units: { [y]: 1 } }))[0];
}

function applyArmyAction(ctx: ActionContext, nation: string, action: ArmyAction): ActionResult {
  const { state, map } = ctx;
  const a = state.armies.find((x) => x.id === action.army);
  if (!a || a.owner !== nation) return { ok: false, error: 'Armee gehört nicht dir' };
  switch (action.type) {
    case 'move': {
      if (inMelee(state, a)) return { ok: false, error: 'Im Nahkampf gebunden – erst nach Kampfende beweglich' };
      const N = map.provinces.length + map.seas.length;
      if (!Number.isInteger(action.to) || action.to < 0 || action.to >= N) return { ok: false, error: 'Unbekanntes Ziel' };
      let target: MoveTarget = { node: action.to };
      if (action.toward !== undefined) {
        const f = Number(action.frac);
        if (!nodeNeighbors(map, action.to).includes(action.toward) || !(f >= 0 && f <= 1)) return { ok: false, error: 'Ungültiger Wegpunkt' };
        target = { road: { a: action.to, b: action.toward, f } };
      }
      // Kriegserklärung beim Eintreffen: an die Besitzer des Ziels, mit denen kein Krieg und kein Durchmarsch besteht
      const warOn = action.declareWar ? requiredWars(state, map, a, target) : [];
      // Besatzung: verlässt die letzte Armee eine eigene Stadt, bleibt eine Einheit zurück
      const keep = garrisonKeep(state, map, a);
      if (keep === 'last') return { ok: false, error: 'Die letzte Einheit bleibt als Besatzung in der Stadt' };
      const mover = { ...a, units: keep ? without(a.units, keep) : a.units, warOn };
      const plan = planRoute(state, map, mover, state.time, target);
      if (!plan) return { ok: false, error: 'Kein Weg dorthin' };
      // mitten im Ein-/Ausschiffen: weiter in dieselbe Richtung nur noch die Restzeit,
      // zurück (Umkehr) so lange, wie schon vergangen ist
      let wait: number | undefined;
      const bw = boardingWait(map, a, state.time);
      if (bw && a.move && plan.path.length >= 2) {
        const u = a.move.path[a.move.seg], v = a.move.path[a.move.seg + 1];
        if (plan.path[0] === u && plan.path[1] === v) wait = bw.remaining;
        else if (plan.path[0] === v && plan.path[1] === u) wait = bw.elapsed;
      }
      if (keep) {
        a.units = without(a.units, keep);
        state.armies.push({ id: ctx.newArmyId(), owner: nation, node: a.node, units: { [keep]: 1 }, morale: a.morale });
      }
      a.node = nearestNode(map, a, state.time);
      a.resume = null;
      a.target = null;
      a.autoTarget = false;
      a.split = null;
      a.warOn = warOn.length ? warOn : null;
      startMove(ctx, a, plan.path, plan.then, { ...plan, wait });
      ctx.invalidate();
      return { ok: true };
    }
    case 'stop': {
      halt(map, a, state.time);
      a.target = null;
      a.resume = null;
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
      a.split = null;
      ctx.invalidate();
      return { ok: true };
    }
    case 'split': {
      if (a.move) return { ok: false, error: 'Nur im Stand möglich' };
      if (inMelee(state, a)) return { ok: false, error: 'Im Nahkampf gebunden – Teilen erst nach Kampfende' };
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
      const id = ctx.newArmyId();
      state.armies.push({
        id, owner: nation, node: a.node, pos: a.pos ?? null, units, morale: a.morale,
        split: action.rejoin === false ? null : { from: a.id, at: state.time },
      });
      ctx.invalidate();
      return { ok: true, army: id };
    }
    case 'rejoin': {
      if (!a.split) return { ok: false, error: 'Nicht abgetrennt' };
      rejoinSplits(ctx, true, a.id);
      return { ok: true };
    }
    case 'rename': {
      const name = String(action.name ?? '').trim().slice(0, 40);
      if (name) a.name = name;
      else delete a.name;
      return { ok: true };
    }
    case 'merge': {
      const into = state.armies.find((x) => x.id === action.into);
      if (!into || into.owner !== nation || into === a) return { ok: false, error: 'Zielarmee nicht gefunden' };
      if (a.move || into.move || !samePlace(a, into)) return { ok: false, error: 'Beide Armeen müssen am selben Ort stehen' };
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
      noteWarDeclaration(state, nation);
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
      // Tribut: ganze, nicht negative Mengen bekannter Rohstoffe; muss jetzt bezahlbar sein (gezahlt wird bei Annahme)
      const tribute: Partial<Record<Res, number>> = {};
      for (const [r, v] of Object.entries(action.tribute ?? {})) {
        const n = Math.floor(Number(v));
        if (!(ALL_RES as string[]).includes(r) || !(n >= 0)) return { ok: false, error: 'Ungültiger Tribut' };
        if (n > 0) tribute[r as Res] = n;
      }
      const hasTribute = Object.keys(tribute).length > 0;
      if (hasTribute && !canAfford(state.nations[nation].stock, tribute)) return { ok: false, error: `Tribut nicht bezahlbar: zu wenig ${missing(state.nations[nation].stock, tribute)}` };
      state.proposals.push({ from: nation, to: action.nation, kind: action.kind, time: state.time, ...(hasTribute ? { tribute } : {}) });
      const extra = hasTribute ? ` (Tribut: ${tributeText(tribute)})` : '';
      ctx.log(`${name(nation)} bietet ${RELATION_NAMES[action.kind]} an${extra}.`, action.nation);
      ctx.log(`Angebot (${RELATION_NAMES[action.kind]}) an ${name(action.nation)} gesendet${extra}.`, nation);
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
      if (p.tribute) {
        const payer = state.nations[action.nation].stock;
        if (!canAfford(payer, p.tribute)) {
          ctx.log(`${name(action.nation)} kann den angebotenen Tribut nicht mehr zahlen – das Angebot ist hinfällig.`, nation);
          ctx.log(`Unser Angebot an ${name(nation)} ist hinfällig: Tribut nicht mehr bezahlbar.`, action.nation);
          return { ok: false, error: 'Der Anbieter kann den Tribut nicht mehr zahlen' };
        }
        pay(payer, p.tribute);
        const stock = state.nations[nation].stock;
        for (const r of Object.keys(p.tribute) as Res[]) stock[r] += p.tribute[r]!;
      }
      setRelation(state, nation, action.nation, p.kind);
      if (p.tribute) ctx.log(`${name(action.nation)} zahlt ${name(nation)} Tribut: ${tributeText(p.tribute)}.`);
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
