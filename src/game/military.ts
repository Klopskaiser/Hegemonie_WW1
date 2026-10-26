// Militär: Wegfindung, Marsch, Nah- und Fernkampf, Eroberung, Aufständische.

import {
  BUILDING_DAMAGE_CHANCE, BUILDINGS, DEFECTION, FORTRESS_REDUCTION, HOUR, MILITARY, MINUTE, MORALE, SPLIT_REJOIN, TROOP_MORALE, UNITS,
  type Building, type UnitType,
} from './balance.ts';
import { atWar, hasRightOfWay, setRelation } from './diplomacy.ts';
import { edgeParts, edgePoint, edgeSlice, edgeThrough, isSea, nodeCount, nodeName, nodeNeighbors, nodePos } from './graph.ts';
import type { MapData } from './mapdata.ts';
import { armyName } from './names.ts';
import { REBELS, type Army, type GameState, type NewsInfo, type RoadPos } from './types.ts';

export interface MilitaryContext {
  state: GameState;
  map: MapData;
  log(text: string, nation?: string, province?: number, news?: NewsInfo): void;
  invalidate(): void;
  random(): number;
  newArmyId(): number;
}

// ---------------------------------------------------------------- Eigenschaften

export function unitTypes(a: Army): UnitType[] {
  return (Object.keys(a.units) as UnitType[]).filter((u) => (a.units[u] ?? 0) > 0);
}

export function unitCount(a: Army): number {
  return unitTypes(a).reduce((s, u) => s + a.units[u]!, 0);
}

export function isNaval(a: Army): boolean {
  return unitTypes(a).some((u) => UNITS[u].naval);
}

export function isRailOnly(a: Army): boolean {
  return unitTypes(a).some((u) => UNITS[u].railOnly);
}

/** nur Fernkampfeinheiten (Artillerie, Eisenbahngeschütze, Schlachtschiffe) */
export function isRangedOnly(a: Army): boolean {
  const t = unitTypes(a);
  return t.length > 0 && t.every((u) => UNITS[u].range > 0);
}

export function armySpeed(a: Army): number {
  return Math.min(...unitTypes(a).map((u) => UNITS[u].speed));
}

export function maxRange(a: Army): number {
  return Math.max(0, ...unitTypes(a).map((u) => UNITS[u].range));
}

/** Grobe Kampfkraft (für KI und Anzeige) */
export function armyPower(a: Army): number {
  return unitTypes(a).reduce((s, u) => s + a.units[u]! * ((UNITS[u].attack + UNITS[u].defense) / 2) * (UNITS[u].hp / 20), 0);
}

export function isMoving(a: Army): boolean {
  return !!a.move;
}

// ---------------------------------------------------------------- Bewegung

/** Darf die Armee den Weg u→v nehmen? Bei Abkürzungen auch durch das Gebiet dazwischen. */
export function canTraverse(state: GameState, map: MapData, a: Army, u: number, v: number): boolean {
  if (!canEnter(state, map, a, v)) return false;
  const t = edgeThrough(map, u, v);
  return !t || canEnter(state, map, a, t.via);
}

export function canEnter(state: GameState, map: MapData, a: Army, node: number): boolean {
  if (isSea(map, node)) return !isRailOnly(a);
  // Schiffe (auch mit Truppen an Bord) gehen nie an Land
  if (isNaval(a)) return false;
  const owner = state.provinces[node].owner;
  if (isRailOnly(a)) return owner === a.owner && state.provinces[node].buildings.railroad > 0;
  return owner === a.owner || atWar(state, a.owner, owner) || hasRightOfWay(state, a.owner, owner) || !!a.warOn?.includes(owner);
}

function landSpeed(state: GameState, a: Army, province: number): number {
  const ps = state.provinces[province];
  const base = armySpeed(a);
  if (isRailOnly(a)) return base;
  const own = ps.owner === a.owner;
  const terr = own ? MILITARY.territory.own : atWar(state, a.owner, ps.owner) ? MILITARY.territory.enemy : MILITARY.territory.foreign;
  return base * terr * (own && ps.buildings.railroad > 0 ? MILITARY.railFactor : 1);
}

/** Dauer eines Abschnitts in Stunden. */
/** Befreundeter Hafen: eigener oder einer Nation mit Durchmarschrecht/geteilter Karte */
export function friendlyHarbor(state: GameState, province: number, nation: string): boolean {
  const ps = state.provinces[province];
  return ps.buildings.harbor > 0 && hasRightOfWay(state, nation, ps.owner);
}

/** Dauer des Ein- bzw. Ausschiffens in einer Küstenprovinz (Stunden). */
export function embarkHours(state: GameState, province: number, nation: string): number {
  return MILITARY.embarkHours * (friendlyHarbor(state, province, nation) ? MILITARY.harborEmbarkFactor : 1);
}

/** Dauer eines Abschnitts in Stunden. */
export function segmentHours(state: GameState, map: MapData, a: Army, u: number, v: number): number {
  const d = edgeParts(map, u, v)[1];
  const su = isSea(map, u), sv = isSea(map, v);
  if (isNaval(a)) {
    // Flotte; mit Truppen an Bord höchstens Transporttempo
    const ships = Math.min(...unitTypes(a).filter((t) => UNITS[t].naval).map((t) => UNITS[t].speed));
    const carrying = unitTypes(a).some((t) => !UNITS[t].naval);
    return d / (carrying ? Math.min(ships, MILITARY.transportSpeed) : ships);
  }
  if (su && sv) return d / MILITARY.transportSpeed;
  // Abkürzung über eine Kreuzung im Gebiet einer dritten Provinz: drei Abschnitte mit eigenem Tempo
  const through = !su && !sv ? edgeThrough(map, u, v) : null;
  if (through && !isSea(map, through.via)) {
    return (d * through.f0) / landSpeed(state, a, u) + (d * (through.f1 - through.f0)) / landSpeed(state, a, through.via)
      + (d * (1 - through.f1)) / landSpeed(state, a, v);
  }
  if (sv) return d / MILITARY.transportSpeed + embarkHours(state, u, a.owner); // einschiffen
  if (su) return d / MILITARY.transportSpeed + embarkHours(state, v, a.owner); // anlanden
  // Landweg: bis zur Grenze im Tempo von u, danach im Tempo von v
  const [l1] = edgeParts(map, u, v);
  return l1 / landSpeed(state, a, u) + (d - l1) / landSpeed(state, a, v);
}

export interface PathTree {
  hours: Float64Array;
  prev: Int32Array;
}

/** Reisezeiten von `from` zu allen erreichbaren Knoten (Dijkstra). */
export function pathsFrom(state: GameState, map: MapData, a: Army, from: number, stopAt?: number): PathTree {
  const n = nodeCount(map);
  const hours = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  hours[from] = 0;
  // binärer Heap aus [Stunden, Knoten]
  const heap: [number, number][] = [[0, from]];
  const push = (e: [number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [best, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === stopAt) break;
    for (const v of nodeNeighbors(map, u)) {
      if (done[v] || !canTraverse(state, map, a, u, v)) continue;
      const c = best + segmentHours(state, map, a, u, v);
      if (c < hours[v]) { hours[v] = c; prev[v] = u; push([c, v]); }
    }
  }
  return { hours, prev };
}

export function pathTo(tree: PathTree, to: number): number[] | null {
  if (!isFinite(tree.hours[to])) return null;
  const path: number[] = [];
  for (let v = to; v !== -1; v = tree.prev[v]) path.unshift(v);
  return path;
}

/** Schnellster Weg (nach Reisezeit). */
export function findPath(state: GameState, map: MapData, a: Army, from: number, to: number): { path: number[]; hours: number } | null {
  if (from === to) return { path: [from], hours: 0 };
  if (!canEnter(state, map, a, to)) return null;
  const tree = pathsFrom(state, map, a, from, to);
  const path = pathTo(tree, to);
  return path ? { path, hours: tree.hours[to] } : null;
}

function minuteRound(ms: number): number {
  return Math.max(MINUTE, Math.round(ms / MINUTE) * MINUTE);
}

/** Landtruppen einer Armee (für Landungen), null wenn keine an Bord */
function landPart(a: Army): Army | null {
  const units: Partial<Record<UnitType, number>> = {};
  for (const u of unitTypes(a)) if (!UNITS[u].naval) units[u] = a.units[u];
  return Object.keys(units).length ? { ...a, units, move: null } : null;
}

export interface MovePlan {
  path: number[];
  /** Landung: Weg der Truppen nach dem Aussteigen */
  then?: number[];
  hours: number;
  /** Start bzw. Ziel auf einem Weg (Anteil des ersten bzw. letzten Abschnitts) */
  startFrac?: number;
  endFrac?: number;
}

/** Ziel eines Marsches: Knoten oder Punkt auf einem Weg */
export type MoveTarget = { node: number } | { road: RoadPos };

/** Anteil des laufenden Abschnitts, an dem die Armee gerade ist (0..1 von path[seg] nach path[seg + 1]) */
function moveFrac(a: Army, time: number): number {
  const m = a.move!;
  const p = Math.max(0, Math.min(1, (time - m.segStart) / Math.max(1, m.segEnd - m.segStart)));
  const s = m.seg === 0 ? m.startFrac ?? 0 : 0;
  const e = m.seg === m.path.length - 2 ? m.endFrac ?? 1 : 1;
  return s + (e - s) * p;
}

const ROAD_EPS = 0.02;

/** Standort einer Armee: Knoten oder Punkt auf einem Weg (auch während des Marsches) */
export function armyLocation(a: Army, time: number): MoveTarget {
  if (a.move) {
    const f = moveFrac(a, time);
    const u = a.move.path[a.move.seg], v = a.move.path[a.move.seg + 1];
    if (f <= ROAD_EPS) return { node: u };
    if (f >= 1 - ROAD_EPS) return { node: v };
    return { road: { a: u, b: v, f } };
  }
  return a.pos ? { road: a.pos } : { node: a.node };
}

/** Ein Wegpunkt nahe an einem Ende gilt als dieser Knoten */
export function normalizeTarget(t: MoveTarget): MoveTarget {
  if ('road' in t) {
    if (t.road.f <= ROAD_EPS) return { node: t.road.a };
    if (t.road.f >= 1 - ROAD_EPS) return { node: t.road.b };
  }
  return t;
}

interface Leg { node: number; path: number[]; frac: number; hours: number }

/**
 * Marschplan vom aktuellen Standort (Knoten oder Weg) zu einem Knoten oder Wegpunkt.
 * Auf einem Weg kann in beide Richtungen losmarschiert werden; ein Wegziel wird von dem
 * Ende her angesteuert, das schneller erreichbar ist.
 */
export function planRoute(state: GameState, map: MapData, a: Army, time: number, target: MoveTarget): MovePlan | null {
  const from = armyLocation(a, time);
  const to = normalizeTarget(target);
  const seg = (u: number, v: number) => segmentHours(state, map, a, u, v);
  // Flotte mit Truppen an Land schicken: Landung wie bisher (vom nächsten Knoten aus)
  if ('node' in to && isNaval(a) && !isSea(map, to.node)) {
    const start = 'node' in from ? from.node : from.road.f < 0.5 ? from.road.a : from.road.b;
    return planMove(state, map, a, start, to.node);
  }
  // Start und Ziel auf demselben Weg: direkt dorthin
  if ('road' in from && 'road' in to) {
    const r = from.road, t = to.road;
    const same = r.a === t.a && r.b === t.b ? t.f : r.a === t.b && r.b === t.a ? 1 - t.f : null;
    if (same !== null) {
      if (Math.abs(same - r.f) < 1e-6) return null;
      if (same > r.f) return { path: [r.a, r.b], startFrac: r.f, endFrac: same, hours: seg(r.a, r.b) * (same - r.f) };
      return { path: [r.b, r.a], startFrac: 1 - r.f, endFrac: 1 - same, hours: seg(r.b, r.a) * (r.f - same) };
    }
  }
  const starts: Leg[] = 'node' in from
    ? [{ node: from.node, path: [from.node], frac: 0, hours: 0 }]
    : [
      { node: from.road.b, path: [from.road.a, from.road.b], frac: from.road.f, hours: seg(from.road.a, from.road.b) * (1 - from.road.f) },
      { node: from.road.a, path: [from.road.b, from.road.a], frac: 1 - from.road.f, hours: seg(from.road.b, from.road.a) * from.road.f },
    ].filter((l) => canEnter(state, map, a, l.node));
  const ends: Leg[] = 'node' in to
    ? [{ node: to.node, path: [to.node], frac: 1, hours: 0 }]
    : [
      { node: to.road.a, path: [to.road.a, to.road.b], frac: to.road.f, hours: seg(to.road.a, to.road.b) * to.road.f },
      { node: to.road.b, path: [to.road.b, to.road.a], frac: 1 - to.road.f, hours: seg(to.road.b, to.road.a) * (1 - to.road.f) },
    ].filter((l) => l.frac < 0.5 || canEnter(state, map, a, l.path[1]));
  let best: MovePlan | null = null;
  for (const s of starts) {
    const tree = pathsFrom(state, map, a, s.node);
    for (const e of ends) {
      if (!canEnter(state, map, a, e.node) && e.node !== s.node) continue;
      const mid = pathTo(tree, e.node);
      if (!mid) continue;
      const hours = s.hours + tree.hours[e.node] + e.hours;
      if (best && hours >= best.hours) continue;
      let path = [...s.path.slice(0, -1), ...mid];
      if (e.path.length > 1) path = [...path, e.path[1]];
      // Hin und gleich wieder zurück auf demselben Weg vermeiden
      if (path.length < 2) continue;
      best = {
        path, hours,
        ...(s.path.length > 1 ? { startFrac: s.frac } : {}),
        ...(e.path.length > 1 ? { endFrac: e.frac } : {}),
      };
    }
  }
  return best;
}

/**
 * Marschplan. Eine Flotte mit Truppen an Bord und einem Ziel an Land fährt bis zum
 * Seegebiet vor der Landungsküste; dort steigen die Truppen aus und marschieren weiter.
 */
export function planMove(state: GameState, map: MapData, a: Army, from: number, to: number): MovePlan | null {
  if (isNaval(a) && !isSea(map, to)) {
    const troops = landPart(a);
    if (!troops) return null;
    const full = findPath(state, map, troops, from, to);
    if (!full) return null;
    let i = -1;
    full.path.forEach((n, k) => isSea(map, n) && (i = k));
    if (i < 0) return null;
    const fleet = findPath(state, map, a, from, full.path[i]);
    if (!fleet) return null;
    const then = full.path.slice(i);
    let hours = fleet.hours;
    for (let k = 0; k + 1 < then.length; k++) hours += segmentHours(state, map, troops, then[k], then[k + 1]);
    return { path: fleet.path, then, hours };
  }
  const r = findPath(state, map, a, from, to);
  return r ? { path: r.path, hours: r.hours } : null;
}

export function startMove(ctx: MilitaryContext, a: Army, path: number[], then?: number[], frac?: { startFrac?: number; endFrac?: number }): void {
  if (path.length < 2) {
    a.move = null;
    if (then) disembark(ctx, a, then);
    return;
  }
  const t = ctx.state.time;
  a.pos = null;
  a.move = { path, seg: 0, segStart: t, segEnd: t, then };
  if (frac?.startFrac !== undefined) a.move.startFrac = frac.startFrac;
  if (frac?.endFrac !== undefined) a.move.endFrac = frac.endFrac;
  a.move.segEnd = t + segmentDuration(ctx.state, ctx.map, a, 0);
}

/** Dauer eines Abschnitts in ms, gekürzt um Start- bzw. Zielanteil */
function segmentDuration(state: GameState, map: MapData, a: Army, k: number): number {
  const m = a.move!;
  const s = k === 0 ? m.startFrac ?? 0 : 0;
  const e = k === m.path.length - 2 ? m.endFrac ?? 1 : 1;
  return minuteRound(segmentHours(state, map, a, m.path[k], m.path[k + 1]) * HOUR * Math.max(0, e - s));
}

/** Truppen verlassen die Flotte und marschieren weiter; die Schiffe bleiben vor der Küste liegen. */
function disembark(ctx: MilitaryContext, fleet: Army, then: number[]): void {
  const troops = landPart(fleet);
  if (!troops) return;
  for (const u of Object.keys(troops.units) as UnitType[]) {
    delete fleet.units[u];
    if (fleet.wounds) delete fleet.wounds[u];
  }
  const army: Army = { id: ctx.newArmyId(), owner: fleet.owner, node: fleet.node, units: troops.units, morale: fleet.morale, warOn: fleet.warOn ?? null };
  ctx.state.armies.push(army);
  startMove(ctx, army, then);
  ctx.log(`Truppen gehen bei ${nodeName(ctx.map, then[then.length - 1])} an Land.`, fleet.owner);
  ctx.invalidate();
}

/** Im Nahkampf gebunden: stehende Armee mit stehenden Feinden am selben Ort. */
export function inMelee(state: GameState, a: Army): boolean {
  if (a.move) return false;
  return state.armies.some((b) => b !== a && b.node === a.node && !b.move && atWar(state, a.owner, b.owner) && unitCount(b) > 0);
}

/** Aktuelle Position (km) – auf dem Weg zwischen zwei Knoten (mit Knick an der Grenze). */
export function armyPosition(map: MapData, a: Army, time: number): [number, number] {
  const m = a.move;
  if (!m) return a.pos ? edgePoint(map, a.pos.a, a.pos.b, a.pos.f) : nodePos(map, a.node);
  return edgePoint(map, m.path[m.seg], m.path[m.seg + 1], moveFrac(a, time));
}

/** Punktfolge eines Weges über mehrere Abschnitte, mit Start-/Zielanteil */
export function routePoints(map: MapData, path: number[], startFrac = 0, endFrac = 1): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const s = k === 0 ? startFrac : 0;
    const e = k === path.length - 2 ? endFrac : 1;
    const part = edgeSlice(map, path[k], path[k + 1], s, e);
    pts.push(...(pts.length ? part.slice(1) : part));
  }
  return pts;
}

/** Restlicher Marschweg ab der aktuellen Position (einschließlich anschließender Landung) */
export function remainingRoute(map: MapData, a: Army, time: number): [number, number][] {
  const m = a.move;
  if (!m) return [armyPosition(map, a, time)];
  const rest = routePoints(map, m.path.slice(m.seg), moveFrac(a, time), m.endFrac ?? 1);
  if (m.then) rest.push(...routePoints(map, m.then).slice(1));
  return rest;
}

/** Knoten, dem eine Armee gerade am nächsten ist (für Befehle während des Marsches). */
export function nearestNode(_map: MapData, a: Army, time: number): number {
  const loc = armyLocation(a, time);
  return 'node' in loc ? loc.node : loc.road.f < 0.5 ? loc.road.a : loc.road.b;
}

/** Gleicher Standort (Knoten bzw. derselbe Wegpunkt) */
export function samePlace(a: Army, b: Army): boolean {
  if (a.node !== b.node) return false;
  const p = a.pos, q = b.pos;
  if (!p || !q) return !p && !q;
  return (p.a === q.a && p.b === q.b && Math.abs(p.f - q.f) < 1e-6) || (p.a === q.b && p.b === q.a && Math.abs(p.f + q.f - 1) < 1e-6);
}

function hostileAt(state: GameState, node: number, owner: string, except?: Army): Army[] {
  return state.armies.filter((b) => b !== except && b.node === node && !b.move && atWar(state, owner, b.owner) && unitCount(b) > 0);
}

/** Verarbeitet Ankünfte aller Armeen, deren Abschnitt bis jetzt abgeschlossen ist. */
export function processArrivals(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  for (const a of [...state.armies]) {
    while (a.move && a.move.segEnd <= state.time) {
      const m = a.move;
      // Ziel auf einem Weg erreicht: dort stehen bleiben (keine Eroberung, die Stadt ist nicht erreicht)
      if (m.seg === m.path.length - 2 && m.endFrac !== undefined && m.endFrac < 1) {
        const u = m.path[m.seg], v = m.path[m.seg + 1];
        a.move = null;
        a.pos = { a: u, b: v, f: m.endFrac };
        a.node = m.endFrac < 0.5 ? u : v;
        declareOnArrival(ctx, a);
        const hostile = hostileAt(state, a.node, a.owner, a);
        if (hostile.length > 0) ctx.log(`Kampf bei ${nodeName(map, a.node)}.`, a.owner, isSea(map, a.node) ? undefined : a.node);
        else mergeInto(ctx, a);
        break;
      }
      const node = m.path[m.seg + 1];
      a.node = node;
      m.seg++;
      declareOnArrival(ctx, a);
      const hostile = hostileAt(state, node, a.owner, a);
      if (!isSea(map, node) && !isNaval(a)) {
        const owner = state.provinces[node].owner;
        if (hostile.length === 0 && owner !== a.owner && atWar(state, a.owner, owner)) conquer(ctx, node, a.owner);
      }
      if (hostile.length > 0) {
        a.move = null;
        ctx.log(`Kampf bei ${nodeName(map, node)}.`, a.owner, isSea(map, node) ? undefined : node);
        for (const o of new Set(hostile.map((h) => h.owner))) {
          if (o !== REBELS) ctx.log(`Feindliche Truppen greifen bei ${nodeName(map, node)} an!`, o, isSea(map, node) ? undefined : node);
        }
        break;
      }
      if (m.seg >= m.path.length - 1) {
        a.move = null;
        if (m.then) disembark(ctx, a, m.then);
        else mergeInto(ctx, a);
        break;
      }
      const next = m.path[m.seg + 1];
      if (!canTraverse(state, map, a, node, next)) {
        a.move = null;
        break;
      }
      m.segStart = m.segEnd;
      m.segEnd = m.segStart + segmentDuration(state, map, a, m.seg);
    }
  }
}

/** Angekündigte Kriegserklärung: betritt die Armee Gebiet einer dieser Nationen, beginnt der Krieg. */
function declareOnArrival(ctx: MilitaryContext, a: Army): void {
  if (!a.warOn?.length || isSea(ctx.map, a.node)) return;
  const owner = ctx.state.provinces[a.node].owner;
  if (owner === a.owner || !a.warOn.includes(owner) || atWar(ctx.state, a.owner, owner)) return;
  const name = (id: string) => ctx.map.nations.find((n) => n.id === id)?.name ?? id;
  setRelation(ctx.state, a.owner, owner, 'war');
  ctx.log(`${name(a.owner)} erklärt ${name(owner)} den Krieg!`);
  ctx.invalidate();
}

/** Nach Ankunft: mit einer stehenden eigenen Armee gleicher Art am Ort zusammenlegen. */
function mergeInto(ctx: MilitaryContext, a: Army): void {
  const other = ctx.state.armies.find((b) => b !== a && b.owner === a.owner && samePlace(a, b) && !b.move
    && isNaval(b) === isNaval(a) && !b.target && unitCount(b) > 0);
  if (!other || a.target) return;
  mergeArmies(ctx.state, other, a);
}

export function mergeArmies(state: GameState, into: Army, from: Army): void {
  into.morale = mixMorale(into, from.units.infantry ?? 0, troopMorale(from));
  for (const u of unitTypes(from)) {
    into.units[u] = (into.units[u] ?? 0) + from.units[u]!;
    if (from.wounds?.[u]) (into.wounds ??= {})[u] = Math.max(into.wounds?.[u] ?? 0, from.wounds[u]!);
  }
  state.armies = state.armies.filter((x) => x !== from);
}

// ---------------------------------------------------------------- Kampf

/** Moral der Infanterie einer Armee */
export function troopMorale(a: Army): number {
  return a.morale ?? TROOP_MORALE.start;
}

/** Moral nach dem Hinzukommen von `count` Infanteristen mit Moral `m` (gewichtet nach Köpfen) */
export function mixMorale(a: Army, count: number, m: number): number {
  const n = a.units.infantry ?? 0;
  if (count <= 0) return troopMorale(a);
  if (n <= 0) return m;
  return (troopMorale(a) * n + m * count) / (n + count);
}

/** Kampfkraft der Infanterie je nach Moral: 0 % → 0,8, 50 % → 1,0, 100 % → 1,2 */
export function infantryStrength(a: Army): number {
  return TROOP_MORALE.strengthMin + (TROOP_MORALE.strengthMax - TROOP_MORALE.strengthMin) * troopMorale(a);
}

function shiftMorale(a: Army, d: number): void {
  a.morale = Math.max(TROOP_MORALE.min, Math.min(1, troopMorale(a) + d));
}

function fortressShield(state: GameState, map: MapData, a: Army): number {
  if (isSea(map, a.node)) return 1;
  const ps = state.provinces[a.node];
  return ps.owner === a.owner ? 1 - FORTRESS_REDUCTION[ps.buildings.fortress] : 1;
}

function spread(ctx: MilitaryContext): number {
  return 1 + (ctx.random() * 2 - 1) * MILITARY.randomSpread;
}

export function applyDamage(a: Army, dmg: number): void {
  const types = unitTypes(a);
  const pool = types.reduce((s, u) => s + a.units[u]! * UNITS[u].hp, 0);
  if (pool <= 0) return;
  for (const u of types) {
    const share = (dmg * a.units[u]! * UNITS[u].hp) / pool;
    const w = (a.wounds?.[u] ?? 0) + share;
    const kills = Math.min(a.units[u]!, Math.floor(w / UNITS[u].hp));
    a.units[u] = a.units[u]! - kills;
    (a.wounds ??= {})[u] = kills >= (a.units[u]! + kills) ? 0 : w - kills * UNITS[u].hp;
    if (!a.units[u]) {
      delete a.units[u];
      delete a.wounds[u];
    }
  }
}

/** Kampfkraft-Faktor: Infanterie nach Moral; Maschinen kämpfen immer voll, unabhängig vom Zustand. */
function soldierFactor(a: Army, u: UnitType): number {
  return u === 'infantry' ? infantryStrength(a) : 1;
}

export function meleeOutput(state: GameState, map: MapData, a: Army): number {
  const sea = isSea(map, a.node);
  const defending = !sea && state.provinces[a.node].owner === a.owner;
  let out = 0;
  for (const u of unitTypes(a)) {
    const d = UNITS[u];
    out += a.units[u]! * (defending ? d.defense : d.attack) * (d.range > 0 ? MILITARY.meleeRangedFactor : 1)
      * (sea && !d.naval ? MILITARY.seaFactor : 1) * soldierFactor(a, u);
  }
  return out;
}

/** Eine Kampfrunde (stündlich) an allen Orten mit verfeindeten Truppen. */
export function combatRound(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  const byNode = new Map<number, Army[]>();
  for (const a of state.armies) {
    if (a.move || unitCount(a) === 0) continue;
    (byNode.get(a.node) ?? byNode.set(a.node, []).get(a.node)!).push(a);
  }
  for (const [node, here] of byNode) {
    if (!here.some((a) => here.some((b) => atWar(state, a.owner, b.owner)))) continue;
    const damage = new Map<Army, number>();
    // wer wem wie viel Schaden zufügt (für die Moral durch Vernichtung)
    const dealt = new Map<Army, Map<Army, number>>();
    for (const a of here) {
      const foes = here.filter((b) => atWar(state, a.owner, b.owner));
      if (!foes.length) continue;
      const out = meleeOutput(state, map, a) * spread(ctx);
      const total = foes.reduce((s, b) => s + Math.max(0.01, armyPower(b)), 0);
      const mine = new Map<Army, number>();
      for (const b of foes) {
        const d = (out * Math.max(0.01, armyPower(b))) / total;
        damage.set(b, (damage.get(b) ?? 0) + d);
        mine.set(b, d);
      }
      dealt.set(a, mine);
    }
    const before = new Map([...damage.keys()].map((b) => [b, unitCount(b)]));
    const names = new Map(here.map((x) => [x, armyName(x)]));
    for (const [b, dmg] of damage) applyDamage(b, dmg * fortressShield(state, map, b));
    // Moral der Infanterie: Nahkampf zehrt, vernichtete Gegner stärken
    for (const [a, mine] of dealt) {
      let kills = 0;
      for (const [b, d] of mine) kills += (before.get(b)! - unitCount(b)) * (d / Math.max(1e-9, damage.get(b)!));
      shiftMorale(a, -TROOP_MORALE.melee + Math.min(TROOP_MORALE.killMax, kills * TROOP_MORALE.perKill));
    }
    if (!isSea(map, node)) damageBuildings(ctx, node);
    // Sieger einer vernichteten Armee: die feindliche Seite mit dem meisten Schaden an ihr
    const victors = new Map<Army, string>();
    for (const b of damage.keys()) {
      let best: Army | null = null, bd = -1;
      for (const [a, mine] of dealt) if ((mine.get(b) ?? 0) > bd) { bd = mine.get(b) ?? 0; best = a; }
      if (best) victors.set(b, best.owner);
    }
    cleanup(ctx, node, names, victors);
  }
}

function distance(map: MapData, a: Army, b: Army, time: number): number {
  const p = armyPosition(map, a, time), q = armyPosition(map, b, time);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/** Gültiges Fernkampfziel in Reichweite (für Anzeige und Kampf) */
export function engagedTarget(state: GameState, map: MapData, a: Army): Army | null {
  if (a.target == null) return null;
  const t = state.armies.find((b) => b.id === a.target);
  if (!t || unitCount(t) === 0 || !atWar(state, a.owner, t.owner)) return null;
  return distance(map, a, t, state.time) <= maxRange(a) ? t : null;
}

/** Marsch anhalten: die Armee bleibt genau dort stehen, wo sie ist (auch mitten auf dem Weg). */
export function halt(map: MapData, a: Army, time: number): void {
  if (!a.move) return;
  const loc = armyLocation(a, time);
  a.node = nearestNode(map, a, time);
  a.pos = 'road' in loc ? loc.road : null;
  a.move = null;
}

/**
 * Fernkampf erfassen (alle 10 Spielminuten): Einheiten mit Reichweite nehmen Feinde in Reichweite
 * sofort ins Visier und bleiben dafür stehen. Gemischte Armeen auf dem Marsch ziehen weiter.
 */
export function engageRanged(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  for (const a of state.armies) {
    const range = maxRange(a);
    if (range <= 0 || unitCount(a) === 0) continue;
    if (a.move && !isRangedOnly(a)) continue;
    if (a.target != null) {
      const t = state.armies.find((b) => b.id === a.target);
      if (!t || unitCount(t) === 0 || !atWar(state, a.owner, t.owner)) {
        a.target = null;
        a.autoTarget = false;
      } else if (distance(map, a, t, state.time) <= range) {
        halt(map, a, state.time);
        continue;
      } else if (a.autoTarget) {
        a.target = null;
        a.autoTarget = false;
      } else continue; // ausdrückliches Ziel außer Reichweite: wird im Fernkampf verfolgt
    }
    let best: Army | undefined, bd = Infinity;
    for (const b of state.armies) {
      if (!atWar(state, a.owner, b.owner) || unitCount(b) === 0) continue;
      const d = distance(map, a, b, state.time);
      if (d <= range && d < bd) { bd = d; best = b; }
    }
    if (!best) continue;
    a.target = best.id;
    a.autoTarget = true;
    halt(map, a, state.time);
  }
}

/** Fernkampf: Artillerie, Eisenbahngeschütze und Schlachtschiffe beschießen ihr Ziel in Reichweite (stündlich). */
export function rangedRound(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  for (const a of [...state.armies]) {
    const range = maxRange(a);
    if (range <= 0 || unitCount(a) === 0) continue;
    const pos = armyPosition(map, a, state.time);
    const inRange = (b: Army) => {
      const p = armyPosition(map, b, state.time);
      return Math.hypot(p[0] - pos[0], p[1] - pos[1]) <= range;
    };
    let target = a.target != null ? state.armies.find((b) => b.id === a.target) : undefined;
    if (target && (!atWar(state, a.owner, target.owner) || unitCount(target) === 0)) {
      a.target = null;
      target = undefined;
    }
    if (target && !inRange(target)) {
      // ausdrückliches Ziel außer Reichweite: hinterher, sofern nicht schon unterwegs oder gebunden
      if (a.autoTarget) {
        a.target = null;
        a.autoTarget = false;
        continue;
      }
      if (!a.move && !inMelee(state, a)) {
        const r = findPath(state, map, a, a.node, target.node);
        if (r) startMove(ctx, a, r.path);
      }
      continue;
    }
    if (!target) continue;
    if (a.move) halt(map, a, state.time); // in Reichweite: stehen bleiben und feuern
    let out = 0;
    const atSea = isSea(map, a.node);
    for (const u of unitTypes(a)) {
      if (UNITS[u].range > 0) out += a.units[u]! * UNITS[u].attack * (atSea && !UNITS[u].naval ? MILITARY.seaFactor : 1);
    }
    const n0 = unitCount(target);
    const targetName = armyName(target);
    applyDamage(target, out * spread(ctx) * fortressShield(state, map, target));
    // beschossen werden zehrt an der Moral, Treffer stärken die Schützen
    shiftMorale(target, -TROOP_MORALE.shelled);
    shiftMorale(a, Math.min(TROOP_MORALE.killMax, (n0 - unitCount(target)) * TROOP_MORALE.perKill));
    cleanup(ctx, target.node, new Map([[target, targetName]]), new Map([[target, a.owner]]));
  }
}

/** Entfernt vernichtete Armeen (mit öffentlicher Meldung) und prüft Eroberung bzw. Aufstand am Ort. */
function cleanup(ctx: MilitaryContext, node: number, names?: Map<Army, string>, victors?: Map<Army, string>): void {
  const { state, map } = ctx;
  const nationName = (id: string) => (id === REBELS ? 'Aufständische' : map.nations.find((n) => n.id === id)?.name ?? id);
  for (const a of state.armies.filter((x) => x.node === node && unitCount(x) === 0)) {
    const place = nodeName(map, node);
    const name = names?.get(a) ?? 'Eine Armee';
    const by = victors?.get(a);
    ctx.log(`${name} wurde bei ${place} vernichtet.`, a.owner, isSea(map, node) ? undefined : node);
    if (a.owner !== REBELS) {
      ctx.log(`Bei ${place} wurde die ${name} (${nationName(a.owner)})${by ? ` von ${nationName(by)}` : ''} vernichtet.`,
        undefined, isSea(map, node) ? undefined : node, { kind: 'battle', place, army: name, from: a.owner, by });
    }
  }
  state.armies = state.armies.filter((x) => unitCount(x) > 0);
  ctx.invalidate();
  if (isSea(map, node)) return;
  const ps = state.provinces[node];
  const here = state.armies.filter((x) => x.node === node && !x.move);
  const owners = new Set(here.map((x) => x.owner));
  if (owners.size !== 1) return;
  const [x] = owners;
  if (x === REBELS) {
    ps.revolt = true;
    return;
  }
  if (x !== ps.owner && atWar(state, x, ps.owner) && here.some((h) => !isNaval(h))) conquer(ctx, node, x);
}

/** Kämpfe in einer Provinz beschädigen Gebäude: je Stunde und Gebäude eine Chance, eine Stufe zu verlieren. */
function damageBuildings(ctx: MilitaryContext, node: number): void {
  const ps = ctx.state.provinces[node];
  for (const b of Object.keys(ps.buildings) as Building[]) {
    if (ps.buildings[b] <= 0 || ctx.random() >= BUILDING_DAMAGE_CHANCE) continue;
    ps.buildings[b]--;
    const name = BUILDINGS[b].name;
    ctx.log(ps.buildings[b] === 0
      ? `${name} in ${ctx.map.provinces[node].name} im Kampf zerstört.`
      : `${name} in ${ctx.map.provinces[node].name} beschädigt (Stufe ${ps.buildings[b]}).`, ps.owner, node);
    ctx.invalidate();
  }
}

// ---------------------------------------------------------------- Eroberung

export function conquer(ctx: MilitaryContext, node: number, by: string): void {
  const { state, map } = ctx;
  const ps = state.provinces[node];
  const old = ps.owner;
  const mp = map.provinces[node];
  ps.owner = by;
  ps.construction = null;
  ps.buildQueue = [];
  ps.queue = [];
  ps.repeat = false;
  ps.recruit = 0;
  ps.revolt = false;
  ps.morale = Math.min(ps.morale, MILITARY.conquestMorale);
  const byName = map.nations.find((n) => n.id === by)?.name ?? by;
  const oldName = map.nations.find((n) => n.id === old)?.name ?? old;
  ctx.log(`${mp.name} wurde von ${byName} erobert.`, old, node);
  ctx.log(`Wir haben ${mp.name} erobert.`, by, node);
  const capitalFall = mp.capital && mp.nation === old;
  if (!capitalFall) {
    ctx.log(`${byName} erobert die Stadt ${mp.name} (Provinz ${mp.name}) von ${oldName}.`, undefined, node,
      { kind: 'conquest', by, from: old, place: mp.name });
  }
  if (capitalFall) {
    ctx.log(`Die Hauptstadt ${mp.name} (${oldName}) ist an ${byName} gefallen!`, undefined, node);
    for (const p of state.provinces) {
      if (p.owner === by) p.morale = Math.min(1, p.morale + MILITARY.capitalMoraleBonus);
      else if (p.owner === old) p.morale = Math.max(MORALE.min, p.morale - MILITARY.capitalMoralePenalty);
    }
  }
  if (!state.provinces.some((p) => p.owner === old) && state.nations[old]) {
    state.nations[old].alive = false;
    state.armies = state.armies.filter((a) => a.owner !== old);
    ctx.log(`${oldName} hat aufgehört zu existieren.`);
  }
  ctx.invalidate();
}

// ---------------------------------------------------------------- Wiedervereinigung

/**
 * Abgetrennte Armeen, die ohne Befehl am selben Ort wie ihre Ursprungsarmee stehen, werden wieder
 * eingegliedert (`now`: sofort, sonst erst nach SPLIT_REJOIN). Ist die Ursprungsarmee fort, entfällt die Markierung.
 */
export function rejoinSplits(ctx: MilitaryContext, now = false, only?: number): void {
  const { state } = ctx;
  for (const a of [...state.armies]) {
    if (!a.split || (only !== undefined && a.id !== only)) continue;
    const origin = state.armies.find((b) => b.id === a.split!.from && b.owner === a.owner);
    if (!origin || origin.move) {
      a.split = null;
      continue;
    }
    if (a.move || a.target != null || origin.target != null || !samePlace(a, origin) || isNaval(a) !== isNaval(origin)) continue;
    if (!now && state.time - a.split.at < SPLIT_REJOIN) continue;
    if (inMelee(state, a)) continue;
    mergeArmies(state, origin, a);
    ctx.invalidate();
  }
}

// ---------------------------------------------------------------- Überlaufen

/**
 * Wahrscheinlichkeit je Tageswechsel, dass eine Provinz überläuft: 1 % bei 33 % Moral bis 33 % bei 0 %;
 * je angefangene 5 Kampfstärke stationierter eigener Truppen in der Stadt 1 Prozentpunkt weniger.
 */
export function defectionChance(morale: number, garrison = 0): number {
  if (morale >= DEFECTION.threshold) return 0;
  const base = DEFECTION.minChance + (DEFECTION.maxChance - DEFECTION.minChance) * (DEFECTION.threshold - morale) / DEFECTION.threshold;
  return Math.max(0, base - Math.ceil(garrison / DEFECTION.strengthPerPoint) / 100);
}

/** Kampfstärke der eigenen Truppen, die in der Stadt einer Provinz stehen */
export function garrisonStrength(state: GameState, province: number): number {
  const owner = state.provinces[province].owner;
  return state.armies.filter((a) => a.owner === owner && a.node === province && !a.move && !a.pos && !isNaval(a))
    .reduce((t, a) => t + armyPower(a), 0);
}

/**
 * Tageswechsel: Provinzen mit sehr niedriger Moral können zu einer nahen anderen Macht überlaufen –
 * bevorzugt zum früheren Besitzer, sonst zu Nachbarn, Kriegsgegner eher. Von den Truppen in der Stadt
 * läuft ein Teil mit über (mindestens eine Einheit, weil immer eine Truppe in der Stadt steht), der Rest fällt.
 */
export function defections(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  state.provinces.forEach((ps, i) => {
    const chance = defectionChance(ps.morale, garrisonStrength(state, i));
    if (chance <= 0 || ctx.random() >= chance) return;
    const old = ps.owner;
    const weights = new Map<string, number>();
    for (const n of map.provinces[i].neighbors) {
      const o = state.provinces[n].owner;
      if (o === old || !state.nations[o]?.alive) continue;
      weights.set(o, (weights.get(o) ?? 0) + 1 + (atWar(state, old, o) ? 2 : 0));
    }
    const original = map.provinces[i].nation;
    if (original !== old && state.nations[original]?.alive) weights.set(original, (weights.get(original) ?? 0) + 5);
    if (!weights.size) return;
    let r = ctx.random() * [...weights.values()].reduce((a, b) => a + b, 0);
    let to = [...weights.keys()][0];
    for (const [o, w] of weights) if ((r -= w) <= 0) { to = o; break; }

    // Truppen in der Stadt: ein Teil läuft über, der Rest fällt
    const here = state.armies.filter((a) => a.owner === old && a.node === i && !a.move && !a.pos && !isNaval(a));
    const turned: Partial<Record<UnitType, number>> = {};
    let total = 0, kept = 0;
    for (const a of here) {
      for (const u of unitTypes(a)) {
        const n = a.units[u]!;
        total += n;
        let k = 0;
        for (let j = 0; j < n; j++) if (ctx.random() < DEFECTION.unitShare) k++;
        if (k) { turned[u] = (turned[u] ?? 0) + k; kept += k; }
      }
    }
    if (total > 0 && kept === 0) {
      const u = here.flatMap((a) => unitTypes(a))[0];
      turned[u] = 1;
      kept = 1;
    }
    state.armies = state.armies.filter((a) => !here.includes(a));
    if (kept) state.armies.push({ id: ctx.newArmyId(), owner: to, node: i, units: turned, morale: TROOP_MORALE.neutral });

    ps.owner = to;
    ps.morale = DEFECTION.morale;
    ps.construction = null;
    ps.buildQueue = [];
    ps.queue = [];
    ps.repeat = false;
    ps.recruit = 0;
    ps.revolt = false;
    const mp = map.provinces[i];
    ctx.log(`Revolution in ${mp.name}: Die Provinz sagt sich von ${name(old)} los und läuft zu ${name(to)} über!`
      + (total ? ` ${kept} von ${total} Einheiten wechseln die Seite.` : ''), undefined, i);
    if (!state.provinces.some((p) => p.owner === old) && state.nations[old]) {
      state.nations[old].alive = false;
      state.armies = state.armies.filter((a) => a.owner !== old);
      ctx.log(`${name(old)} hat aufgehört zu existieren.`);
    }
    ctx.invalidate();
  });
}

// ---------------------------------------------------------------- Aufstände (ältere Spielstände)

/** Tageswechsel: bei sehr niedriger Moral erheben sich Aufständische. */
export function revolts(ctx: MilitaryContext, newId: () => number): void {
  const { state, map } = ctx;
  state.provinces.forEach((ps, i) => {
    if (ps.morale >= MORALE.revolt) return;
    if (state.armies.some((a) => a.node === i && a.owner === REBELS)) return;
    if (ctx.random() >= (MORALE.revolt - ps.morale) * 3) return;
    const [lo, hi] = MILITARY.rebelUnits;
    const n = lo + Math.floor(ctx.random() * (hi - lo + 1));
    state.armies.push({ id: newId(), owner: REBELS, node: i, units: { infantry: n } });
    ctx.log(`Aufstand in ${map.provinces[i].name}: ${n} Einheiten Aufständische!`, ps.owner, i);
  });
}

/** Stündlich: Aufstandsstatus aktualisieren (Produktion ruht, solange Aufständische die Provinz halten). */
export function updateRevoltFlags(state: GameState): boolean {
  let changed = false;
  state.provinces.forEach((ps, i) => {
    const rebels = state.armies.some((a) => a.node === i && a.owner === REBELS);
    const garrison = state.armies.some((a) => a.node === i && a.owner === ps.owner && !a.move);
    const revolt = rebels && !garrison;
    if (!!ps.revolt !== revolt) {
      ps.revolt = revolt;
      changed = true;
    }
  });
  return changed;
}
