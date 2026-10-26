// Feinschliff des Wegenetzes nach dem Kartenbau:
//  1. Seewege, die über Land führen, werden per Rasterwegsuche durchs Wasser gelegt (eckige Pfade).
//  2. Wege, die von einem Knoten aus lange dicht nebeneinander laufen, werden gebündelt: gemeinsamer
//     Abschnitt bis zu einer Wegkreuzung, dort verzweigen sie. Zusätzlich entstehen Abkürzungen
//     zwischen den Zielen über die Kreuzung (ohne Umweg über die Stadt bzw. die Mitte des Seegebiets).

import type { MapData } from '../src/game/mapdata.ts';
import { edgePoints, isSea, nodeCount, nodeNeighbors } from '../src/game/graph.ts';
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
  const P = map.provinces.length;
  // grob zuerst; scheitert es (enge Meerengen), fein in einem schmaleren Streifen;
  // um Inseln herum braucht es mitunter einen größeren Suchbereich
  const route = (a: Pt, b: Pt) => rasterPath(a, b, water) ?? rasterPath(a, b, water, 0.12, 1.5) ?? rasterPath(a, b, water, 1.2) ?? rasterPath(a, b, water, 0.6, 2.5);
  const coast = map.provinces.map(() => [] as Pt[]);
  for (const b of map.borders) {
    if (b.b >= 0) continue;
    for (let k = 0; k < b.segs.length; k += 2) coast[b.a].push([b.segs[k], b.segs[k + 1]]);
  }
  const out: Road[] = [];
  for (let u = 0; u < nodeCount(map); u++) {
    for (const v of nodeNeighbors(map, u)) {
      if (v < u || (!isSea(map, u) && !isSea(map, v))) continue;
      const pts = edgePoints(map, u, v);
      const fromHarbor = !isSea(map, u) ? 1 : 0;
      if (blockedShare(pts, water, fromHarbor) <= 0.03) continue;
      const b = pts[pts.length - 1];
      let path = route(pts[fromHarbor], b);
      let harbor = pts[fromHarbor];
      // Hafenweg: lässt sich vom üblichen Einschiffpunkt kein Weg durchs Wasser finden (oder bleibt er
      // über Land), wird ein anderer Küstenpunkt zu diesem Seegebiet gewählt – der stadtnächste, der passt
      if (fromHarbor && (!path || blockedShare(path, water) > 0.03)) {
        const zone = map.seas[v - P].polys.flatMap((poly) => poly.flatMap((ring) => {
          const r: Pt[] = [];
          for (let k = 0; k < ring.length; k += 2) r.push([ring[k], ring[k + 1]]);
          return r;
        }));
        const city = pts[0];
        const cands = coast[u]
          .filter((c) => zone.some((z) => Math.hypot(z[0] - c[0], z[1] - c[1]) < 12))
          .sort((x, y) => Math.hypot(x[0] - city[0], x[1] - city[1]) - Math.hypot(y[0] - city[0], y[1] - city[1]));
        const tried = new Set<string>();
        for (const c of cands) {
          const k = `${Math.round(c[0] / 15)},${Math.round(c[1] / 15)}`;
          if (tried.has(k)) continue;
          tried.add(k);
          if (tried.size > 12) break;
          const p = route(c, b);
          if (p && blockedShare(p, water) <= 0.03) { path = p; harbor = c; break; }
        }
      }
      if (!path) continue;
      out.push({ a: u, b: v, pts: flat(fromHarbor ? [pts[0], harbor, ...path.slice(1)] : path), split: 0.5 });
    }
  }
  return out;
}


// ---------------------------------------------------------------- Polylinien-Werkzeuge

interface Line { pts: Pt[]; cum: number[]; len: number }

function line(pts: Pt[]): Line {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

function pointAt(l: Line, s: number): Pt {
  s = Math.max(0, Math.min(l.len, s));
  for (let k = 0; k + 1 < l.pts.length; k++) {
    if (s <= l.cum[k + 1] || k === l.pts.length - 2) {
      const seg = l.cum[k + 1] - l.cum[k];
      const t = seg > 0 ? (s - l.cum[k]) / seg : 0;
      return [l.pts[k][0] + (l.pts[k + 1][0] - l.pts[k][0]) * t, l.pts[k][1] + (l.pts[k + 1][1] - l.pts[k][1]) * t];
    }
  }
  return l.pts[l.pts.length - 1];
}

/** Teilstück zwischen den Bogenlängen s0 < s1 (mit den Knickpunkten dazwischen) */
function sliceLine(l: Line, s0: number, s1: number): Pt[] {
  const out: Pt[] = [pointAt(l, s0)];
  for (let k = 1; k + 1 < l.pts.length; k++) if (l.cum[k] > s0 && l.cum[k] < s1) out.push(l.pts[k]);
  out.push(pointAt(l, s1));
  return out;
}

/** Nächster Punkt der Linie zu p: Bogenlänge und Abstand */
function projectOn(l: Line, p: Pt): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let k = 0; k + 1 < l.pts.length; k++) {
    const [ax, ay] = l.pts[k], [bx, by] = l.pts[k + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    const d = Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]);
    if (d < best.d) best = { s: l.cum[k] + (l.cum[k + 1] - l.cum[k]) * t, d };
  }
  return best;
}

/** Douglas-Peucker */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let idx = -1, dmax = 0;
  for (let k = 1; k + 1 < pts.length; k++) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((pts[k][0] - a[0]) * dx + (pts[k][1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * t - pts[k][0], a[1] + dy * t - pts[k][1]);
    if (d > dmax) { dmax = d; idx = k; }
  }
  if (dmax <= tol) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

const angleBetween = (u: Pt, v: Pt) => {
  const c = (u[0] * v[0] + u[1] * v[1]) / Math.max(1e-9, Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

// ---------------------------------------------------------------- Landwege bündeln

/** Gemeinsame Strecke (km) zweier Linien ab ihrem gemeinsamen Anfang, solange höchstens D km auseinander */
function sharedRun(a: Line, b: Line, D: number): number {
  const L = Math.min(a.len, b.len);
  let s = 4;
  for (; s <= L; s += 3) {
    const p = pointAt(a, s), q = pointAt(b, s);
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > D) break;
  }
  return Math.max(0, s - 3);
}

export interface BundleResult { roads: Road[]; shortcuts: Shortcut[]; junctions: { node: number; x: number; y: number }[] }

/**
 * Landwege bündeln (selten): Laufen Wege von einer Stadt aus lange dicht nebeneinander (≤ 20 km über
 * ≥ 80 km und ≥ 25 % der Länge), teilen sie sich den Weg bis zu einer Kreuzung. Von dort zweigt jeder Weg
 * möglichst gerade zur Grenze ab; die Kreuzung liegt so, dass die Abzweige nicht zu flach abgehen (≥ 30°,
 * ein durchgehender Weg ausgenommen). Zwischen Zielen ohne eigene Verbindung entsteht eine Abkürzung.
 */
export function bundleRoutes(map: MapData, shapes: MultiPoly[]): BundleResult {
  const P = map.provinces.length;
  const roads: Road[] = [];
  const shortcuts: Shortcut[] = [];
  const junctions: BundleResult['junctions'] = [];
  const D = 20, minRun = 80, minShare = 0.25, minAngle = 30;
  const adjacent = (a: number, b: number) => nodeNeighbors(map, a).includes(b);
  const inProv = (i: number, p: Pt) => pointInMulti(p[0], p[1], shapes[i]);
  const straightIn = (a: Pt, b: Pt, provs: number[]) => {
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
    let bad = 0;
    for (let k = 1; k < n; k++) {
      const p: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      if (!provs.some((i) => inProv(i, p))) bad++;
    }
    return bad <= 1;
  };
  const boxes = shapes.map((sh) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of sh) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  });
  /** Anteil der Strecke in Provinzen außer den erlaubten (Wasser zählt nicht) */
  const foreignShare = (pts: Pt[], allowed: number[]) => {
    const l = line(pts);
    let bad = 0, total = 0;
    for (let s = 2; s < l.len; s += 4) {
      const p = pointAt(l, s);
      total++;
      if (allowed.some((i) => inProv(i, p))) continue;
      for (let i = 0; i < shapes.length; i++) {
        const b = boxes[i];
        if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
        if (inProv(i, p)) { bad++; break; }
      }
    }
    return total ? bad / total : 0;
  };
  const splitOf = (pts: Pt[], u: number, m: number) => {
    const l = line(pts);
    for (let s = 0; s <= l.len; s += 2) {
      const p = pointAt(l, s);
      if (!inProv(u, p) && inProv(m, p)) return Math.round((s / Math.max(1, l.len)) * 1000) / 1000;
    }
    return 0.5;
  };
  for (let u = 0; u < P; u++) {
    const nb = nodeNeighbors(map, u).filter((v) => !isSea(map, v));
    const lines = new Map(nb.map((v) => [v, line(edgePoints(map, u, v))]));
    // Grenzübertritt je Weg (Bogenlänge)
    const border = new Map(nb.map((v) => {
      const l = lines.get(v)!;
      let s = 0;
      // Grenze = erster Punkt im Gebiet des Nachbarn (Wasser an der Küste zählt nicht)
      for (; s <= l.len; s += 2) if (inProv(v, pointAt(l, s))) break;
      return [v, Math.min(l.len, s)] as [number, number];
    }));
    const parent = new Map(nb.map((v) => [v, v]));
    const find = (x: number): number => (parent.get(x) === x ? x : find(parent.get(x)!));
    const run = new Map<string, number>();
    for (let i = 0; i < nb.length; i++) for (let j = i + 1; j < nb.length; j++) {
      const a = lines.get(nb[i])!, b = lines.get(nb[j])!;
      const s = sharedRun(a, b, D);
      if (s >= minRun && s >= Math.min(a.len, b.len) * minShare) {
        run.set(`${nb[i]}:${nb[j]}`, s);
        run.set(`${nb[j]}:${nb[i]}`, s);
        parent.set(find(nb[i]), find(nb[j]));
      }
    }
    if (!run.size) continue;
    const groups = new Map<number, number[]>();
    for (const v of nb) (groups.get(find(v)) ?? groups.set(find(v), []).get(find(v))!).push(v);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const ref = g.reduce((x, y) => (g.filter((m) => run.has(`${y}:${m}`)).length > g.filter((m) => run.has(`${x}:${m}`)).length ? y : x));
      const members = [ref, ...g.filter((m) => m !== ref && run.has(`${ref}:${m}`))];
      if (members.length < 2) continue;
      const refLine = lines.get(ref)!;
      // Kreuzung: innerhalb der Provinz, vor allen Grenzübertritten, mit ausreichend steilen Abzweigen
      // der Stamm darf über die gemeinsame Strecke hinaus bis kurz vor die Grenzen führen, damit die
      // Abzweige steil genug werden
      const tMax = Math.min(...members.map((m) => border.get(m)! - 15));
      if (tMax < minRun * 0.5) continue;
      let best: { t: number; score: number } | null = null;
      for (let t = Math.min(minRun * 0.5, tMax); t <= tMax; t += 5) {
        const J = pointAt(refLine, t), back = pointAt(refLine, Math.max(0, t - 10));
        const dir: Pt = [J[0] - back[0], J[1] - back[1]];
        // Abzweige untereinander nicht zu flach (≥ minAngle) und nicht zurück (≤ 120° zur Stammrichtung)
        const dirs = members.map((m) => {
          const B = pointAt(lines.get(m)!, border.get(m)!);
          return [B[0] - J[0], B[1] - J[1]] as Pt;
        });
        let spread = 180;
        for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) spread = Math.min(spread, angleBetween(dirs[i], dirs[j]));
        const ok = spread >= minAngle && dirs.every((d) => angleBetween(dir, d) <= 120)
          && members.every((m) => straightIn(J, pointAt(lines.get(m)!, border.get(m)!), [u, m]));
        const score = (ok ? 1000 : 0) + spread + t / 100;
        if (!best || score > best.score) best = { t, score };
        if (ok) break; // frühester Punkt mit steilen Abzweigen
      }
      if (!best) continue;
      const trunk = sliceLine(refLine, 0, best.t);
      const J = trunk[trunk.length - 1];
      junctions.push({ node: u, x: r1(J[0]), y: r1(J[1]) });
      // Abzweige: gerade zur Grenze, sofern das an Land bleibt, sonst entlang des bisherigen Weges
      const tails = new Map<number, Pt[]>();
      for (const m of members) {
        const l = lines.get(m)!;
        const b = border.get(m)!;
        const B = pointAt(l, b);
        tails.set(m, straightIn(J, B, [u, m])
          ? [J, ...sliceLine(l, b, l.len)]
          : [J, ...sliceLine(l, projectOn(l, J).s, l.len).slice(1)]);
      }
      for (const m of members) {
        const pts = simplify([...trunk, ...tails.get(m)!.slice(1)], 0.5);
        // führt der gebündelte Weg durch eine dritte Provinz, bleibt es beim bisherigen Weg
        if (foreignShare(pts, [u, m]) > 0.03) continue;
        roads.push({ a: u, b: m, pts: flat(pts), split: splitOf(pts, u, m) });
      }
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (adjacent(a, b)) continue;
        const pts: Pt[] = [...[...tails.get(a)!].reverse(), ...tails.get(b)!.slice(1)];
        if (foreignShare(pts, [a, b, u]) > 0.03) continue;
        const l = line(pts);
        let f0 = -1, f1 = -1;
        for (let s = 0; s <= l.len; s += 2) if (inProv(u, pointAt(l, s))) { if (f0 < 0) f0 = s / l.len; f1 = s / l.len; }
        shortcuts.push({ a, b, via: u, pts: flat(pts), f0: Math.round(Math.max(0, f0) * 1000) / 1000, f1: Math.round(Math.max(0, f1) * 1000) / 1000 });
      }
    }
  }
  return { roads, shortcuts, junctions };
}

// ---------------------------------------------------------------- Seewege zusammenlegen

/**
 * Seewege (See–See und Hafen–See ab dem Hafen) laufen oft eng nebeneinander her. Längere Wege werden zum
 * Rückgrat; kürzere übernehmen dessen Verlauf, wo sie ihm über ≥ 40 km auf ≤ 25 km nahekommen, und
 * verlassen es an einer Kreuzung. Die Verbindungen bleiben, es entstehen nur weniger sichtbare Linien.
 */
export function snapSeaLanes(map: MapData): { roads: Road[]; junctions: BundleResult['junctions'] } {
  const D = 25, minRun = 40, step = 4;
  const lanes: { a: number; b: number; fixed: number; pts: Pt[]; len: number }[] = [];
  for (let u = 0; u < nodeCount(map); u++) {
    for (const v of nodeNeighbors(map, u)) {
      if (v < u || (!isSea(map, u) && !isSea(map, v))) continue;
      const pts = edgePoints(map, u, v);
      // Hafenwege: Stadt → Hafen bleibt, verlegt wird nur der Teil auf See
      lanes.push({ a: u, b: v, fixed: isSea(map, u) ? 0 : 1, pts, len: line(pts).len });
    }
  }
  lanes.sort((x, y) => y.len - x.len);
  const backbone: Line[] = [];
  const roads: Road[] = [];
  const junctions: BundleResult['junctions'] = [];
  for (const lane of lanes) {
    const head = lane.pts.slice(0, lane.fixed);
    const sea = line(lane.pts.slice(lane.fixed));
    const samples: { s: number; p: Pt }[] = [];
    for (let s = 0; s < sea.len; s += step) samples.push({ s, p: pointAt(sea, s) });
    samples.push({ s: sea.len, p: pointAt(sea, sea.len) });
    const hits = samples.map(({ p }) => {
      let best: { b: number; s: number; d: number } | null = null;
      for (let b = 0; b < backbone.length; b++) {
        const pr = projectOn(backbone[b], p);
        if (pr.d <= D && (!best || pr.d < best.d)) best = { b, s: pr.s, d: pr.d };
      }
      return best;
    });
    // Läufe entlang eines Rückgrats; mehrere Läufe auf demselben Rückgrat werden verbunden, damit der Weg
    // es nicht verlässt, um später wieder einzumünden (kein Abzweig ohne Ziel)
    const runs: { k: number; e: number; b: number }[] = [];
    for (let k = 0; k < samples.length;) {
      const h = hits[k];
      if (!h) { k++; continue; }
      let e = k;
      while (e + 1 < samples.length && hits[e + 1] && hits[e + 1]!.b === h.b) e++;
      if (samples[e].s - samples[k].s >= minRun) {
        const prev = runs[runs.length - 1];
        if (prev && prev.b === h.b && Math.sign(hits[e]!.s - hits[k]!.s) === Math.sign(hits[prev.e]!.s - hits[prev.k]!.s)) prev.e = e;
        else runs.push({ k, e, b: h.b });
      }
      k = e + 1;
    }
    const seaPart: Pt[] = [];
    const changed = runs.length > 0;
    let k = 0;
    for (const r of runs) {
      for (; k < r.k; k++) seaPart.push(samples[k].p);
      const bl = backbone[r.b];
      const s0 = hits[r.k]!.s, s1 = hits[r.e]!.s;
      const part = s0 <= s1 ? sliceLine(bl, s0, s1) : sliceLine(bl, s1, s0).reverse();
      if (r.k > 0) junctions.push({ node: lane.a, x: r1(part[0][0]), y: r1(part[0][1]) });
      if (r.e < samples.length - 1) junctions.push({ node: lane.a, x: r1(part[part.length - 1][0]), y: r1(part[part.length - 1][1]) });
      seaPart.push(...part);
      k = r.e + 1;
    }
    for (; k < samples.length; k++) seaPart.push(samples[k].p);
    // Anfang und Ende des Seeteils exakt erhalten
    const start = lane.pts[lane.fixed], end = lane.pts[lane.pts.length - 1];
    if (seaPart[0][0] !== start[0] || seaPart[0][1] !== start[1]) seaPart.unshift(start);
    const last = seaPart[seaPart.length - 1];
    if (last[0] !== end[0] || last[1] !== end[1]) seaPart.push(end);
    const finalPts = changed ? [...head, ...seaPart] : lane.pts;
    if (changed) roads.push({ a: lane.a, b: lane.b, pts: flat(finalPts), split: 0.5 });
    backbone.push(line(finalPts.slice(lane.fixed)));
  }
  return { roads, junctions };
}
