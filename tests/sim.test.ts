import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/game/balance.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import { recruitHours } from '../src/game/economy.ts';
import { unitHours } from '../src/game/actions.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));

function newSim(seed = 42) {
  return new Simulation(createGame(map, { id: 't', name: 'Test', playerNation: 'DE', speed: 1, seed, now: 0 }), map);
}

const capitalDE = map.nations.find((n) => n.id === 'DE')!.capital;

describe('Karte', () => {
  it('hat Nationen mit Hauptstadt und Provinzen mit Nachbarn', () => {
    expect(map.nations.length).toBeGreaterThanOrEqual(10);
    for (const n of map.nations) expect(map.provinces[n.capital].nation).toBe(n.id);
    const lonely = map.provinces.filter((p) => p.neighbors.length === 0 && !p.coastal);
    expect(lonely).toEqual([]);
    for (const p of map.provinces) for (const n of p.neighbors) expect(map.provinces[n].neighbors).toContain(p.id);
  });

  it('gibt jeder Spielernation 10 Provinzen mit genau 2 Doppelprovinzen, Kleinstaaten weniger', () => {
    expect(map.provinces.length).toBeGreaterThanOrEqual(160);
    expect(map.provinces.length).toBeLessThanOrEqual(195);
    for (const n of map.nations) {
      const own = map.provinces.filter((p) => p.nation === n.id);
      if (n.major) {
        expect(own.length, n.id).toBe(10);
        expect(own.filter((p) => p.double).length, n.id).toBe(2);
      } else {
        expect(own.length, n.id).toBeLessThan(10);
      }
    }
  });
});

describe('Rohstoffverteilung', () => {
  const CAT: Record<string, string> = { grain: 'food', fish: 'food', iron: 'mat', lumber: 'mat', coal: 'energy', oil: 'energy', gas: 'energy' };
  const pts = (p: MapData['provinces'][number]) => (p.double ? 2 : 1);
  const share = (ps: MapData['provinces'], cat: string) =>
    ps.filter((p) => CAT[p.resource] === cat).reduce((s, p) => s + pts(p), 0) / ps.reduce((s, p) => s + pts(p), 0);

  it('verteilt die Gesamtkarte grob 40 % Energie, 30 % Baustoffe, 30 % Nahrung', () => {
    expect(share(map.provinces, 'energy')).toBeCloseTo(0.4, 1);
    expect(share(map.provinces, 'mat')).toBeCloseTo(0.3, 1);
    expect(share(map.provinces, 'food')).toBeCloseTo(0.3, 1);
  });

  it('gibt jeder Nation ab 3 Provinzen alle Kategorien und keine über 60 %', () => {
    for (const n of map.nations) {
      const own = map.provinces.filter((p) => p.nation === n.id);
      if (own.length < 3) continue;
      for (const c of ['energy', 'mat', 'food']) {
        expect(share(own, c), `${n.id} ${c}`).toBeGreaterThan(0);
        expect(share(own, c), `${n.id} ${c}`).toBeLessThanOrEqual(0.6 + 1e-9);
      }
    }
  });

  it('hält Öl knapp, aber vorhanden', () => {
    const oil = map.provinces.filter((p) => p.resource === 'oil');
    expect(oil.length).toBeGreaterThanOrEqual(8);
    expect(oil.length / map.provinces.length).toBeLessThan(0.1);
    expect(oil.filter((p) => p.double).length).toBeLessThanOrEqual(2);
  });
});

describe('Simulation', () => {
  it('produziert Rohstoffe über die Zeit', () => {
    const sim = newSim();
    const before = sim.state.nations.DE.stock.money;
    sim.advance(6 * HOUR);
    expect(sim.state.time).toBe(6 * HOUR);
    expect(sim.state.nations.DE.stock.money).toBeGreaterThan(before);
  });

  it('stellt Gebäude nach der Bauzeit fertig', () => {
    const sim = newSim();
    const target = map.provinces.find((p) => p.nation === 'DE' && !p.city)!.id;
    // Eisenbahn erst ab Tag 3
    expect(sim.apply('DE', { type: 'build', province: target, building: 'railroad' }).ok).toBe(false);
    sim.advance(2 * DAY);
    const r = sim.apply('DE', { type: 'build', province: target, building: 'railroad' });
    expect(r.ok).toBe(true);
    sim.advance(71 * HOUR);
    expect(sim.state.provinces[target].buildings.railroad).toBe(0);
    sim.advance(1 * HOUR);
    expect(sim.state.provinces[target].buildings.railroad).toBe(1);
  });

  it('Fertigungsschleife wiederholt Aufträge', () => {
    const sim = newSim();
    for (const k of Object.keys(sim.state.nations.DE.stock) as (keyof typeof sim.state.nations.DE.stock)[]) sim.state.nations.DE.stock[k] = 1e6;
    sim.state.provinces[capitalDE].buildings.factory = 4; // Panzerwagen: 4 h je Stück
    const r = sim.apply('DE', { type: 'enqueue', province: capitalDE, unit: 'armoredCar' });
    expect(r.ok).toBe(true);
    sim.apply('DE', { type: 'setRepeat', province: capitalDE, repeat: true });
    const count = () => sim.state.armies.filter((a) => a.owner === 'DE' && a.node === capitalDE)
      .reduce((s, a) => s + (a.units.armoredCar ?? 0), 0);
    sim.advance(4 * HOUR * 3 + 20 * MINUTE);
    expect(count()).toBeGreaterThanOrEqual(3);
    expect(sim.state.provinces[capitalDE].queue.length).toBe(1);
  });

  it('höhere Fabrikstufen verkürzen die Bauzeit (Artillerie 4/3/2/1 Tage, Panzer ab Stufe 2: 40/30/20 h)', () => {
    const sim = newSim();
    const ps = sim.state.provinces[capitalDE];
    const days = [1, 2, 3, 4].map((l) => { ps.buildings.factory = l; return unitHours(sim.state, capitalDE, 'artillery') / 24; });
    expect(days).toEqual([4, 3, 2, 1]);
    const tank = [2, 3, 4].map((l) => { ps.buildings.factory = l; return unitHours(sim.state, capitalDE, 'tank'); });
    expect(tank).toEqual([40, 30, 20]);
  });

  it('lässt Infanterie nicht in Auftrag geben', () => {
    const sim = newSim();
    expect(sim.apply('DE', { type: 'enqueue', province: capitalDE, unit: 'infantry' }).ok).toBe(false);
  });

  it('Wehramt und Kaserne stellen Infanterie auf (32/21/16 h bei 100 % Moral, Doppelprovinz doppelt so schnell)', () => {
    const ps = { ...newSim().state.provinces[capitalDE], morale: 1, revolt: false };
    ps.buildings = { ...ps.buildings, recruitment: 1, barracks: 0 };
    expect(recruitHours(ps)).toBeCloseTo(32);
    expect(recruitHours(ps, true)).toBeCloseTo(16);
    ps.buildings.barracks = 1;
    expect(recruitHours(ps)).toBeCloseTo(21);
    ps.buildings.barracks = 2;
    expect(recruitHours(ps)).toBeCloseTo(16);
    // Moral wirkt anteilig
    expect(recruitHours({ ...ps, morale: 0.5 })).toBeCloseTo(32);
    // Kaserne ohne Wehramt: halb so schnell
    ps.buildings.recruitment = 0;
    expect(recruitHours(ps)).toBeCloseTo(32);
    ps.buildings.barracks = 0;
    expect(recruitHours(ps)).toBeNull();
  });

  it('erzeugt Infanterie in der Provinz über die Zeit', () => {
    const sim = newSim();
    const ps = sim.state.provinces[capitalDE];
    const before = sim.state.armies.filter((a) => a.node === capitalDE && a.owner === 'DE').reduce((s, a) => s + (a.units.infantry ?? 0), 0);
    sim.advance(DAY);
    const after = sim.state.armies.filter((a) => a.node === capitalDE && a.owner === 'DE').reduce((s, a) => s + (a.units.infantry ?? 0), 0);
    expect(after - before).toBeGreaterThanOrEqual(Math.floor(24 / recruitHours(ps)!) - 1);
  });

  it('Kaserne braucht ein Wehramt', () => {
    const sim = newSim();
    sim.state.provinces[capitalDE].buildings.recruitment = 0;
    expect(sim.apply('DE', { type: 'build', province: capitalDE, building: 'barracks' }).ok).toBe(false);
    sim.state.provinces[capitalDE].buildings.recruitment = 1;
    expect(sim.apply('DE', { type: 'build', province: capitalDE, building: 'barracks' }).ok).toBe(true);
  });

  it('startet mit Wehramt, 10 Infanterie je Provinz und einheitlichen Vorräten', () => {
    const s = newSim().state;
    for (const ps of s.provinces) {
      expect(ps.buildings.recruitment).toBe(1);
      expect(ps.buildings.railroad + ps.buildings.factory + ps.buildings.barracks + ps.buildings.fortress + ps.buildings.harbor).toBe(0);
    }
    for (const p of map.provinces) {
      expect(s.armies.filter((a) => a.node === p.id).reduce((t, a) => t + (a.units.infantry ?? 0), 0)).toBe(10);
    }
    for (const n of Object.values(s.nations)) {
      const raw = (['grain', 'fish', 'iron', 'lumber', 'coal', 'oil', 'gas'] as const).map((r) => n.stock[r]);
      expect(raw.filter((v) => v === 7000).length).toBe(1);
      expect(raw.filter((v) => v === 6000).length).toBe(6);
      expect(n.stock.money).toBe(100000);
    }
  });

  it('lehnt Panzerwagen ohne Fabrik ab', () => {
    const sim = newSim();
    const r = sim.apply('DE', { type: 'enqueue', province: capitalDE, unit: 'armoredCar' });
    expect(r.ok).toBe(false);
  });

  it('ist unabhängig von der Schrittweite deterministisch (Nachsimulation = Live)', () => {
    const a = newSim(7), b = newSim(7);
    a.advance(5 * DAY);
    for (let t = 0; t < 5 * DAY; t += 37_123) b.advance(Math.min(37_123, 5 * DAY - t));
    b.advance(0);
    expect(b.state.time).toBe(a.state.time);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('KI-Nationen bauen und rekrutieren', () => {
    const sim = newSim();
    const builtBefore = sim.state.provinces.filter((p) => p.owner === 'FR').reduce((s, p) => s + p.buildings.railroad + p.buildings.factory, 0);
    sim.advance(10 * DAY);
    const builtAfter = sim.state.provinces.filter((p) => p.owner === 'FR').reduce((s, p) => s + p.buildings.railroad + p.buildings.factory, 0);
    expect(builtAfter).toBeGreaterThan(builtBefore);
  });
});
