import { describe, expect, it } from 'vitest';
import {
  addProvince, addVertex, autoLinks, coastalProvinceIds, coastsWithoutHarbor, deleteBend, exportDraft, insertBend, insertOnEdge, mergeProvinces, moveBend, newDraft, provArea, provRef, seaRef,
  splitProvince, toggleLink, tracePath, type Draft,
} from '../src/game/draft.ts';
import { importRaster, type RasterImage } from '../src/game/draftImport.ts';
import { edgeLength, edgeParts, edgePoints, nodeNeighbors } from '../src/game/graph.ts';
import { createGame } from '../src/game/state.ts';

/** zwei Quadrate 100×100 km nebeneinander mit gemeinsamer Kante */
function twoSquares(): Draft {
  const d = newDraft('t', 'Test', 400, 200);
  const v = [[50, 50], [150, 50], [250, 50], [250, 150], [150, 150], [50, 150]].map((p) => addVertex(d, p as [number, number]));
  addProvince(d, [v[0], v[1], v[4], v[5]], { name: 'West', nation: 'A', resource: 'coal' });
  addProvince(d, [v[1], v[2], v[3], v[4]], { name: 'Ost', nation: 'B', resource: 'iron' });
  d.nations = [
    { id: 'A', name: 'Alpha', color: '#aa0000', major: true, capital: d.provinces[0].id },
    { id: 'B', name: 'Beta', color: '#0000aa', major: false, capital: d.provinces[1].id },
  ];
  return d;
}

describe('Kartenentwurf', () => {
  it('gemeinsame Kante wird Grenze, Rest Küste; Flächen stimmen', () => {
    const d = twoSquares();
    expect(provArea(d, d.provinces[0])).toBeCloseTo(10000);
    const r = exportDraft(d);
    expect(r.errors).toEqual([]);
    const m = r.map!;
    const inner = m.borders.filter((b) => b.b >= 0);
    expect(inner).toHaveLength(1);
    expect(inner[0].segs).toHaveLength(4);
    expect(m.provinces[0].neighbors).toEqual([1]);
    expect(m.provinces[0].area).toBe(10000);
    expect(m.provinces[0].capital).toBe(true);
    expect(m.nations.map((n) => n.capital)).toEqual([0, 1]);
  });

  it('Verbindungen: Landweg, Hafen, Seeweg landen im Bewegungsnetz', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] }, { id: d.nextId++, name: 'S2', at: [350, 180] });
    const [w, o] = d.provinces;
    toggleLink(d, provRef(w.id), provRef(o.id));
    toggleLink(d, provRef(o.id), seaRef(d.seas[0].id));
    toggleLink(d, seaRef(d.seas[0].id), seaRef(d.seas[1].id));
    const m = exportDraft(d).map!;
    const P = m.provinces.length;
    expect(nodeNeighbors(m, 0)).toEqual([1]);
    expect(nodeNeighbors(m, 1).sort()).toEqual([0, P]);
    expect(nodeNeighbors(m, P).sort()).toEqual([1, P + 1]);
    expect(m.provinces[1].coastal).toBe(true);
    expect(m.seas[0].coasts).toEqual([1]);
    // gezogener gerader Hafenweg: Straße Stadt → Seepunkt, split am Wasseraustritt (x = 250)
    const pts = edgePoints(m, 1, P);
    expect(pts).toHaveLength(2);
    expect(m.roads!.some((r) => r.a === 1 && r.b === P && Math.abs(r.split - 0.5) < 0.02)).toBe(true);
    // gerader Landweg: Straße Stadt → Stadt (kein vom Spiel erfundener Grenzknick), split an der Provinzgrenze
    const land = m.roads!.find((r) => r.a === 0 && r.b === 1)!;
    expect(land).toBeTruthy();
    expect(edgePoints(m, 0, 1)).toEqual([[100, 100], [200, 100]]);
    expect(Math.abs(land.split - 0.5)).toBeLessThan(0.02);
    // das Spiel lässt sich damit anlegen
    const g = createGame(m, { id: 'g', name: 'G', playerNation: 'A', speed: 1, seed: 1, now: 0 });
    expect(g.provinces).toHaveLength(2);
  });

  it('Knickpunkte biegen Landwege und werden zu Weggeometrie in der Karte', () => {
    const d = twoSquares();
    const [w, o] = d.provinces;
    toggleLink(d, provRef(w.id), provRef(o.id));
    expect(insertBend(d, provRef(w.id), provRef(o.id), [150, 20])).toBe(true);
    const m = exportDraft(d).map!;
    expect(m.roads).toHaveLength(1);
    const road = m.roads![0];
    const pts = edgePoints(m, road.a, road.b);
    expect(pts).toHaveLength(3);
    expect(pts[1]).toEqual([150, 20]);
    expect(pts[0]).toEqual(m.provinces[road.a].center);
    expect(pts[2]).toEqual(m.provinces[road.b].center);
    expect(road.split).toBeGreaterThan(0);
    expect(road.split).toBeLessThan(1);
    // das Spiel biegt die Truppenmarsche über den Knick
    const g = createGame(m, { id: 'g', name: 'G', playerNation: 'A', speed: 1, seed: 1, now: 0 });
    expect(g.provinces).toHaveLength(2);

    expect(moveBend(d, provRef(w.id), provRef(o.id), 0, [150, 180])).toBe(true);
    expect(edgePoints(exportDraft(d).map!, road.a, road.b)[1]).toEqual([150, 180]);
    expect(deleteBend(d, provRef(w.id), provRef(o.id), 0)).toBe(true);
    // ohne Knick bleibt die gerade gezogene Linie als Straße erhalten (kein gespielter Grenzknick)
    const straight = exportDraft(d).map!.roads!;
    expect(straight).toHaveLength(1);
    expect(straight[0].pts).toEqual([100, 100, 200, 100]);
    // Verbindung löschen nimmt die Knickpunkte mit
    insertBend(d, provRef(w.id), provRef(o.id), [150, 60]);
    toggleLink(d, provRef(w.id), provRef(o.id));
    expect(d.links).toHaveLength(0);
  });

  it('Knicks an Verbindungen über See werden gemeldet, Seewege bleiben gerade', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] }, { id: d.nextId++, name: 'S2', at: [350, 180] });
    toggleLink(d, seaRef(d.seas[0].id), seaRef(d.seas[1].id));
    insertBend(d, seaRef(d.seas[0].id), seaRef(d.seas[1].id), [340, 120]);
    const r = exportDraft(d);
    expect(r.map!.roads).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('Knick') && w.includes('Wasser'))).toBe(true);
  });

  it('Hafenverbindung: Knick an Land wird Weggeometrie, Knick im Wasser verworfen', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] }, { id: d.nextId++, name: 'S2', at: [350, 180] });
    const o = d.provinces[1];
    toggleLink(d, provRef(o.id), seaRef(d.seas[0].id));
    expect(insertBend(d, provRef(o.id), seaRef(d.seas[0].id), [230, 80])).toBe(true);   // an Land (Ost: x ≤ 250)
    expect(insertBend(d, provRef(o.id), seaRef(d.seas[0].id), [280, 60])).toBe(true);   // im Wasser
    const m = exportDraft(d).map!;
    expect(m.roads).toHaveLength(1);
    const road = m.roads![0];
    expect(Math.min(road.a, road.b)).toBe(1);
    const pts = edgePoints(m, 1, m.provinces.length);
    expect(pts).toHaveLength(3);                       // Stadt → Landknick → Seeende (Wasserknick weg)
    expect(pts[1]).toEqual([230, 80]);
    expect(pts[2]).toEqual(m.seas[0].center);
    expect(road.split).toBeGreaterThan(0);
    expect(road.split).toBeLessThan(1);                // split = Wasseraustritt an der Küste x = 250
    // in Gegenrichtung zeigt der Verlauf die umgekehrte Punktfolge
    expect(edgePoints(m, m.provinces.length, 1)[1]).toEqual([230, 80]);
  });

  it('Gerader Hafenweg ohne Knicke: Straße mit gezogener Linie und Wasseraustritt als split', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] });
    const o = d.provinces[1];
    toggleLink(d, seaRef(d.seas[0].id), provRef(o.id));   // ohne Knick, Seepunkt vorn
    const m = exportDraft(d).map!;
    expect(m.roads).toHaveLength(1);
    const road = m.roads![0];
    expect(road.a).toBe(1);                               // a ist die Provinzseite
    expect(road.b).toBe(m.provinces.length);
    expect(edgePoints(m, 1, m.provinces.length)).toEqual([road.pts.slice(0, 2), road.pts.slice(2)].map(([x, y]) => [x, y]));
    expect(edgeParts(m, 1, m.provinces.length)[0]).toBeCloseTo(road.split * edgeLength(m, 1, m.provinces.length), 3);
    // Küste bei x = 250 von Stadt (200, 100) nach (300, 100): halbe Weglänge
    expect(road.split).toBeCloseTo(0.5, 2);
  });

  it('Hafenweg rückwärts (Seepunkt vorn): alle Landknicke bleiben, der letzte zählt als Hafen', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] });
    const o = d.provinces[1];
    toggleLink(d, seaRef(d.seas[0].id), provRef(o.id));   // Seepunkt steht im Entwurf vorn
    // Knickliste folgt der Zugrichtung Seepunkt → Provinz: zuerst der Wasserknick, zuletzt der an Land
    expect(insertBend(d, seaRef(d.seas[0].id), provRef(o.id), [275, 60])).toBe(true);    // im Wasser
    expect(insertBend(d, seaRef(d.seas[0].id), provRef(o.id), [249, 95])).toBe(true);    // knapp vor der Küste x = 250
    expect(insertBend(d, seaRef(d.seas[0].id), provRef(o.id), [230, 80])).toBe(true);    // an Land
    const m = exportDraft(d).map!;
    expect(m.roads).toHaveLength(1);
    const P = m.provinces.length;
    const pts = edgePoints(m, 1, P);                     // Stadt → ... → Seeende
    expect(pts.slice(1, -1)).toEqual([[230, 80], [249, 95]]); // beide Landknicke in Zugfolge, Wasserknick weg
    expect(pts[pts.length - 1]).toEqual(m.seas[0].center);
    // split gilt ab road.a (hier der Seepunkt): das Wasserstück ist kürzer als das halbe Band
    expect(m.roads![0].split).toBeGreaterThan(0.5);
    expect(m.roads![0].split).toBeLessThan(1);
  });

  it('Kartenrand ist keine Küste: Provinzen, die an der Kartengrenze enden, haben keinen Seezugang', () => {
    const d = newDraft('rf', 'Rand', 400, 200);
    // zwei Provinzen über die volle Höhe; die rechte endet bündig am Kartenrand (rechts nur Land)
    const v = [[50, 0], [250, 0], [400, 0], [400, 200], [250, 200], [50, 200]].map((p) => addVertex(d, p as [number, number]));
    addProvince(d, [v[0], v[1], v[4], v[5]], { name: 'Innen', nation: 'A' });
    addProvince(d, [v[1], v[2], v[3], v[4]], { name: 'Rand', nation: 'A' });
    d.nations = [{ id: 'A', name: 'Alpha', color: '#aa0000', major: true, capital: d.provinces[0].id }];
    d.seas.push({ id: d.nextId++, name: 'S1', at: [25, 100] });     // Wasser links im Randstreifen
    const [innen, rand] = d.provinces;
    expect(coastalProvinceIds(d)).toEqual([innen.id]);              // nur die Innenprovinz grenzt an Wasser
    expect(coastsWithoutHarbor(d)).toEqual([innen.id]);             // Rand fehlt trotz fehlendem Anschluss
    autoLinks(d);
    expect(d.links.some(([x, y]) => (x === provRef(rand.id) || y === provRef(rand.id)) && (x[0] === 's' || y[0] === 's'))).toBe(false);
    // nach der Ergänzung meldet die Exportprüfung keine Küste ohne Hafen mehr
    expect(exportDraft(d).warnings.some((w) => w.includes('ohne Hafen-Verbindung'))).toBe(false);
  });

  it('Hervorhebung: Küstenprovinzen ohne Wasserweg werden gemeldet', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] });
    const [w, o] = d.provinces;
    expect(coastsWithoutHarbor(d).sort()).toEqual([w.id, o.id].sort()); // beide am Wasser, beide ohne Anschluss
    toggleLink(d, provRef(o.id), seaRef(d.seas[0].id));
    expect(coastsWithoutHarbor(d)).toEqual([w.id]);                     // Ost ist versorgt
    w.noHarbor = true;
    expect(coastsWithoutHarbor(d)).toEqual([]);                         // markierte zählen nicht als Fehler
  });

  it('Markierung „kein Hafen“: keine automatische und keine exportierte Wasserverbindung', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] });
    const [w] = d.provinces;
    w.noHarbor = true;
    autoLinks(d);                                                   // West bleibt außen vor, Ost bekommt den Seepunkt
    const seaLinks = d.links.filter(([x, y]) => x[0] === 's' || y[0] === 's');
    expect(seaLinks).toHaveLength(1);
    expect(seaLinks[0]).toContain(provRef(d.provinces[1].id));      // nur Ost ist verbunden
    let m = exportDraft(d).map!;
    expect(m.provinces[0].seaLinks).toEqual([]);
    expect(m.provinces[0].coastal).toBe(false);
    // vorhandene Wasserwege markierter Provinzen werden ignoriert und gemeldet
    toggleLink(d, provRef(w.id), seaRef(d.seas[0].id));
    const r = exportDraft(d);
    m = r.map!;
    expect(m.provinces[0].seaLinks).toEqual([]);
    expect(m.seas[0].coasts).toEqual([1]);
    expect(r.warnings.some((x) => x.includes('kein Hafen') && x.includes('ignoriert'))).toBe(true);
    // die allgemeine Warnung „Provinzen am Wasser ohne Hafen“ trifft für markierte Provinzen nicht mehr zu
    expect(r.warnings.some((x) => x.includes('ohne Hafen-Verbindung'))).toBe(false);
  });

  it('Markierung bleibt beim Teilen erhalten und fällt beim Verschmelzen zurück', () => {
    const d = newDraft('nh', 'T', 400, 300);
    const v = [[0, 0], [200, 0], [200, 300], [0, 300]].map((p) => addVertex(d, p as [number, number]));
    const p = addProvince(d, v);
    p.noHarbor = true;
    // bei x = 100 teilen: beide Hälften erben die Markierung
    const m1 = addVertex(d, [100, 0]), m2 = addVertex(d, [100, 300]);
    const np = splitProvince(d, p.id, [v[0], m1, m2, v[3]]) as Draft['provinces'][number];
    expect(typeof np !== 'string' && np.noHarbor).toBe(true);
    expect(mergeProvinces(d, p.id, np.id)).toBeNull();
    expect(p.noHarbor).toBe(true);
    // Verschmelzen mit einer unmarkierten Nachbarprovinz hebt die Sperre auf
    const w1 = addVertex(d, [300, 0]), w2 = addVertex(d, [300, 300]);
    const q = addProvince(d, [v[1], w1, w2, v[2]]);
    expect(mergeProvinces(d, p.id, q.id)).toBeNull();
    expect(p.noHarbor).toBe(false);
  });

  it('Hafenverbindung ohne Knick an Land bleibt unverändert gerade', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] }, { id: d.nextId++, name: 'S2', at: [350, 180] });
    const o = d.provinces[1];
    toggleLink(d, provRef(o.id), seaRef(d.seas[0].id));
    expect(insertBend(d, provRef(o.id), seaRef(d.seas[0].id), [270, 70])).toBe(true);   // nur im Wasser
    const r = exportDraft(d);
    expect(r.map!.roads).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('Knick') && w.includes('Wasser'))).toBe(true);
    const pts = edgePoints(r.map!, 1, r.map!.provinces.length);
    expect(pts).toHaveLength(3);                       // Default-Hafen: knickt an der Küste (x = 250)
    expect(pts[1][0]).toBeCloseTo(250, 0);
  });

  it('Teilen und wieder Verschmelzen', () => {
    const d = newDraft('t', 'T', 300, 300);
    const v = [[0, 0], [200, 0], [200, 200], [0, 200]].map((p) => addVertex(d, p as [number, number]));
    const p = addProvince(d, v);
    const top = insertOnEdge(d, v[0], v[1], [100, 0]);
    const bottom = insertOnEdge(d, v[2], v[3], [100, 200]);
    const mid = addVertex(d, [110, 100]);
    const np = splitProvince(d, p.id, [top, mid, bottom]);
    expect(typeof np).not.toBe('string');
    expect(d.provinces).toHaveLength(2);
    const a = provArea(d, d.provinces[0]), b = provArea(d, d.provinces[1]);
    expect(a + b).toBeCloseTo(40000);
    // Schnitt (100,0) → (110,100) → (100,200): links 21 000, rechts 19 000 km²
    expect(Math.min(a, b)).toBeCloseTo(19000);
    // gemeinsame Grenze: zwei Kanten (oben–Mitte, Mitte–unten)
    const r = exportDraft({ ...d, nations: [{ id: 'A', name: 'A', color: '#000', major: true, capital: p.id }], provinces: d.provinces.map((q) => ({ ...q, nation: 'A' })) });
    expect(r.map!.borders.filter((x) => x.b >= 0)[0].segs).toHaveLength(8);
    expect(mergeProvinces(d, d.provinces[0].id, d.provinces[1].id)).toBeNull();
    expect(d.provinces).toHaveLength(1);
    expect(provArea(d, d.provinces[0])).toBeCloseTo(40000);
    expect(d.provinces[0].polys).toHaveLength(1);
    expect(d.provinces[0].polys[0]).toHaveLength(1);
    expect(d.verts[mid]).toBeUndefined();
  });

  it('Nachzeichnen folgt der kürzeren Seite einer Grenze', () => {
    const d = newDraft('t', 'T', 300, 300);
    const v = [[0, 0], [100, 0], [200, 0], [200, 200], [0, 200]].map((p) => addVertex(d, p as [number, number]));
    addProvince(d, v);
    expect(tracePath(d, v[0], v[2])).toEqual([v[1]]);
    expect(tracePath(d, v[0], v[1])).toEqual([]);
  });

  it('Verbindungen ergänzen: Nachbarn und Hafen', () => {
    const d = twoSquares();
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] });
    expect(autoLinks(d)).toBe(1 + 2);
    expect(exportDraft(d).warnings.join(' ')).not.toMatch(/ohne Verbindung/);
  });

  it('meldet fehlende Nation und Hauptstadt', () => {
    const d = twoSquares();
    d.provinces[1].nation = null;
    d.nations[0].capital = null;
    const r = exportDraft(d);
    expect(r.map).toBeNull();
    expect(r.errors.join(' ')).toMatch(/ohne Nation/);
    expect(r.errors.join(' ')).toMatch(/keine Hauptstadt/);
  });
});

describe('PNG-Vorlage einlesen', () => {
  function image(): RasterImage {
    const W = 60, H = 40;
    const data = new Uint8ClampedArray(W * H * 4);
    const set = (x: number, y: number, [r, g, b]: number[]) => {
      const o = (y * W + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [120, 160, 200]); // Wasser
    for (let y = 5; y < 35; y++) for (let x = 10; x < 50; x++) set(x, y, [255, 255, 255]); // Land
    for (let y = 5; y < 35; y++) set(30, y, [0, 0, 0]); // Grenze
    for (let x = 6; x < 37; x++) set(x, 20, [0, 255, 0]); // Linien Seepunkt–West–Ost
    for (const [cx, cy] of [[20, 20], [40, 20]]) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) set(x, y, [255, 0, 0]);
    for (let y = 19; y <= 21; y++) for (let x = 3; x <= 5; x++) set(x, y, [0, 0, 255]); // Seepunkt
    return { width: W, height: H, data };
  }

  it('zwei Provinzen mit gemeinsamer Grenze, Städten, Seepunkt und Verbindungen', () => {
    const colors = { land: '#ffffff', border: '#000000', capital: '#ff0000', sea: '#0000ff', link: '#00ff00' };
    const res = importRaster(image(), { colors, tolerance: 40, simplify: 1, minArea: 10 }, 600, 400);
    expect(res.provinces).toHaveLength(2);
    expect(res.seas).toHaveLength(1);
    const d = newDraft('imp', 'Import', 600, 400);
    Object.assign(d, { verts: res.verts, provinces: res.provinces, seas: res.seas, links: res.links, nextId: res.nextId });
    // Flächen: 40×30 px Land à 10×10 km, je Hälfte etwa 60 000 km²
    const areas = d.provinces.map((p) => provArea(d, p));
    expect(areas[0] + areas[1]).toBeCloseTo(120000, -3);
    expect(Math.abs(areas[0] - areas[1])).toBeLessThan(15000);
    // Städte im Land, in verschiedenen Provinzen
    const xs = d.provinces.map((p) => p.city![0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(205, -1);
    expect(xs[1]).toBeCloseTo(405, -1);
    // Verbindungen: Seepunkt–West und West–Ost
    expect(res.links).toHaveLength(2);
    const west = d.provinces.find((p) => p.city![0] < 300)!, east = d.provinces.find((p) => p.city![0] > 300)!;
    const keys = res.links.map(([a, b]) => [a, b].sort().join('|'));
    expect(keys).toContain([provRef(west.id), seaRef(res.seas[0].id)].sort().join('|'));
    expect(keys).toContain([provRef(west.id), provRef(east.id)].sort().join('|'));
    // exportfähig, gemeinsame Grenze erkannt
    d.nations = [{ id: 'A', name: 'A', color: '#a00', major: true, capital: west.id }, { id: 'B', name: 'B', color: '#00a', major: true, capital: east.id }];
    west.nation = 'A';
    east.nation = 'B';
    const r = exportDraft(d);
    expect(r.errors).toEqual([]);
    const m = r.map!;
    const wi = m.provinces.findIndex((p) => p.name === west.name), ei = 1 - wi;
    expect(m.provinces[wi].neighbors).toEqual([ei]);
    expect(m.provinces[wi].coastal).toBe(true);
    expect(m.borders.some((b) => b.b >= 0)).toBe(true);
  });

  function gapImage(): RasterImage {
    // zwei Landblöcke mit gezeichneten Grenzen; zwischen linker Grenze und linkem Land klafft eine
    // 2 px breite Naht ohne Grenzfarbe. Eine Verbindungslinie quert alles senkrecht.
    const W = 60, H = 40;
    const data = new Uint8ClampedArray(W * H * 4);
    const set = (x: number, y: number, [r, g, b]: number[]) => {
      const o = (y * W + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [120, 160, 200]);
    for (let y = 0; y < H; y++) {
      for (let x = 10; x < 26; x++) set(x, y, [255, 255, 255]); // Land (rechts klafft die 2 px Naht x=26..27)
      set(28, y, [0, 0, 0]);
      set(31, y, [0, 0, 0]);
      for (let x = 32; x < 50; x++) set(x, y, [255, 255, 255]);
    }
    for (let x = 20; x <= 40; x++) set(x, 12, [0, 255, 0]); // Verbindung Stadt zu Stadt über beide Grenzen
    for (const [cx, cy] of [[20, 12], [40, 12]]) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) set(x, y, [255, 0, 0]);
    return { width: W, height: H, data };
  }

  it('Lücken ohne Grenzfarbe werden zugeschlagen, dicke bleiben stehen', () => {
    const colors = { land: '#ffffff', border: '#000000', capital: '#ff0000', sea: '#0000ff', link: '#00ff00' };
    const mit = importRaster(gapImage(), { colors, tolerance: 40, simplify: 1, minArea: 10, maxGap: 4 }, 600, 400);
    expect(mit.provinces).toHaveLength(2);
    const ohne = importRaster(gapImage(), { colors, tolerance: 40, simplify: 1, minArea: 10, maxGap: 0 }, 600, 400);
    // ohne Zuschlagen gehört die Lücke nicht zur Westprovinz (kleinere Fläche)
    const area = (res: typeof mit) => {
      const d = newDraft('g', 'G', 600, 400);
      Object.assign(d, { verts: res.verts, provinces: res.provinces, seas: res.seas, links: res.links, nextId: res.nextId });
      const p = res.provinces.find((x) => x.city![0] < 300)!;
      return provArea(d, d.provinces.find((x) => x.id === p.id)!);
    };
    expect(area(mit)).toBeGreaterThan(area(ohne));
    // zugeschlagene Naht macht die Provinzen zu Nachbarn: sie teilen sich Grenzpunkte
    const wm = mit.provinces.find((p) => p.city![0] < 300)!, em = mit.provinces.find((p) => p.city![0] > 300)!;
    const shared = (a: typeof wm, b: typeof em) => a.polys.flat(Infinity).some((v) => b.polys.flat(Infinity).includes(v));
    expect(shared(wm, em)).toBe(true);
    // große Lücke: rechts 6 px dick → bleibt auch bei maxGap 4 stehen, keine Landgrenze
    const big = gapImage();
    for (let y = 0; y < 40; y++) {
      for (let x = 29; x <= 30; x++) { const o = (y * 60 + x) * 4; big.data[o] = 128; big.data[o + 1] = 128; big.data[o + 2] = 128; } // links 2 px (würde zugeschlagen)
      for (let x = 32; x <= 37; x++) { const o = (y * 60 + x) * 4; big.data[o] = 128; big.data[o + 1] = 128; big.data[o + 2] = 128; } // rechts 6 px dick (bleibt)
    }
    for (let x = 20; x <= 40; x++) { const o = (12 * 60 + x) * 4; big.data[o] = 0; big.data[o + 1] = 255; big.data[o + 2] = 0; } // Verbindung bleibt über der großen Lücke
    const gross = importRaster(big, { colors, tolerance: 40, simplify: 1, minArea: 10, maxGap: 4, maxIsland: 0 }, 600, 400);
    expect(gross.provinces).toHaveLength(2);
    // große Lücke bleibt stehen: keine geteilten Grenzpunkte, keine Landgrenze
    const gw = gross.provinces.find((p) => p.city![0] < 300)!, ge = gross.provinces.find((p) => p.city![0] > 300)!;
    expect(gw.polys.flat(Infinity).some((v) => ge.polys.flat(Infinity).includes(v))).toBe(false);
  });

  it('Kleine Inseln mit eigenem Punkt werden der Hauptinsel zugeschlagen', () => {
    const W = 80, H = 40;
    const data = new Uint8ClampedArray(W * H * 4);
    const set = (x: number, y: number, [r, g, b]: number[]) => {
      const o = (y * W + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [120, 160, 200]);
    for (let y = 10; y <= 30; y++) for (let x = 20; x <= 45; x++) set(x, y, [255, 255, 255]); // Hauptinsel
    for (let y = 16; y <= 21; y++) for (let x = 6; x <= 11; x++) set(x, y, [255, 255, 255]); // kleine Insel West
    for (let y = 14; y <= 19; y++) for (let x = 50; x <= 55; x++) set(x, y, [255, 255, 255]); // kleine Insel Ost
    for (const [cx, cy] of [[32, 20], [8, 18], [52, 16]]) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) set(x, y, [255, 0, 0]);
    const colors = { land: '#ffffff', border: '#000000', capital: '#ff0000', sea: '#0000ff', link: '#00ff00' };
    const mit = importRaster({ width: W, height: H, data }, { colors, tolerance: 40, simplify: 1, minArea: 10, maxGap: 0 }, 800, 400);
    expect(mit.provinces).toHaveLength(1);
    expect(mit.provinces[0].polys.length).toBe(3); // Hauptinsel plus zwei Zuschläge
    expect(mit.provinces[0].city![0]).toBeCloseTo(325, -1);
    const ohne = importRaster({ width: W, height: H, data }, { colors, tolerance: 40, simplify: 1, minArea: 10, maxGap: 0, maxIsland: 0 }, 800, 400);
    expect(ohne.provinces).toHaveLength(3);
  });

  it('Verbindungen über Grenzen hinweg bleiben eine Linie und verbinden beide Provinzen', () => {
    const colors = { land: '#ffffff', border: '#000000', capital: '#ff0000', sea: '#0000ff', link: '#00ff00' };
    const res = importRaster(gapImage(), { colors, tolerance: 40, simplify: 1, minArea: 10, maxGap: 4 }, 600, 400);
    expect(res.links).toHaveLength(1); // Linie zerfällt nicht an den gezeichneten Grenzen
    const west = res.provinces.find((p) => p.city![0] < 300)!, east = res.provinces.find((p) => p.city![0] > 300)!;
    expect(res.links[0].sort().join('|')).toBe([provRef(west.id), provRef(east.id)].sort().join('|'));
  });
});
