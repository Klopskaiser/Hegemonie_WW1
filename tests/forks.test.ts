// Gabelungen: zusammengelegte Wege trennen sich vor einer Stadt – über den Gabelpunkt geht es auf den anderen Weg,
// ohne die Stadt zu betreten (Wegsuche, Marsch, Befehle unterwegs). Kriegsgrund unterwegs ist nur eine Begegnung
// von Truppen ohne Wegrecht.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/game/balance.ts';
import { setRelation, atWar } from '../src/game/diplomacy.ts';
import { forks, nodeNeighbors } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { armyPosition, findPath, planRoute, segRange, startMove } from '../src/game/military.ts';
import { requiredWars } from '../src/game/actions.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'big_europe.json'), 'utf8'));
const id = (name: string) => map.provinces.find((p) => p.name === name)!.id;
const cherson = id('Cherson'), tiflis = id('Tiflis'), sevastopol = id('Sevastopol');
const neapel = id('Neapel'), bologna = id('Bologna'), rom = id('Rom');

function newSim(owner = 'KA') {
  const state = createGame(map, { id: 't', name: 'T', playerNation: owner, speed: 1, seed: 5, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  state.time = 8 * DAY;
  return new Simulation(state, map);
}

const army = (sim: Simulation, owner: string, node: number, extra: Partial<Army> = {}): Army => {
  const a: Army = { id: sim.state.nextArmyId++, owner, node, units: { infantry: 5 }, morale: 1, ...extra };
  sim.state.armies.push(a);
  return a;
};

/** betritt der Plan die Stadt `city` (ein Abschnitt endet voll in ihr bzw. beginnt in ihr)? */
const enters = (plan: { path: number[]; startFrac?: number; endFrac?: number; cut?: Record<number, [number, number]> }, city: number) =>
  plan.path.some((n, k) => n === city && ((k > 0 && segRange(plan, k - 1)[1] >= 1 - 1e-9) || (k < plan.path.length - 1 && k > 0 && segRange(plan, k)[0] <= 1e-9)));

describe('Gabelungen erkennen', () => {
  it('findet die zusammengelegten Wege der Referenzkarte (u. a. Rom – Bologna – Neapel, Cherson – Tiflis – Sevastopol)', () => {
    const fs = forks(map);
    const has = (b: number, x: number, y: number) => fs.some((f) => f.b === b && ((f.a === x && f.c === y) || (f.a === y && f.c === x)));
    expect(has(bologna, rom, neapel)).toBe(true);
    expect(has(tiflis, cherson, sevastopol)).toBe(true);
    for (const f of fs) {
      expect(f.fa).toBeGreaterThan(0);
      expect(f.fa).toBeLessThan(1);
      expect(nodeNeighbors(map, f.b)).toContain(f.a);
      expect(nodeNeighbors(map, f.b)).toContain(f.c);
    }
  });
});

describe('Wegsuche über Gabelungen', () => {
  it('Cherson → Sevastopol geht an der Gabel vorbei, nicht durch Tiflis – und ist kürzer', () => {
    const sim = newSim();
    for (const p of [cherson, tiflis, sevastopol]) sim.state.provinces[p].owner = 'KA';
    const a = army(sim, 'KA', cherson);
    const plan = planRoute(sim.state, map, a, sim.state.time, { node: sevastopol })!;
    expect(plan).toBeTruthy();
    expect(enters(plan, tiflis)).toBe(false);
    const old = findPath(sim.state, map, a, cherson, sevastopol)!; // reine Knotenwege (ohne Gabelungen)
    expect(plan.hours).toBeLessThan(old.hours - 1);
  });

  it('unterwegs von Neapel nach Bologna lässt sich die Armee nach Rom umleiten, ohne Bologna zu betreten', () => {
    const sim = newSim('IT');
    for (const f of [0.3, 0.6]) { // vor der Gabel (Zweig) und auf dem gemeinsamen Abschnitt
      const a = army(sim, 'IT', neapel);
      startMove(sim.ctx, a, [neapel, bologna]);
      a.move!.segStart = sim.state.time - (a.move!.segEnd - a.move!.segStart) * f;
      a.move!.segEnd = a.move!.segStart + (a.move!.segEnd - sim.state.time) / (1 - f);
      const plan = planRoute(sim.state, map, a, sim.state.time, { node: rom })!;
      expect(plan, `f = ${f}`).toBeTruthy();
      expect(enters(plan, bologna), `f = ${f}`).toBe(false);
      expect(plan.path[plan.path.length - 1]).toBe(rom);
    }
  });

  it('der Marsch über die Gabel kommt an, ohne die Stadt dazwischen zu betreten (eine leere Feindstadt bleibt unerobert)', () => {
    const sim = newSim();
    sim.state.provinces[cherson].owner = 'KA';
    sim.state.provinces[sevastopol].owner = 'KA';
    sim.state.provinces[tiflis].owner = 'UA';
    setRelation(sim.state, 'KA', 'UA', 'war');
    sim.state.armies = sim.state.armies.filter((x) => ![cherson, tiflis, sevastopol].includes(x.node) && x.owner !== 'UA');
    const a = army(sim, 'KA', cherson);
    expect(sim.apply('KA', { type: 'move', army: a.id, to: sevastopol }).ok).toBe(true);
    expect(a.move!.cut).toBeDefined(); // Teilstücke: Wechsel an der Gabel
    for (let h = 0; h < 24 * 30 && a.move; h++) sim.advance(HOUR);
    expect(a.move).toBeNull();
    expect(a.node).toBe(sevastopol);
    expect(a.pos ?? null).toBeNull();
    expect(sim.state.provinces[tiflis].owner).toBe('UA');
  });

  it('Abkürzung durch fremdes Gebiet ist kein Kriegsgrund, solange keine Truppen im Weg stehen', () => {
    const sim = newSim();
    sim.state.provinces[cherson].owner = 'KA';
    sim.state.provinces[sevastopol].owner = 'KA';
    sim.state.provinces[tiflis].owner = 'UA';
    setRelation(sim.state, 'KA', 'UA', 'peace');
    sim.state.armies = sim.state.armies.filter((x) => ![cherson, tiflis, sevastopol].includes(x.node));
    const a = army(sim, 'KA', cherson);
    const plan = planRoute(sim.state, map, a, sim.state.time, { node: sevastopol })!;
    expect(plan).toBeTruthy();
    expect(enters(plan, tiflis)).toBe(false);
    expect(requiredWars(sim.state, map, a, { node: sevastopol })).toEqual([]);
    expect(sim.apply('KA', { type: 'move', army: a.id, to: sevastopol }).ok).toBe(true);
    for (let h = 0; h < 24 * 30 && a.move; h++) sim.advance(HOUR);
    expect(a.node).toBe(sevastopol);
    expect(atWar(sim.state, 'KA', 'UA')).toBe(false);
  });
});

describe('Kriegsgrund: Begegnung ohne Wegrecht', () => {
  it('treffen sich Truppen zweier Nationen im Frieden an Land, beginnt der Krieg', () => {
    const sim = newSim('IT');
    const v = map.provinces.find((p) => sim.state.provinces[p.id].owner === 'IT'
      && nodeNeighbors(map, p.id).filter((n) => n < map.provinces.length).length >= 3)!.id;
    const [u, w, y] = nodeNeighbors(map, v).filter((n) => n < map.provinces.length);
    sim.state.armies = sim.state.armies.filter((x) => ![u, v, w, y].includes(x.node));
    for (const n of [u, v, w, y]) sim.state.provinces[n].owner = 'IT';
    for (const n of [u, v, w]) sim.state.provinces[n].buildings.railroad = 1;
    setRelation(sim.state, 'IT', 'AU', 'peace');
    // eigene Bahn, Panzerwagen im Gewaltmarsch: gut 4 km je Minute
    const A = army(sim, 'IT', u, { units: { armoredCar: 5 }, forcedMarch: true });
    const B = army(sim, 'AU', v);
    startMove(sim.ctx, A, [u, v, w]);
    startMove(sim.ctx, B, [v, y]);
    // A zieht eine halbe Minute nach B's Aufbruch durch v – die beiden begegnen sich dort
    const T = sim.state.time + MINUTE / 2;
    const D = A.move!.segEnd - A.move!.segStart;
    A.move!.segStart = T - D;
    A.move!.segEnd = T;
    const E = B.move!.segEnd - B.move!.segStart;
    B.move!.segStart = T - MINUTE / 2;
    B.move!.segEnd = B.move!.segStart + E;
    sim.ctx.invalidate();
    for (let k = 0; k < 3; k++) sim.advance(MINUTE);
    expect(atWar(sim.state, 'IT', 'AU')).toBe(true);
    expect(sim.state.events.some((e) => /Zusammenstoß/.test(e.text))).toBe(true);
    const pa = armyPosition(map, A, sim.state.time), pb = armyPosition(map, B, sim.state.time);
    expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1])).toBeLessThan(1.6);
  });

  it('mit Durchmarschrecht kein Krieg', () => {
    const sim = newSim('IT');
    setRelation(sim.state, 'IT', 'AU', 'rightOfWay');
    const v = map.provinces.find((p) => sim.state.provinces[p.id].owner === 'IT'
      && nodeNeighbors(map, p.id).filter((n) => n < map.provinces.length).length >= 3)!.id;
    const [u, , y] = nodeNeighbors(map, v).filter((n) => n < map.provinces.length);
    sim.state.armies = sim.state.armies.filter((x) => ![u, v, y].includes(x.node));
    const A = army(sim, 'IT', u);
    const B = army(sim, 'AU', v);
    startMove(sim.ctx, A, [u, v]);
    startMove(sim.ctx, B, [v, y]);
    sim.ctx.invalidate();
    for (let k = 0; k < 60; k++) sim.advance(MINUTE);
    expect(atWar(sim.state, 'IT', 'AU')).toBe(false);
  });
});
