// Feinschliff des Wegenetzes nach dem Kartenbau:
//  1. Seewege, die über Land führen, werden per Rasterwegsuche durchs Wasser gelegt (eckige Pfade).
//  2. Wege, die von einem Knoten aus lange dicht nebeneinander laufen, werden gebündelt: gemeinsamer
//     Abschnitt bis zu einer Wegkreuzung, dort verzweigen sie. Zusätzlich entstehen Abkürzungen
//     zwischen den Zielen über die Kreuzung (ohne Umweg über die Stadt bzw. die Mitte des Seegebiets).

import type { MapData } from '../src/game/mapdata.ts';
import { closestOnEdge, edgeLength, edgePoint, edgePoints, edgeSlice, isSea, nodeCount, nodeNeighbors } from '../src/game/graph.ts';
import { pointInMulti, type MultiPoly, type Pt } from '../src/game/geom.ts';

type Road = NonNullable<MapData['roads']>[number];
type Shortcut = NonNullable<MapData['shortcuts']>[number];

const r1 = (v: number) => Math.round(v * 10) / 10;
const flat = (pts: Pt[]) => pts.flatMap(([x, y]) => [r1(x), r1(y)]);

/** Liegt die Strecke a–b vollständig im erlaubten Bereich (Probe alle ~3 km)? */
function clear(a: Pt, b: Pt, ok: (x: number, y: number) => boolean): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
  for (let k = 1; k < n; k++) if (!ok(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n)) return false;
  return true;
}

/** Rasterweg (A*, 8 Nachbarn) von a nach b durch den erlaubten Bereich, geglättet; null ohne Weg */
export function rasterPath(a: Pt, b: Pt, ok: (x: number, y: number) => boolean, pad = 0.25, cellSize?: number): Pt[] | null {
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const m = Math.max(80, span * pad);
  const x0 = Math.min(a[0], b[0]) - m, y0 = Math.min(a[1], b[1]) - m, x1 = Math.max(a[0], b[0]) + m, y1 = Math.max(a[1], b[1]) + m;
  const h = cellSize ?? Math.max(4, Math.hypot(x1 - x0, y1 - y0) / 220);
  const W = Math.ceil((x1 - x0) / h) + 1, H = Math.ceil((y1 - y0) / h) + 1;
  const free = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) free[j * W + i] = ok(x0 + i * h, y0 + j * h) ? 1 : 0;
  const cell = (p: Pt) => {
    const bi = Math.round((p[0] - x0) / h), bj = Math.round((p[1] - y0) / h);
    let best = -1, bd = Infinity;
    for (let j = Math.max(0, bj - 8); j <= Math.min(H - 1, bj + 8); j++) {
      for (let i = Math.max(0, bi - 8); i <= Math.min(W - 1, bi + 8); i++) {
        const d = (i - bi) ** 2 + (j - bj) ** 2;
        if (free[j * W + i] && d < bd) { bd = d; best = j * W + i; }
      }
    }
    if (best < 0) {
      // weiter entfernt suchen (z. B. Mitte eines Seegebiets an einer Engstelle)
      for (let k = 0; k < W * H; k++) {
        if (!free[k]) continue;
        const d = ((k % W) - bi) ** 2 + (Math.floor(k / W) - bj) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    }
    return best;
  };
  const start = cell(a), goal = cell(b);
  if (start < 0 || goal < 0) return null;
  const g = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const open: [number, number][] = [[0, start]];
  g[start] = 0;
  const est = (c: number) => Math.hypot((c % W) - (goal % W), Math.floor(c / W) - Math.floor(goal / W));
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, c] = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (c === goal) break;
    const ci = c % W, cj = Math.floor(c / W);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (!free[nc]) continue;
      const cost = g[c] + (di && dj ? Math.SQRT2 : 1);
      if (cost < g[nc]) { g[nc] = cost; prev[nc] = c; open.push([cost + est(nc), nc]); }
    }
  }
  if (!isFinite(g[goal])) return null;
  const cells: Pt[] = [];
  for (let c = goal; c !== -1; c = prev[c]) cells.unshift([x0 + (c % W) * h, y0 + Math.floor(c / W) * h]);
  const raw: Pt[] = [a, ...cells, b];
  const out: Pt[] = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !clear(raw[i], raw[j], ok)) j--;
    out.push(raw[j]);
    i = j;
  }
  return out;
}

/** Anteil der Strecke (ab Punkt `from`), der nicht im erlaubten Bereich liegt */
function blockedShare(pts: Pt[], ok: (x: number, y: number) => boolean, from = 0): number {
  let bad = 0, total = 0;
  for (let k = from; k + 1 < pts.length; k++) {
    const [a, b] = [pts[k], pts[k + 1]];
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
    for (let s = 1; s < n; s++) {
      total++;
      if (!ok(a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n)) bad++;
    }
  }
  return total ? bad / total : 0;
}

/** Seewege über Land durchs Wasser legen (Provinz–See ab dem Hafenpunkt, See–See ganz). */
export function waterRoutes(map: MapData, anyLand: (x: number, y: number) => boolean): Road[] {
  const water = (x: number, y: number) => !anyLand(x, y);
  const out: Road[] = [];
  for (let u = 0; u < nodeCount(map); u++) {
    for (const v of nodeNeighbors(map, u)) {
      if (v < u || (!isSea(map, u) && !isSea(map, v))) continue;
      const pts = edgePoints(map, u, v);
      const fromHarbor = !isSea(map, u) ? 1 : 0;
      if (blockedShare(pts, water, fromHarbor) <= 0.03) continue;
      const a = pts[fromHarbor], b = pts[pts.length - 1];
      // grob zuerst; scheitert es (enge Meerengen), fein in einem schmaleren Streifen
      // um Inseln herum braucht es mitunter einen größeren Suchbereich
      const path = rasterPath(a, b, water) ?? rasterPath(a, b, water, 0.12, 1.5) ?? rasterPath(a, b, water, 1.2) ?? rasterPath(a, b, water, 0.6, 2.5);
      if (!path) continue;
      out.push({ a: u, b: v, pts: flat([...pts.slice(0, fromHarbor), ...path]), split: 0.5 });
    }
  }
  return out;
}

/** Gemeinsame Strecke (km) zweier Wege ab u, solange sie höchstens D km auseinanderliegen */
function sharedRun(map: MapData, u: number, v: number, w: number, D: number): number {
  const lv = edgeLength(map, u, v), lw = edgeLength(map, u, w);
  const L = Math.min(lv, lw);
  let s = 4;
  for (; s <= L; s += 3) {
    const p = edgePoint(map, u, v, s / lv), q = edgePoint(map, u, w, s / lw);
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > D) break;
  }
  return Math.max(0, s - 3);
}

export interface BundleResult { roads: Road[]; shortcuts: Shortcut[]; junctions: { node: number; x: number; y: number }[] }

/**
 * Wege bündeln: Von einem Knoten u aus dicht nebeneinander laufende Wege (Land: höchstens 15 km Abstand
 * über ≥ 60 km und ≥ 20 % der Länge – das bleibt selten; See: 35 km, ≥ 50 km) bekommen einen gemeinsamen
 * Abschnitt bis zur Kreuzung. Zwischen den Zielen entstehen Abkürzungen über die Kreuzung.
 */
export function bundleRoutes(map: MapData, shapes: MultiPoly[]): BundleResult {
  const P = map.provinces.length;
  const roads: Road[] = [];
  const shortcuts: Shortcut[] = [];
  const junctions: BundleResult['junctions'] = [];
  const adjacent = (a: number, b: number) => nodeNeighbors(map, a).includes(b);
  const provinceAt = (x: number, y: number, cands: number[]) => cands.find((c) => c >= 0 && c < P && pointInMulti(x, y, shapes[c])) ?? -1;
  /** Anteile (von–bis) der Länge, die im Gebiet von `mid` liegen */
  const spanIn = (pts: Pt[], a: number, mid: number, b: number): [number, number] => {
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const len = cum[cum.length - 1] || 1;
    let f0 = -1, f1 = -1;
    for (let k = 0; k + 1 < pts.length; k++) {
      const n = Math.max(1, Math.ceil((cum[k + 1] - cum[k]) / 2));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, y = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t;
        if (provinceAt(x, y, [mid, a, b]) === mid) {
          const f = (cum[k] + (cum[k + 1] - cum[k]) * t) / len;
          if (f0 < 0) f0 = f;
          f1 = f;
        }
      }
    }
    return f0 < 0 ? [0.5, 0.5] : [f0, f1];
  };
  for (let u = 0; u < nodeCount(map); u++) {
    const land = !isSea(map, u);
    const D = land ? 10 : 35, minRun = land ? 90 : 50, minShare = land ? 0.3 : 0.15;
    const nb = nodeNeighbors(map, u).filter((v) => isSea(map, v) === !land);
    // Kandidatenpaare und Gruppen (Union-Find)
    const parent = new Map(nb.map((v) => [v, v]));
    const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x)!));
    const run = new Map<string, number>();
    for (let i = 0; i < nb.length; i++) for (let j = i + 1; j < nb.length; j++) {
      const s = sharedRun(map, u, nb[i], nb[j], D);
      const L = Math.min(edgeLength(map, u, nb[i]), edgeLength(map, u, nb[j]));
      if (s >= minRun && s >= L * minShare) {
        run.set(`${nb[i]}:${nb[j]}`, s);
        run.set(`${nb[j]}:${nb[i]}`, s);
        parent.set(find(nb[i]), find(nb[j]));
      }
    }
    const groups = new Map<number, number[]>();
    for (const v of nb) if (run.size) (groups.get(find(v)) ?? groups.set(find(v), []).get(find(v))!).push(v);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      // Bezugsweg: der mit den meisten dicht laufenden Partnern
      const ref = g.reduce((x, y) => (g.filter((m) => run.has(`${y}:${m}`)).length > g.filter((m) => run.has(`${x}:${m}`)).length ? y : x));
      const members = [ref, ...g.filter((m) => m !== ref && run.has(`${ref}:${m}`))];
      if (members.length < 2) continue;
      const T = Math.min(...members.slice(1).map((m) => run.get(`${ref}:${m}`)!));
      const lenRef = edgeLength(map, u, ref);
      const trunk = edgeSlice(map, u, ref, 0, T / lenRef);
      const J = trunk[trunk.length - 1];
      junctions.push({ node: u, x: r1(J[0]), y: r1(J[1]) });
      const tails = new Map<number, Pt[]>();
      for (const m of members) {
        const f = m === ref ? T / lenRef : closestOnEdge(map, u, m, J[0], J[1]).f;
        tails.set(m, edgeSlice(map, u, m, f, 1));
      }
      for (const m of members) {
        const pts: Pt[] = [...trunk, ...tails.get(m)!.slice(m === ref ? 1 : 0)];
        let split = 0.5;
        if (land) {
          const [, f1] = spanIn(pts, -1, u, m);
          split = Math.round(f1 * 1000) / 1000;
        }
        roads.push({ a: u, b: m, pts: flat(pts), split });
      }
      // Abkürzungen zwischen den Zielen über die Kreuzung
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (adjacent(a, b)) continue;
        const pts: Pt[] = [...[...tails.get(a)!].reverse(), J, ...tails.get(b)!];
        const [f0, f1] = land ? spanIn(pts, a, u, b) : [0.5, 0.5];
        shortcuts.push({ a, b, via: u, pts: flat(pts), f0: Math.round(f0 * 1000) / 1000, f1: Math.round(f1 * 1000) / 1000 });
      }
    }
  }
  return { roads, shortcuts, junctions };
}
