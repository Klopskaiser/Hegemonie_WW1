import { describe, expect, it } from 'vitest';
import {
  addProvince, addVertex, autoLinks, exportDraft, insertOnEdge, mergeProvinces, newDraft, provArea, provRef, seaRef,
  splitProvince, toggleLink, tracePath, type Draft,
} from '../src/game/draft.ts';
import { importRaster, type RasterImage } from '../src/game/draftImport.ts';
import { edgePoints, nodeNeighbors } from '../src/game/graph.ts';
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
    // Einzugsbereich ohne Land: der Hafen knickt an der Küste (x = 250)
    const pts = edgePoints(m, 1, P);
    expect(pts).toHaveLength(3);
    expect(pts[1][0]).toBeCloseTo(250, 0);
    // das Spiel lässt sich damit anlegen
    const g = createGame(m, { id: 'g', name: 'G', playerNation: 'A', speed: 1, seed: 1, now: 0 });
    expect(g.provinces).toHaveLength(2);
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
