// Armeenamen: Größe nach Kampfstärke, Art nach der Einheit, die am meisten Stärke beiträgt.
// Die Nummer ist je Nation eindeutig und bleibt der Armee erhalten.

import { UNITS, type UnitType } from './balance.ts';
import { armyPower, isNaval, unitTypes } from './military.ts';
import type { MapData } from './mapdata.ts';
import { REBELS, type Army, type GameState } from './types.ts';

/** Größenstufen nach Kampfstärke (obere Grenze, ausschließlich) */
const SIZES: [number, string][] = [
  [10, 'Brigade'],
  [30, 'Division'],
  [70, 'Heeresgruppe'],
  [120, 'Korps'],
  [Infinity, 'Armee'],
];

const PREFIX: Record<UnitType, string> = {
  infantry: 'Infanterie',
  artillery: 'Artillerie',
  armoredCar: 'Panzerwagen',
  tank: 'Panzer',
  railgun: 'Eisenbahnartillerie',
  battleship: '',
};

/** Einheitentyp mit dem größten Beitrag zur Kampfkraft */
export function dominantType(a: Army): UnitType | null {
  let best: UnitType | null = null, bp = -1;
  for (const u of unitTypes(a)) {
    const p = armyPower({ ...a, units: { [u]: a.units[u] } });
    if (p > bp) { bp = p; best = u; }
  }
  return best;
}

/** Bezeichnung ohne Nummer, z. B. „Panzerdivision“, „Heeresgruppe“, „Flotte“ */
export function armyDesignation(a: Army): string {
  if (a.owner === REBELS) return 'Aufständische';
  const power = armyPower(a);
  if (isNaval(a)) return power < 30 ? 'Geschwader' : 'Flotte';
  const size = SIZES.find(([max]) => power < max)![1];
  const type = dominantType(a) ?? 'infantry';
  if (type === 'infantry') {
    // reine Infanterieverbände: klassische Bezeichnungen
    return size === 'Brigade' || size === 'Division' ? `Infanterie${size.toLowerCase()}` : size === 'Korps' ? 'Armeekorps' : size;
  }
  const prefix = PREFIX[type] || UNITS[type].name;
  return size === 'Heeresgruppe' ? `${prefix}-Heeresgruppe` : `${prefix}${size.toLowerCase()}`;
}

/** Voller Name, z. B. „3. Panzerdivision“, oder der eigene Name (Schiffe, Geschütze, umbenannte Armeen) */
export function armyName(a: Army): string {
  if (a.owner === REBELS) return 'Aufständische';
  if (a.name) return a.name;
  return a.num ? `${a.num}. ${armyDesignation(a)}` : armyDesignation(a);
}

/** Armeen ohne Nummer die kleinste freie Nummer ihrer Nation geben (deterministisch, in Listenreihenfolge). */
export function numberArmies(state: GameState): boolean {
  if (state.armies.every((a) => a.num !== undefined || a.owner === REBELS)) return false;
  const used = new Map<string, Set<number>>();
  for (const a of state.armies) if (a.num !== undefined) (used.get(a.owner) ?? used.set(a.owner, new Set()).get(a.owner)!).add(a.num);
  for (const a of state.armies) {
    if (a.num !== undefined || a.owner === REBELS) continue;
    const set = used.get(a.owner) ?? used.set(a.owner, new Set()).get(a.owner)!;
    let n = 1;
    while (set.has(n)) n++;
    a.num = n;
    set.add(n);
  }
  return true;
}

/** Namenspräfix für Schlachtschiffe je Nation */
const SHIP_PREFIX: Record<string, string> = { DE: 'SMS', AT: 'SMS', GB: 'HMS', IT: 'RN' };

const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];

/**
 * Eigener Name für ein neues Schlachtschiff bzw. Eisenbahngeschütz: nach den Provinzen der
 * Stammnation der Reihe nach (deterministisch); ist die Liste durch, mit römischer Zählung.
 */
export function unitName(state: GameState, map: MapData, owner: string, unit: 'battleship' | 'railgun'): string {
  const n = state.nations[owner];
  const k = n?.named ?? 0;
  if (n) n.named = k + 1;
  let places = map.provinces.filter((p) => p.nation === owner).map((p) => p.name);
  if (!places.length) places = map.provinces.map((p) => p.name);
  const place = places[k % places.length] + (ROMAN[Math.floor(k / places.length)] ?? ` ${Math.floor(k / places.length) + 1}`);
  if (unit === 'railgun') return `Geschütz „${place}“`;
  const prefix = SHIP_PREFIX[owner];
  return prefix ? `${prefix} ${place}` : `„${place}“`;
}
