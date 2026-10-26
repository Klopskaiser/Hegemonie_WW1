// Rohstoffverteilung beim Kartenbau.
// 1. Jede Provinz bekommt nach Lage einen Wunschrohstoff (Rohstoffzentren, Küste, Breite, Wüste).
// 2. Gesamtkarte: grob 40 % Energie, 30 % Baustoffe, 30 % Nahrung (gewichtet: Doppelprovinz = 2).
// 3. Je Nation (ab 3 Provinzen): jede Kategorie mindestens einmal, keine über 60 %.
// Öl gibt es nur in der Nähe historischer Ölorte.

import type { MapProvince, Resource } from '../src/game/mapdata.ts';
import { distSegment, pointInMulti, type MultiPoly, type Pt } from '../src/game/geom.ts';

function distToShape(p: Pt, shape: MultiPoly): number {
  let d = Infinity;
  for (const poly of shape) for (const ring of poly) for (let k = 0; k + 1 < ring.length; k++) {
    d = Math.min(d, distSegment(p[0], p[1], ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1]));
  }
  return d;
}

export type Cat = 'food' | 'materials' | 'energy';
export const CAT_OF: Record<Resource, Cat> = {
  grain: 'food', fish: 'food', iron: 'materials', lumber: 'materials', coal: 'energy', oil: 'energy', gas: 'energy',
};
const CATS: Cat[] = ['energy', 'materials', 'food'];
const RES_OF: Record<Cat, Resource[]> = { food: ['grain', 'fish'], materials: ['iron', 'lumber'], energy: ['coal', 'oil', 'gas'] };
export const TARGET: Record<Cat, number> = { energy: 0.4, materials: 0.3, food: 0.3 };
const NATION_MAX = 0.6;
/** Nationen ab 5 Provinzen: jede Kategorie mindestens 15 % */
const NATION_MIN = 0.15;
/** Reichweite eines Rohstofforts in km, gemessen bis zur Provinzfläche */
const SPOT_RANGE = 120;
/** Öl ist seltener: kleinerer Radius und Obergrenze je Nation */
const OIL_RANGE = 60;

export interface ResourceInput {
  province: MapProvince;
  shape: MultiPoly;
  lat: number;
  desert: boolean;
}

export function assignResources(
  items: ResourceInput[],
  spots: { r: Resource; pos: Pt }[],
  rnd: () => number,
  oilLimit: (nation: string) => number,
): void {
  // ------------------------------------------------ Eignung je Provinz und Rohstoff
  const score = items.map(({ province: p, shape, lat, desert }) => {
    const near = (r: Resource) => {
      const range = r === 'oil' ? OIL_RANGE : SPOT_RANGE;
      let d = Infinity;
      for (const s of spots) {
        if (s.r !== r) continue;
        d = Math.min(d, pointInMulti(s.pos[0], s.pos[1], shape) ? 0 : distToShape(s.pos, shape));
      }
      return d < range ? 1 + 3 * (1 - d / range) : 0;
    };
    const noise = () => rnd() * 0.4;
    const sc: Record<Resource, number> = {
      grain: (desert ? 0.15 : lat > 60 ? 0.2 : 1) + near('grain') * 0.6 + noise(),
      fish: p.coastal ? 0.9 + noise() : -Infinity,
      lumber: (desert ? 0.05 : lat > 56 ? 1.3 : 0.8) + noise(),
      iron: 0.3 + near('iron') * 0.8 + noise(),
      coal: 0.4 + near('coal') + noise(),
      gas: 0.45 + near('gas') + noise(),
      // Öl nie in Doppelprovinzen, damit es knapp bleibt
      oil: near('oil') > 0 && !p.double ? 1.5 + near('oil') + noise() : -Infinity,
    };
    return sc;
  });
  const best = (i: number, cat: Cat) => RES_OF[cat].reduce((a, b) => (score[i][b] > score[i][a] ? b : a));
  const pts = (i: number) => (items[i].province.double ? 2 : 1);
  const catOf = (i: number) => CAT_OF[items[i].province.resource];

  const argmax = (i: number) => (Object.keys(score[i]) as Resource[]).reduce((a, b) => (score[i][b] > score[i][a] ? b : a));
  for (let i = 0; i < items.length; i++) items[i].province.resource = argmax(i);

  const byNation = new Map<string, number[]>();
  items.forEach((it, i) => (byNation.get(it.province.nation) ?? byNation.set(it.province.nation, []).get(it.province.nation)!).push(i));
  const nationOf = (i: number) => byNation.get(items[i].province.nation)!;

  // Öl begrenzen: je Nation nur die besten Ölstandorte, alle anderen verlieren die Öloption
  for (const [nation, own] of byNation) {
    const oil = own.filter((i) => isFinite(score[i].oil)).sort((a, b) => score[b].oil - score[a].oil);
    oil.slice(oilLimit(nation)).forEach((i) => (score[i].oil = -Infinity));
    for (const i of own) if (items[i].province.resource === 'oil' && !isFinite(score[i].oil)) items[i].province.resource = argmax(i);
  }
  const share = (idx: number[], cat: Cat) => idx.filter((i) => catOf(i) === cat).reduce((s, i) => s + pts(i), 0) / idx.reduce((s, i) => s + pts(i), 0);
  const count = (idx: number[], cat: Cat) => idx.filter((i) => catOf(i) === cat).length;

  /** Darf Provinz i von ihrer Kategorie nach `to` wechseln, ohne Nationsregeln zu verletzen? */
  const allowed = (i: number, to: Cat) => {
    const own = nationOf(i);
    const from = catOf(i);
    const old = items[i].province.resource;
    items[i].province.resource = best(i, to);
    const ok = (own.length < 3 || count(own, from) >= 1) && share(own, to) <= NATION_MAX + 1e-9
      && (own.length < 5 || share(own, from) >= NATION_MIN - 1e-9);
    items[i].province.resource = old;
    return ok;
  };
  const loss = (i: number, to: Cat) => score[i][items[i].province.resource] - score[i][best(i, to)];

  const switchCheapest = (candidates: number[], to: Cat, check: boolean, bias: (i: number) => number = () => 0) => {
    let pick = -1, pl = Infinity;
    for (const i of candidates) {
      if (items[i].province.resource === 'oil' || !isFinite(score[i][best(i, to)])) continue;
      if (check && !allowed(i, to)) continue;
      const l = loss(i, to) + bias(i);
      if (l < pl) { pl = l; pick = i; }
    }
    if (pick >= 0) items[pick].province.resource = best(pick, to);
    return pick >= 0;
  };

  const nationRules = () => {
    for (const own of byNation.values()) {
      if (own.length < 3) {
        // Kleinststaaten: wenigstens zwei verschiedene Kategorien, falls möglich
        if (own.length === 2 && catOf(own[0]) === catOf(own[1])) {
          const to = CATS.filter((c) => c !== catOf(own[0])).sort((a, b) => loss(own[1], a) - loss(own[1], b))[0];
          switchCheapest([own[1]], to, false);
        }
        continue;
      }
      for (const c of CATS) {
        if (count(own, c) > 0) continue;
        const donor = CATS.filter((d) => d !== c).sort((a, b) => share(own, b) - share(own, a))[0];
        switchCheapest(own.filter((i) => catOf(i) === donor), c, false);
      }
      for (let guard = 0; guard < 20; guard++) {
        const top = CATS.reduce((a, b) => (share(own, b) > share(own, a) ? b : a));
        if (share(own, top) <= NATION_MAX + 1e-9) break;
        const low = CATS.reduce((a, b) => (share(own, b) < share(own, a) ? b : a));
        if (!switchCheapest(own.filter((i) => catOf(i) === top), low, false)) break;
      }
      if (own.length < 5) continue;
      for (let guard = 0; guard < 20; guard++) {
        const low = CATS.reduce((a, b) => (share(own, b) < share(own, a) ? b : a));
        if (share(own, low) >= NATION_MIN - 1e-9) break;
        const top = CATS.reduce((a, b) => (share(own, b) > share(own, a) ? b : a));
        if (!switchCheapest(own.filter((i) => catOf(i) === top), low, false)) break;
      }
    }
  };

  const globalBalance = () => {
    const all = items.map((_, i) => i);
    for (let guard = 0; guard < 400; guard++) {
      const over = CATS.reduce((a, b) => (share(all, b) - TARGET[b] > share(all, a) - TARGET[a] ? b : a));
      const under = CATS.reduce((a, b) => (share(all, b) - TARGET[b] < share(all, a) - TARGET[a] ? b : a));
      if (share(all, over) - TARGET[over] < 0.015) break;
      // bevorzugt in Nationen wechseln, die von der überzähligen Kategorie viel und von der fehlenden wenig haben
      const bias = (i: number) => -2 * (share(nationOf(i), over) - share(nationOf(i), under));
      if (!switchCheapest(all.filter((i) => catOf(i) === over), under, true, bias)) break;
    }
  };

  nationRules();
  globalBalance();
  nationRules();
}

export function resourceReport(provinces: MapProvince[]): string {
  const pts = (p: MapProvince) => (p.double ? 2 : 1);
  const total = provinces.reduce((s, p) => s + pts(p), 0);
  const lines: string[] = [];
  const byCat = CATS.map((c) => `${c} ${Math.round((provinces.filter((p) => CAT_OF[p.resource] === c).reduce((s, p) => s + pts(p), 0) / total) * 100)} %`);
  const byRes = (Object.keys(CAT_OF) as Resource[]).map((r) => `${r} ${provinces.filter((p) => p.resource === r).reduce((s, p) => s + pts(p), 0)}`);
  lines.push(`Gesamt: ${byCat.join(', ')} | ${byRes.join(', ')}`);
  const nations = [...new Set(provinces.map((p) => p.nation))];
  for (const n of nations) {
    const own = provinces.filter((p) => p.nation === n);
    const t = own.reduce((s, p) => s + pts(p), 0);
    const cats = CATS.map((c) => `${c[0].toUpperCase()}${Math.round((own.filter((p) => CAT_OF[p.resource] === c).reduce((s, p) => s + pts(p), 0) / t) * 100)}`).join(' ');
    lines.push(`${n.padEnd(3)} ${cats.padEnd(14)} ${own.map((p) => p.resource + (p.double ? '×2' : '')).join(', ')}`);
  }
  return lines.join('\n');
}
