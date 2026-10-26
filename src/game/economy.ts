// Produktion, Verbrauch, Moral und Siegpunkte.

import {
  ALL_RES, BUILDING_ORDER, BUILDINGS, CATEGORIES, CATEGORY_OF, CATEGORY_RES, DEFECTION, MORALE, POINTS, PROVINCE, RECRUIT_BASE_HOURS,
  RECRUIT_WITHOUT_OFFICE, UNITS, type Building, type Category, type Res, type UnitType,
} from './balance.ts';
import { RESOURCES, type MapData, type Resource } from './mapdata.ts';
import { warCount } from './diplomacy.ts';
import type { GameState, ProvinceState } from './types.ts';

export interface ProvinceOutput {
  resource: Resource;
  amount: number;
  money: number;
  bonus: number;
}

export interface NationRates {
  /** pro Tag */
  prod: Record<Res, number>;
  /** fester Verbrauch: Unterhalt von Einheiten und Gebäuden (nicht umstellbar) */
  cons: Record<Res, number>;
  /** Provinzunterhalt je Kategorie und Tag (in allen drei Kategorien gleich) */
  upkeep: number;
  /** Verbrauchsregler als Anteil 0..1 je Rohstoff */
  shares: Record<Resource, number>;
}

const zero = (): Record<Res, number> => Object.fromEntries(ALL_RES.map((r) => [r, 0])) as Record<Res, number>;

/** Wirksame Stufe eines Gebäudes: abgeschaltete und beschädigte zählen wie nicht gebaut */
export function activeLevel(ps: ProvinceState, b: Building): number {
  return ps.off?.[b] || ps.damage?.[b] ? 0 : ps.buildings[b];
}

/** Stufe für den Unterhalt: abgeschaltete kosten nichts, beschädigte weiter */
export function upkeepLevel(ps: ProvinceState, b: Building): number {
  return ps.off?.[b] ? 0 : ps.buildings[b];
}

export function productionBonus(ps: ProvinceState): number {
  let b = 0;
  for (const k of Object.keys(ps.buildings) as Building[]) b += BUILDINGS[k].prodBonus(activeLevel(ps, k));
  return b;
}

export function provinceOutput(map: MapData, ps: ProvinceState, id: number): ProvinceOutput {
  const mp = map.provinces[id];
  const bonus = productionBonus(ps);
  const size = mp.double ? 2 : 1;
  const amount = PROVINCE.resourceBase * size * ps.morale * (1 + bonus);
  return { resource: mp.resource, amount, money: PROVINCE.money * size * ps.morale, bonus };
}

/** Raten aller Nationen in einem Durchlauf. */
export function allRates(state: GameState, map: MapData): Record<string, NationRates> {
  const out: Record<string, NationRates> = {};
  for (const [id, n] of Object.entries(state.nations)) {
    const shares = {} as Record<Resource, number>;
    for (const r of RESOURCES) shares[r] = (n.consumption?.[r] ?? 0) / 100;
    out[id] = { prod: zero(), cons: zero(), upkeep: 0, shares };
  }
  state.provinces.forEach((ps, i) => {
    const r = out[ps.owner];
    if (!r) return;
    const po = ps.revolt ? { resource: map.provinces[i].resource, amount: 0, money: 0 } : provinceOutput(map, ps, i);
    r.prod[po.resource] += po.amount;
    r.prod.money += po.money;
    r.upkeep += PROVINCE.upkeep;
    for (const b of Object.keys(ps.buildings) as Building[]) {
      const up = BUILDINGS[b].upkeep;
      const lvl = upkeepLevel(ps, b);
      if (up && lvl > 0) for (const k of Object.keys(up) as Res[]) r.cons[k] += up[k]! * lvl;
    }
  });
  for (const a of state.armies) {
    const r = out[a.owner];
    if (!r) continue; // Aufständische haben keinen Unterhalt
    for (const u of Object.keys(a.units) as UnitType[]) {
      const n = a.units[u] ?? 0;
      const up = UNITS[u].upkeep;
      for (const k of Object.keys(up) as Res[]) r.cons[k] += up[k]! * n;
    }
  }
  return out;
}

export function nationRates(state: GameState, map: MapData, nation: string): NationRates {
  return allRates(state, map)[nation];
}

/** Provinzunterhalt, der laut Verbrauchsregler auf einen Rohstoff entfällt (pro Tag) */
export function upkeepUse(r: NationRates, res: Res): number {
  return res === 'money' ? 0 : r.upkeep * r.shares[res];
}

/** Gesamtverbrauch pro Tag: fester Unterhalt plus Anteil am Provinzunterhalt */
export function totalUse(r: NationRates, res: Res): number {
  return r.cons[res] + upkeepUse(r, res);
}

export interface UseSource {
  label: string;
  amount: number;
}

/**
 * Verbrauch einer Nation nach Verursachern je Rohstoff (pro Tag): Provinzunterhalt laut Regler,
 * Gebäude je Art (Stufen zusammengezählt) und Einheiten je Typ (über alle Armeen).
 */
export function useSources(state: GameState, map: MapData, nation: string): Record<Res, UseSource[]> {
  const out = Object.fromEntries(ALL_RES.map((r) => [r, [] as UseSource[]])) as Record<Res, UseSource[]>;
  const r = nationRates(state, map, nation);
  for (const res of ALL_RES) {
    const u = upkeepUse(r, res);
    if (u > 0) out[res].push({ label: `Provinzunterhalt (${Math.round(r.shares[res as Resource] * 100)} % laut Regler)`, amount: u });
  }
  const levels = new Map<Building, { levels: number; provinces: number; off: number }>();
  for (const ps of state.provinces) {
    if (ps.owner !== nation) continue;
    for (const b of Object.keys(ps.buildings) as Building[]) {
      if (!BUILDINGS[b].upkeep || ps.buildings[b] <= 0) continue;
      const e = levels.get(b) ?? { levels: 0, provinces: 0, off: 0 };
      if (ps.off?.[b]) e.off++;
      else {
        e.levels += ps.buildings[b];
        e.provinces++;
      }
      levels.set(b, e);
    }
  }
  for (const [b, e] of levels) {
    const up = BUILDINGS[b].upkeep!;
    for (const res of Object.keys(up) as Res[]) {
      const lvl = BUILDINGS[b].maxLevel > 1 ? `${e.levels} Stufen in ${e.provinces} Provinzen` : `${e.provinces}×`;
      out[res].push({ label: `${BUILDINGS[b].name} (${lvl}${e.off ? `, ${e.off} abgeschaltet` : ''})`, amount: up[res]! * e.levels });
    }
  }
  const units = new Map<UnitType, number>();
  for (const a of state.armies) {
    if (a.owner !== nation) continue;
    for (const u of Object.keys(a.units) as UnitType[]) units.set(u, (units.get(u) ?? 0) + (a.units[u] ?? 0));
  }
  for (const [u, n] of units) {
    for (const res of Object.keys(UNITS[u].upkeep) as Res[]) {
      if (n > 0) out[res].push({ label: `${UNITS[u].name} (${n}× à ${UNITS[u].upkeep[res]})`, amount: UNITS[u].upkeep[res]! * n });
    }
  }
  for (const res of ALL_RES) out[res].sort((x, y) => y.amount - x.amount);
  return out;
}

/** Tagesbilanz eines Rohstoffs */
export function netRate(r: NationRates, res: Res): number {
  return r.prod[res] - totalUse(r, res);
}

/**
 * Gewichte je Rohstoff einer Kategorie in ganze Prozent mit Summe 100 umrechnen
 * (größte Reste zuerst); ohne positive Gewichte gleichmäßig.
 */
export function toShares(cat: Category, weights: Partial<Record<Resource, number>>): Partial<Record<Resource, number>> {
  const list = CATEGORY_RES[cat];
  let w = list.map((r) => Math.max(0, weights[r] ?? 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) w = list.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (x / total) * 100);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) if (rest-- > 0) out[i]++;
  return Object.fromEntries(list.map((r, i) => [r, out[i]]));
}

/** Startwerte des Verbrauchsreglers: je Kategorie anteilig zur eigenen Produktion bei Spielbeginn. */
export function defaultConsumption(map: MapData, nation: string): Record<Resource, number> {
  const prod: Partial<Record<Resource, number>> = {};
  for (const p of map.provinces) if (p.nation === nation) prod[p.resource] = (prod[p.resource] ?? 0) + (p.double ? 2 : 1);
  const out = {} as Record<Resource, number>;
  for (const c of CATEGORIES) Object.assign(out, toShares(c, prod));
  return out;
}

/** Verbrauchsregler gültig? (ganze Prozent 0–100, je Kategorie Summe 100) */
export function validShares(cat: Category, shares: Partial<Record<Resource, number>>): boolean {
  const list = CATEGORY_RES[cat];
  if (Object.keys(shares).some((k) => !list.includes(k as Resource))) return false;
  let sum = 0;
  for (const r of list) {
    const v = shares[r] ?? 0;
    if (!Number.isInteger(v) || v < 0 || v > 100) return false;
    sum += v;
  }
  return sum === 100;
}

/** Spielstunden je Infanterie in einer Provinz, null = es entsteht keine Infanterie. */
export function recruitHours(ps: ProvinceState): number | null {
  const office = activeLevel(ps, 'recruitment') > 0;
  const barracks = activeLevel(ps, 'barracks');
  if ((!office && barracks === 0) || ps.revolt || ps.morale <= 0) return null;
  const rate = (2 ** barracks * (office ? 1 : RECRUIT_WITHOUT_OFFICE) * ps.morale) / RECRUIT_BASE_HOURS;
  return 1 / rate;
}

export function categoryOf(r: Res): Category | null {
  return r === 'money' ? null : CATEGORY_OF[r];
}


// ---------------------------------------------------------------- Moral

export interface MoraleBreakdown {
  target: number;
  parts: { label: string; value: number }[];
}

/** Hauptstadt einer Nation (verlegt oder laut Karte), auch wenn sie gerade verloren ist; -1 ohne */
export function activeCapital(state: GameState, map: MapData, nation: string): number {
  const own = state.nations[nation]?.capital;
  if (own !== undefined) return own;
  return map.nations.find((x) => x.id === nation)?.capital ?? -1;
}

/** Hauptstadtprovinz, sofern die Nation sie noch hält */
export function capitalOf(state: GameState, map: MapData, nation: string): number | null {
  const c = activeCapital(state, map, nation);
  return c >= 0 && state.provinces[c]?.owner === nation ? c : null;
}

export function warsOf(state: GameState, nation: string): number {
  return warCount(state, nation);
}

export function moraleTarget(state: GameState, map: MapData, id: number): MoraleBreakdown {
  const ps = state.provinces[id];
  const mp = map.provinces[id];
  const nation = state.nations[ps.owner];
  const parts: { label: string; value: number }[] = [{ label: 'Grundwert', value: MORALE.base }];
  const cap = capitalOf(state, map, ps.owner);
  if (cap !== id) {
    let pen = MORALE.distanceMax;
    if (cap !== null) {
      const c = map.provinces[cap].center;
      const d = Math.hypot(c[0] - mp.center[0], c[1] - mp.center[1]);
      pen = Math.min(MORALE.distanceMax, (Math.max(0, d - MORALE.distanceFree) / 100) * MORALE.distancePer100);
    }
    if (pen > 0) parts.push({ label: cap === null ? 'Hauptstadt verloren (verlegen!)' : 'Entfernung zur Hauptstadt', value: -pen });
  }
  for (const k of BUILDING_ORDER) {
    const lvl = activeLevel(ps, k);
    const v = BUILDINGS[k].morale(lvl);
    if (v > 0) parts.push({ label: BUILDINGS[k].maxLevel > 1 ? `${BUILDINGS[k].name} Stufe ${lvl}` : BUILDINGS[k].name, value: v });
  }
  // Kämpfe: je Tag in Folge −10 %, höchstens −30 %; ohne Kampf bis zum Tageswechsel fällt der Abzug weg
  if (ps.fought) {
    const days = (ps.battleDays ?? 0) + 1;
    parts.push({ label: `Kämpfe in der Provinz (${days}. Tag)`, value: -Math.min(MORALE.battleMax, days * MORALE.battle) });
  }
  const unrest = mp.neighbors.filter((n) => state.provinces[n].owner === ps.owner && state.provinces[n].morale < DEFECTION.threshold).length;
  if (unrest > 0) parts.push({ label: `Unruhe in ${unrest} Nachbarprovinz${unrest > 1 ? 'en' : ''}`, value: -unrest * MORALE.unrestNeighbor });
  const wars = warsOf(state, ps.owner);
  if (wars > 0) parts.push({ label: 'Kriege', value: -Math.min(MORALE.warMax, wars * MORALE.warEach) });
  if (nation) {
    for (const c of Object.keys(nation.shortage) as Category[]) {
      if (nation.shortage[c]) parts.push({ label: `Mangel (${c === 'food' ? 'Nahrung' : c === 'materials' ? 'Baustoffe' : 'Energie'})`, value: -MORALE.shortage[c] });
    }
  }
  const sum = parts.reduce((s, p) => s + p.value, 0);
  return { target: Math.max(MORALE.min, Math.min(1, sum)), parts };
}

export function stepMorale(current: number, target: number): number {
  const gap = target - current;
  if (Math.abs(gap) < 0.005) return target;
  let step = gap * MORALE.adapt;
  if (Math.abs(step) < 0.01) step = Math.sign(gap) * Math.min(0.01, Math.abs(gap));
  step = Math.max(-MORALE.maxStep, Math.min(MORALE.maxStep, step));
  return Math.max(MORALE.min, Math.min(1, current + step));
}

// ---------------------------------------------------------------- Siegpunkte

export function provincePoints(map: MapData, ps: ProvinceState, id: number): number {
  const mp = map.provinces[id];
  const base = mp.capital ? POINTS.capital : mp.city ? POINTS.city : POINTS.rural;
  let levels = 0;
  for (const k of Object.keys(ps.buildings) as Building[]) levels += ps.buildings[k];
  return base * (0.5 + 0.5 * ps.morale) + levels * POINTS.perBuildingLevel;
}

export function totalPoints(state: GameState, map: MapData): number {
  let s = 0;
  state.provinces.forEach((ps, i) => (s += provincePoints(map, ps, i)));
  return s;
}
