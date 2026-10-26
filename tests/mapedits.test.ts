import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { edgePoints, edgeThrough, nodeNeighbors } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { applyEdits } from '../src/game/mapedits.ts';

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
    expect(pts[1][0]).toBeCloseTo(mid[0], 1);
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
