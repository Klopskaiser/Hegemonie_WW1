// Karte mit Seeknoten statt Seegebieten (europa_real): Aufbau des Netzes und Fahrten darüber.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/game/balance.ts';
import { setRelation } from '../src/game/diplomacy.ts';
import { edgePoints, harborSea, isSea, nodeNeighbors } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europa_real.json'), 'utf8'));
const P = map.provinces.length;

describe('Seeknoten-Karte', () => {
  it('hat Knoten statt Seegebieten: keine Seegrenzen, viele Knoten, durchnummerierte Namen', () => {
    expect(map.seaNodes).toBe(true);
    expect(map.seaBorders).toEqual([]);
    expect(map.seas.length).toBeGreaterThanOrEqual(150);
    expect(new Set(map.seas.map((z) => z.name)).size).toBe(map.seas.length);
  });

  it('alle Knoten hängen in einem Netz zusammen, Verbindungen beidseitig', () => {
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length) {
      const z = queue.pop()!;
      for (const t of map.seas[z].seas) {
        expect(map.seas[t].seas, `${map.seas[z].name}–${map.seas[t].name}`).toContain(z);
        if (!seen.has(t)) { seen.add(t); queue.push(t); }
      }
    }
    expect(seen.size).toBe(map.seas.length);
  });

  it('jede Küstenprovinz hat genau einen Hafen, am nächstgelegenen angrenzenden Knoten', () => {
    for (const p of map.provinces.filter((q) => q.coastal)) {
      expect(p.seaLinks, p.name).toHaveLength(1);
      const d = (z: number) => Math.hypot(map.seas[z].center[0] - p.center[0], map.seas[z].center[1] - p.center[1]);
      const nearest = Math.min(...p.seas.map(d));
      expect(d(p.seaLinks![0]), p.name).toBe(nearest);
      expect(harborSea(map, p.id)).toBe(P + p.seaLinks![0]);
      // Hafenweg: Stadt → Hafenpunkt an der Küste → Knoten
      expect(edgePoints(map, p.id, P + p.seaLinks![0]).length, p.name).toBeGreaterThanOrEqual(3);
    }
  });

  it('Knoten sind nur mit Häfen und anderen Knoten verbunden', () => {
    for (let z = 0; z < map.seas.length; z++) {
      for (const n of nodeNeighbors(map, P + z)) {
        if (isSea(map, n)) continue;
        expect(map.provinces[n].seaLinks).toContain(z);
      }
    }
  });
});

describe('Fahrten über Seeknoten', () => {
  it('Truppen setzen über die Knoten von England nach Holland über', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'GB', speed: 1, seed: 7, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = 'human';
    const sim = new Simulation(state, map);
    setRelation(sim.state, 'GB', 'NL', 'war');
    const london = map.provinces.find((p) => p.name === 'London')!.id;
    const target = map.provinces.find((p) => p.nation === 'NL' && p.coastal)!.id;
    const army = sim.state.armies.find((a) => a.owner === 'GB' && a.node === london)!;
    army.units.infantry = 30;
    const r = sim.apply('GB', { type: 'move', army: army.id, to: target });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    expect(army.move!.path.some((n) => isSea(map, n))).toBe(true);
    let arrived = false;
    for (let h = 0; h < 30 * 24 && !arrived; h++) {
      sim.advance(HOUR);
      const a = sim.state.armies.find((x) => x.id === army.id);
      arrived = !!a && a.node === target && !a.move;
    }
    expect(arrived).toBe(true);
  });

  it('KI-Partie läuft auf der Seeknoten-Karte', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = 'ai';
    const sim = new Simulation(state, map);
    setRelation(sim.state, 'GB', 'DE', 'war');
    for (let h = 0; h < 10 * 24; h++) sim.advance(HOUR);
    expect(sim.state.armies.length).toBeGreaterThan(0);
  });
});
