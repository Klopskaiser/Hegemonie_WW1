// Nebel des Krieges: was eine Nation sieht.
// Eigene Provinzen sind immer ganz einsehbar; dazu sieht jede eigene Armee in einem Umkreis um sich
// (100 km, Eisenbahngeschütze und Schlachtschiffe 200 km). Partner mit geteilter Karte zählen mit.

import { MILITARY, UNITS } from './balance.ts';
import { isSea, nodeCount, nodePos } from './graph.ts';
import type { MapData } from './mapdata.ts';
import { sharesMap } from './diplomacy.ts';
import { armyPosition, unitTypes } from './military.ts';
import type { Army, GameState } from './types.ts';

/**
 * Sicht einer Nation. Als Menge enthält sie alle Knoten, deren Mittelpunkt einsehbar ist (für Anzeigen
 * und die KI); `full` sind die ganz einsehbaren Provinzen, `circles` die Sichtkreise der Armeen [x, y, r].
 */
export class Sight extends Set<number> {
  full = new Set<number>();
  circles: [number, number, number][] = [];

  /** Liegt ein Punkt in Sicht (ganz einsehbare Provinz oder Sichtkreis)? */
  sees(x: number, y: number, province?: number): boolean {
    if (province !== undefined && this.full.has(province)) return true;
    return this.circles.some(([cx, cy, r]) => Math.hypot(cx - x, cy - y) <= r);
  }
}

/** Sichtweite einer Armee (km): die größte ihrer Einheiten */
export function sightRange(a: Army): number {
  return Math.max(MILITARY.viewRange, ...unitTypes(a).map((u) => UNITS[u].sight ?? 0));
}

/** Sicht einer Nation einschließlich der Partner mit geteilter Karte. */
export function visibleNodes(state: GameState, map: MapData, nation: string): Sight {
  const sight = new Sight();
  const who = new Set([nation, ...Object.keys(state.nations).filter((n) => n !== nation && sharesMap(state, nation, n))]);
  state.provinces.forEach((ps, i) => {
    if (who.has(ps.owner)) sight.full.add(i);
  });
  for (const a of state.armies) {
    if (!who.has(a.owner)) continue;
    const [x, y] = armyPosition(map, a, state.time);
    sight.circles.push([x, y, sightRange(a)]);
  }
  for (let i = 0; i < nodeCount(map); i++) {
    const [x, y] = nodePos(map, i);
    if (sight.sees(x, y, isSea(map, i) ? undefined : i)) sight.add(i);
  }
  return sight;
}

/**
 * Ist eine Armee für `nation` sichtbar? In eigenen Provinzen immer, sonst innerhalb eines Sichtkreises.
 * Festungen ab Stufe 2 verbergen die Truppen ihres Besitzers in dessen eigener Provinz.
 */
export function armyVisible(state: GameState, map: MapData, nation: string, a: Army, vis: Sight): boolean {
  if (a.owner === nation || sharesMap(state, nation, a.owner)) return true;
  const [x, y] = armyPosition(map, a, state.time);
  const province = !isSea(map, a.node) ? a.node : undefined;
  if (!vis.sees(x, y, province)) return false;
  if (!a.move && province !== undefined) {
    const ps = state.provinces[province];
    if (ps.owner === a.owner && ps.buildings.fortress >= 2 && !vis.full.has(province)) return false;
  }
  return true;
}
