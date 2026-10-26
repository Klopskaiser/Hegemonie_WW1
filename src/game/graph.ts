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
    for (const r of map.roads ?? []) {
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
