// Nebel des Krieges: was eine Nation sieht.

import { MILITARY } from './balance.ts';
import { isSea, nodeCount, nodeNeighbors, nodePos } from './graph.ts';
import type { MapData } from './mapdata.ts';
import { sharesMap } from './diplomacy.ts';
import { armyPosition } from './military.ts';
import type { Army, GameState } from './types.ts';

/** Sichtbare Knoten (Provinzen und Seegebiete), einschließlich der Sicht von Partnern mit geteilter Karte. */
export function visibleNodes(state: GameState, map: MapData, nation: string): Set<number> {
  const vis = new Set<number>();
  for (const n of [nation, ...mapPartners(state, nation)]) addOwnSight(state, map, n, vis);
  return vis;
}

function mapPartners(state: GameState, nation: string): string[] {
  return Object.keys(state.nations).filter((n) => sharesMap(state, nation, n));
}

function addOwnSight(state: GameState, map: MapData, nation: string, vis: Set<number>): void {
  state.provinces.forEach((ps, i) => {
    if (ps.owner !== nation) return;
    vis.add(i);
    for (const n of nodeNeighbors(map, i)) vis.add(n);
  });
  const n = nodeCount(map);
  const done = new Set<number>();
  for (const a of state.armies) {
    if (a.owner !== nation) continue;
    const here = a.move ? [a.move.path[a.move.seg], a.move.path[a.move.seg + 1]] : [a.node];
    for (const h of here) {
      vis.add(h);
      for (const nb of nodeNeighbors(map, h)) vis.add(nb);
    }
    // stehende Armeen am Knoten: vorberechnete Sichtweite, je Knoten nur einmal
    if (!a.move && !a.pos) {
      if (done.has(a.node)) continue;
      done.add(a.node);
      for (const i of inSight(map)[a.node]) vis.add(i);
      continue;
    }
    const pos = armyPosition(map, a, state.time);
    for (let i = 0; i < n; i++) {
      const p = nodePos(map, i);
      if (Math.hypot(p[0] - pos[0], p[1] - pos[1]) <= MILITARY.viewRange) vis.add(i);
    }
  }
}

const sightCache = new WeakMap<MapData, number[][]>();

/** Je Knoten alle Knoten in Sichtweite (Abstand der Mittelpunkte) */
function inSight(map: MapData): number[][] {
  let s = sightCache.get(map);
  if (!s) {
    const n = nodeCount(map);
    s = [];
    for (let k = 0; k < n; k++) {
      const q = nodePos(map, k);
      const list: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = nodePos(map, i);
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= MILITARY.viewRange) list.push(i);
      }
      s.push(list);
    }
    sightCache.set(map, s);
  }
  return s;
}

/** Ist eine Armee für `nation` sichtbar? Festungen ab Stufe 2 verbergen die Truppen ihres Besitzers. */
export function armyVisible(state: GameState, map: MapData, nation: string, a: Army, vis: Set<number>): boolean {
  if (a.owner === nation || sharesMap(state, nation, a.owner)) return true;
  const at = a.move ? [a.move.path[a.move.seg], a.move.path[a.move.seg + 1]] : [a.node];
  if (!at.some((n) => vis.has(n))) return false;
  if (!a.move && !isSea(map, a.node)) {
    const ps = state.provinces[a.node];
    if (ps.owner === a.owner && ps.buildings.fortress >= 2 && ps.owner !== nation) return false;
  }
  return true;
}
