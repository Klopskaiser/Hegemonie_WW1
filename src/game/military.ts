// Militär: Wegfindung, Marsch, Nah- und Fernkampf, Eroberung, Aufständische.

import {
  BUILDING_DAMAGE_CHANCE, BUILDINGS, FORTRESS_REDUCTION, HOUR, MILITARY, MINUTE, MORALE, UNITS, type Building, type UnitType,
} from './balance.ts';
import { atWar, hasRightOfWay } from './diplomacy.ts';
import { isSea, nodeCount, nodeDist, nodeName, nodeNeighbors, nodePos } from './graph.ts';
import type { MapData } from './mapdata.ts';
import { REBELS, type Army, type GameState } from './types.ts';

export interface MilitaryContext {
  state: GameState;
  map: MapData;
  log(text: string, nation?: string, province?: number): void;
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

export function canEnter(state: GameState, map: MapData, a: Army, node: number): boolean {
  if (isSea(map, node)) return !isRailOnly(a);
  // Schiffe (auch mit Truppen an Bord) gehen nie an Land
  if (isNaval(a)) return false;
  const owner = state.provinces[node].owner;
  if (isRailOnly(a)) return owner === a.owner && state.provinces[node].buildings.railroad > 0;
  return owner === a.owner || atWar(state, a.owner, owner) || hasRightOfWay(state, a.owner, owner);
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
  const d = nodeDist(map, u, v);
  const su = isSea(map, u), sv = isSea(map, v);
  if (isNaval(a)) {
    // Flotte; mit Truppen an Bord höchstens Transporttempo
    const ships = Math.min(...unitTypes(a).filter((t) => UNITS[t].naval).map((t) => UNITS[t].speed));
    const carrying = unitTypes(a).some((t) => !UNITS[t].naval);
    return d / (carrying ? Math.min(ships, MILITARY.transportSpeed) : ships);
  }
  if (su && sv) return d / MILITARY.transportSpeed;
  if (sv) return d / MILITARY.transportSpeed + embarkHours(state, u, a.owner); // einschiffen
  if (su) return d / MILITARY.transportSpeed + embarkHours(state, v, a.owner); // anlanden
  return d / 2 / landSpeed(state, a, u) + d / 2 / landSpeed(state, a, v);
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
      if (done[v] || !canEnter(state, map, a, v)) continue;
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

export function startMove(ctx: MilitaryContext, a: Army, path: number[], then?: number[]): void {
  if (path.length < 2) {
    a.move = null;
    if (then) disembark(ctx, a, then);
    return;
  }
  const t = ctx.state.time;
  a.move = { path, seg: 0, segStart: t, segEnd: t + minuteRound(segmentHours(ctx.state, ctx.map, a, path[0], path[1]) * HOUR), then };
}

/** Truppen verlassen die Flotte und marschieren weiter; die Schiffe bleiben vor der Küste liegen. */
function disembark(ctx: MilitaryContext, fleet: Army, then: number[]): void {
  const troops = landPart(fleet);
  if (!troops) return;
  for (const u of Object.keys(troops.units) as UnitType[]) {
    delete fleet.units[u];
    if (fleet.wounds) delete fleet.wounds[u];
  }
  const army: Army = { id: ctx.newArmyId(), owner: fleet.owner, node: fleet.node, units: troops.units };
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

/** Aktuelle Position (km) – während des Marsches zwischen zwei Knoten interpoliert. */
export function armyPosition(map: MapData, a: Army, time: number): [number, number] {
  const m = a.move;
  if (!m) return nodePos(map, a.node);
  const p0 = nodePos(map, m.path[m.seg]), p1 = nodePos(map, m.path[m.seg + 1]);
  const f = Math.max(0, Math.min(1, (time - m.segStart) / Math.max(1, m.segEnd - m.segStart)));
  return [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
}

/** Knoten, an dem eine marschierende Armee gerade „steht“ (für Befehle während des Marsches). */
export function nearestNode(map: MapData, a: Army, time: number): number {
  const m = a.move;
  if (!m) return a.node;
  const f = (time - m.segStart) / Math.max(1, m.segEnd - m.segStart);
  return f < 0.5 ? m.path[m.seg] : m.path[m.seg + 1];
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
      const node = m.path[m.seg + 1];
      a.node = node;
      m.seg++;
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
      if (!canEnter(state, map, a, next)) {
        a.move = null;
        break;
      }
      m.segStart = m.segEnd;
      m.segEnd = m.segStart + minuteRound(segmentHours(state, map, a, node, next) * HOUR);
    }
  }
}

/** Nach Ankunft: mit einer stehenden eigenen Armee gleicher Art am Ort zusammenlegen. */
function mergeInto(ctx: MilitaryContext, a: Army): void {
  const other = ctx.state.armies.find((b) => b !== a && b.owner === a.owner && b.node === a.node && !b.move
    && isNaval(b) === isNaval(a) && !b.target && unitCount(b) > 0);
  if (!other || a.target) return;
  mergeArmies(ctx.state, other, a);
}

export function mergeArmies(state: GameState, into: Army, from: Army): void {
  for (const u of unitTypes(from)) {
    into.units[u] = (into.units[u] ?? 0) + from.units[u]!;
    if (from.wounds?.[u]) (into.wounds ??= {})[u] = Math.max(into.wounds?.[u] ?? 0, from.wounds[u]!);
  }
  state.armies = state.armies.filter((x) => x !== from);
}

// ---------------------------------------------------------------- Kampf

function moraleFactor(state: GameState, map: MapData, a: Army): number {
  if (a.owner === REBELS) return 0.8;
  if (isSea(map, a.node)) return 0.85;
  const ps = state.provinces[a.node];
  return 0.6 + 0.4 * (ps.owner === a.owner ? ps.morale : 0.75);
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

/** Kampfkraft-Faktor: nur Soldaten (Infanterie) leiden unter Moral und Verwundung, Maschinen nicht. */
function soldierFactor(state: GameState, map: MapData, a: Army, u: UnitType): number {
  if (u !== 'infantry') return 1;
  const health = 1 - (a.wounds?.[u] ?? 0) / Math.max(1, a.units[u]! * UNITS[u].hp);
  return moraleFactor(state, map, a) * health;
}

export function meleeOutput(state: GameState, map: MapData, a: Army): number {
  const sea = isSea(map, a.node);
  const defending = !sea && state.provinces[a.node].owner === a.owner;
  let out = 0;
  for (const u of unitTypes(a)) {
    const d = UNITS[u];
    out += a.units[u]! * (defending ? d.defense : d.attack) * (d.range > 0 ? MILITARY.meleeRangedFactor : 1)
      * (sea && !d.naval ? MILITARY.seaFactor : 1) * soldierFactor(state, map, a, u);
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
    for (const a of here) {
      const foes = here.filter((b) => atWar(state, a.owner, b.owner));
      if (!foes.length) continue;
      const out = meleeOutput(state, map, a) * spread(ctx);
      const total = foes.reduce((s, b) => s + Math.max(0.01, armyPower(b)), 0);
      for (const b of foes) damage.set(b, (damage.get(b) ?? 0) + (out * Math.max(0.01, armyPower(b))) / total);
    }
    for (const [b, dmg] of damage) applyDamage(b, dmg * fortressShield(state, map, b));
    if (!isSea(map, node)) damageBuildings(ctx, node);
    cleanup(ctx, node);
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

function halt(map: MapData, a: Army, time: number): void {
  if (!a.move) return;
  a.node = nearestNode(map, a, time);
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
    applyDamage(target, out * spread(ctx) * fortressShield(state, map, target));
    cleanup(ctx, target.node);
  }
}

/** Entfernt vernichtete Armeen und prüft Eroberung bzw. Aufstand am Ort. */
function cleanup(ctx: MilitaryContext, node: number): void {
  const { state, map } = ctx;
  for (const a of state.armies.filter((x) => x.node === node && unitCount(x) === 0)) {
    ctx.log(`Eine Armee wurde bei ${nodeName(map, node)} vernichtet.`, a.owner, isSea(map, node) ? undefined : node);
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
  if (mp.capital && mp.nation === old) {
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

// ---------------------------------------------------------------- Aufstände

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
