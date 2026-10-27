import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MILITARY, MINUTE, UNITS } from '../src/game/balance.ts';
import { armyPosition, forcedMarchWear, repairMachines, segmentHours, unitCount } from '../src/game/military.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;

function setup() {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 7, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  const sim = new Simulation(state, map);
  const fr = map.provinces.find((p) => p.nation === 'FR' && !p.capital && (p.links ?? []).some((n) => map.provinces[n].nation === 'DE'))!;
  const q = fr.id, p = fr.links!.find((n) => map.provinces[n].nation === 'DE')!;
  sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
  const add = (a: Omit<Army, 'id'>): Army => {
    const x = { id: sim.state.nextArmyId++, ...a } as Army;
    sim.state.armies.push(x);
    return x;
  };
  const dist = (a: Army, b: Army) => {
    const u = armyPosition(map, a, sim.state.time), v = armyPosition(map, b, sim.state.time);
    return Math.hypot(u[0] - v[0], u[1] - v[1]);
  };
  return { sim, p, q, add, dist };
}

describe('Gewaltmarsch', () => {
  it('50 % schneller; im Marsch −4 % Moral je Stunde, Maschinen fallen aus, keine Reparatur', () => {
    const { sim, p, q, add } = setup();
    const a = add({ owner: 'DE', node: p, units: { infantry: 5, tank: 2 }, morale: 0.8, keepApart: true });
    const normal = segmentHours(sim.state, map, a, p, q);
    a.forcedMarch = true;
    expect(segmentHours(sim.state, map, a, p, q)).toBeCloseTo(normal / MILITARY.forcedMarchSpeed, 9);
    // Verschleiß im Marsch
    const far = map.provinces.find((x) => x.nation === 'DE' && x.id !== p && Math.hypot(x.center[0] - map.provinces[p].center[0], x.center[1] - map.provinces[p].center[1]) > 400)!;
    expect(sim.apply('DE', { type: 'move', army: a.id, to: far.id }).ok).toBe(true);
    sim.advance(HOUR);
    expect(a.morale).toBeCloseTo(0.76, 6);
    expect(a.wounds?.tank).toBeCloseTo(2 * UNITS.tank.hp * MILITARY.forcedMarchWear, 6);
    const w = a.wounds!.tank!;
    repairMachines(sim.state, map);
    expect(a.wounds!.tank).toBe(w);
    // nach 13 Marschstunden hat sich der erste Panzer aufgerieben (2 × 4 % = 8 % je Stunde)
    for (let k = 0; k < 12; k++) forcedMarchWear(sim.ctx);
    expect(a.units.tank ?? 0).toBeLessThan(2);
  });

  it('Umschalten im Marsch plant den Weg mit dem neuen Tempo', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const a = add({ owner: 'DE', node: p, units: { infantry: 5 }, keepApart: true });
    expect(sim.apply('DE', { type: 'move', army: a.id, to: q }).ok).toBe(true);
    const slow = a.move!.segEnd;
    expect(sim.apply('DE', { type: 'setMarch', army: a.id, forced: true }).ok).toBe(true);
    expect(a.move!.segEnd).toBeLessThan(slow);
  });
});

describe('Marschart und Angriff', () => {
  it('Normalmarsch zieht an Gegnern in Reichweite vorbei, der Angriffsmarsch hält und feuert', () => {
    for (const aggressive of [false, true]) {
      const { sim, p, q, add, dist } = setup();
      sim.apply('DE', { type: 'declareWar', nation: 'FR' });
      const foe = add({ owner: 'FR', node: q, units: { infantry: 3 } });
      const gun = add({ owner: 'DE', node: p, units: { artillery: 3 }, aggressive: aggressive || undefined });
      expect(sim.apply('DE', { type: 'move', army: gun.id, to: q }).ok).toBe(true);
      let stopped = false;
      for (let k = 0; k < 3 * 24 * 6 && gun.move; k++) {
        sim.advance(10 * MINUTE);
        // angehalten, um zu feuern – nicht erst in Nahkampfreichweite
        if (!gun.move && gun.target != null && dist(gun, foe) > MILITARY.meleeKm + 0.01) stopped = true;
      }
      if (aggressive) {
        expect(stopped).toBe(true);
        expect(gun.resume ?? null).not.toBeNull(); // zieht nach dem Feuern weiter
      } else expect(stopped).toBe(false);
    }
  });

  it('Angriff ohne Fernkampf verfolgt den Gegner bis in den Nahkampf', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const foe = add({ owner: 'FR', node: q, units: { infantry: 1 } });
    const a = add({ owner: 'DE', node: p, units: { infantry: 20 }, keepApart: true });
    expect(sim.apply('DE', { type: 'attack', army: a.id, target: foe.id }).ok).toBe(true);
    expect(a.chase).toBe(foe.id);
    expect(a.move).not.toBeNull();
    sim.advance(3 * DAY);
    expect(sim.state.armies.includes(foe)).toBe(false);
    expect(a.chase ?? null).toBeNull();
  });

  it('Angriff mit Fernkampf rückt nur bis in Reichweite heran und beschießt', () => {
    const { sim, p, q, add, dist } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const foe = add({ owner: 'FR', node: q, units: { infantry: 30 } });
    const gun = add({ owner: 'DE', node: p, units: { artillery: 3, infantry: 2 }, keepApart: true });
    expect(sim.apply('DE', { type: 'attack', army: gun.id, target: foe.id }).ok).toBe(true);
    for (let k = 0; k < 3 * 24 * 6 && (gun.move || dist(gun, foe) > UNITS.artillery.range); k++) sim.advance(10 * MINUTE);
    expect(gun.move ?? null).toBeNull();
    const d = dist(gun, foe);
    expect(d).toBeLessThanOrEqual(UNITS.artillery.range);
    expect(d).toBeGreaterThan(MILITARY.meleeKm);
    expect(gun.target).toBe(foe.id);
  });
});

describe('Verbände im Umkreis von 1 km', () => {
  it('stehende Armeen werden zusammengefasst, abgeteilte nicht', () => {
    const { sim, add } = setup();
    const berlin = prov('Berlin');
    const garrison = sim.state.armies.find((a) => a.owner === 'DE' && a.node === berlin)!;
    const n0 = unitCount(garrison);
    const extra = add({ owner: 'DE', node: berlin, units: { infantry: 4 } });
    const apart = add({ owner: 'DE', node: berlin, units: { infantry: 3 }, keepApart: true });
    sim.advance(10 * MINUTE);
    expect(sim.state.armies.includes(extra)).toBe(false);
    expect(unitCount(garrison)).toBe(n0 + 4);
    expect(sim.state.armies.includes(apart)).toBe(true);
    // per Teilen entstandene Armeen bleiben getrennt
    const r = sim.apply('DE', { type: 'split', army: garrison.id, units: { infantry: 2 } });
    if (!r.ok) throw new Error(r.error);
    sim.advance(10 * MINUTE);
    expect(sim.state.armies.some((a) => a.id === r.army)).toBe(true);
  });

  it('eine Armee mit unterbrochenem Marschbefehl kämpft im Verband und zieht danach mit ihrem Anteil weiter', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    add({ owner: 'FR', node: q, units: { infantry: 2 } });
    const big = add({ owner: 'DE', node: q, units: { infantry: 20 } });
    const late = add({ owner: 'DE', node: q, units: { infantry: 6 }, resume: { node: p } });
    sim.advance(10 * MINUTE);
    expect(sim.state.armies.includes(late)).toBe(false);
    expect(big.parts?.map((x) => x.id)).toEqual([late.id]);
    sim.advance(DAY);
    const again = sim.state.armies.find((a) => a.id === late.id);
    expect(again).toBeDefined();
    expect(unitCount(again!)).toBeGreaterThan(0);
    expect(unitCount(again!)).toBeLessThanOrEqual(6);
    expect(big.parts ?? null).toBeNull();
    // zieht zu seinem Ziel weiter (oder ist schon dort)
    expect(again!.move !== null || again!.node === p).toBe(true);
  });
});
