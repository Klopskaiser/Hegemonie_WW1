// Bewegungsnetz: Knoten 0..P-1 sind Provinzen, P..P+S-1 Seegebiete.

import type { MapData } from './mapdata.ts';

interface Graph {
  adj: number[][];
  pos: [number, number][];
  /** Knickpunkt eines Landweges an der gemeinsamen Grenze (Schlüssel min * N + max) */
  via: Map<number, [number, number]>;
}

const cache = new WeakMap<MapData, Graph>();

function graph(map: MapData): Graph {
  let g = cache.get(map);
  if (!g) {
    const P = map.provinces.length;
    const adj: number[][] = [];
    const pos: [number, number][] = [];
    for (const p of map.provinces) {
      adj.push([...(p.links ?? p.neighbors), ...(p.seaLinks ?? p.seas).map((z) => P + z)]);
      pos.push(p.center);
    }
    for (const z of map.seas) {
      adj.push([...z.seas.map((s) => P + s), ...z.coasts.filter((c) => (map.provinces[c].seaLinks ?? map.provinces[c].seas).includes(z.id))]);
      pos.push(z.center);
    }
    // Abkürzungen über Wegkreuzungen
    for (const s of map.shortcuts ?? []) {
      if (!adj[s.a].includes(s.b)) adj[s.a].push(s.b);
      if (!adj[s.b].includes(s.a)) adj[s.b].push(s.a);
    }
    // Landwege führen über den Punkt der gemeinsamen Grenze, der der Verbindungslinie am nächsten liegt
    const N = P + map.seas.length;
    const shared = new Map<number, number[]>();
    for (const b of map.borders) {
      if (b.b < 0) continue;
      const k = Math.min(b.a, b.b) * N + Math.max(b.a, b.b);
      (shared.get(k) ?? shared.set(k, []).get(k)!).push(...b.segs);
    }
    const via = new Map<number, [number, number]>();
    map.provinces.forEach((p, i) => {
      for (const n of p.links ?? p.neighbors) {
        if (n < i) continue;
        const segs = shared.get(i * N + n);
        if (!segs) continue;
        const q = map.provinces[n].center;
        const mx = (p.center[0] + q[0]) / 2, my = (p.center[1] + q[1]) / 2;
        let best: [number, number] = [mx, my], bd = Infinity;
        for (let k = 0; k < segs.length; k += 2) {
          const d = Math.hypot(segs[k] - mx, segs[k + 1] - my);
          if (d < bd) { bd = d; best = [segs[k], segs[k + 1]]; }
        }
        via.set(i * N + n, best);
      }
    });
    // Wasserwege knicken ebenfalls: Provinz → Hafenpunkt an der Küste zu diesem Seegebiet (nahe der Stadt)
    // → Mitte des Seegebiets; zwischen Seegebieten über einen Punkt ihrer gemeinsamen Grenze
    const coastPts = map.provinces.map(() => [] as [number, number][]);
    for (const b of map.borders) {
      if (b.b >= 0) continue;
      for (let k = 0; k < b.segs.length; k += 2) coastPts[b.a].push([b.segs[k], b.segs[k + 1]]);
    }
    const seaPts = map.seas.map((z) => z.polys.flatMap((poly) => poly.flatMap((ring) => {
      const pts: [number, number][] = [];
      for (let k = 0; k < ring.length; k += 2) pts.push([ring[k], ring[k + 1]]);
      return pts;
    })));
    map.provinces.forEach((p, i) => {
      const coast = coastPts[i];
      if (!coast.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of coast) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      for (const z of p.seaLinks ?? p.seas) {
        const near = seaPts[z].filter(([x, y]) => x > x0 - 30 && x < x1 + 30 && y > y0 - 30 && y < y1 + 30);
        if (!near.length) continue;
        // Küstenpunkte, die an dieses Seegebiet grenzen; davon der Stadt nächste
        const scored = coast.map((c) => {
          let d = Infinity;
          for (const q of near) d = Math.min(d, Math.hypot(q[0] - c[0], q[1] - c[1]));
          return { c, d };
        });
        const minD = Math.min(...scored.map((s) => s.d));
        const touching = scored.filter((s) => s.d <= Math.max(8, minD + 2));
        let best = touching[0].c, bd = Infinity;
        for (const { c } of touching) {
          const d = Math.hypot(c[0] - p.center[0], c[1] - p.center[1]);
          if (d < bd) { bd = d; best = c; }
        }
        via.set(i * N + P + z, best);
      }
    });
    map.seas.forEach((z, i) => {
      if (map.seaNodes) return; // Seeknoten-Karten: Seewege verlaufen gerade, keine Grenze zwischen Knoten
      const own = new Set(seaPts[i].map(([x, y]) => `${x},${y}`));
      for (const s of z.seas) {
        if (s < i) continue;
        const shared = seaPts[s].filter(([x, y]) => own.has(`${x},${y}`));
        if (!shared.length) continue;
        const c = map.seas[s].center;
        const mx = (z.center[0] + c[0]) / 2, my = (z.center[1] + c[1]) / 2;
        let best = shared[0], bd = Infinity;
        for (const q of shared) {
          const d = Math.hypot(q[0] - mx, q[1] - my);
          if (d < bd) { bd = d; best = q; }
        }
        via.set((P + i) * N + P + s, best);
      }
    });
    g = { adj, pos, via };
    cache.set(map, g);
  }
  return g;
}

export function nodeCount(map: MapData): number {
  return map.provinces.length + map.seas.length;
}

export function isSea(map: MapData, node: number): boolean {
  return node >= map.provinces.length;
}

export function seaIndex(map: MapData, node: number): number {
  return node - map.provinces.length;
}

export function nodeNeighbors(map: MapData, node: number): number[] {
  return graph(map).adj[node];
}

export function nodePos(map: MapData, node: number): [number, number] {
  return graph(map).pos[node];
}

export function nodeName(map: MapData, node: number): string {
  return isSea(map, node) ? map.seas[seaIndex(map, node)].name : map.provinces[node].name;
}

/** Knickpunkt des Weges u–v (nur Landwege zwischen Provinzen), sonst null */
export function edgeVia(map: MapData, u: number, v: number): [number, number] | null {
  const N = nodeCount(map);
  return graph(map).via.get(Math.min(u, v) * N + Math.max(u, v)) ?? null;
}

const roadCache = new WeakMap<MapData, Map<number, { a: number; pts: [number, number][]; split: number }>>();

/** Landweg mit eigenem Verlauf (um Wasser herum), falls vorhanden */
function road(map: MapData, u: number, v: number) {
  let m = roadCache.get(map);
  if (!m) {
    m = new Map();
    const N = nodeCount(map);
    for (const r of [...(map.roads ?? []), ...(map.shortcuts ?? []).map((s) => ({ a: s.a, b: s.b, pts: s.pts, split: s.f0 }))]) {
      const pts: [number, number][] = [];
      for (let k = 0; k < r.pts.length; k += 2) pts.push([r.pts[k], r.pts[k + 1]]);
      m.set(Math.min(r.a, r.b) * N + Math.max(r.a, r.b), { a: r.a, pts, split: r.split });
    }
    roadCache.set(map, m);
  }
  return m.get(Math.min(u, v) * nodeCount(map) + Math.max(u, v));
}

/** Wegpunkte von u nach v: eigener Verlauf, sonst mit Knick an der Grenze bzw. am Hafenpunkt */
export function edgePoints(map: MapData, u: number, v: number): [number, number][] {
  const r = road(map, u, v);
  if (r) return r.a === u ? r.pts : [...r.pts].reverse();
  const b = edgeVia(map, u, v);
  return b ? [nodePos(map, u), b, nodePos(map, v)] : [nodePos(map, u), nodePos(map, v)];
}

interface Parts { l1: number; len: number; cum: number[] }
const partsCache = new WeakMap<MapData, Map<number, Parts>>();

/** Längen eines Weges (zwischengespeichert): bis zur Grenze, gesamt und kumuliert je Wegpunkt */
function parts(map: MapData, u: number, v: number): Parts {
  let c = partsCache.get(map);
  if (!c) partsCache.set(map, (c = new Map()));
  const key = u * nodeCount(map) + v;
  let r = c.get(key);
  if (!r) {
    const pts = edgePoints(map, u, v);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const len = cum[cum.length - 1];
    const rd = road(map, u, v);
    const l1 = rd ? (rd.a === u ? rd.split : 1 - rd.split) * len : cum[1];
    r = { l1, len, cum };
    c.set(key, r);
  }
  return r;
}

const throughCache = new WeakMap<MapData, Map<number, { a: number; via: number; f0: number; f1: number }>>();

/**
 * Abkürzung über eine Wegkreuzung: Gebiet, durch das der Weg u–v führt, und der Anteil des Weges
 * (von u aus) in diesem Gebiet; null für gewöhnliche Wege.
 */
export function edgeThrough(map: MapData, u: number, v: number): { via: number; f0: number; f1: number } | null {
  let m = throughCache.get(map);
  if (!m) {
    m = new Map();
    const N = nodeCount(map);
    for (const s of map.shortcuts ?? []) m.set(Math.min(s.a, s.b) * N + Math.max(s.a, s.b), { a: s.a, via: s.via, f0: s.f0, f1: s.f1 });
    throughCache.set(map, m);
  }
  const t = m.get(Math.min(u, v) * nodeCount(map) + Math.max(u, v));
  if (!t) return null;
  return t.a === u ? { via: t.via, f0: t.f0, f1: t.f1 } : { via: t.via, f0: 1 - t.f1, f1: 1 - t.f0 };
}

/** Länge des Teilstücks in u (bis zur Grenze) und des ganzen Weges u–v in km */
export function edgeParts(map: MapData, u: number, v: number): [number, number] {
  const p = parts(map, u, v);
  return [p.l1, p.len];
}

export function edgeLength(map: MapData, u: number, v: number): number {
  return edgeParts(map, u, v)[1];
}

/** Punkt auf dem Weg u–v beim Anteil f der Weglänge */
export function edgePoint(map: MapData, u: number, v: number, f: number): [number, number] {
  const pts = edgePoints(map, u, v);
  const { len, cum } = parts(map, u, v);
  const d = Math.max(0, Math.min(1, f)) * len;
  for (let k = 0; k + 1 < pts.length; k++) {
    if (d <= cum[k + 1] || k === pts.length - 2) {
      const seg = cum[k + 1] - cum[k];
      const t = seg > 0 ? Math.min(1, (d - cum[k]) / seg) : 0;
      return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t];
    }
  }
  return pts[pts.length - 1];
}

/** Teilstück des Weges u–v zwischen den Anteilen f0 und f1 als Punktfolge (mit den Knickpunkten dazwischen) */
export function edgeSlice(map: MapData, u: number, v: number, f0: number, f1: number): [number, number][] {
  const pts = edgePoints(map, u, v);
  const { len, cum } = parts(map, u, v);
  const out: [number, number][] = [edgePoint(map, u, v, f0)];
  for (let k = 1; k + 1 < pts.length; k++) {
    const fk = len > 0 ? cum[k] / len : 0;
    if (fk > f0 && fk < f1) out.push(pts[k]);
  }
  out.push(edgePoint(map, u, v, f1));
  return out;
}

/** Nächster Punkt auf dem Weg u–v zu (x, y): Anteil f und Abstand */
export function closestOnEdge(map: MapData, u: number, v: number, x: number, y: number): { f: number; d: number } {
  const pts = edgePoints(map, u, v);
  const { len, cum } = parts(map, u, v);
  let best = { f: 0, d: Infinity };
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best.d) best = { f: len > 0 ? (cum[k] + (cum[k + 1] - cum[k]) * t) / len : 0, d };
  }
  return best;
}

/** Eck- und Probenpunkte aller Wege in einem 1-km-Raster (je Karte gebaut) */
const sampleGridCache = new WeakMap<MapData, Map<string, [number, number][]>>();

function sampleGrid(map: MapData): Map<string, [number, number][]> {
  let grid = sampleGridCache.get(map);
  if (!grid) {
    grid = new Map();
    const put = (u: number, v: number, x: number, y: number) => {
      const k = Math.floor(x) + ':' + Math.floor(y);
      let cell = grid!.get(k);
      if (!cell) grid!.set(k, (cell = []));
      let has = false;
      for (const e of cell) if (e[0] === u && e[1] === v) { has = true; break; }
      if (!has) cell.push([u, v]);
    };
    const n = nodeCount(map);
    for (let u = 0; u < n; u++) for (const v of nodeNeighbors(map, u)) {
      if (v <= u) continue;
      const pts = edgePoints(map, u, v);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len));
        put(u, v, ax, ay);
        for (let i = 1; i <= steps; i++) put(u, v, ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps);
      }
    }
    sampleGridCache.set(map, grid);
  }
  return grid;
}

/**
 * Gleichwertige Darstellungen eines Wegpunkts: alle Wege, die an dieser Stelle geometrisch
 * zusammenfallen (zusammengelegte Abschnitte). Dient dazu, den Anmarsch über die kürzeste
 * Auslegung zu planen – nicht über einen beliebigen Endpunkt der angeklickten Straße.
 */
export function roadVariants(map: MapData, u: number, v: number, f: number, eps = 0.06): { a: number; b: number; f: number }[] {
  const out: { a: number; b: number; f: number }[] = [{ a: u, b: v, f }];
  const [x, y] = edgePoint(map, u, v, f);
  const grid = sampleGrid(map);
  const cx = Math.floor(x), cy = Math.floor(y);
  const seen = new Set<string>([`${Math.min(u, v)}|${Math.max(u, v)}`]);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const [i, j] of grid.get((cx + dx) + ':' + (cy + dy)) ?? []) {
      const key = `${Math.min(i, j)}|${Math.max(i, j)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = closestOnEdge(map, i, j, x, y);
      if (r.d <= eps) out.push({ a: i, b: j, f: r.f });
    }
  }
  return out;
}

export function nodeDist(map: MapData, a: number, b: number): number {
  const pa = nodePos(map, a), pb = nodePos(map, b);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
}

/** Seegebiet vor einer Küstenprovinz (das dem Provinzmittelpunkt nächste), als Knoten. */
export function harborSea(map: MapData, province: number): number | null {
  const p = map.provinces[province];
  const seas = p.seaLinks ?? p.seas;
  if (!seas.length) return null;
  const P = map.provinces.length;
  let best = seas[0], bd = Infinity;
  for (const z of seas) {
    const c = map.seas[z].center;
    const d = Math.hypot(c[0] - p.center[0], c[1] - p.center[1]);
    if (d < bd) { bd = d; best = z; }
  }
  return P + best;
}

// ---------------------------------------------------------------- Gabelungen

/**
 * Gabelung: die Landwege b–a und b–c fallen ab der Stadt b ein Stück weit zusammen (zusammengelegte Wegkorridore)
 * und trennen sich am Gabelpunkt. `fa` / `fc` = Anteil des Gabelpunkts auf dem Weg b→a bzw. b→c (von b aus).
 * Über den Gabelpunkt lässt sich von a nach c (und umgekehrt) wechseln, ohne die Stadt b zu betreten.
 */
export interface Fork { b: number; a: number; c: number; fa: number; fc: number }

/** Teilstück eines Weges: auf dem Weg u→v vom Anteil f0 bis f1 (f0 < f1, Anteile von u aus) */
export interface Piece { u: number; v: number; f0: number; f1: number }

/** Mindestlänge des gemeinsamen Abschnitts (km), ab der eine Gabelung zählt */
const FORK_MIN_KM = 1;
/** Abstand (km), bis zu dem zwei Wege als zusammenfallend gelten (wie roadVariants) */
const FORK_EPS = 0.06;

const forkCache = new WeakMap<MapData, Fork[]>();

/** Alle Gabelungen der Karte (nur Landwege ohne Abkürzung über ein drittes Gebiet), je Karte einmal bestimmt */
export function forks(map: MapData): Fork[] {
  let list = forkCache.get(map);
  if (list) return list;
  list = [];
  const P = map.provinces.length;
  for (let b = 0; b < P; b++) {
    const land = nodeNeighbors(map, b).filter((n) => n < P && !edgeThrough(map, b, n));
    for (let i = 0; i < land.length; i++) {
      for (let j = i + 1; j < land.length; j++) {
        const a = land[i], c = land[j];
        const [, la] = edgeParts(map, b, a);
        const [, lc] = edgeParts(map, b, c);
        if (la <= 0 || lc <= 0) continue;
        // gemeinsamer Abschnitt ab b: grob abtasten, dann das Ende eingrenzen
        const on = (km: number) => {
          const [x, y] = edgePoint(map, b, a, km / la);
          return closestOnEdge(map, b, c, x, y).d <= FORK_EPS;
        };
        const step = 0.25;
        let ok = 0;
        for (let km = step; km < Math.min(la, lc) - step && on(km); km += step) ok = km;
        if (ok < FORK_MIN_KM - step) continue;
        let lo = ok, hi = Math.min(ok + step, la);
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          if (on(mid)) lo = mid; else hi = mid;
        }
        if (lo < FORK_MIN_KM) continue;
        const [x, y] = edgePoint(map, b, a, lo / la);
        list.push({ b, a, c, fa: lo / la, fc: closestOnEdge(map, b, c, x, y).f });
      }
    }
  }
  forkCache.set(map, list);
  return list;
}

/** Kante im erweiterten Netz: Ziel (Knoten oder Gabelpunkt) und das befahrene Teilstück */
export interface ForkEdge { to: number; piece: Piece }

export interface ForkGraph {
  /** Knoten 0..N-1 wie im Bewegungsnetz, N.. die Gabelpunkte (nur für die Wegsuche, nie als Standort) */
  n: number;
  base: number;
  adj: ForkEdge[][];
  /** Gabelpunkte je Weg (Schlüssel min * N + max), Anteile vom kleineren Knoten aus, aufsteigend */
  chain: Map<number, { f: number; node: number }[]>;
}

const forkGraphCache = new WeakMap<MapData, ForkGraph>();

/**
 * Erweitertes Bewegungsnetz für die Wegsuche: jeder Weg mit Gabelpunkten ist an ihnen unterteilt
 * (u – g1 – g2 – … – v); an einem Gabelpunkt kann man auf den anderen Weg wechseln.
 */
export function forkGraph(map: MapData): ForkGraph {
  let g = forkGraphCache.get(map);
  if (g) return g;
  const N = nodeCount(map);
  const fs = forks(map);
  const chain = new Map<number, { f: number; node: number }[]>();
  const key = (u: number, v: number) => Math.min(u, v) * N + Math.max(u, v);
  const put = (b: number, x: number, f: number, node: number) => {
    const k = key(b, x);
    const lo = Math.min(b, x);
    (chain.get(k) ?? chain.set(k, []).get(k)!).push({ f: b === lo ? f : 1 - f, node });
  };
  fs.forEach((fk, i) => {
    put(fk.b, fk.a, fk.fa, N + i);
    put(fk.b, fk.c, fk.fc, N + i);
  });
  for (const list of chain.values()) list.sort((p, q) => p.f - q.f);
  const adj: ForkEdge[][] = Array.from({ length: N + fs.length }, () => []);
  // Teilstück zwischen zwei Punkten des Weges lo–hi (Anteile vom kleineren Knoten aus), in Fahrtrichtung
  const piece = (lo: number, hi: number, fFrom: number, fTo: number): Piece =>
    fTo >= fFrom ? { u: lo, v: hi, f0: fFrom, f1: fTo } : { u: hi, v: lo, f0: 1 - fFrom, f1: 1 - fTo };
  for (let u = 0; u < N; u++) {
    for (const v of nodeNeighbors(map, u)) {
      if (v <= u) continue;
      const pts = chain.get(key(u, v));
      if (!pts?.length) {
        adj[u].push({ to: v, piece: { u, v, f0: 0, f1: 1 } });
        adj[v].push({ to: u, piece: { u: v, v: u, f0: 0, f1: 1 } });
        continue;
      }
      // Kette u – g1 – … – gk – v (u ist der kleinere Knoten)
      const seq = [{ f: 0, node: u }, ...pts, { f: 1, node: v }];
      for (let k = 0; k + 1 < seq.length; k++) {
        const p = seq[k], q = seq[k + 1];
        if (p.node === q.node) continue;
        adj[p.node].push({ to: q.node, piece: piece(u, v, p.f, q.f) });
        adj[q.node].push({ to: p.node, piece: piece(u, v, q.f, p.f) });
      }
    }
  }
  g = { n: N + fs.length, base: N, adj, chain };
  forkGraphCache.set(map, g);
  return g;
}

/** Gabelpunkte auf dem Weg u–v mit ihrem Anteil von u aus (aufsteigend) */
export function forksOnEdge(map: MapData, u: number, v: number): { f: number; node: number }[] {
  const g = forkGraph(map);
  const N = g.base;
  const list = g.chain.get(Math.min(u, v) * N + Math.max(u, v)) ?? [];
  return u < v ? list : list.map((p) => ({ f: 1 - p.f, node: p.node })).reverse();
}
