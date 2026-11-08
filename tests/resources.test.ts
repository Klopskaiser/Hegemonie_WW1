// Harte Nations-Grenzen bei der Rohstoffverteilung: an = Quoten erzwungen, aus = Lage verteilt frei.
import { describe, expect, it } from 'vitest';
import { assignResources, type ResourceInput } from '../scripts/resources.ts';
import type { MapProvince } from '../src/game/mapdata.ts';
import type { MultiPoly } from '../src/game/geom.ts';

/** 2 Nationen à 6 Provinzen: A liegt komplett auf Kohlencentren, B komplett auf Getreidecentren. */
function makeItems(): ResourceInput[] {
  const items: ResourceInput[] = [];
  const square = (x0: number, y0: number): MultiPoly =>
    [[[[x0, y0], [x0 + 100, y0], [x0 + 100, y0 + 100], [x0, y0 + 100], [x0, y0]]]];
  for (const nation of ['A', 'B'] as const) {
    for (let k = 0; k < 6; k++) {
      const x0 = (nation === 'A' ? 0 : 1000) + k * 100;
      const province = { nation, double: false, coastal: false, resource: 'grain' } as unknown as MapProvince;
      items.push({ province, shape: square(x0, 0), lat: 50, desert: false });
    }
  }
  return items;
}

function makeSpots(items: ResourceInput[]) {
  const spots: { r: 'coal' | 'grain'; pos: [number, number] }[] = [];
  for (const it of items) {
    const c = it.shape[0][0][0];
    spots.push({ r: it.province.nation === 'A' ? 'coal' : 'grain', pos: [c[0] + 50, c[1] + 50] });
  }
  return spots;
}

const coalShare = (items: ResourceInput[]) =>
  items.filter((i) => i.province.nation === 'A' && i.province.resource === 'coal').length / 6;

describe('assignResources: nationLimits', () => {
  it('mit Grenzen: Nation A bleibt trotz Kohlencentren unter der Obergrenze von 60 %', () => {
    const items = makeItems();
    assignResources(items, makeSpots(items), () => 0.5, () => 0, { nationLimits: true });
    expect(coalShare(items)).toBeLessThanOrEqual(0.6);
  });

  it('ohne Grenzen: die Lage setzt sich über die Nationsgrenze hinweg durch', () => {
    const items = makeItems();
    assignResources(items, makeSpots(items), () => 0.5, () => 0, { nationLimits: false });
    expect(coalShare(items)).toBeGreaterThan(0.6);
  });
});
