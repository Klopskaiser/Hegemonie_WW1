// Hafenpunkt: Bau wählt den Hafenort; steht ein aktiver Hafen, führt jede Einschiffnung nur über ihn.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harborCandidates } from '../src/game/actions.ts';
import { DAY, HOUR } from '../src/game/balance.ts';
import { harborSea } from '../src/game/graph.ts';
import { canTraverse } from '../src/game/military.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const berlin = map.provinces.find((p) => p.name === 'Berlin')!.id;

function newSim() {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  for (const r of Object.keys(state.nations.DE.stock) as (keyof typeof state.nations.DE.stock)[]) state.nations.DE.stock[r] = 200000;
  state.time = 2 * DAY; // Hafen erst ab Tag 3 baubar
  return new Simulation(state, map);
}

describe('Hafenpunkt', () => {
  it('weist Bau ohne Wahl den nächsten Seepunkt zu, mit Wahl den gewählten und lehnt fremde Punkte ab', () => {
    const sim = newSim();
    const cands = harborCandidates(map, berlin);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'harbor', harborPoint: cands[0] + 5000 }).ok).toBe(false);
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'harbor', harborPoint: cands[1] }).ok).toBe(true);
    expect(sim.state.provinces[berlin].harborNode).toBe(cands[1]);
    const sim2 = newSim();
    expect(sim2.apply('DE', { type: 'build', province: berlin, building: 'harbor' }).ok).toBe(true);
    expect(sim2.state.provinces[berlin].harborNode).toBe(harborSea(map, berlin));
  });

  it('ein aktiver Hafen sperrt alle anderen Küstenpunkte der Provinz für die Einschiffnung', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'harbor', harborPoint: harborSea(map, berlin)! }).ok).toBe(true);
    const other = harborCandidates(map, berlin).find((z) => z !== ps.harborNode)!;
    const a: any = { id: 9001, owner: 'DE', node: berlin, units: { infantry: 5 }, morale: 1 };
    sim.state.armies.push(a);
    // ohne fertigen Hafen führt jeder Küstenpunkt aufs Wasser
    expect(canTraverse(sim.state, map, a, berlin, other)).toBe(true);
    sim.advance(Math.round(73 * HOUR));
    expect(ps.buildings.harbor).toBe(1);
    expect(canTraverse(sim.state, map, a, berlin, ps.harborNode!)).toBe(true);
    expect(canTraverse(sim.state, map, a, berlin, other)).toBe(false);
    // Landen in der Provinz bleibt überall möglich
    expect(canTraverse(sim.state, map, a, other, berlin)).toBe(true);
  });

  it('verlegt den Hafenpunkt auf Befehl und lässt Schiffe dort aufs Wasser', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    ps.buildings.harbor = 1;
    const cands = harborCandidates(map, berlin);
    ps.harborNode = cands[0];
    expect(sim.apply('DE', { type: 'setHarborPoint', province: berlin, sea: cands[1] }).ok).toBe(true);
    expect(ps.harborNode).toBe(cands[1]);
    expect(sim.apply('DE', { type: 'setHarborPoint', province: berlin, sea: berlin }).ok).toBe(false);
    sim.spawn(berlin, 'DE', 'battleship', 1);
    const ship = sim.state.armies.find((x: any) => x.units.battleship);
    expect(ship!.node).toBe(cands[1]);
  });
});
