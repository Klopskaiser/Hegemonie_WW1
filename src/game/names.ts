// Armeenamen: Größe nach Kampfstärke, Art nach der Einheit, die am meisten Stärke beiträgt.
// Die Nummer ist je Nation eindeutig und bleibt der Armee erhalten.

import { UNITS, type UnitType } from './balance.ts';
import { armyPower, isNaval, unitTypes } from './military.ts';
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

/** Voller Name, z. B. „3. Panzerdivision“ */
export function armyName(a: Army): string {
  if (a.owner === REBELS) return 'Aufständische';
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
