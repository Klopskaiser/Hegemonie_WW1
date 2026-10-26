// Bewegungsnetz: Knoten 0..P-1 sind Provinzen, P..P+S-1 Seegebiete.

import type { MapData } from './mapdata.ts';

interface Graph {
  adj: number[][];
  pos: [number, number][];
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
    g = { adj, pos };
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
