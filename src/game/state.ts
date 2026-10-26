import { RESOURCES } from './mapdata.ts';
import { START_BONUS, START_INFANTRY, START_STOCK, type Building } from './balance.ts';
import { makeRng } from './rng.ts';
import { defaultConsumption, moraleTarget, provincePoints } from './economy.ts';
import type { MapData } from './mapdata.ts';
import type { Difficulty, GameMeta, GameState, NationState, ProvinceState } from './types.ts';

export interface NewGameOptions {
  id: string;
  name: string;
  playerNation: string;
  speed: number;
  seed: number;
  now: number;
  /** standard: nur Wehramt und 10 Infanterie je Provinz; test: ausgebaute Provinzen, große Vorräte */
  scenario?: Scenario;
  difficulty?: Difficulty;
}

export type Scenario = 'standard' | 'test';

export const SCENARIOS: { id: Scenario; name: string; description: string }[] = [
  { id: 'standard', name: 'Standard', description: 'Jede Provinz mit Wehramt und 10 Infanterie, sonst keine Gebäude.' },
  { id: 'test', name: 'Testszenario', description: 'Ausgebaute Provinzen (Eisenbahn, Fabrik 2, Kaserne, Hafen, Festung) und große Vorräte.' },
];

const noBuildings = (): Record<Building, number> => ({
  railroad: 0, harbor: 0, fortress: 0, factory: 0, manufactory: 0, barracks: 0, recruitment: 0, office: 0,
});

export function createGame(map: MapData, opt: NewGameOptions): GameState {
  const scenario = opt.scenario ?? 'standard';
  const rnd = makeRng(opt.seed ^ 0x51a7);
  const nations: Record<string, NationState> = {};
  for (const n of map.nations) {
    const stock = { ...START_STOCK };
    if (scenario === 'test') for (const k of Object.keys(stock) as (keyof typeof stock)[]) stock[k] = 50000;
    // +1000 beim Rohstoff mit den meisten Symbolen (Doppelprovinz = 2), Gleichstand per Zufall
    const symbols = new Map<string, number>();
    for (const p of map.provinces) if (p.nation === n.id) symbols.set(p.resource, (symbols.get(p.resource) ?? 0) + (p.double ? 2 : 1));
    const most = Math.max(0, ...symbols.values());
    const top = RESOURCES.filter((r) => (symbols.get(r) ?? 0) === most && most > 0);
    if (top.length) stock[top[Math.floor(rnd() * top.length)]] += START_BONUS;
    nations[n.id] = {
      id: n.id,
      stock,
      controller: n.id === opt.playerNation ? 'human' : 'ai',
      consumption: defaultConsumption(map, n.id),
      alive: true,
      points: 0,
      shortage: { food: false, materials: false, energy: false },
    };
  }
  const provinces: ProvinceState[] = map.provinces.map((mp) => {
    const b = noBuildings();
    b.recruitment = 1;
    if (scenario === 'test') {
      Object.assign(b, { railroad: 1, factory: 2, barracks: 1, fortress: 1 });
      if (mp.coastal) b.harbor = 1;
    }
    return { owner: mp.nation, morale: 0.7, buildings: b, construction: null, buildQueue: [], queue: [], repeat: false, recruit: 0 };
  });
  const state: GameState = {
    version: 1,
    id: opt.id,
    name: opt.name,
    mapId: map.id,
    playerNation: opt.playerNation,
    speed: opt.speed,
    paused: false,
    createdAt: opt.now,
    lastRealTime: opt.now,
    time: 0,
    rng: opt.seed | 0,
    nations,
    provinces,
    armies: [],
    nextArmyId: 1,
    events: [],
    relations: {},
    warSince: {},
    proposals: [],
    truceUntil: {},
    market: { offers: [], nextId: 1, lastPrice: {} },
    newspapers: [],
    winner: null,
    difficulty: opt.difficulty ?? 'normal',
    aiProfiles: Object.fromEntries(map.nations.map((n) => [n.id, {
      aggression: Math.round((0.7 + rnd() * 0.6) * 100) / 100,
      caution: Math.round((0.8 + rnd() * 0.4) * 100) / 100,
    }])),
  };
  provinces.forEach((ps, i) => (ps.morale = moraleTarget(state, map, i).target));

  const addArmy = (province: number, units: GameState['armies'][number]['units']) => {
    state.armies.push({ id: state.nextArmyId++, owner: map.provinces[province].nation, node: province, units });
  };
  // Startaufstellung: in jeder Provinz eine Armee aus 10 Infanterie an der Stadt
  for (const mp of map.provinces) addArmy(mp.id, { infantry: START_INFANTRY });
  provinces.forEach((ps, i) => (nations[ps.owner].points += provincePoints(map, ps, i)));
  state.events.push({ time: 0, text: 'Der Große Krieg droht. Das Spiel beginnt.' });
  return state;
}

/** Ältere Spielstände auf das aktuelle Format bringen. */
export function migrate(state: GameState): GameState {
  state.relations ??= {};
  state.warSince ??= {};
  state.proposals ??= [];
  state.truceUntil ??= {};
  state.market ??= { offers: [], nextId: 1, lastPrice: {} };
  state.newspapers ??= [];
  state.winner ??= null;
  state.difficulty ??= 'normal';
  state.aiProfiles ??= {};
  for (const ps of state.provinces) {
    ps.buildQueue ??= [];
    ps.buildings = { ...noBuildings(), ...ps.buildings };
  }
  for (const a of state.armies as (GameState['armies'][number] & { province?: number })[]) {
    if (a.node === undefined && a.province !== undefined) {
      a.node = a.province;
      delete a.province;
    }
  }
  return state;
}

export function metaOf(state: GameState, map: MapData): GameMeta {
  return {
    id: state.id,
    name: state.name,
    mapId: state.mapId,
    mapName: map.name,
    playerNation: state.playerNation,
    nationName: map.nations.find((n) => n.id === state.playerNation)?.name ?? state.playerNation,
    speed: state.speed,
    paused: state.paused,
    time: state.time,
    lastRealTime: state.lastRealTime,
    createdAt: state.createdAt,
  };
}
