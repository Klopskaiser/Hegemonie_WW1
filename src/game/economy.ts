// Produktion, Verbrauch, Moral und Siegpunkte.

import {
  ALL_RES, BUILDINGS, CATEGORIES, CATEGORY_OF, CATEGORY_RES, MORALE, POINTS, PROVINCE, RECRUIT_BASE_HOURS,
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

export function productionBonus(ps: ProvinceState): number {
  let b = 0;
  for (const k of Object.keys(ps.buildings) as Building[]) b += BUILDINGS[k].prodBonus(ps.buildings[k]);
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
      if (up && ps.buildings[b] > 0) for (const k of Object.keys(up) as Res[]) r.cons[k] += up[k]! * ps.buildings[b];
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
  const office = ps.buildings.recruitment > 0;
  const barracks = ps.buildings.barracks;
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

/** Hauptstadtprovinz, sofern die Nation sie noch hält */
export function capitalOf(state: GameState, map: MapData, nation: string): number | null {
  const n = map.nations.find((x) => x.id === nation);
  if (!n) return null;
  return state.provinces[n.capital]?.owner === nation ? n.capital : null;
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
  if (cap === id) parts.push({ label: 'Hauptstadt', value: MORALE.capitalBonus });
  else {
    let pen = MORALE.distanceMax;
    if (cap !== null) {
      const c = map.provinces[cap].center;
      const d = Math.hypot(c[0] - mp.center[0], c[1] - mp.center[1]);
      pen = Math.min(MORALE.distanceMax, (Math.max(0, d - MORALE.distanceFree) / 100) * MORALE.distancePer100);
    }
    if (pen > 0) parts.push({ label: cap === null ? 'Hauptstadt verloren' : 'Entfernung zur Hauptstadt', value: -pen });
  }
  let b = 0;
  for (const k of Object.keys(ps.buildings) as Building[]) b += BUILDINGS[k].morale(ps.buildings[k]);
  if (b > 0) parts.push({ label: 'Gebäude', value: b });
  if (mp.nation !== ps.owner) parts.push({ label: 'Besetztes Gebiet', value: -MORALE.occupied });
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
