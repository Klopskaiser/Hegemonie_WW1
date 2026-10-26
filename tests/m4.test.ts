import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/game/balance.ts';
import { BasicAI } from '../src/game/ai.ts';
import { mapSummary } from '../src/game/bridgeProtocol.ts';
import { setRelation } from '../src/game/diplomacy.ts';
import { isSea } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame, migrate } from '../src/game/state.ts';
import { HeadlessEnv, RecordingController } from '../src/headless/env.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;

describe('KI-Profile und Schwierigkeit', () => {
  it('jede Nation hat ein Profil; ältere Spielstände erhalten Vorgaben', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 5, now: 0, difficulty: 'hard' });
    expect(state.difficulty).toBe('hard');
    for (const n of map.nations) {
      const p = state.aiProfiles[n.id];
      expect(p.aggression).toBeGreaterThanOrEqual(0.7);
      expect(p.aggression).toBeLessThanOrEqual(1.3);
      expect(p.caution).toBeGreaterThanOrEqual(0.8);
    }
    const old = { ...state } as Partial<typeof state>;
    delete old.difficulty;
    delete old.aiProfiles;
    migrate(old as typeof state);
    expect(old.difficulty).toBe('normal');
    expect(old.aiProfiles).toEqual({});
  });
});

describe('Steuerung', () => {
  it('extern gesteuerte Nationen ohne Modell übernimmt die eingebaute KI, die Spielernation nicht', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 5, now: 0 });
    state.nations.DE.controller = 'external';
    state.nations.FR.controller = 'external';
    const sim = new Simulation(state, map);
    expect(sim.controllerOf('FR')).toBeInstanceOf(BasicAI);
    expect(sim.controllerOf('DE')).toBeNull();
    state.nations.DE.controller = 'ai';
    expect(sim.controllerOf('DE')).toBeInstanceOf(BasicAI);
  });

  it('Beobachtung enthält Beziehungen, Angebote und eigene Marschziele', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 5, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = 'human';
    const sim = new Simulation(state, map);
    sim.apply('FR', { type: 'propose', nation: 'DE', kind: 'rightOfWay' });
    sim.apply('DE', { type: 'declareWar', nation: 'NL' });
    const obs = sim.observation('DE');
    expect(obs.relations.NL).toBe('war');
    expect(obs.relations.FR).toBe('peace');
    expect(obs.proposals).toEqual([{ from: 'FR', kind: 'rightOfWay' }]);
    expect(obs.enemies).toEqual(['NL']);
    const mine = obs.armies.find((a) => a.owner === 'DE')!;
    expect(mine.to).toBe(mine.node);
  });

  it('Kartenübersicht nummeriert Seegebiete hinter den Provinzen', () => {
    const s = mapSummary(map);
    expect(s.provinceCount).toBe(map.provinces.length);
    expect(s.seas[0].node).toBe(map.provinces.length);
    expect(s.provinces[0].neighbors.length).toBeGreaterThan(0);
  });
});

describe('Headless-Umgebung', () => {
  it('Agenten handeln nur über step(); Belohnung und Ergebnisse je Nation', () => {
    const env = new HeadlessEnv(map, { agents: ['DE'], seed: 2, stepHours: 12 });
    const obs = env.reset();
    expect(Object.keys(obs)).toEqual(['DE']);
    const berlin = prov('Berlin');
    const r = env.step({ DE: [{ type: 'build', province: berlin, building: 'fortress' }], FR: [{ type: 'declareWar', nation: 'DE' }] });
    expect(r.info.results.DE[0].ok).toBe(true);
    expect(r.info.results.FR[0].ok).toBe(false);
    expect(r.reward.DE).toBeTypeOf('number');
    expect(r.done).toBe(false);
    // die KI rührt deutsche Provinzen nicht an: außer Berlin baut nichts
    for (let k = 0; k < 4; k++) env.step();
    env.sim.state.provinces.forEach((ps, i) => {
      if (ps.owner === 'DE' && i !== berlin) expect(ps.construction).toBeNull();
      if (ps.owner === 'DE') expect(ps.queue.length).toBe(0);
    });
    // andere Nationen werden von der KI gesteuert
    expect(env.sim.state.provinces.some((ps) => ps.owner === 'FR' && ps.construction)).toBe(true);
  });

  it('gleicher Seed und gleiche Aktionen ergeben denselben Verlauf', () => {
    const run = () => {
      const env = new HeadlessEnv(map, { agents: ['IT'], seed: 9, stepHours: 24 });
      env.reset();
      for (let d = 0; d < 6; d++) env.step();
      return JSON.stringify(env.sim.state);
    };
    expect(run()).toBe(run());
  });

  it('Aufzeichnung erfasst die KI-Entscheidungen', () => {
    const env = new HeadlessEnv(map, { seed: 4, stepHours: 24 });
    const recs: { nation: string }[] = [];
    env.reset(4, (_n, ctrl) => new RecordingController(ctrl, (rec) => recs.push(rec)));
    env.step();
    expect(recs.length).toBeGreaterThan(10);
    expect(new Set(recs.map((r) => r.nation)).size).toBeGreaterThan(5);
  });

  it('endet nach maxDays', () => {
    const env = new HeadlessEnv(map, { seed: 1, stepHours: 24, maxDays: 2 });
    env.reset();
    expect(env.step().done).toBe(false);
    expect(env.step().done).toBe(true);
  });
});

describe('Strategische KI', () => {
  /** nur die gewählten Nationen werden von der KI geführt */
  function aiSim(ai: string[], seed = 3) {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = ai.includes(n.id) ? 'ai' : 'human';
    return new Simulation(state, map);
  }

  it('Großmacht greift über See an, wenn es keinen Landweg gibt', () => {
    const sim = aiSim(['GB']);
    setRelation(sim.state, 'GB', 'NL', 'war');
    const london = prov('London');
    sim.state.armies.find((a) => a.owner === 'GB' && a.node === london)!.units.infantry = 40;
    let seaMove = false;
    for (let h = 0; h < 2 * 24 && !seaMove; h++) {
      sim.advance(HOUR);
      seaMove = sim.state.armies.some((a) => a.owner === 'GB' && (isSea(map, a.node) || a.move?.path.some((n) => isSea(map, n))));
    }
    expect(seaMove).toBe(true);
  });

  it('verlegt Reserven an eine bedrohte Front', () => {
    const sim = aiSim(['FR']);
    setRelation(sim.state, 'FR', 'DE', 'war');
    // starke deutsche Armee vor der Grenze, französische Reserve im Hinterland
    const front = map.provinces.filter((p) => p.nation === 'FR' && p.neighbors.some((n) => map.provinces[n].nation === 'DE'));
    const enemyNode = front[0].neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    sim.state.armies.find((a) => a.owner === 'DE' && a.node === enemyNode)!.units.infantry = 60;
    const frontIds = new Set(front.map((p) => p.id));
    const paris = prov('Paris');
    sim.state.armies.find((a) => a.owner === 'FR' && a.node === paris)!.units.infantry = 40;
    sim.advance(DAY);
    const toFront = sim.state.armies.some((a) => a.owner === 'FR' && a.move && frontIds.has(a.move.path[a.move.path.length - 1]));
    const atFront = sim.state.armies.filter((a) => a.owner === 'FR' && frontIds.has(a.node))
      .reduce((t, a) => t + (a.units.infantry ?? 0), 0);
    expect(toFront || atFront > front.length * 10).toBe(true);
  });
});
