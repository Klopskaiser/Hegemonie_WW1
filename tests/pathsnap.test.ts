import { describe, expect, it } from 'vitest';
import { snapEdgeOverlaps, mergeRailSegs } from '../src/game/pathsnap.ts';
import type { MapData, MapProvince, MapSea } from '../src/game/mapdata.ts';

function prov(id: number, center: [number, number], links: number[], seaLinks: number[] = []): MapProvince {
  return { id, name: `P${id}`, nation: 'A', polys: [], center, lonlat: [0, 0], mid: center, area: 1, city: false, capital: false, coastal: false, resource: 'grain', double: false, neighbors: links, links, seaLinks, seas: seaLinks };
}
function seaNode(id: number, center: [number, number]): MapSea {
  return { id, name: `S${id}`, polys: [], center, seas: [], coasts: [] };
}
function makeMap(provinces: MapProvince[], seas: MapSea[], roads?: MapData['roads']): MapData {
  return { id: 't', name: 't', bounds: [0, 0, 2000, 600], nations: [], provinces, borders: [], seas, seaBorders: [], roads: roads ?? [], seaNodes: true, shortcuts: [], junctions: [] };
}
const roadOf = (m: MapData, a: number, b: number) => m.roads!.find((r) => Math.min(r.a, r.b) === Math.min(a, b) && Math.max(r.a, r.b) === Math.max(a, b));

describe('Wegabschnitt-Snapping', () => {
  it('paralleler Abschnitt (300 m Versatz) wird auf die Referenzgerade gesnappt', () => {
    const m = makeMap([
      prov(0, [100, 100], [1]), prov(1, [500, 100], [0]),        // Referenz y = 100
      prov(2, [120, 100.3], [3]), prov(3, [480, 100.3], [2]),    // 300 m daneben, 360 km Überdeckung
      prov(4, [100, 300], [5]), prov(5, [500, 300], [4]),        // zweite Gruppe (unbeteiligt)
      prov(6, [120, 301.9], [7]), prov(7, [480, 301.9], [6]),    // 1,9 km Versatz → bleibt
      prov(8, [700, 100], [9, 10]), prov(9, [1100, 100.2], [8]), prov(10, [1100, 104], [8]), // enger Fächer
      prov(11, [700, 400], [12, 13]), prov(12, [1100, 400.2], [11]), prov(13, [1100, 440], [11]), // weiter Fächer (5,7°) → bleibt
    ], []);
    const out = snapEdgeOverlaps(m);
    const snapped = roadOf(out, 2, 3);
    expect(snapped).toBeTruthy();
    const pts: [number, number][] = [];
    for (let k = 0; k < snapped!.pts.length; k += 2) pts.push([snapped!.pts[k], snapped!.pts[k + 1]]);
    expect(pts[0]).toEqual([120, 100.3]);                       // Städte bleiben
    expect(pts[pts.length - 1]).toEqual([480, 100.3]);
    const inner = pts.slice(1, -1);
    expect(inner.length).toBeGreaterThan(0);
    for (const [, y] of inner) expect(y).toBeCloseTo(100, 6);    // Korridor exakt auf der Referenzlinie
    expect(roadOf(out, 0, 1)).toBeFalsy();                      // Referenz bleibt implizit
    expect(roadOf(out, 6, 7)).toBeFalsy();                      // 1,9 km: zu weit weg
    expect(roadOf(out, 11, 12)).toBeFalsy();                    // weiter Fächer (5,7°): bleibt unangetastet
    expect(roadOf(out, 11, 13)).toBeFalsy();
    const fan = roadOf(out, 8, 9)!;                             // enger Fächer: nur der gemeinsame Abschnitt
    expect(fan).toBeTruthy();
    const fpts: [number, number][] = [];
    for (let k = 0; k < fan.pts.length; k += 2) fpts.push([fan.pts[k], fan.pts[k + 1]]);
    expect(fpts[0]).toEqual([700, 100]);                        // Stadt gemeinsam, bleibt
    expect(fpts[fpts.length - 1]).toEqual([1100, 100.2]);       // Spreizung am entfernten Ende bleibt
    const aufLinie = fpts.filter(([x, y]) => Math.abs(y - (100 + 0.01 * (x - 700))) < 0.002); // Referenzgerade 8–10 (mm-genau gerundet)
    expect(aufLinie.length).toBeGreaterThanOrEqual(2);          // Stück liegt exakt auf der Referenz
  });

  it('Hafenstraße: Snapping des Landanteils, Wasseraustritt (split) wandert nicht weg', () => {
    const m = makeMap(
      [prov(0, [50, 200], [], [0]), prov(1, [120, 200.3], [], [1])],
      [seaNode(0, [600, 200]), seaNode(1, [500, 230])],
      [
        { a: 0, b: 2, pts: [50, 200, 550, 200, 600, 260], split: 0.874 },   // Referenz y = 200, Küste bei x = 550
        { a: 1, b: 3, pts: [120, 200.3, 480, 200.3, 500, 230], split: 0.92 }, // 300 m daneben; Küste hinter dem Knick
      ],
    );
    const out = snapEdgeOverlaps(m);
    expect(roadOf(out, 0, 2)!.pts).toEqual([50, 200, 550, 200, 600, 260]); // Referenz bleibt
    const r = roadOf(out, 1, 3)!;
    const pts: [number, number][] = [];
    for (let k = 0; k < r.pts.length; k += 2) pts.push([r.pts[k], r.pts[k + 1]]);
    expect(pts[0]).toEqual([120, 200.3]);                       // Stadt bleibt
    const inner = pts.slice(1, -1);
    expect(inner.length).toBeGreaterThan(0);
    for (const [, y] of inner.slice(0, 2)) expect(y).toBeCloseTo(200, 6);  // Korridor auf der Referenzlinie
    let len = 0; const cum = [0];
    for (let k = 0; k + 1 < pts.length; k++) { len += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); cum.push(len); }
    const bx = r.split * len;                                   // a = Provinzseite → split ab Stadt
    let seg = 0; while (cum[seg + 1] < bx) seg++;
    const t = (bx - cum[seg]) / (cum[seg + 1] - cum[seg]);
    const px = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t;
    const py = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t;
    expect(Math.hypot(px - 482.3, py - 203.8)).toBeLessThan(0.5); // Wasseraustritt bleibt physikalisch ortsfest
  });

  it('unveränderte Karte wird als Originalobjekt zurückgegeben', () => {
    const m = makeMap([prov(0, [100, 100], [1]), prov(1, [500, 100], [0])], []);
    expect(snapEdgeOverlaps(m)).toBe(m);
  });

  it('Snapping ist idempotent (zweite Runde ändert nichts mehr)', () => {
    const m = makeMap([
      prov(0, [100, 100], [1]), prov(1, [500, 100], [0]),
      prov(2, [120, 100.3], [3]), prov(3, [480, 100.3], [2]),
    ], []);
    const once = snapEdgeOverlaps(m);
    expect(snapEdgeOverlaps(once)).toBe(once);
  });
});

describe('Schienen zusammenfassen', () => {
  it('deckungsgleiche und überlappende Abschnitte werden ein Zug', () => {
    const out = mergeRailSegs([[0, 0, 10, 0], [0, 0, 10, 0], [5, 0, 20, 0]]);
    expect(out).toHaveLength(1);
    expect(out[0][0]).toBeCloseTo(0); expect(out[0][2]).toBeCloseTo(20);
  });
  it('umgekehrte Richtung zählt als dieselbe Gerade', () => {
    expect(mergeRailSegs([[0, 0, 10, 0], [10, 0, 0, 0]])).toHaveLength(1);
  });
  it('Lücken und seitlicher Abstand bleiben getrennt', () => {
    expect(mergeRailSegs([[0, 0, 10, 0], [15, 0, 20, 0]])).toHaveLength(2);
    expect(mergeRailSegs([[0, 0, 10, 0], [0, 1, 10, 1]])).toHaveLength(2);
  });
});
