// Rohstoffprüfung einer Karte je Nation: Kategorieanteile, Doppelprovinzen, Öl und die Entfernung
// von der Hauptstadt zum nächsten Feld jedes Rohstoffs. Genutzt vom Kartenbau (Bericht) und vom Karteneditor.

import { CATEGORIES, CATEGORY_OF, type Category } from './balance.ts';
import { RESOURCES, type MapData, type Resource } from './mapdata.ts';

/** Regeln aus dem Kartenbau (scripts/resources.ts) */
export const NATION_MAX = 0.6;
export const NATION_MIN = 0.15;
/** Ab dieser Entfernung (km) zum nächsten Feld eines Rohstoffs gibt es eine Warnung */
export const FAR_KM = 1000;

export interface NationCheck {
  nation: string;
  provinces: number;
  /** Anteil je Kategorie (Doppelprovinz zählt doppelt) */
  shares: Record<Category, number>;
  doubles: number;
  oil: number;
  /** Entfernung Hauptstadt → nächste Provinz mit dem Rohstoff (km), eigene Provinz = 0 */
  nearest: Record<Resource, { km: number; province: number }>;
  problems: string[];
}

export function checkNation(map: MapData, nation: string, oilLimit?: number): NationCheck {
  const n = map.nations.find((x) => x.id === nation)!;
  const own = map.provinces.filter((p) => p.nation === nation);
  const pts = (d: boolean) => (d ? 2 : 1);
  const total = own.reduce((t, p) => t + pts(p.double), 0) || 1;
  const shares = Object.fromEntries(CATEGORIES.map((c) => [c, own.filter((p) => CATEGORY_OF[p.resource] === c).reduce((t, p) => t + pts(p.double), 0) / total])) as Record<Category, number>;
  const doubles = own.filter((p) => p.double).length;
  const oil = own.filter((p) => p.resource === 'oil').length;
  const cap = map.provinces[n.capital].center;
  const nearest = {} as NationCheck['nearest'];
  for (const r of RESOURCES) {
    let best = { km: Infinity, province: -1 };
    for (const p of map.provinces) {
      if (p.resource !== r) continue;
      const km = p.nation === nation ? 0 : Math.hypot(p.center[0] - cap[0], p.center[1] - cap[1]);
      if (km < best.km) best = { km, province: p.id };
    }
    nearest[r] = best;
  }
  const problems: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  if (n.major) {
    for (const c of CATEGORIES) {
      if (shares[c] < NATION_MIN - 1e-9) problems.push(`${c} nur ${pct(shares[c])}`);
      if (shares[c] > NATION_MAX + 1e-9) problems.push(`${c} ${pct(shares[c])}`);
    }
    if (doubles !== 2) problems.push(`${doubles} Doppelprovinzen statt 2`);
  } else if (own.length >= 3) {
    for (const c of CATEGORIES) if (shares[c] === 0) problems.push(`keine ${c}`);
  }
  if (oilLimit !== undefined && oil > oilLimit) problems.push(`${oil} Öl (höchstens ${oilLimit})`);
  for (const r of RESOURCES) if (nearest[r].km > FAR_KM) problems.push(`${r} ${Math.round(nearest[r].km)} km entfernt`);
  return { nation, provinces: own.length, shares, doubles, oil, nearest, problems };
}

/** Kurzbericht für die Konsole */
export function checkReport(map: MapData, oilLimit: (nation: string) => number | undefined = () => undefined): string {
  return map.nations.map((n) => {
    const c = checkNation(map, n.id, oilLimit(n.id));
    const far = RESOURCES.map((r) => `${r} ${Math.round(c.nearest[r].km)}`).join(' ');
    return `${n.id.padEnd(3)} ${String(c.provinces).padStart(2)} Prov. | km: ${far}${c.problems.length ? ` | ⚠ ${c.problems.join(', ')}` : ''}`;
  }).join('\n');
}
