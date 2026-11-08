import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { edgePoints, edgeThrough, nodeNeighbors } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { checkNation } from '../src/game/mapcheck.ts';
import { applyEdits, harborSplit } from '../src/game/mapedits.ts';

const base: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'data', 'maps', 'europe.base.json'), 'utf8'));
const id = (name: string) => base.provinces.find((p) => p.name === name)!.id;
const sea = (name: string) => base.provinces.length + base.seas.find((z) => z.name === name)!.id;

describe('Karteneditor-Vorgaben', () => {
  it('ohne Vorgaben bleibt die Karte gleich', () => {
    const { map, warnings } = applyEdits(base, {});
    expect(warnings).toEqual([]);
    expect(map.provinces.map((p) => p.links ?? p.neighbors)).toEqual(base.provinces.map((p) => p.links ?? p.neighbors));
    expect(map.roads?.length).toBe(base.roads?.length);
  });

  it('streicht und ergänzt Verbindungen und setzt Verläufe', () => {
    const berlin = id('Berlin');
    const n = base.provinces[berlin].links![0];
    const other = base.provinces[berlin].neighbors.find((x) => !base.provinces[berlin].links!.includes(x));
    const a = base.provinces[berlin].name, b = base.provinces[n].name;
    const { map } = applyEdits(base, {
      remove: [[a, b]],
      ...(other !== undefined ? { add: [[a, base.provinces[other].name]] as [string, string][] } : {}),
    });
    expect(nodeNeighbors(map, berlin)).not.toContain(n);
    if (other !== undefined) expect(nodeNeighbors(map, berlin)).toContain(other);

    const [x0, y0] = base.provinces[berlin].center, [x1, y1] = base.provinces[n].center;
    const mid: [number, number] = [(x0 + x1) / 2 + 5, (y0 + y1) / 2];
    const moved = applyEdits(base, { paths: { [`${b}|${a}`]: [mid] } }).map;
    const pts = edgePoints(moved, berlin, n);
    expect(pts).toHaveLength(3);
    // Raster der Karte ist halbe km; ein naher Kreuzungspunkt darf den Knick um bis zu 1 km anziehen
    expect(Math.abs(pts[1][0] - mid[0])).toBeLessThanOrEqual(1);
    expect(pts[0]).toEqual(base.provinces[berlin].center);
  });

  it('Abkürzung zwischen Provinzen ohne gemeinsame Grenze führt durch das Gebiet dazwischen', () => {
    const { map } = applyEdits(base, { add: [['Berlin', 'Dresden'], ['Hamburg', 'Nordsee']] });
    const berlin = id('Berlin'), dresden = id('Dresden');
    expect(nodeNeighbors(map, berlin)).toContain(dresden);
    if (!base.provinces[berlin].neighbors.includes(dresden)) expect(edgeThrough(map, berlin, dresden)).not.toBeNull();
    expect(nodeNeighbors(map, id('Hamburg'))).toContain(sea('Nordsee'));
  });
});

describe('Rohstoffe der Karte', () => {
  it('Editor-Vorgaben setzen Rohstoff und Doppelprovinz, unbekannte Provinzen werden gemeldet', () => {
    const { map, warnings } = applyEdits(base, { resources: { Kiew: { r: 'iron', double: false }, Nirgendwo: { r: 'oil', double: true } } });
    expect(map.provinces[id('Kiew')].resource).toBe('iron');
    expect(map.provinces[id('Kiew')].double).toBe(false);
    expect(base.provinces[id('Kiew')].resource).toBe('grain');
    expect(warnings).toEqual(['Unbekannte Provinz: Nirgendwo']);
    // Russland verliert damit seine Doppelprovinz
    expect(checkNation(map, 'RU').problems).toContain('1 Doppelprovinzen statt 2');
  });

  it('Großmächte halten die Rohstoffregeln ein, Großmächte haben 10 Provinzen', () => {
    for (const n of base.nations.filter((x) => x.major)) {
      const c = checkNation(base, n.id);
      expect(c.provinces, n.id).toBe(10);
      expect(c.problems.filter((p) => !p.includes('km entfernt')), n.id).toEqual([]);
    }
    expect(base.provinces[id('Kiew')].double).toBe(true);
    expect(base.provinces.filter((p) => p.nation === 'RU' && p.resource === 'iron').length).toBeGreaterThan(0);
    // Holz auch in Nordafrika
    expect(base.provinces.filter((p) => ['MG', 'LY', 'EG'].includes(p.nation) && p.resource === 'lumber').length).toBeGreaterThanOrEqual(2);
  });
});

describe('Hauptstädte', () => {
  it('Vorgaben verschieben den Nationssitz; fremde Provinz, unbekannte Nation und Provinz werden gemeldet', () => {
    const ru = base.nations.find((n) => n.id === 'RU')!;
    const oldCap = ru.capital;
    expect(base.provinces[oldCap].capital).toBe(true);
    const { map, warnings } = applyEdits(base, { capitals: { RU: 'Kiew', DE: 'Kiew', XX: 'Nirgendwo', MG: 'Unbekannteste' } });
    expect(map.nations.find((n) => n.id === 'RU')!.capital).toBe(id('Kiew'));
    expect(map.provinces[id('Kiew')].capital).toBe(true);
    expect(map.provinces[oldCap].capital).toBe(false);
    // Grundkarte bleibt unverändert
    expect(base.provinces[id('Kiew')].capital).toBe(false);
    // DE darf Kiew nicht übernehmen
    expect(map.nations.find((n) => n.id === 'DE')!.capital).toBe(base.nations.find((n) => n.id === 'DE')!.capital);
    expect(warnings).toContain('Unbekannte Nation: XX');
    expect(warnings).toContain('Kiew gehört zu einer anderen Nation – Hauptstadt nicht verschoben.');
    expect(warnings).toContain('Unbekannte Provinz: Unbekannteste');
  });

  it('Hauptstadt per Nationnamen setzen und Nächstes-Feld-Prüfung nutzt den neuen Sitz', () => {
    const { map } = applyEdits(base, { capitals: { 'Russisches Reich': 'Kiew' } });
    expect(map.nations.find((n) => n.id === 'RU')!.capital).toBe(id('Kiew'));
    const c = checkNation(map, 'RU');
    expect(c.nearest.grain.province >= 0 || c.problems.some((p) => p.includes('km'))).toBe(true);
  });
});

describe('Kreuzungs- und Pfadhygiene', () => {
  /** Kreuzung, die nur auf genau einem Weg liegt (und > 2 km von allen anderen entfernt ist) */
  const orphanCandidate = (() => {
    const segs = (base.roads ?? []).map((r) => ({ r, p: r.pts }));
    const dist = (x: number, y: number, p: number[]) => {
      let bd = Infinity;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ax = p[k], ay = p[k + 1], dx = p[k + 2] - ax, dy = p[k + 3] - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        bd = Math.min(bd, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
      }
      return bd;
    };
    const nm = (n: number) => (n < base.provinces.length ? base.provinces[n].name : base.seas[n - base.provinces.length].name);
    for (const j of base.junctions ?? []) {
      // nur auf genau diesem Weg, nirgends sonst (auch nicht auf einer Abkürzung)
      if ((base.shortcuts ?? []).some((s) => dist(j.x, j.y, s.pts) <= 2)) continue;
      const on = segs.filter(({ p }) => dist(j.x, j.y, p) <= 2);
      if (on.length === 1) return { j, a: nm(on[0].r.a), b: nm(on[0].r.b) };
    }
    return null;
  })();

  it('Kreuzung ohne Weg wird entfernt und gemeldet', () => {
    expect(orphanCandidate).not.toBeNull();
    const { j, a, b } = orphanCandidate!;
    const { map, warnings } = applyEdits(base, { remove: [[a, b]] });
    expect(map.junctions!.some((k) => Math.hypot(k.x - j.x, k.y - j.y) < 3)).toBe(false);
    expect(warnings.some((w) => w.includes('auf keinem Weg'))).toBe(true);
    // ohne Entfernen des Weges bleibt sie stehen
    expect(applyEdits(base, {}).map.junctions!.some((k) => Math.hypot(k.x - j.x, k.y - j.y) < 3)).toBe(true);
  });

  it('per Hand gesetzte Kreuzung auf freier Fläche bleibt erhalten', () => {
    const { map } = applyEdits(base, { junctions: { add: [[-400, 1500]] } });
    expect(map.junctions!.some((k) => Math.hypot(k.x + 400, k.y - 1500) < 3)).toBe(true);
  });

  it('doppelte aufeinanderfolgende Punkte im Verlauf werden ignoriert', () => {
    const p: [number, number] = [-565.5, 1298.6];
    const { map } = applyEdits(base, { paths: { 'Straße von Sizilien|Ionisches Meer': [p, [...p] as [number, number], [-329.6, 1401.7]] } });
    const r = map.roads!.find((x) => (x.a === base.provinces.length + base.seas.findIndex((s) => s.name === 'Straße von Sizilien') || x.b === base.provinces.length + base.seas.findIndex((s) => s.name === 'Straße von Sizilien')) && (x.a === base.provinces.length + base.seas.findIndex((s) => s.name === 'Ionisches Meer') || x.b === base.provinces.length + base.seas.findIndex((s) => s.name === 'Ionisches Meer')))!;
    const pts = r.pts;
    for (let k = 0; k + 3 < pts.length; k += 2)
      expect(Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]), 'aufeinanderfolgende Punkte').toBeGreaterThan(0.05);
  });

  it('neue Verbindung mit Kreuzungs-Endpunkten biegt sofort über sie', () => {
    // Seegebietspaar suchen, das noch nicht verbunden ist
    const P = base.provinces.length;
    let pair: [string, string] | null = null;
    outer: for (const a of base.seas) for (const b of base.seas) {
      if (a.id >= b.id) continue;
      if (!a.seas.includes(b.id)) { pair = [a.name, b.name]; break outer; }
    }
    expect(pair).not.toBeNull();
    const [na, nb] = pair!;
    const A: [number, number] = [base.seas.find((s) => s.name === na)!.center[0] + 40, base.seas.find((s) => s.name === na)!.center[1] - 60];
    const B: [number, number] = [base.seas.find((s) => s.name === nb)!.center[0] - 40, base.seas.find((s) => s.name === nb)!.center[1] + 60];
    const { map } = applyEdits(base, { add: [[na, nb]], paths: { [`${na}|${nb}`]: [A, B] } });
    const ia = P + base.seas.findIndex((s) => s.name === na), ib = P + base.seas.findIndex((s) => s.name === nb);
    const r = map.roads!.find((x) => (x.a === ia && x.b === ib) || (x.a === ib && x.b === ia));
    expect(r, `${na}–${nb}`).toBeDefined();
    expect(r!.pts.slice(2, -2)).toEqual([A[0], A[1], B[0], B[1]]);
    // und die Verbindung existiert im Netzwerk
    expect(map.seas[ia - P].seas).toContain(ib - P);
  });

  it('Hafenweg: split endet an der Wassergrenze, nicht pauschal in der Mitte', () => {
    // Provinz 0 = Quadrat 0..100, Seegebiet dahinter; Weg Stadt (50,50) → Knick an Land → See (250,50)
    const m = { provinces: [{ polys: [[[0, 0, 100, 0, 100, 100, 0, 100]]] }] } as unknown as MapData;
    const pts: [number, number][] = [[50, 50], [90, 50], [250, 50]];
    expect(harborSplit(m, 0, 1, pts)).toBeCloseTo(0.25, 2);                    // 50 von 200 km an Land
    expect(harborSplit(m, 1, 0, [...pts].reverse())).toBeCloseTo(0.75, 2);     // Seepunkt vorn: ab a gezählt
  });
});
