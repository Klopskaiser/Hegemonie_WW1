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
      adj.push([...p.neighbors, ...p.seas.map((z) => P + z)]);
      pos.push(p.center);
    }
    for (const z of map.seas) {
      adj.push([...z.seas.map((s) => P + s), ...z.coasts]);
      pos.push(z.center);
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
      for (const n of p.neighbors) {
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

/** Wegpunkte von u nach v (mit Knick an der Grenze) */
export function edgePoints(map: MapData, u: number, v: number): [number, number][] {
  const b = edgeVia(map, u, v);
  return b ? [nodePos(map, u), b, nodePos(map, v)] : [nodePos(map, u), nodePos(map, v)];
}

const partsCache = new WeakMap<MapData, Map<number, [number, number]>>();

/** Länge des ersten Teilstücks (bis zur Grenze) und des ganzen Weges u–v in km (zwischengespeichert) */
export function edgeParts(map: MapData, u: number, v: number): [number, number] {
  let c = partsCache.get(map);
  if (!c) partsCache.set(map, (c = new Map()));
  const key = u * nodeCount(map) + v;
  let r = c.get(key);
  if (!r) {
    const pts = edgePoints(map, u, v);
    const l1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    r = pts.length === 2 ? [l1, l1] : [l1, l1 + Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])];
    c.set(key, r);
  }
  return r;
}

export function edgeLength(map: MapData, u: number, v: number): number {
  return edgeParts(map, u, v)[1];
}

/** Punkt auf dem Weg u–v beim Anteil f der Weglänge */
export function edgePoint(map: MapData, u: number, v: number, f: number): [number, number] {
  const pts = edgePoints(map, u, v);
  const [l1, len] = edgeParts(map, u, v);
  let d = Math.max(0, Math.min(1, f)) * len;
  for (let k = 0; k + 1 < pts.length; k++) {
    const seg = k === 0 ? l1 : len - l1;
    if (d <= seg || k === pts.length - 2) {
      const t = seg > 0 ? Math.min(1, d / seg) : 0;
      return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t];
    }
    d -= seg;
  }
  return pts[pts.length - 1];
}

/** Teilstück des Weges u–v zwischen den Anteilen f0 und f1 als Punktfolge */
export function edgeSlice(map: MapData, u: number, v: number, f0: number, f1: number): [number, number][] {
  const out: [number, number][] = [edgePoint(map, u, v, f0)];
  const via = edgeVia(map, u, v);
  if (via) {
    const [l1, len] = edgeParts(map, u, v);
    const fv = l1 / len;
    if (f0 < fv && f1 > fv) out.push(via);
  }
  out.push(edgePoint(map, u, v, f1));
  return out;
}

/** Nächster Punkt auf dem Weg u–v zu (x, y): Anteil f und Abstand */
export function closestOnEdge(map: MapData, u: number, v: number, x: number, y: number): { f: number; d: number } {
  const pts = edgePoints(map, u, v);
  const [l1, len] = edgeParts(map, u, v);
  let best = { f: 0, d: Infinity };
  let acc = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    const seg = k === 0 ? l1 : len - l1;
    if (d < best.d) best = { f: len > 0 ? (acc + seg * t) / len : 0, d };
    acc += seg;
  }
  return best;
}

export function nodeDist(map: MapData, a: number, b: number): number {
  const pa = nodePos(map, a), pb = nodePos(map, b);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
}

/** Seegebiet vor einer Küstenprovinz (das dem Provinzmittelpunkt nächste), als Knoten. */
export function harborSea(map: MapData, province: number): number | null {
  const p = map.provinces[province];
  if (!p.seas.length) return null;
  const P = map.provinces.length;
  let best = p.seas[0], bd = Infinity;
  for (const z of p.seas) {
    const c = map.seas[z].center;
    const d = Math.hypot(c[0] - p.center[0], c[1] - p.center[1]);
    if (d < bd) { bd = d; best = z; }
  }
  return P + best;
}
