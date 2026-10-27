// Militär: Wegfindung, Marsch, Nah- und Fernkampf, Eroberung, Aufständische.

import { DEFAULT_COMBAT_MORALE, SUPERIORITY, COMBAT_MORALE_V2, BUILDING_DAMAGE_CHANCE, BUILDINGS, buildingLives, DAY, DEFECTION, FORTRESS_REDUCTION, HOUR, MILITARY, MINUTE, MORALE, TROOP_MORALE, UNITS,
  type Building, type UnitType,
} from './balance.ts';
import { atWar, hasRightOfWay, setRelation, noteWarDeclaration } from './diplomacy.ts';
import { edgeParts, edgePoint, edgePoints, edgeSlice, edgeThrough, isSea, nodeCount, nodeName, nodeNeighbors, nodePos } from './graph.ts';
import type { MapData } from './mapdata.ts';
import { activeCapital, activeLevel } from './economy.ts';
import { armyName } from './names.ts';
import { REBELS, type Army, type GameState, type NewsInfo, type RoadPos, type CombatMoraleMode } from './types.ts';

export interface MilitaryContext {
  state: GameState;
  map: MapData;
  log(text: string, nation?: string, province?: number, news?: NewsInfo): void;
  invalidate(): void;
  /** wirtschaftlich relevante Änderung (Besitz, Einheiten, Moral); ohne Angabe genügt invalidate */
  invalidateRates?(): void;
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

/** Reichweite eines Einheitentyps am Standort der Armee: auf See haben Landeinheiten keine (sie kämpfen im Nahkampf) */
export function unitRange(a: Army, u: UnitType, map?: MapData): number {
  return ((map && isSea(map, a.node)) || a.boarding) && !UNITS[u].naval ? 0 : UNITS[u].range;
}

/**
 * Ist die Armee gerade beim Ein- oder Ausschiffen (Hafenweg, Richtung Wasser über den Hafenpunkt hinaus
 * oder vom Wasser kommend)? Wer nur bis zum Hafenpunkt marschiert (z. B. um dort anzugreifen), nicht.
 */
function isBoarding(map: MapData, a: Army): boolean {
  const m = a.move;
  if (!m || isNaval(a)) return false;
  const u = m.path[m.seg], v = m.path[m.seg + 1];
  if (isSea(map, u) === isSea(map, v)) return false;
  if (isSea(map, u)) return true;
  return !(m.seg === m.path.length - 2 && m.endFrac !== undefined && m.endFrac < 1);
}

/** nur Fernkampfeinheiten (Artillerie, Eisenbahngeschütze, Schlachtschiffe) – auf See nur Schiffe */
export function isRangedOnly(a: Army, map?: MapData): boolean {
  const t = unitTypes(a);
  return t.length > 0 && t.every((u) => unitRange(a, u, map) > 0);
}

export function armySpeed(a: Army): number {
  return Math.min(...unitTypes(a).map((u) => UNITS[u].speed));
}

export function maxRange(a: Army, map?: MapData): number {
  return Math.max(0, ...unitTypes(a).map((u) => unitRange(a, u, map)));
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
  // Eisenbahngeschütze brauchen auch dort intakte Schienen, wo sie losfahren (beschädigte: festgefahren bis zur Reparatur)
  if (isRailOnly(a) && !isSea(map, u) && activeLevel(state.provinces[u], 'railroad') <= 0) return false;
  const t = edgeThrough(map, u, v);
  return !t || canEnter(state, map, a, t.via);
}

export function canEnter(state: GameState, map: MapData, a: Army, node: number): boolean {
  if (isSea(map, node)) return true;
  // Schiffe (auch mit Truppen an Bord) gehen nie an Land
  if (isNaval(a)) return false;
  const owner = state.provinces[node].owner;
  // Eisenbahngeschütze nur auf intakten Schienen; sonst dieselben Regeln wie für alle (Frieden: Kriegserklärung beim Eintreffen)
  if (isRailOnly(a) && activeLevel(state.provinces[node], 'railroad') <= 0) return false;
  return owner === a.owner || atWar(state, a.owner, owner) || hasRightOfWay(state, a.owner, owner) || !!a.warOn?.includes(owner);
}

/**
 * Wie weit (Anteil des Weges) eine Armee von u aus in Richtung v kommt, ohne v zu betreten. Wege sind frei (auch
 * im Friedensgebiet, nur die fremde Stadt verlangt Krieg); Eisenbahngeschütze fahren nur bis knapp vor die Grenze
 * des befahrbaren Bahnnetzes.
 */
export function roadLimit(state: GameState, map: MapData, a: Army, u: number, v: number): number {
  if (!isRailOnly(a) || canTraverse(state, map, a, u, v)) return 1;
  if (!canEnter(state, map, a, u)) return 0;
  const [l1, len] = edgeParts(map, u, v);
  const t = edgeThrough(map, u, v);
  const own = Math.min(l1, t ? t.f0 * len : l1);
  return Math.max(0, (own - BORDER_GAP_KM) / len);
}

/** Abstand zur Grenze, an dem ein Marsch auf einem Weg endet, der nicht weiter darf (km) */
const BORDER_GAP_KM = 0.5;

/** Länge des Landstücks eines Hafenweges: von der Stadt bis zum Hafenpunkt */
export function harborLeg(map: MapData, u: number, v: number): number {
  const pts = edgePoints(map, u, v);
  const [c, h] = isSea(map, u) ? [pts[pts.length - 1], pts[pts.length - 2]] : [pts[0], pts[1]];
  return Math.hypot(h[0] - c[0], h[1] - c[1]);
}

function landSpeed(state: GameState, a: Army, province: number): number {
  const ps = state.provinces[province];
  const base = armySpeed(a);
  const own = ps.owner === a.owner;
  // Eisenbahngeschütze: auf eigenen Schienen und mit Durchmarschrecht voll, auf fremden sonst halb so schnell
  if (isRailOnly(a)) return own || hasRightOfWay(state, a.owner, ps.owner) ? base : base * MILITARY.enemyRailFactor;
  // halbes Tempo auf feindlichem Land und überall ohne Durchmarschrecht oder Bündnis
  const terr = own ? MILITARY.territory.own : hasRightOfWay(state, a.owner, ps.owner) ? MILITARY.territory.foreign : MILITARY.territory.enemy;
  return base * terr * (own && activeLevel(ps, 'railroad') > 0 ? MILITARY.railFactor : 1) * marchFactor(a);
}

/** Gewaltmarsch: alle Marschgeschwindigkeiten mal MILITARY.forcedMarchSpeed (Ein-/Ausschiffen bleibt gleich) */
function marchFactor(a: Army): number {
  return a.forcedMarch ? MILITARY.forcedMarchSpeed : 1;
}

/** Dauer eines Abschnitts in Stunden. */
/** Befreundeter Hafen: eigener oder einer Nation mit Durchmarschrecht/geteilter Karte */
export function friendlyHarbor(state: GameState, province: number, nation: string): boolean {
  const ps = state.provinces[province];
  return activeLevel(ps, 'harbor') > 0 && hasRightOfWay(state, nation, ps.owner);
}

/** Dauer des Ein- bzw. Ausschiffens in einer Küstenprovinz (Stunden). */
export function embarkHours(state: GameState, province: number, nation: string): number {
  return MILITARY.embarkHours * (friendlyHarbor(state, province, nation) ? MILITARY.harborEmbarkFactor : 1);
}

/** Dauer eines Abschnitts in Stunden. */
export function segmentHours(state: GameState, map: MapData, a: Army, u: number, v: number): number {
  const p = segmentProfile(state, map, a, u, v);
  return p[p.length - 1];
}

/**
 * Tempoverlauf eines Abschnitts: Paare [Anteil der Weglänge, Stunden bis dorthin] von 0 bis 1.
 * Landwege wechseln an der Grenze (bzw. an der Kreuzung einer Abkürzung) das Tempo.
 */
export function segmentProfile(state: GameState, map: MapData, a: Army, u: number, v: number): number[] {
  const [l1, d] = edgeParts(map, u, v);
  const su = isSea(map, u), sv = isSea(map, v);
  if (isNaval(a)) {
    // Flotte; mit Truppen an Bord höchstens Transporttempo
    const ships = Math.min(...unitTypes(a).filter((t) => UNITS[t].naval).map((t) => UNITS[t].speed));
    const carrying = unitTypes(a).some((t) => !UNITS[t].naval);
    return [0, 0, 1, d / ((carrying ? Math.min(ships, MILITARY.transportSpeed) : ships) * marchFactor(a))];
  }
  const transport = MILITARY.transportSpeed * marchFactor(a);
  if (su && sv) return [0, 0, 1, d / transport];
  // Abkürzung über eine Kreuzung im Gebiet einer dritten Provinz: drei Abschnitte mit eigenem Tempo
  const through = !su && !sv ? edgeThrough(map, u, v) : null;
  if (through && !isSea(map, through.via)) {
    const h0 = (d * through.f0) / landSpeed(state, a, u);
    const h1 = h0 + (d * (through.f1 - through.f0)) / landSpeed(state, a, through.via);
    return [0, 0, through.f0, h0, through.f1, h1, 1, h1 + (d * (1 - through.f1)) / landSpeed(state, a, v)];
  }
  // Hafenwege: an Land bis zum Hafenpunkt im Landtempo (mit eigener Bahn auf der Schiene), dort
  // Ein- bzw. Ausschiffen (Pause an der Wassergrenze), auf dem Wasser im Transporttempo
  if (sv || su) {
    const prov = sv ? u : v;
    const wait = embarkHours(state, prov, a.owner);
    const land = Math.min(d, harborLeg(map, u, v));
    const fl = d > 0 ? land / d : 0;
    const hl = land / landSpeed(state, a, prov), hs = (d - land) / transport;
    return sv
      ? [0, 0, fl, hl, fl, hl + wait, 1, hl + wait + hs]
      : [0, 0, 1 - fl, hs, 1 - fl, hs + wait, 1, hs + wait + hl];
  }
  // Landweg: bis zur Grenze im Tempo von u, danach im Tempo von v
  const h0 = l1 / landSpeed(state, a, u);
  return [0, 0, d > 0 ? l1 / d : 0, h0, 1, h0 + (d - l1) / landSpeed(state, a, v)];
}

/** Index der Pause (Ein-/Ausschiffen) im Tempoverlauf: gleicher Anteil, steigende Stunden; -1 ohne */
function pauseIndex(p: number[]): number {
  for (let k = 0; k + 3 < p.length; k += 2) if (p[k] === p[k + 2] && p[k + 3] > p[k + 1]) return k;
  return -1;
}

/** Tempoverlauf mit anderer Pausenlänge (Stunden) */
function withPause(p: number[], wait: number): number[] {
  const i = pauseIndex(p);
  if (i < 0) return p;
  const delta = Math.max(0, wait) - (p[i + 3] - p[i + 1]);
  return p.map((v, j) => (j % 2 === 1 && j >= i + 3 ? v + delta : v));
}

/**
 * Ein- bzw. Ausschiffen im Gange (Armee wartet am Hafenpunkt): wie lange schon und wie lange noch
 * (Spielstunden); null sonst.
 */
export function boardingWait(map: MapData, a: Army, time: number): { landing: boolean; elapsed: number; remaining: number } | null {
  const m = a.move;
  if (!m?.prof || isNaval(a)) return null;
  const u = m.path[m.seg], v = m.path[m.seg + 1];
  if (isSea(map, u) === isSea(map, v)) return null;
  const pr = m.prof, i = pauseIndex(pr);
  if (i < 0) return null;
  const p = Math.max(0, Math.min(1, (time - m.segStart) / Math.max(1, m.segEnd - m.segStart)));
  const s = m.seg === 0 ? m.startFrac ?? 0 : 0;
  const e = m.seg === m.path.length - 2 ? m.endFrac ?? 1 : 1;
  const hs = profileHours(pr, s), he = profileHours(pr, e);
  const h = hs + (he - hs) * p;
  if (h < pr[i + 1] - 1e-9 || h >= pr[i + 3]) return null;
  return { landing: isSea(map, u), elapsed: h - pr[i + 1], remaining: pr[i + 3] - h };
}

/** Stunden im Tempoverlauf bis zum Anteil f */
function profileHours(p: number[], f: number): number {
  for (let k = 0; k + 3 < p.length; k += 2) {
    if (f <= p[k + 2] || k + 4 >= p.length) {
      const span = p[k + 2] - p[k];
      return p[k + 1] + (span > 0 ? (p[k + 3] - p[k + 1]) * Math.max(0, Math.min(1, (f - p[k]) / span)) : 0);
    }
  }
  return 0;
}

/** Anteil im Tempoverlauf nach h Stunden */
function profileFrac(p: number[], h: number): number {
  for (let k = 0; k + 3 < p.length; k += 2) {
    if (h <= p[k + 3] || k + 4 >= p.length) {
      const span = p[k + 3] - p[k + 1];
      return p[k] + (span > 0 ? (p[k + 2] - p[k]) * Math.max(0, Math.min(1, (h - p[k + 1]) / span)) : 0);
    }
  }
  return 1;
}

export interface PathTree {
  hours: Float64Array;
  prev: Int32Array;
}

/** Reisezeiten von `from` zu allen erreichbaren Knoten (Dijkstra). */
/** Kürzeste Wege ab `from` (Dijkstra). Mit `maxHours` endet die Suche dort: weiter entfernte Knoten bleiben unvollständig (Stunden > maxHours). */
export function pathsFrom(state: GameState, map: MapData, a: Army, from: number, stopAt?: number, maxHours = Infinity): PathTree {
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
    if (best > maxHours) break;
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
  if (!m.prof) return s + (e - s) * p;
  // gleichmäßig in der Zeit, aber jeder Teil des Weges in seinem eigenen Tempo
  const hs = profileHours(m.prof, s), he = profileHours(m.prof, e);
  return Math.max(Math.min(s, e), Math.min(Math.max(s, e), profileFrac(m.prof, hs + (he - hs) * p)));
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
  // Eisenbahngeschütz auf beschädigten Schienen (auch mitten auf der Strecke): festgefahren bis zur Reparatur
  if (isRailOnly(a)) {
    const here = currentProvince(map, a, time);
    if (here >= 0 && activeLevel(state.provinces[here], 'railroad') <= 0) return null;
  }
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
      // nicht über die Grenze hinaus, wenn das Land dahinter nicht betreten werden darf
      const ahead = same > r.f ? Math.min(same, roadLimit(state, map, a, r.a, r.b)) : Math.max(same, 1 - roadLimit(state, map, a, r.b, r.a));
      if (Math.abs(ahead - r.f) < 1e-6 || (ahead - r.f) * (same - r.f) <= 0) return null;
      if (ahead > r.f) return { path: [r.a, r.b], startFrac: r.f, endFrac: ahead, hours: seg(r.a, r.b) * (ahead - r.f) };
      return { path: [r.b, r.a], startFrac: 1 - r.f, endFrac: 1 - ahead, hours: seg(r.b, r.a) * (r.f - ahead) };
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
    ];
  let best: MovePlan | null = null;
  for (const s of starts) {
    const tree = pathsFrom(state, map, a, s.node);
    for (const e of ends) {
      if (!canEnter(state, map, a, e.node) && e.node !== s.node) continue;
      const mid = pathTo(tree, e.node);
      if (!mid) continue;
      let hours = s.hours + tree.hours[e.node] + e.hours;
      let path = [...s.path.slice(0, -1), ...mid];
      if (e.path.length > 1) path = [...path, e.path[1]];
      // Hin und gleich wieder zurück auf demselben Weg vermeiden
      if (path.length < 2) continue;
      let endFrac = e.path.length > 1 ? e.frac : undefined;
      if (endFrac !== undefined) {
        // Wegziel jenseits einer Grenze, die nicht überschritten werden darf: bis knapp davor
        const u = path[path.length - 2], v = path[path.length - 1];
        const lim = roadLimit(state, map, a, u, v);
        if (endFrac > lim) {
          hours -= seg(u, v) * (endFrac - lim);
          endFrac = lim;
          if (lim < ROAD_EPS) {
            path = path.slice(0, -1);
            endFrac = undefined;
            if (path.length < 2) continue;
          }
        }
      }
      if (best && hours >= best.hours) continue;
      best = {
        path, hours,
        ...(s.path.length > 1 ? { startFrac: s.frac } : {}),
        ...(endFrac !== undefined ? { endFrac } : {}),
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

export function startMove(ctx: MilitaryContext, a: Army, path: number[], then?: number[], frac?: { startFrac?: number; endFrac?: number; wait?: number }): void {
  if (path.length < 2) {
    a.move = null;
    if (then) disembark(ctx, a, then);
    return;
  }
  const t = ctx.state.time;
  a.pos = null;
  delete a.boarding;
  // wer losmarschiert, ist nicht mehr frisch abgeteilt – weder die Armee selbst noch die von ihr abgeteilten
  delete a.apartFrom;
  for (const b of ctx.state.armies) if (b.apartFrom === a.id) delete b.apartFrom;
  a.move = { path, seg: 0, segStart: t, segEnd: t, then };
  if (frac?.startFrac !== undefined) a.move.startFrac = frac.startFrac;
  if (frac?.endFrac !== undefined) a.move.endFrac = frac.endFrac;
  if (frac?.wait !== undefined) a.move.wait = frac.wait;
  a.move.segEnd = t + segmentDuration(ctx.state, ctx.map, a, 0);
}

/** Dauer eines Abschnitts in ms, gekürzt um Start- bzw. Zielanteil; merkt sich den Tempoverlauf */
function segmentDuration(state: GameState, map: MapData, a: Army, k: number): number {
  const m = a.move!;
  const s = k === 0 ? m.startFrac ?? 0 : 0;
  const e = k === m.path.length - 2 ? m.endFrac ?? 1 : 1;
  m.prof = segmentProfile(state, map, a, m.path[k], m.path[k + 1]);
  if (k === 0 && m.wait !== undefined) m.prof = withPause(m.prof, m.wait);
  return minuteRound(Math.max(0, profileHours(m.prof, e) - profileHours(m.prof, s)) * HOUR);
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

/** Im Nahkampf gebunden: stehende Armee mit stehenden Feinden im Umkreis von MILITARY.meleeKm. */
export function inMelee(state: GameState, map: MapData, a: Army): boolean {
  if (a.move) return false;
  return hostileNear(state, map, a).length > 0;
}

/** Zwei Armeen in Nahkampfreichweite (MILITARY.meleeKm) */
export function inMeleeRange(map: MapData, a: Army, b: Army, time: number): boolean {
  const p = armyPosition(map, a, time), q = armyPosition(map, b, time);
  return Math.hypot(p[0] - q[0], p[1] - q[1]) <= MILITARY.meleeKm;
}

/** Aktuelle Position (km) – auf dem Weg zwischen zwei Knoten (mit Knick an der Grenze). */
export function armyPosition(map: MapData, a: Army, time: number): [number, number] {
  const m = a.move;
  if (!m) return standingPosition(map, a);
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

/** Stehende Feinde in Nahkampfreichweite von `a` (bzw. vom Punkt `at`, etwa beim Eintreffen an einem Knoten) */
export function hostileNear(state: GameState, map: MapData, a: Army, at?: [number, number], cells?: Map<number, Army[]>): Army[] {
  return standingNear(state, map, at ?? armyPosition(map, a, state.time), cells)
    .filter((b) => b !== a && unitCount(b) > 0 && atWar(state, a.owner, b.owner));
}

/** Raster der stehenden Armeen (Zellen = Nahkampfreichweite); neu gebaut, sobald eine losmarschiert, anhält oder fällt */
let standIndex: { state: GameState; map: MapData; sig: number; n: number; cells: Map<number, Army[]> } | null = null;
const cellOf = (v: number) => Math.floor(v / MILITARY.meleeKm) + 50000;

function standingCells(state: GameState, map: MapData): Map<number, Army[]> {
  let sig = 0, n = 0;
  for (const a of state.armies) {
    if (a.move) continue;
    n++;
    const p = a.pos;
    sig = (Math.imul(sig, 31) + a.id * 7 + a.node * 13 + (p ? p.a * 17 + p.b * 19 + Math.round(p.f * 1e6) : 0)) | 0;
  }
  if (standIndex && standIndex.state === state && standIndex.map === map && standIndex.sig === sig && standIndex.n === n) return standIndex.cells;
  const cells = new Map<number, Army[]>();
  for (const a of state.armies) {
    if (a.move) continue;
    const q = standingPosition(map, a);
    const k = cellOf(q[0]) * 100000 + cellOf(q[1]);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(a);
  }
  standIndex = { state, map, sig, n, cells };
  return cells;
}

/** Stehende Armeen (auch ohne Einheiten) im Umkreis von MILITARY.meleeKm um p */
function standingNear(state: GameState, map: MapData, p: [number, number], cells = standingCells(state, map)): Army[] {
  const cx = cellOf(p[0]), cy = cellOf(p[1]);
  const out: Army[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const b of cells.get((cx + dx) * 100000 + cy + dy) ?? []) {
        if (b.move) continue;
        const q = standingPosition(map, b);
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= MILITARY.meleeKm) out.push(b);
      }
    }
  }
  return out;
}

/**
 * Feinde, die gerade genau an diesem Wegpunkt warten (beim Ein- oder Ausschiffen am Hafenpunkt),
 * werden gestellt: sie bleiben stehen (Ziel bleibt vorgemerkt) und es kommt zum Nahkampf.
 */
function catchWaiting(map: MapData, state: GameState, a: Army): void {
  const [x, y] = armyPosition(map, a, state.time);
  for (const b of state.armies) {
    if (b === a || !b.move || unitCount(b) === 0 || !atWar(state, a.owner, b.owner)) continue;
    const [bx, by] = armyPosition(map, b, state.time);
    if (Math.hypot(bx - x, by - y) > MILITARY.meleeKm) continue;
    halt(map, b, state.time, true);
    b.node = a.node;
    b.pos = a.pos ? { ...a.pos } : null;
  }
}

/** Endziel eines Marsches (für die Fortsetzung nach einem Kampf) */
function finalTarget(a: Army): { node: number } | { road: RoadPos } | null {
  const m = a.move;
  if (!m) return null;
  if (m.then?.length) return { node: m.then[m.then.length - 1] };
  const n = m.path.length;
  if (m.endFrac !== undefined && m.endFrac < 1) return { road: { a: m.path[n - 2], b: m.path[n - 1], f: m.endFrac } };
  return { node: m.path[n - 1] };
}

/** Marsch wegen eines Kampfes unterbrechen; das Ziel bleibt vorgemerkt (außer es ist schon erreicht) */
function interrupt(map: MapData, a: Army): void {
  const t = finalTarget(a);
  a.boarding = isBoarding(map, a) || undefined;
  a.move = null;
  if (t && !('node' in t && t.node === a.node && !a.pos)) a.resume = t;
}

/**
 * Unterbrochene Marschbefehle fortsetzen (alle 10 Spielminuten): sobald die Armee nicht mehr im
 * Nahkampf gebunden ist und kein Fernkampfziel in Reichweite hat, zieht sie zum vorgemerkten Ziel weiter.
 */
export function resumeOrders(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  for (const a of state.armies) {
    if (!a.resume || a.move || unitCount(a) === 0) continue;
    if (a.chase != null) {
      a.resume = null; // die Verfolgung bestimmt den Weg
      continue;
    }
    if (inMelee(state, map, a) || engagedTarget(state, map, a)) continue;
    const plan = planRoute(state, map, a, state.time, a.resume);
    a.resume = null;
    if (!plan || plan.path.length < 2) continue;
    // letzte Truppe einer eigenen Stadt: eine Einheit bleibt; eine einzelne bleibt ganz (Befehl verfällt)
    if (!leaveGarrison(ctx, a)) continue;
    startMove(ctx, a, plan.path, plan.then, plan);
    ctx.invalidate();
  }
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
        catchWaiting(map, state, a);
        const hostile = hostileNear(state, map, a);
        if (hostile.length > 0) {
          ctx.log(`Kampf bei ${nodeName(map, a.node)}.`, a.owner, isSea(map, a.node) ? undefined : a.node);
          joinBattle(ctx, a);
        } else {
          mergeInto(ctx, a);
          // eine feindliche Stadt in Nahkampfreichweite fällt (Prüfung wie nach einem Kampf)
          for (const n of [u, v]) if (!isSea(map, n)) cleanup(ctx, n);
        }
        break;
      }
      const node = m.path[m.seg + 1];
      a.node = node;
      m.seg++;
      declareOnArrival(ctx, a);
      const hostile = hostileNear(state, map, a, nodePos(map, node));
      if (!isSea(map, node) && !isNaval(a)) {
        const owner = state.provinces[node].owner;
        if (hostile.length === 0 && owner !== a.owner && atWar(state, a.owner, owner)) conquer(ctx, node, a.owner);
      }
      if (hostile.length > 0) {
        // am Rand der Nahkampfreichweite stehen bleiben, nicht erst in der Stadt – aber nur, wenn von dort ein
        // Gegner in Reichweite ist (steht er auf der anderen Seite der Stadt, geht es bis in die Stadt)
        const from = m.path[m.seg - 1];
        const f = fracBefore(map, from, node, MILITARY.meleeKm);
        if (f < 1 && hostileNear(state, map, a, edgePoint(map, from, node, f)).length > 0) {
          a.pos = { a: from, b: node, f };
          a.node = f < 0.5 ? from : node;
        }
        interrupt(map, a);
        joinBattle(ctx, a);
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
      // letztes Teilstück zu einem Wegpunkt: nur bis dorthin (darf vor einer Grenze enden)
      const partial = m.seg + 1 === m.path.length - 1 && m.endFrac !== undefined && m.endFrac < 1;
      if (partial ? m.endFrac! > roadLimit(state, map, a, node, next) + 1e-9 : !canTraverse(state, map, a, node, next)) {
        a.move = null;
        break;
      }
      m.segStart = m.segEnd;
      m.segEnd = m.segStart + segmentDuration(state, map, a, m.seg);
    }
  }
}

/** Anteil auf dem Weg u→v, ab dem v höchstens `km` entfernt ist (rückwärts von v gesucht) */
function fracBefore(map: MapData, u: number, v: number, km: number): number {
  const c = nodePos(map, v);
  for (let f = 1; f > 0; f -= 0.002) {
    const p = edgePoint(map, u, v, f);
    if (Math.hypot(p[0] - c[0], p[1] - c[1]) > km) return Math.min(1, f + 0.002);
  }
  return 0;
}

/** Angekündigte Kriegserklärung: betritt die Armee Gebiet einer dieser Nationen, beginnt der Krieg. */
function declareOnArrival(ctx: MilitaryContext, a: Army): void {
  if (!a.warOn?.length || isSea(ctx.map, a.node)) return;
  const owner = ctx.state.provinces[a.node].owner;
  if (owner === a.owner || !a.warOn.includes(owner) || atWar(ctx.state, a.owner, owner)) return;
  const name = (id: string) => ctx.map.nations.find((n) => n.id === id)?.name ?? id;
  setRelation(ctx.state, a.owner, owner, 'war');
  noteWarDeclaration(ctx.state, a.owner);
  ctx.log(`${name(a.owner)} erklärt ${name(owner)} den Krieg!`);
  ctx.invalidate();
}

/**
 * Ankunft in einem laufenden Kampf: mit den eigenen Truppen in Nahkampfreichweite zu einem Verband
 * verschmelzen (Regeln wie mergeNearby). Am Ort bleibt die größte Armee ohne eigenen Marschbefehl; wer
 * nur durchzieht, kämpft als Teil mit und zieht danach mit seinem Anteil weiter (splitParts) – die
 * Truppen am Ort gehen also nicht mit. Die Nachrücker kämpfen in der nächsten Runde der Schlacht mit.
 */
function joinBattle(ctx: MilitaryContext, a: Army): void {
  const { state, map } = ctx;
  if (!mergeable(a)) return;
  const own = [a, ...comrades(state, map, a).filter((b) => isNaval(b) === isNaval(a) && mergeable(b))];
  if (own.length < 2) return;
  const [into, ...rest] = [...own].sort(headOrder);
  for (const b of rest) absorb(state, into, b);
  ctx.invalidate();
}

/**
 * Eigene stehende Armeen, die zu `a` gehören: im Umkreis von MILITARY.meleeKm oder in derselben Schlacht
 * (im Nahkampf mit demselben Gegner) – wer von zwei Seiten an eine Stadt heranrückt, hält je 1 km vor dem
 * Gegner an und steht dann bis zu 2 km vom anderen entfernt.
 */
function comrades(state: GameState, map: MapData, a: Army, cells = standingCells(state, map)): Army[] {
  const set = new Set<Army>();
  const add = (list: Army[]) => {
    for (const b of list) if (b !== a && b.owner === a.owner && !b.move && unitCount(b) > 0) set.add(b);
  };
  const pa = armyPosition(map, a, state.time);
  add(standingNear(state, map, pa, cells));
  // gemeinsamer Gegner: nur nötig, wenn überhaupt eine eigene stehende Armee bis 2 km entfernt ist
  if (ownWithin(state, map, a, pa, 2 * MILITARY.meleeKm, cells)) {
    for (const foe of hostileNear(state, map, a, pa, cells)) add(standingNear(state, map, armyPosition(map, foe, state.time), cells));
  }
  return [...set];
}

/** Gibt es eine andere eigene stehende Armee höchstens `km` entfernt (km bis 2 × Rasterweite)? */
function ownWithin(state: GameState, map: MapData, a: Army, p: [number, number], km: number, cells: Map<number, Army[]>): boolean {
  const cx = cellOf(p[0]), cy = cellOf(p[1]);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (const b of cells.get((cx + dx) * 100000 + cy + dy) ?? []) {
        if (b === a || b.owner !== a.owner || b.move) continue;
        const q = standingPosition(map, b);
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= km) return true;
      }
    }
  }
  return false;
}

/** Darf automatisch in einen Verband aufgenommen werden (nicht vom Spieler abgeteilt, ohne Angriffsziel) */
function mergeable(a: Army): boolean {
  return !a.keepApart && attackTarget(a) == null && a.target == null && unitCount(a) > 0;
}

/** Wer im Verband vorne steht (und am Ort bleibt): ohne eigenen Marschbefehl zuerst, dann die größte */
function headOrder(x: Army, y: Army): number {
  return Number(!!x.resume) - Number(!!y.resume) || unitCount(y) - unitCount(x) || x.id - y.id;
}

/**
 * Begegnungen (jede Minute): Armeen, die auf demselben Weg aneinander vorbeiziehen, sich überholen oder
 * auf eine dort stehende Armee treffen, bleiben am Treffpunkt stehen und kämpfen – im Krieg überall, an
 * Land auch im Frieden (dann beginnt der Krieg). Nur Durchmarschrecht und Bündnis (geteilte Karte) lassen
 * sie passieren. Außerdem bleiben marschierende Armeen stehen, sobald sie einer Armee im Krieg auf
 * Nahkampfreichweite (MILITARY.meleeKm) nahe kommen – auch auf anderen Wegen, vor Städten und auf See.
 * Liefert true, wenn es eine Begegnung gab.
 */
export function encounters(ctx: MilitaryContext): boolean {
  const { state, map } = ctx;
  const N = nodeCount(map);
  type Entry = { a: Army; f0: number; f1: number };
  const byEdge = new Map<number, Entry[]>();
  for (const a of state.armies) {
    let u: number, v: number, f0: number, f1: number;
    if (a.move) {
      const m = a.move;
      u = m.path[m.seg];
      v = m.path[m.seg + 1];
      f1 = moveFrac(a, state.time);
      f0 = moveFrac(a, Math.max(m.segStart, state.time - MINUTE));
    } else if (a.pos) {
      u = a.pos.a;
      v = a.pos.b;
      f0 = f1 = a.pos.f;
    } else continue;
    if (u > v) [u, v, f0, f1] = [v, u, 1 - f0, 1 - f1];
    const key = u * N + v;
    (byEdge.get(key) ?? byEdge.set(key, []).get(key)!).push({ a, f0, f1 });
  }
  let met = false;
  for (const [key, list] of byEdge) {
    if (list.length < 2) continue;
    const u = Math.floor(key / N), v = key % N;
    const land = !isSea(map, u) && !isSea(map, v);
    const len = edgeParts(map, u, v)[1];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (A.a.owner === B.a.owner || unitCount(A.a) === 0 || unitCount(B.a) === 0) continue;
        if (!atWar(state, A.a.owner, B.a.owner) && (!land || hasRightOfWay(state, A.a.owner, B.a.owner))) continue;
        const d0 = A.f0 - B.f0, d1 = A.f1 - B.f1;
        // schon beisammen (z. B. Rückzug aus dem Kampf) oder kein Kreuzen und keine Annäherung bis auf meleeKm
        if (d0 === 0) continue;
        if (d0 * d1 > 0 && (Math.abs(d1) * len > MILITARY.meleeKm || Math.abs(d1) >= Math.abs(d0))) continue;
        const s = d0 === d1 ? 1 : Math.max(0, Math.min(1, d0 / (d0 - d1)));
        const f = A.f0 + (A.f1 - A.f0) * s;
        meet(ctx, A.a, B.a, u, v, f);
        A.f0 = A.f1 = B.f0 = B.f1 = f;
        met = true;
      }
    }
  }
  if (approach(ctx)) met = true;
  return met;
}

/** Lage stehender Armeen (zwischengespeichert, solange sie am selben Punkt stehen) */
const standCache = new WeakMap<Army, { map: MapData; node: number; a: number; b: number; f: number; p: [number, number] }>();
function standingPosition(map: MapData, a: Army): [number, number] {
  const c = standCache.get(a), q = a.pos;
  if (c && c.map === map && c.node === a.node && c.a === (q?.a ?? -1) && c.b === (q?.b ?? -1) && c.f === (q?.f ?? -1)) return c.p;
  const p: [number, number] = q ? edgePoint(map, q.a, q.b, q.f) : nodePos(map, a.node);
  standCache.set(a, { map, node: a.node, a: q?.a ?? -1, b: q?.b ?? -1, f: q?.f ?? -1, p });
  return p;
}

/**
 * Annäherung auf Nahkampfreichweite: eine marschierende Armee, die gerade in den Umkreis einer Armee im
 * Krieg kommt (vor einer Minute noch außerhalb), bleibt stehen – ebenso die andere, falls sie marschiert.
 * Wer schon im Umkreis losmarschiert, wird nicht aufgehalten. Gesucht wird über ein Raster (Zellen = Umkreis).
 */
function approach(ctx: MilitaryContext): boolean {
  const { state, map } = ctx;
  const R = MILITARY.meleeKm;
  // nur Nationen im Krieg (mit Aufständischen auf der Karte alle) können aufeinandertreffen
  const rebels = state.armies.some((b) => b.owner === REBELS);
  const warring = new Map<string, boolean>();
  const inWar = (o: string) => warring.get(o) ?? warring.set(o, rebels || o === REBELS || Object.values(state.relations[o] ?? {}).includes('war')).get(o)!;
  const moving = state.armies.filter((a) => a.move && inWar(a.owner) && unitCount(a) > 0);
  if (!moving.length) return false;
  const cells = standingCells(state, map);
  const now = new Map<Army, [number, number]>();
  const grid = new Map<number, Army[]>();
  for (const a of moving) {
    const p = armyPosition(map, a, state.time);
    now.set(a, p);
    const k = cellOf(p[0]) * 100000 + cellOf(p[1]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(a);
  }
  const pos = (a: Army) => now.get(a) ?? standingPosition(map, a);
  const before = new Map<Army, [number, number]>();
  const prev = (a: Army): [number, number] => {
    if (!a.move) return pos(a);
    let p = before.get(a);
    if (!p) before.set(a, (p = armyPosition(map, a, Math.max(a.move.segStart, state.time - MINUTE))));
    return p;
  };
  const d = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  // Gegner im Krieg, der gerade erst in den Umkreis gekommen ist (vor einer Minute noch draußen)
  const fresh = (a: Army, b: Army) => b !== a && b.owner !== a.owner && unitCount(b) > 0 && atWar(state, a.owner, b.owner)
    && d(prev(a), prev(b)) > R;
  let met = false;
  for (const a of moving) {
    if (!a.move) continue;
    const pa = now.get(a)!;
    let hit: Army | null = standingNear(state, map, pa, cells).find((b) => fresh(a, b)) ?? null;
    if (!hit) {
      const cx = cellOf(pa[0]), cy = cellOf(pa[1]);
      for (let dx = -1; dx <= 1 && !hit; dx++) {
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (const b of grid.get((cx + dx) * 100000 + cy + dy) ?? []) {
            if (b.move && now.has(b) && d(pa, now.get(b)!) <= R && fresh(a, b)) { hit = b; break; }
          }
        }
      }
    }
    if (!hit) continue;
    // Zeitpunkt innerhalb der letzten Minute, an dem der Umkreis erreicht wurde (dort anhalten, nicht mittendrin)
    const posAt = (x: Army, t: number) => (x.move ? armyPosition(map, x, t) : pos(x));
    let lo = Math.max(a.move.segStart, hit.move?.segStart ?? 0, state.time - MINUTE), hi = state.time;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (d(posAt(a, mid), posAt(hit, mid)) <= R) hi = mid;
      else lo = mid;
    }
    for (const x of [a, hit]) {
      if (!x.move) continue;
      halt(map, x, Math.round(hi), true, true);
      now.delete(x);
    }
    const at = a.node, province = isSea(map, at) ? undefined : at;
    for (const x of [a, hit]) {
      if (x.owner !== REBELS) ctx.log(`Kampf bei ${nodeName(map, at)}.`, x.owner, province);
      joinBattle(ctx, x);
    }
    ctx.invalidate();
    met = true;
  }
  return met;
}

/** Zwei Armeen treffen auf dem Weg u–v beim Anteil f aufeinander und bleiben dort stehen. */
function meet(ctx: MilitaryContext, x: Army, y: Army, u: number, v: number, f: number): void {
  const { state, map } = ctx;
  for (const a of [x, y]) {
    interrupt(map, a);
    if (f <= ROAD_EPS || f >= 1 - ROAD_EPS) {
      a.node = f < 0.5 ? u : v;
      a.pos = null;
    } else {
      a.node = f < 0.5 ? u : v;
      a.pos = { a: u, b: v, f };
    }
  }
  const at = x.node;
  const province = isSea(map, at) ? undefined : at;
  if (!atWar(state, x.owner, y.owner)) {
    const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
    setRelation(state, x.owner, y.owner, 'war');
    ctx.log(`Zusammenstoß bei ${nodeName(map, at)}: ${name(x.owner)} und ${name(y.owner)} sind im Krieg!`);
  }
  for (const a of [x, y]) {
    if (a.owner !== REBELS) ctx.log(`Kampf bei ${nodeName(map, at)}: Truppen treffen auf dem Weg aufeinander.`, a.owner, province);
    joinBattle(ctx, a);
  }
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
  if (from.kills) into.kills = (into.kills ?? 0) + from.kills;
  if (!into.name && from.name) into.name = from.name;
  for (const u of unitTypes(from)) {
    into.units[u] = (into.units[u] ?? 0) + from.units[u]!;
    if (from.wounds?.[u]) (into.wounds ??= {})[u] = Math.max(into.wounds?.[u] ?? 0, from.wounds[u]!);
  }
  state.armies = state.armies.filter((x) => x !== from);
  // von `from` abgeteilte Armeen bleiben getrennt von dem Verband, in dem sie aufgeht
  for (const x of state.armies) {
    if (x.apartFrom !== from.id) continue;
    if (x === into) delete x.apartFrom;
    else x.apartFrom = into.id;
  }
}

/** Frisch abgeteilt: `a` stammt von `b` oder umgekehrt (siehe Army.apartFrom) */
function apart(a: Army, b: Army): boolean {
  return a.apartFrom === b.id || b.apartFrom === a.id;
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
  const m = troopMorale(a), pts = TROOP_MORALE.strength;
  if (m <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const [m0, s0] = pts[k - 1], [m1, s1] = pts[k];
    if (m <= m1) return s0 + ((s1 - s0) * (m - m0)) / (m1 - m0);
  }
  return pts[pts.length - 1][1];
}

export interface TroopTarget {
  target: number;
  parts: { label: string; value: number }[];
  hungry: boolean;
}

/**
 * Zielmoral der Infanterie (zum Tageswechsel): stehend in eigener Provinz deren Moral, sonst neutral;
 * Getreidemangel senkt das Ziel.
 */
export function troopTarget(state: GameState, map: MapData, a: Army): TroopTarget {
  const n = state.nations[a.owner];
  const hungry = !n || n.stock.grain < 1 || n.shortage.food;
  // maßgeblich ist das Gebiet, in dem die Armee gerade ist (auch unterwegs): eigenes → dessen Moral
  const prov = currentProvince(map, a, state.time);
  const home = prov >= 0 && state.provinces[prov].owner === a.owner;
  const parts = [home
    ? { label: `Moral der Provinz ${map.provinces[prov].name}`, value: state.provinces[prov].morale }
    : { label: prov >= 0 ? 'Fremdes Gebiet' : 'Auf See', value: TROOP_MORALE.neutral }];
  if (hungry) parts.push({ label: 'Getreidemangel', value: -TROOP_MORALE.hungerTarget });
  const sum = parts.reduce((s, p) => s + p.value, 0);
  return { target: Math.max(TROOP_MORALE.min, Math.min(1, sum)), parts, hungry };
}

/**
 * Moral der Infanterie nach einem Tageswechsel, nie über das Ziel hinaus: höchstens +10 % bzw. −8 %;
 * bei Getreidemangel fällt sie 5 Punkte schneller (−13 %) und steigt 5 Punkte langsamer (+5 %).
 */
export function nextTroopMorale(m: number, t: TroopTarget): number {
  const gap = t.target - m;
  const hunger = t.hungry ? TROOP_MORALE.hunger : 0;
  const max = gap >= 0 ? TROOP_MORALE.rise.max - hunger : TROOP_MORALE.fall.max + hunger;
  return Math.max(TROOP_MORALE.min, Math.min(1, m + Math.sign(gap) * Math.min(Math.abs(gap), max)));
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

/**
 * Schaden zufällig auf die Einheiten einer Armee verteilen: jeder Treffer gilt einer ausgewürfelten
 * Einheit (jede Einheit gleich wahrscheinlich, viele Infanteristen schützen also teure Technik) und trifft
 * sie, bis sie fällt oder der Schaden aufgebraucht ist. Angeschlagene Einheiten behalten ihre Wunden.
 */
export function applyDamage(a: Army, dmg: number, random: () => number, keep = 0, map?: MapData): void {
  let rest = dmg;
  while (rest > 1e-9) {
    const types = unitTypes(a);
    const total = types.reduce((s, u) => s + a.units[u]!, 0);
    if (total <= 0) return;
    let r = random() * total, u = types[types.length - 1];
    for (const t of types) if ((r -= a.units[t]!) < 0) { u = t; break; }
    const hp = unitHp(a, u, map);
    const w = a.wounds?.[u] ?? 0;
    // ist die Moral gefallen, kann die Wunde schon über den Lebenspunkten liegen: dann fällt die Einheit
    const hit = Math.max(0, Math.min(rest, hp - w));
    // die letzten `keep` Einheiten fallen nicht (Beschuss allein räumt keine Stadt)
    if (total <= keep && w + hit >= hp - 1e-9) return;
    rest -= hit;
    if (w + hit >= hp - 1e-9) {
      a.units[u] = a.units[u]! - 1;
      if (a.wounds) a.wounds[u] = 0;
      if (!a.units[u]) {
        delete a.units[u];
        if (a.wounds) delete a.wounds[u];
      }
    } else (a.wounds ??= {})[u] = w + hit;
  }
}

/**
 * Lebenspunkte einer Einheit: Infanterie nach Moral wie ihre Kampfkraft (1,2 × Moral: 10 % → 0,12-fach … 100 % → 1,2-fach);
 * Landtruppen auf See und beim Ein-/Ausschiffen halb (mit `map`; Schlachtschiffe voll).
 */
export function unitHp(a: Army, u: UnitType, map?: MapData): number {
  const sea = !UNITS[u].naval && (!!a.boarding || (map !== undefined && isSea(map, a.node)));
  return UNITS[u].hp * (u === 'infantry' ? infantryStrength(a) : 1) * (sea ? MILITARY.seaHpFactor : 1);
}

/** Tageswechsel: Maschinen außerhalb von Kämpfen bekommen einen Teil ihrer fehlenden Lebenspunkte zurück */
export function repairMachines(state: GameState, map: MapData): void {
  for (const a of state.armies) {
    if (!a.wounds || inMelee(state, map, a) || (a.forcedMarch && a.move)) continue;
    for (const u of Object.keys(a.wounds) as UnitType[]) {
      if (u === 'infantry' || !a.wounds[u]) continue;
      const w = a.wounds[u]!;
      const heal = Math.max(w * MILITARY.repairShare, UNITS[u].hp * MILITARY.repairMin);
      if (heal >= w - 1e-6) delete a.wounds[u];
      else a.wounds[u] = w - heal;
    }
  }
}

/** Summe der Nahkampfgewichte der Plätze 1..n (bis meleeFull je 1, dann linear fallend, nach meleeMax 0) */
function meleeWeight(n: number): number {
  const full = MILITARY.meleeFull, max = MILITARY.meleeMax, span = max - full + 1;
  if (n <= full) return Math.max(0, n);
  const m = Math.min(n, max);
  // Platz k (full < k ≤ max) zählt (max + 1 − k) / span
  let s = full;
  for (let k = full + 1; k <= m; k++) s += (max + 1 - k) / span;
  return s;
}

/** Kampfkraft-Faktor: Infanterie nach Moral; Maschinen kämpfen immer voll, unabhängig vom Zustand. */
function soldierFactor(a: Army, u: UnitType): number {
  return u === 'infantry' ? infantryStrength(a) : 1;
}

export function meleeOutput(state: GameState, map: MapData, a: Army): number {
  // auf See und beim Ein-/Ausschiffen kämpfen Landeinheiten mit halber Stärke
  const sea = isSea(map, a.node) || !!a.boarding;
  const defending = !sea && state.provinces[a.node].owner === a.owner;
  return meleePower(a, map, defending, sea);
}

/**
 * Nahkampfschaden je Kampfrunde (ohne Zufallsstreuung und Festung): mit Angriffs- bzw. Verteidigungswerten
 * (Maschinen gleich, Infanterie in eigenen Provinzen +10 %), Infanterie nach aktueller Moral, Artillerie und
 * Eisenbahngeschütze halb, auf See Landeinheiten halb; nur die vordersten
 * Plätze zählen voll (meleeWeight). Diesen Schaden bekommt jede gegnerische Armee im Umkreis.
 */
export function meleePower(a: Army, map: MapData, defending: boolean, sea = false): number {
  // Nahkampfwert je Einheit; die stärksten kämpfen vorne, nur die ersten Plätze zählen (siehe meleeWeight)
  const per = unitTypes(a).map((u) => {
    const d = UNITS[u];
    return {
      n: a.units[u]!,
      v: (defending ? d.defense : d.attack) * (!d.naval && unitRange(a, u, map) > 0 ? MILITARY.meleeRangedFactor : 1)
        * (sea && !d.naval ? MILITARY.seaFactor : 1) * soldierFactor(a, u),
    };
  }).sort((x, y) => y.v - x.v);
  let out = 0, rank = 0;
  for (const { n, v } of per) {
    out += v * (meleeWeight(rank + n) - meleeWeight(rank));
    rank += n;
  }
  return out;
}

/** Moralwirkung einer Kampfstunde je Armee (Nah- und Fernkampf zusammen), siehe applyCombatMorale */
export type CombatTally = Map<Army, { foes: number; shelled: boolean; kills: number; boost?: number }>;

function tallyOf(t: CombatTally, a: Army) {
  let e = t.get(a);
  if (!e) t.set(a, (e = { foes: 0, shelled: false, kills: 0 }));
  return e;
}

/**
 * Moral der Infanterie nach einer Kampfstunde.
 * Mechanik 1: Nahkampf −2 %, gegen mehrere Armeen −1 % mehr, beschossen −2 %, zusammen höchstens
 * TROOP_MORALE.lossMax – egal wie viele Armeen angreifen oder schießen. Abschüsse bringen bis killMax zurück
 * (im Nahkampf also netto höchstens +2 %, ein Schütze ohne Gegenwehr bis +4 %).
 * Mechanik 2: siehe COMBAT_MORALE_V2.
 */
export function applyCombatMorale(t: CombatTally, mode: CombatMoraleMode = DEFAULT_COMBAT_MORALE): void {
  for (const [a, e] of t) {
    if (mode === 2) {
      const v = COMBAT_MORALE_V2;
      let loss = e.foes > 0 || e.shelled ? v.base : 0;
      if (e.foes > 1 || (e.foes > 0 && e.shelled)) loss += v.extra;
      shiftMorale(a, killPoints2(e.kills) * 0.01 - Math.min(v.lossMax, loss) + (e.boost ?? 0));
      continue;
    }
    let loss = 0;
    if (e.foes > 0) loss += TROOP_MORALE.melee + (e.foes > 1 ? TROOP_MORALE.outnumbered : 0);
    if (e.shelled) loss += TROOP_MORALE.shelled;
    const gain = Math.min(TROOP_MORALE.killMax, e.kills * TROOP_MORALE.perKill);
    // Übermacht wirkt zusätzlich, außerhalb der Rundengrenzen
    shiftMorale(a, gain - Math.min(TROOP_MORALE.lossMax, loss) + (e.boost ?? 0));
  }
}

/**
 * Übermacht im Nahkampf (vor dem Schaden der Runde): Schlachten sind zusammenhängende Gruppen von Armeen im
 * Nahkampf. Je Armee zählt ihre Seite (sie und alle, mit denen sie nicht im Krieg ist) gegen alle Gegner der
 * Schlacht, nach Einheitenzahl. Mindestens SUPERIORITY.ratio-fach und um minGap Einheiten überlegen: +boost,
 * ebenso unterlegen: −malus.
 */
function superiority(state: GameState, t: CombatTally, foesOf: Map<Army, Army[]>): void {
  const parent = new Map<Army, Army>();
  const find = (x: Army): Army => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, foes] of foesOf) {
    for (const x of [a, ...foes]) if (!parent.has(x)) parent.set(x, x);
    for (const b of foes) parent.set(find(b), find(a));
  }
  const groups = new Map<Army, Army[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(x);
  }
  for (const group of groups.values()) {
    for (const a of group) {
      let own = 0, enemy = 0;
      for (const x of group) {
        if (atWar(state, a.owner, x.owner)) enemy += unitCount(x);
        else own += unitCount(x);
      }
      if (!enemy || !own) continue;
      const e = tallyOf(t, a);
      const s = SUPERIORITY;
      if (own >= s.ratio * enemy && own - enemy >= s.minGap) e.boost = (e.boost ?? 0) + s.boost;
      else if (enemy >= s.ratio * own && enemy - own >= s.minGap) e.boost = (e.boost ?? 0) - s.malus;
    }
  }
}

/** Mechanik 2: Moralpunkte aus (gewichteten) Abschüssen einer Runde – 1, 2, 3, dann je 2 Abschüsse ein Punkt, abgerundet */
export function killPoints2(kills: number): number {
  const v = COMBAT_MORALE_V2;
  const k = Math.floor(kills + 1e-9);
  return Math.min(k, v.fullKills) + Math.min(v.maxPoints - v.fullKills, Math.floor(Math.max(0, k - v.fullKills) / v.killsPerExtra));
}

/** Flächenschaden: alle Armeen im Krieg mit `owner` im Umkreis von MILITARY.meleeKm um `pos` */
function splashTargets(state: GameState, map: MapData, owner: string, pos: [number, number]): Army[] {
  return state.armies.filter((b) => {
    if (unitCount(b) === 0 || !atWar(state, owner, b.owner)) return false;
    const p = armyPosition(map, b, state.time);
    return Math.hypot(p[0] - pos[0], p[1] - pos[1]) <= MILITARY.meleeKm;
  });
}

/**
 * Steht die Armee in einer Stadt ihrer Seite (eigene oder nicht verfeindete) und hat ihre Seite (sie und alle,
 * mit denen sie nicht im Krieg ist) dort sonst keine Einheiten? Dann lässt Beschuss ihre letzte Einheit
 * stehen – Städte fallen nur im Nahkampf.
 */
function lastInCity(state: GameState, map: MapData, b: Army): boolean {
  if (b.pos || isSea(map, b.node) || atWar(state, b.owner, state.provinces[b.node].owner)) return false;
  return !state.armies.some((x) => x !== b && x.node === b.node && !x.pos && unitCount(x) > 0 && !atWar(state, b.owner, x.owner));
}

/** Vernichtete Armeen an allen getroffenen Orten entfernen (Meldung, Eroberung) */
function cleanupHit(ctx: MilitaryContext, nodes: Iterable<number>, names: Map<Army, string>, victors: Map<Army, string>): void {
  for (const n of new Set(nodes)) cleanup(ctx, n, names, victors);
}

/**
 * Eine Kampfrunde (stündlich): jede stehende Armee kämpft mit allen stehenden Feinden in Nahkampfreichweite
 * (MILITARY.meleeKm) und trifft jede davon mit voller Kraft (Flächenschaden) – Aufteilen schützt also nicht.
 * Fernkampfeinheiten in diesem Umkreis kämpfen mit. Ohne `tally` wird die Moral sofort angewendet, sonst
 * gesammelt (zusammen mit dem Fernkampf derselben Stunde).
 */
export function combatRound(ctx: MilitaryContext, tally?: CombatTally): void {
  const { state, map } = ctx;
  const t: CombatTally = tally ?? new Map();
  const standing = state.armies.filter((a) => !a.move && unitCount(a) > 0);
  const cells = standingCells(state, map);
  const damage = new Map<Army, number>();
  // wer wem wie viel Schaden zufügt (für die Moral durch Vernichtung und den Sieger)
  const dealt = new Map<Army, Map<Army, number>>();
  const provinces = new Set<number>();
  const foesOf = new Map<Army, Army[]>();
  for (const a of standing) {
    const foes = hostileNear(state, map, a, undefined, cells);
    if (!foes.length) continue;
    foesOf.set(a, foes);
    tallyOf(t, a).foes = foes.length;
    const out = meleeOutput(state, map, a) * spread(ctx);
    const mine = new Map<Army, number>();
    for (const b of foes) {
      damage.set(b, (damage.get(b) ?? 0) + out);
      mine.set(b, out);
    }
    dealt.set(a, mine);
    const prov = a.pos ? roadProvince(map, a.pos) : isSea(map, a.node) ? -1 : a.node;
    if (prov >= 0) provinces.add(prov);
  }
  if (dealt.size && state.superiority !== false) superiority(state, t, foesOf);
  if (dealt.size) {
    const before = new Map([...damage.keys()].map((b) => [b, unitCount(b)]));
    const names = new Map([...dealt.keys(), ...damage.keys()].map((x) => [x, armyName(x)]));
    for (const [b, dmg] of damage) applyDamage(b, dmg * fortressShield(state, map, b), ctx.random, 0, map);
    // vernichtete Gegner stärken die Moral (angewendet mit dem Fernkampf derselben Stunde)
    for (const [a, mine] of dealt) {
      let kills = 0;
      for (const [b, d] of mine) kills += (before.get(b)! - unitCount(b)) * (d / Math.max(1e-9, damage.get(b)!));
      if (kills > 0) a.kills = (a.kills ?? 0) + kills;
      tallyOf(t, a).kills += kills;
    }
    for (const prov of provinces) {
      damageBuildings(ctx, prov);
      markFight(state, prov);
    }
    // Sieger einer vernichteten Armee: die feindliche Seite mit dem meisten Schaden an ihr
    const victors = new Map<Army, string>();
    for (const b of damage.keys()) {
      let best: Army | null = null, bd = -1;
      for (const [a, mine] of dealt) if ((mine.get(b) ?? 0) > bd) { bd = mine.get(b) ?? 0; best = a; }
      if (best) victors.set(b, best.owner);
    }
    cleanupHit(ctx, [...names.keys()].map((x) => x.node), names, victors);
  }
  if (!tally) applyCombatMorale(t, state.combatMorale ?? DEFAULT_COMBAT_MORALE);
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
  return distance(map, a, t, state.time) <= maxRange(a, map) ? t : null;
}

/** Marsch anhalten: die Armee bleibt genau dort stehen, wo sie ist (auch mitten auf dem Weg). */
export function halt(map: MapData, a: Army, time: number, keepOrder = false, exact = false): void {
  if (!a.move) return;
  // exact: genau dort (Anhalten am Rand der Nahkampfreichweite), sonst rastet ein Punkt nahe einem Ende auf den Knoten ein
  const f = moveFrac(a, time);
  const loc: MoveTarget = exact && f > 1e-6 && f < 1 - 1e-6 ? { road: { a: a.move.path[a.move.seg], b: a.move.path[a.move.seg + 1], f } } : armyLocation(a, time);
  const t = keepOrder ? finalTarget(a) : null;
  a.boarding = (keepOrder && isBoarding(map, a)) || undefined;
  a.node = nearestNode(map, a, time);
  a.pos = 'road' in loc ? loc.road : null;
  a.move = null;
  a.resume = t;
}

/**
 * Fernkampf erfassen (alle 10 Spielminuten): Einheiten mit Reichweite nehmen Feinde in Reichweite
 * sofort ins Visier und bleiben dafür stehen. Gemischte Armeen auf dem Marsch ziehen weiter.
 */
export function engageRanged(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  for (const a of state.armies) {
    const range = maxRange(a, map);
    if (range <= 0 || unitCount(a) === 0) continue;
    if (a.target != null) {
      const t = state.armies.find((b) => b.id === a.target);
      if (!t || unitCount(t) === 0 || !atWar(state, a.owner, t.owner)) {
        a.target = null;
        a.autoTarget = false;
      } else if (distance(map, a, t, state.time) <= range) {
        // ausdrückliches Ziel: die Verfolgung endet hier; selbständig erfasst: danach weiter zum Marschziel
        halt(map, a, state.time, !!a.autoTarget, true);
        continue;
      } else if (a.autoTarget) {
        a.target = null;
        a.autoTarget = false;
      } else continue; // ausdrückliches Ziel außer Reichweite: wird verfolgt (pursue)
    }
    // im Marsch nur im Angriffsmarsch selbständig anhalten; im Stand immer
    if (a.move && !a.aggressive) continue;
    let best: Army | undefined, bd = Infinity;
    for (const b of state.armies) {
      if (!atWar(state, a.owner, b.owner) || unitCount(b) === 0) continue;
      const d = distance(map, a, b, state.time);
      if (d <= range && d < bd) { bd = d; best = b; }
    }
    if (!best) continue;
    a.target = best.id;
    a.autoTarget = true;
    halt(map, a, state.time, true);
  }
}

/**
 * Fernkampf: Artillerie, Eisenbahngeschütze und Schlachtschiffe beschießen ihr Ziel in Reichweite (stündlich).
 * Jeder Treffer gilt voll für alle gegnerischen Armeen im Umkreis des Ziels (Flächenschaden).
 */
export function rangedRound(ctx: MilitaryContext, tally?: CombatTally): void {
  const { state, map } = ctx;
  const t: CombatTally = tally ?? new Map();
  for (const a of [...state.armies]) {
    const range = maxRange(a, map);
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
      // ausdrückliches Ziel außer Reichweite: wird verfolgt (pursue), selbständig erfasstes aufgegeben
      if (a.autoTarget) {
        a.target = null;
        a.autoTarget = false;
      }
      continue;
    }
    if (!target) continue;
    if (a.move) halt(map, a, state.time, true); // in Reichweite: stehen bleiben und feuern, danach weiter
    // auf See schießen nur Schiffe (Landeinheiten haben dort keine Reichweite)
    let out = 0;
    for (const u of unitTypes(a)) {
      if (unitRange(a, u, map) > 0) out += a.units[u]! * UNITS[u].attack;
    }
    const victims = splashTargets(state, map, a.owner, armyPosition(map, target, state.time));
    if (!victims.includes(target)) victims.push(target);
    const before = new Map(victims.map((b) => [b, unitCount(b)]));
    const names = new Map(victims.map((b) => [b, armyName(b)]));
    const hit = out * spread(ctx);
    for (const b of victims) {
      applyDamage(b, hit * fortressShield(state, map, b), ctx.random, lastInCity(state, map, b) ? 1 : 0, map);
      // beschossen werden zehrt an der Moral (einmal je Stunde, egal wie viele Schützen)
      tallyOf(t, b).shelled = true;
      const prov = b.pos ? roadProvince(map, b.pos) : isSea(map, b.node) ? -1 : b.node;
      if (prov >= 0) markFight(state, prov);
    }
    const kills = victims.reduce((k, b) => k + before.get(b)! - unitCount(b), 0);
    if (kills > 0) a.kills = (a.kills ?? 0) + kills;
    tallyOf(t, a).kills += kills;
    cleanupHit(ctx, victims.map((b) => b.node), names, new Map(victims.map((b) => [b, a.owner])));
  }
  if (!tally) applyCombatMorale(t, state.combatMorale ?? DEFAULT_COMBAT_MORALE);
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
  // stehende Truppen in Nahkampfreichweite der Stadt zählen (auch auf einem Weg dicht davor)
  const city = nodePos(map, node);
  const here = state.armies.filter((x) => {
    if (x.move) return false;
    const p = armyPosition(map, x, state.time);
    return Math.hypot(p[0] - city[0], p[1] - city[1]) <= MILITARY.meleeKm;
  });
  const owners = [...new Set(here.map((x) => x.owner))];
  // solange sich noch Verfeindete gegenüberstehen, geht der Kampf weiter
  if (owners.some((o) => owners.some((q) => atWar(state, o, q)))) return;
  if (owners.length === 1 && owners[0] === REBELS) {
    ps.revolt = true;
    return;
  }
  if (owners.includes(ps.owner)) return;
  // mehrere Angreifer, die untereinander nicht verfeindet sind: die stärkste verbliebene Landstreitmacht erobert
  const power = new Map<string, number>();
  for (const h of here) {
    if (isNaval(h) || h.owner === REBELS || !atWar(state, h.owner, ps.owner)) continue;
    power.set(h.owner, (power.get(h.owner) ?? 0) + armyPower(h));
  }
  if (!power.size) return;
  const winner = [...power].reduce((b, e) => (e[1] > b[1] ? e : b))[0];
  conquer(ctx, node, winner);
}

/** Provinz, in deren Gebiet die Armee gerade steht oder marschiert; -1 auf See */
export function currentProvince(map: MapData, a: Army, time: number): number {
  const loc = armyLocation(a, time);
  if ('road' in loc) return roadProvince(map, loc.road);
  return isSea(map, loc.node) ? -1 : loc.node;
}

/** Provinz, in deren Gebiet ein Wegpunkt liegt (vor oder hinter der Grenze); -1 auf dem Wasser */
function roadProvince(map: MapData, p: RoadPos): number {
  const [l1, len] = edgeParts(map, p.a, p.b);
  const first = p.f * len <= l1 ? p.a : p.b, other = first === p.a ? p.b : p.a;
  if (!isSea(map, first)) return first;
  return isSea(map, other) ? -1 : other;
}

/** Kämpfe in einer Provinz beschädigen Gebäude: je Stunde und Gebäude eine Chance, eine Stufe zu verlieren. */
export function damageBuildings(ctx: MilitaryContext, node: number): void {
  const ps = ctx.state.provinces[node];
  for (const b of Object.keys(ps.buildings) as Building[]) {
    if (ps.buildings[b] <= 0 || ctx.random() >= BUILDING_DAMAGE_CHANCE) continue;
    // ein Treffer kostet ein Leben der obersten Stufe; ohne Leben fällt die Stufe weg (die darunter ist heil)
    const name = BUILDINGS[b].name, place = ctx.map.provinces[node].name;
    const lost = (ps.damage?.[b] ?? 0) + 1;
    if (lost >= buildingLives(b)) {
      ps.buildings[b]--;
      if (ps.damage) delete ps.damage[b];
      ctx.log(ps.buildings[b] === 0 ? `${name} in ${place} im Kampf zerstört.`
        : `${name} in ${place}: Stufe ${ps.buildings[b] + 1} zerstört, jetzt Stufe ${ps.buildings[b]}.`, ps.owner, node);
    } else {
      (ps.damage ??= {})[b] = lost;
      ctx.log(`${name} in ${place} beschädigt (${buildingLives(b) - lost}/${buildingLives(b)} Leben) – ohne Wirkung, bis repariert.`, ps.owner, node);
    }
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
  // eroberte Provinzen beginnen bei 25 %; holt der Vorbesitzer sie am selben Tag zurück, bei 40 %
  const day = Math.floor(state.time / DAY);
  ps.morale = ps.lost && ps.lost.owner === by && ps.lost.day === day ? DEFECTION.morale : MILITARY.conquestMorale;
  ps.lost = { owner: old, day };
  const move = state.nations[old]?.capitalMove;
  if (move && move.province === node) {
    state.nations[old].capitalMove = null;
    ctx.log(`Die Verlegung der Hauptstadt nach ${mp.name} ist gescheitert.`, old, node);
  }
  const byName = map.nations.find((n) => n.id === by)?.name ?? by;
  const oldName = map.nations.find((n) => n.id === old)?.name ?? old;
  ctx.log(`${mp.name} wurde von ${byName} erobert.`, old, node);
  ctx.log(`Wir haben ${mp.name} erobert.`, by, node);
  const capitalFall = state.nations[old] !== undefined && activeCapital(state, map, old) === node;
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
    eliminate(state, old);
    ctx.log(`${oldName} hat aufgehört zu existieren.`);
  }
  ctx.invalidateRates?.();
  // die Eroberer im Umkreis (stehende Landtruppen) rücken in die Stadt ein; weitere Marschbefehle danach
  // gehen nach der Besatzungsregel (eine Einheit bleibt, eine einzelne letzte bleibt ganz)
  const city = nodePos(map, node);
  for (const a of state.armies) {
    if (a.owner !== by || a.move || isNaval(a) || unitCount(a) === 0) continue;
    const p = armyPosition(map, a, state.time);
    if (Math.hypot(p[0] - city[0], p[1] - city[1]) > MILITARY.meleeKm) continue;
    a.node = node;
    a.pos = null;
  }
  ctx.invalidate();
}

/**
 * Eine Nation ist untergegangen: ihre Armeen, diplomatischen Angebote (von ihr und an sie),
 * Börsenangebote und eine laufende Hauptstadtverlegung verschwinden.
 */
export function eliminate(state: GameState, nation: string): void {
  const n = state.nations[nation];
  if (n) {
    n.alive = false;
    n.capitalMove = null;
  }
  state.armies = state.armies.filter((a) => a.owner !== nation);
  state.proposals = state.proposals.filter((p) => p.from !== nation && p.to !== nation);
  state.market.offers = state.market.offers.filter((o) => o.nation !== nation);
}

// ---------------------------------------------------------------- Wiedervereinigung

/**
 * Befehl „Eingliedern“: eine abgetrennte Armee, die ohne Befehl am selben Ort wie ihre Ursprungsarmee steht,
 * geht wieder in ihr auf. Ist die Ursprungsarmee fort oder unterwegs, entfällt die Markierung.
 */
export function rejoinSplits(ctx: MilitaryContext, only: number): void {
  const { state, map } = ctx;
  for (const a of [...state.armies]) {
    if (!a.split || a.id !== only) continue;
    // die Ursprungsarmee oder der Verband, in dem sie inzwischen aufgegangen ist
    const from = a.apartFrom ?? a.split.from;
    const origin = state.armies.find((b) => b.id === from && b.owner === a.owner);
    if (!origin || origin.move) {
      a.split = null;
      continue;
    }
    if (a.move || a.target != null || origin.target != null || !samePlace(a, origin) || isNaval(a) !== isNaval(origin)) continue;
    if (inMelee(state, map, a)) continue;
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
    // die Stadt bleibt nie leer: ohne Überläufer stellt der neue Herr eine Infanterie
    if (!kept) {
      turned.infantry = 1;
      kept = 1;
    }
    state.armies.push({ id: ctx.newArmyId(), owner: to, node: i, units: turned, morale: TROOP_MORALE.neutral });

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
      eliminate(state, old);
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

// ---------------------------------------------------------------- Gewaltmarsch, Verfolgung, Verbände

/**
 * Gewaltmarsch (stündlich): marschierende Armeen verlieren MILITARY.forcedMarchWear Moral (Infanterie),
 * Maschinen nehmen diesen Anteil ihrer Lebenspunkte als Schaden und können dabei ausfallen.
 */
export function forcedMarchWear(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  let lost = false;
  for (const a of state.armies) {
    if (!a.move || !a.forcedMarch) continue;
    if (a.units.infantry) shiftMorale(a, -MILITARY.forcedMarchWear);
    for (const u of unitTypes(a)) {
      if (u === 'infantry') continue;
      const hp = UNITS[u].hp;
      let dmg = a.units[u]! * hp * MILITARY.forcedMarchWear;
      while (dmg > 1e-9 && a.units[u]) {
        const w = a.wounds?.[u] ?? 0;
        const hit = Math.min(dmg, hp - w);
        dmg -= hit;
        if (w + hit >= hp - 1e-9) {
          a.units[u] = a.units[u]! - 1;
          if (a.wounds) a.wounds[u] = 0;
          if (!a.units[u]) {
            delete a.units[u];
            if (a.wounds) delete a.wounds[u];
          }
        } else (a.wounds ??= {})[u] = w + hit;
      }
    }
    if (unitCount(a) === 0) {
      ctx.log(`${armyName(a)} hat sich auf dem Gewaltmarsch aufgerieben.`, a.owner, isSea(map, a.node) ? undefined : a.node);
      lost = true;
    }
  }
  if (lost) {
    state.armies = state.armies.filter((a) => unitCount(a) > 0);
    ctx.invalidate();
  }
}

function sameGoal(a: MoveTarget | null, b: MoveTarget): boolean {
  if (!a) return false;
  if ('node' in a || 'node' in b) return 'node' in a && 'node' in b && a.node === b.node;
  const p = a.road, q = b.road;
  return (p.a === q.a && p.b === q.b && Math.abs(p.f - q.f) < 0.02) || (p.a === q.b && p.b === q.a && Math.abs(p.f + q.f - 1) < 0.02);
}

/** Angriffsziel: Verfolgung (Nahkampf) oder ausdrückliches Fernkampfziel */
function attackTarget(a: Army): number | null {
  if (a.chase != null) return a.chase;
  return a.target != null && !a.autoTarget ? a.target : null;
}

/**
 * Verfolgung (alle 10 Spielminuten und sofort beim Angriffsbefehl): Armeen mit Angriffsziel ziehen zum
 * aktuellen Standort des Gegners. Mit Fernkampfeinheiten nur bis in Reichweite (dort feuern sie, siehe
 * engageRanged), sonst bis in den Nahkampf. Läuft der Gegner weg, wird neu geplant.
 */
export function pursue(ctx: MilitaryContext, only?: Army): void {
  const { state, map } = ctx;
  for (const a of only ? [only] : state.armies) {
    const id = attackTarget(a);
    if (id == null || unitCount(a) === 0) continue;
    const t = state.armies.find((b) => b.id === id);
    if (!t || unitCount(t) === 0 || !atWar(state, a.owner, t.owner)) {
      a.chase = null;
      if (a.target === id) a.target = null;
      continue;
    }
    a.resume = null;
    if (inMelee(state, map, a)) continue;
    const range = maxRange(a, map);
    const d = distance(map, a, t, state.time);
    if (range > 0 ? d <= range : d <= MILITARY.meleeKm) continue;
    const goal = normalizeTarget(armyLocation(t, state.time));
    if (a.move && sameGoal(finalTarget(a), goal)) continue;
    const plan = planRoute(state, map, a, state.time, goal);
    if (!plan || plan.path.length < 2) continue;
    if (!a.move && !leaveGarrison(ctx, a)) {
      // einzelne letzte Einheit einer Stadt: bleibt, der Angriffsbefehl verfällt
      a.chase = null;
      if (a.target === id) a.target = null;
      continue;
    }
    a.node = nearestNode(map, a, state.time);
    startMove(ctx, a, plan.path, plan.then, plan);
    ctx.invalidate();
  }
}

/** Teile eines Verbands an den aktuellen Bestand anpassen: Verluste seit dem letzten Abgleich anteilig abziehen */
function rebaseParts(a: Army): void {
  if (!a.parts?.length) return;
  const base = a.partBase ?? {};
  for (const p of a.parts) {
    for (const u of Object.keys(p.units) as UnitType[]) {
      const f = base[u] ? Math.min(1, (a.units[u] ?? 0) / base[u]!) : 0;
      p.units[u] = p.units[u]! * f;
    }
  }
  a.partBase = { ...a.units };
}

/** Eine Armee in den Verband `into` aufnehmen; mit eigenem Marschbefehl wird sie als Teil vorgemerkt */
function absorb(state: GameState, into: Army, b: Army): void {
  rebaseParts(into);
  rebaseParts(b);
  const parts = [...(into.parts ?? []), ...(b.parts ?? [])];
  const own = { ...b.units };
  for (const p of b.parts ?? []) for (const u of Object.keys(p.units) as UnitType[]) own[u] = Math.max(0, (own[u] ?? 0) - p.units[u]!);
  if (b.resume) parts.push({ id: b.id, num: b.num, name: b.name, units: own, resume: b.resume, forcedMarch: b.forcedMarch, aggressive: b.aggressive });
  mergeArmies(state, into, b);
  state.armies = state.armies.filter((x) => x !== b);
  into.parts = parts.length ? parts : null;
  into.partBase = parts.length ? { ...into.units } : null;
}

/**
 * Verbände (alle 10 Spielminuten): stehende Armeen derselben Nation (und Art: Flotte bzw. Landtruppen) im
 * Umkreis von MILITARY.meleeKm oder in derselben Schlacht (gemeinsamer Gegner im Nahkampf) werden zur größten
 * zusammengefasst – im Kampf wie im Stand. Ausgenommen: Armeen mit keepApart oder Angriffsziel; frisch
 * abgeteilte Armeen außerhalb von Kämpfen nicht mit ihrer Ursprungsarmee (Army.apartFrom). Wer einen unterbrochenen Marschbefehl hat, bleibt
 * als Teil vorgemerkt und zieht nach dem Kampf weiter (splitParts).
 */
export function mergeNearby(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  const free = (a: Army) => !a.move && mergeable(a);
  const cand = state.armies.filter(free);
  if (cand.length < 2) return;
  const cells = standingCells(state, map);
  const done = new Set<Army>();
  let merged = false;
  // größte zuerst; ohne eigenen Marschbefehl bevorzugt (sie bleibt am Ort)
  const order = [...cand].sort(headOrder);
  const ok = new Set(cand);
  for (const head of order) {
    if (done.has(head)) continue;
    done.add(head);
    // im Umkreis oder in derselben Schlacht (gemeinsamer Gegner im Nahkampf)
    const near = comrades(state, map, head, cells).filter((b) => !done.has(b) && ok.has(b) && isNaval(b) === isNaval(head));
    // frisch Abgeteilte bleiben außerhalb von Kämpfen getrennt von ihrer Ursprungsarmee (auch über einen Dritten)
    const fighting = near.length > 0 && hostileNear(state, map, head, undefined, cells).length > 0;
    const group = [head];
    for (const b of near) {
      if (!fighting && group.some((g) => apart(g, b))) continue;
      done.add(b);
      absorb(state, head, b);
      group.push(b);
      merged = true;
    }
  }
  if (merged) ctx.invalidate();
}

/** Nach dem Kampf (alle 10 Spielminuten): vorgemerkte Teile mit ihrem Anteil abteilen; sie ziehen weiter (resumeOrders) */
export function splitParts(ctx: MilitaryContext): void {
  const { state, map } = ctx;
  for (const a of [...state.armies]) {
    if (!a.parts?.length || a.move || inMelee(state, map, a)) continue;
    rebaseParts(a);
    for (const p of a.parts) {
      const units: Partial<Record<UnitType, number>> = {};
      for (const u of Object.keys(p.units) as UnitType[]) {
        const n = Math.min(a.units[u] ?? 0, Math.floor(p.units[u]! + 1e-6));
        if (n > 0) units[u] = n;
      }
      // die Armee am Ort behält mindestens eine Einheit
      if (!Object.keys(units).length || Object.entries(units).reduce((s, [, n]) => s + n!, 0) >= unitCount(a)) continue;
      for (const u of Object.keys(units) as UnitType[]) {
        a.units[u] = a.units[u]! - units[u]!;
        if (!a.units[u]) delete a.units[u];
      }
      state.armies.push({
        id: p.id, num: p.num, name: p.name, owner: a.owner, node: a.node, pos: a.pos ? { ...a.pos } : null,
        units, morale: a.morale, resume: p.resume, forcedMarch: p.forcedMarch, aggressive: p.aggressive,
      });
    }
    a.parts = null;
    a.partBase = null;
    ctx.invalidate();
  }
}

/** Laufenden Marsch mit dem aktuellen Tempo neu planen (nach Umschalten des Gewaltmarsches); nicht beim Ein-/Ausschiffen */
export function replan(ctx: MilitaryContext, a: Army): void {
  const { state, map } = ctx;
  const t = finalTarget(a);
  if (!a.move || !t || boardingWait(map, a, state.time)) return;
  const plan = planRoute(state, map, a, state.time, t);
  if (!plan || plan.path.length < 2) return;
  a.node = nearestNode(map, a, state.time);
  startMove(ctx, a, plan.path, plan.then, plan);
}

/** Fernkampfschaden je Kampfrunde (ohne Zufallsstreuung und Festung), wie in rangedRound */
export function rangedPower(a: Army, map: MapData): number {
  let out = 0;
  for (const u of unitTypes(a)) if (unitRange(a, u, map) > 0) out += a.units[u]! * UNITS[u].attack;
  return out;
}

/** Verbleibende Lebenspunkte aller Einheiten (Infanterie nach Moral, abzüglich Verwundungen; auf See siehe unitHp) */
export function armyHp(a: Army, map?: MapData): number {
  return unitTypes(a).reduce((t, u) => t + Math.max(0, a.units[u]! * unitHp(a, u, map) - (a.wounds?.[u] ?? 0)), 0);
}

// ---------------------------------------------------------------- Besatzung

/**
 * Besatzungsregel: Steht eine Armee in einer eigenen Stadt (im Umkreis von 1 km um den Provinzknoten) und
 * ist sie die letzte dort, bleibt beim Abmarsch eine Einheit zurück – bevorzugt Infanterie, sonst die
 * schwächste. Besteht sie nur aus einer Einheit, darf sie nicht abziehen ('last').
 */
export function garrisonKeep(state: GameState, map: MapData, a: Army): { unit: UnitType; node: number } | 'last' | null {
  if (isNaval(a)) return null;
  // eigene Stadt in Nahkampfreichweite: dort steht die Armee als Besatzung (auch dicht davor auf dem Weg,
  // etwa nach einer Eroberung aus 1 km Entfernung, oder gerade auf dem Weg hinein)
  const at = armyPosition(map, a, state.time);
  const near = (p: [number, number], n: number) => {
    const c = nodePos(map, n);
    return Math.hypot(p[0] - c[0], p[1] - c[1]) <= MILITARY.meleeKm;
  };
  const cands = a.move ? [a.move.path[a.move.seg], a.move.path[a.move.seg + 1]] : a.pos ? [a.pos.a, a.pos.b] : [a.node];
  const city = cands.find((n) => !isSea(map, n) && state.provinces[n].owner === a.owner && near(at, n));
  if (city === undefined) return null;
  const others = state.armies.some((b) => b !== a && b.owner === a.owner && !b.move && !isNaval(b) && unitCount(b) > 0
    && near(armyPosition(map, b, state.time), city));
  if (others) return null;
  // eine einzelne Einheit bleibt stehen; nur auf dem Durchmarsch darf sie weiter
  if (unitCount(a) <= 1) return a.move ? null : 'last';
  if ((a.units.infantry ?? 0) > 0) return { unit: 'infantry', node: city };
  return { unit: unitTypes(a).sort((x, y) => armyPower({ ...a, units: { [x]: 1 } }) - armyPower({ ...a, units: { [y]: 1 } }))[0], node: city };
}

/**
 * Besatzungsregel beim Abmarsch ohne Spielerbefehl (fortgesetzter Marsch, Verfolgung): ist die Armee die
 * letzte in einer eigenen Stadt, bleibt eine Einheit dort. false: eine einzelne letzte Einheit darf nicht weg.
 */
export function leaveGarrison(ctx: MilitaryContext, a: Army): boolean {
  const keep = garrisonKeep(ctx.state, ctx.map, a);
  if (keep === 'last') return false;
  if (!keep) return true;
  a.units[keep.unit] = a.units[keep.unit]! - 1;
  if (!a.units[keep.unit]) {
    delete a.units[keep.unit];
    if (a.wounds) delete a.wounds[keep.unit];
  }
  ctx.state.armies.push({ id: ctx.newArmyId(), owner: a.owner, node: keep.node, units: { [keep.unit]: 1 }, morale: a.morale });
  ctx.invalidate();
  return true;
}

/**
 * Kampf in einer Provinz vermerken: senkt das Moralziel bis zum Tageswechsel (MORALE.battle) und die Moral sofort
 * um MORALE.battleHit – höchstens einmal je Spielstunde, egal wie viele Kämpfe dort laufen.
 */
export function markFight(state: GameState, prov: number): void {
  const ps = state.provinces[prov];
  ps.fought = true;
  const hour = Math.floor(state.time / HOUR);
  if (ps.fightHour === hour) return;
  ps.fightHour = hour;
  ps.morale = Math.max(MORALE.min, ps.morale - MORALE.battleHit);
}
