// Zusammengelegte Wegabschnitte: Ziel auf geteiltem Abschnitt wird über die kürzeste Auslegung angefahren,
// nicht erst durch die Stadt durch und wieder zurück.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closestOnEdge, edgePoint, roadVariants } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { planRoute } from '../src/game/military.ts';
import { createGame } from '../src/game/state.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'big_europe.json'), 'utf8'));
const id = (name: string) => map.provinces.find((p) => p.name === name)!.id;
const brest = id('Brest'), bordeaux = id('Bordeaux'), limoges = id('Limoges');

/** Punkt auf Brest–Bordeaux, der auf Limoges–Brest liegt (zusammengelegter Abschnitt, fern von Endpunkten) */
function sharedF(): number {
  for (let f = 0.15; f < 0.85; f += 0.002) {
    const [x, y] = edgePoint(map, brest, bordeaux, f);
    if (closestOnEdge(map, limoges, brest, x, y).d < 0.03) return f;
  }
  throw new Error('kein gemeinsamer Abschnitt gefunden');
}

describe('Ziel auf zusammengelegtem Wegabschnitt', () => {
  it('erkennt die geometrisch gleichen Wege an dem Punkt', () => {
    const f = sharedF();
    const vars = roadVariants(map, brest, bordeaux, f);
    expect(vars.some((t) => (t.a === limoges && t.b === brest) || (t.a === brest && t.b === limoges))).toBe(true);
  });

  it('läuft von Limoges direkt zum Punkt, ohne Brest zu betreten', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'FR', speed: 1, seed: 5, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = 'human';
    const army = { id: state.nextArmyId++, owner: 'FR', node: limoges, units: { infantry: 5 }, morale: 1 };
    state.armies.push(army);
    const f = sharedF();
    const plan = planRoute(state, map, army, 0, { road: { a: brest, b: bordeaux, f } })!;
    // letzte Etappe: von Limoges kommend auf dem geteilten Abschnitt, vor Brest gehalten
    expect(plan.path[plan.path.length - 2]).toBe(limoges);
    expect(plan.endFrac).toBeDefined();
    expect(plan.endFrac!).toBeLessThan(1);
    // Endpunkt liegt am angeklickten Punkt
    const [tx, ty] = edgePoint(map, brest, bordeaux, f);
    const [ex, ey] = edgePoint(map, limoges, brest, plan.endFrac ?? 0); // endFrac gilt vom vorletzten Knoten aus
    expect(Math.hypot(tx - ex, ty - ey)).toBeLessThan(0.5);
  });

  it('Einheit mitten auf dem geteilten Abschnitt bleibt stehen, wenn sie dort schon steht', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'FR', speed: 1, seed: 5, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = 'human';
    const f = sharedF();
    const onOther = closestOnEdge(map, limoges, brest, ...edgePoint(map, brest, bordeaux, f));
    const army = { id: state.nextArmyId++, owner: 'FR', node: limoges, pos: { a: limoges, b: brest, f: onOther.f }, units: { infantry: 5 }, morale: 1 };
    (army as any).move = null;
    state.armies.push(army);
    // von der Position auf Limoges–Brest zum selben Punkt auf Brest–Bordeaux: kein Weg nötig
    expect(planRoute(state, map, army, 0, { road: { a: brest, b: bordeaux, f } })).toBeNull();
  });
});
