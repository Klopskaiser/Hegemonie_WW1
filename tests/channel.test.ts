// Werkzeug „Wasser einfügen“ (cutWaterChannel): Meerengen durchschneiden
import { describe, expect, it } from 'vitest';
import { addProvince, addVertex, coastalProvinceIds, cutWaterChannel, edgeOwners, newDraft, provArea, provinceAt, type Draft, type Pt } from '../src/game/draft.ts';

/** Rechteck-Provinz; gibt ihre Ring-Eckpunkte zurück */
function rect(d: Draft, x0: number, y0: number, x1: number, y1: number, name = 'R'): number[] {
  const ids = [addVertex(d, [x0, y0]), addVertex(d, [x1, y0]), addVertex(d, [x1, y1]), addVertex(d, [x0, y1])];
  addProvince(d, ids, { name });
  return ids;
}

describe('Wasser einfügen (Meerenge)', () => {
  it('trennt eine über das Wasser verbundene Provinz und lässt Wasser dazwischen', () => {
    const d = newDraft('t', 'T', 400, 200);
    // zwei Blöcke, verbunden durch eine dünne Landbrücke über das Wasser
    const ring = [
      addVertex(d, [0, 0]), addVertex(d, [100, 0]), addVertex(d, [100, 40]), addVertex(d, [200, 40]),
      addVertex(d, [200, 0]), addVertex(d, [300, 0]), addVertex(d, [300, 100]), addVertex(d, [200, 100]),
      addVertex(d, [200, 60]), addVertex(d, [100, 60]), addVertex(d, [100, 100]), addVertex(d, [0, 100]),
    ];
    addProvince(d, ring, { name: 'Konstantinopel' });
    const r = cutWaterChannel(d, [[150, 20], [150, 80]], 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.cuts).toBe(2);
    expect(r.removed).toBe(1);
    expect(d.provinces.length).toBe(2);
    expect(provinceAt(d, 150, 50)).toBeNull(); // Kanal ist Wasser
    // keine gemeinsame Grenze mehr, beide Ufer werden Küste
    expect([...edgeOwners(d).values()].every((e) => e.owners.length === 1)).toBe(true);
    expect(coastalProvinceIds(d).sort()).toEqual(d.provinces.map((p) => p.id).sort());
  });

  it('trennt zwei Provinzen, die sich über die Meerenge hinweg berühren', () => {
    const d = newDraft('t', 'T', 400, 200);
    // linke Provinz mit Brückenstumpf bis x=150, rechte gespiegelt – gemeinsame Kante bei x=150
    const sharedA = addVertex(d, [150, 40]), sharedB = addVertex(d, [150, 60]);
    addProvince(d, [
      addVertex(d, [0, 0]), addVertex(d, [100, 0]), addVertex(d, [100, 40]), sharedA,
      sharedB, addVertex(d, [100, 60]), addVertex(d, [100, 100]), addVertex(d, [0, 100]),
    ], { name: 'Rumelien' });
    addProvince(d, [
      sharedA, addVertex(d, [200, 40]), addVertex(d, [200, 0]), addVertex(d, [300, 0]),
      addVertex(d, [300, 100]), addVertex(d, [200, 100]), addVertex(d, [200, 60]), sharedB,
    ], { name: 'Anatolien' });
    expect([...edgeOwners(d).values()].some((e) => e.owners.length === 2)).toBe(true); // gemeinsame Grenze da
    const r = cutWaterChannel(d, [[150, 20], [150, 80]], 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.removed).toBe(2);
    expect(d.provinces.length).toBe(2);
    expect(provinceAt(d, 150, 50)).toBeNull();
    expect([...edgeOwners(d).values()].every((e) => e.owners.length === 1)).toBe(true);
  });

  it('ein Zug, der die Brücke nicht überquert, schneidet nichts', () => {
    const d = newDraft('t', 'T', 400, 400);
    rect(d, 0, 0, 400, 400);
    const r = cutWaterChannel(d, [[200, 100], [200, 300]], 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.cuts).toBe(0); // die Grenzen der Provinz liegen weit außerhalb des Zuges
    expect(r.removed).toBe(0);
    expect(d.provinces.length).toBe(1);
  });

  it('schneidet in einer riesigen, konkaven Provinz nur die getroffene Landzunge', () => {
    const d = newDraft('t', 'T', 800, 700);
    // C-Provinz (Öffnung unten): oberer Balken + zwei Beine; der Zug quert nur das linke Bein
    const ring = [[0, 0], [800, 0], [800, 700], [500, 700], [500, 200], [300, 200], [300, 700], [0, 700]]
      .map((p) => addVertex(d, p as Pt));
    addProvince(d, ring, { name: 'Riesen-C' });
    const r = cutWaterChannel(d, [[-30, 450], [330, 450]], 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.cuts).toBe(2);
    expect(r.removed).toBe(1); // das Bandstück im linken Bein wird Wasser
    expect(provinceAt(d, 150, 450)).toBeNull(); // Graben offen
    expect(provinceAt(d, 650, 450)).not.toBeNull(); // rechtes Bein in keiner Ferne angefasst
  });

  it('löst Landwege quer durch das neue Wasser', () => {
    const d = newDraft('t', 'T', 400, 200);
    const a = rect(d, 0, 0, 80, 100, 'A');
    void a;
    rect(d, 220, 0, 300, 100, 'B');
    // Landbrücke als eigene schmale Provinz dazwischen
    addProvince(d, [addVertex(d, [80, 45]), addVertex(d, [220, 45]), addVertex(d, [220, 55]), addVertex(d, [80, 55])], { name: 'Brücke' });
    d.links.push([`p${d.provinces[0].id}`, `p${d.provinces[1].id}`, [[150, 50]]]);
    const r = cutWaterChannel(d, [[150, 20], [150, 80]], 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(d.links.length).toBe(0); // Querweg durchs Wasser ist weg
    const ids = d.provinces.map((p) => p.id);
    expect(d.links.some((l) => !ids.includes(Number(l[0].slice(1))) || !ids.includes(Number(l[1].slice(1))))).toBe(false);
  });

  it('Stück mit Stadt/Hauptstadt im Band bleibt erhalten', () => {
    const d = newDraft('t', 'T', 400, 200);
    addProvince(d, [addVertex(d, [140, 40]), addVertex(d, [160, 40]), addVertex(d, [160, 60]), addVertex(d, [140, 60])], { name: 'Inselstadt', city: [150, 50] });
    const r = cutWaterChannel(d, [[150, 20], [150, 80]], 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.removed).toBe(0);
    expect(r.kept).toBe('Inselstadt');
  });

  // ---- Flächen-Modus: geschlossener Ring wird geflutet
  const ring = (...pts: Pt[]): Pt[] => [...pts, pts[0]];

  it('Quadrat zwischen zwei Provinzen flutet die Fläche, ohne Städte zu kopieren', () => {
    const d = newDraft('t', 'T', 400, 200);
    rect(d, 0, 0, 100, 100, 'A');
    rect(d, 200, 0, 300, 100, 'B');
    d.provinces[0].city = [25, 50];
    d.provinces[1].city = [275, 50];
    const r = cutWaterChannel(d, ring([50, 30], [250, 30], [250, 70], [50, 70]), 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.cuts).toBe(0);
    expect(r.removed).toBe(0);
    expect(d.provinces.length).toBe(2); // keine neuen Provinzen → keine Auto-Städte
    expect(d.provinces.every((p) => p.city !== null)).toBe(true);
    expect(provArea(d, d.provinces[0])).toBeCloseTo(100 * 100 - 50 * 40, 0); // Streifen x50..100 · y30..70 fehlt
    expect(provArea(d, d.provinces[1])).toBeCloseTo(100 * 100 - 50 * 40, 0);
    expect(provinceAt(d, 150, 50)).toBeNull(); // Graben ist Wasser
    expect(provinceAt(d, 25, 50)?.name).toBe('A');
  });

  it('Provinz ganz im Flutgebiet verschwindet', () => {
    const d = newDraft('t', 'T', 400, 200);
    rect(d, 0, 0, 100, 100, 'A');
    rect(d, 150, 30, 190, 70, 'Insel');
    const r = cutWaterChannel(d, ring([120, 10], [220, 10], [220, 90], [120, 90]), 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.removed).toBe(1);
    expect(d.provinces.map((p) => p.name)).toEqual(['A']);
  });

  it('Stadt im Flutgebiet: Provinz schrumpft, Stadt wandert, gemeldet wird sie auch', () => {
    const d = newDraft('t', 'T', 400, 200);
    rect(d, 0, 0, 100, 100, 'A');
    d.provinces[0].city = [70, 50];
    const r = cutWaterChannel(d, ring([50, 30], [250, 30], [250, 70], [50, 70]), 20);
    if (typeof r === 'string') throw new Error(r);
    expect(r.kept).toBe('A');
    expect(d.provinces.length).toBe(1);
    expect(d.provinces[0].city).toBeNull(); // automatische neue Stadtlage außerhalb des Wassers
    expect(provArea(d, d.provinces[0])).toBeCloseTo(100 * 100 - 50 * 40, 0);
  });

  it('Flutkorridor trennt zwei Provinzen an gemeinsamer Grenze', () => {
    const d = newDraft('t', 'T', 400, 200);
    const sharedTop = addVertex(d, [150, 0]), sharedBottom = addVertex(d, [150, 100]);
    addProvince(d, [addVertex(d, [0, 0]), sharedTop, sharedBottom, addVertex(d, [0, 100])], { name: 'W' });
    addProvince(d, [sharedTop, addVertex(d, [300, 0]), addVertex(d, [300, 100]), sharedBottom], { name: 'O' });
    // Korridor quer über die gesamte gemeinsame Grenze
    const r = cutWaterChannel(d, ring([120, -10], [180, -10], [180, 110], [120, 110]), 20);
    if (typeof r === 'string') throw new Error(r);
    expect([...edgeOwners(d).values()].every((e) => e.owners.length === 1)).toBe(true);
    expect(provinceAt(d, 150, 50)).toBeNull();
    expect(coastalProvinceIds(d).sort()).toEqual(d.provinces.map((p) => p.id).sort());
  });

  it('selbstüberschneidender Ring wird abgelehnt', () => {
    const d = newDraft('t', 'T', 400, 200);
    rect(d, 0, 0, 100, 100);
    const r = cutWaterChannel(d, ring([0, 0], [100, 80], [0, 80], [100, 0]), 20);
    expect(typeof r).toBe('string');
  });
});
