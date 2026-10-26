/// <reference lib="webworker" />
// Führt das aktive Spiel aus: Nachsimulation beim Öffnen, danach Echtzeitlauf
// mit der eingestellten Geschwindigkeit, regelmäßiges Speichern.

import type { Action } from '../game/actions.ts';
import { DAY, MINUTE } from '../game/balance.ts';
import { mapSummary, PROTOCOL_VERSION, type FromModel, type ToModel } from '../game/bridgeProtocol.ts';
import { QueuedController } from '../game/controller.ts';
import type { MapData } from '../game/mapdata.ts';
import { Simulation } from '../game/sim.ts';
import { createGame, metaOf } from '../game/state.ts';
import type { ControllerKind } from '../game/types.ts';
import { loadGame, saveGame } from '../persist/db.ts';
import type { BridgeInfo, FromWorker, ToWorker } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 100;
const SNAPSHOT_MS = 200;
const SAVE_MS = 15_000;
const RECONNECT_MS = 5_000;

let sim: Simulation | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let lastSnapshot = 0;
let lastSave = 0;
const maps = new Map<string, MapData>();

const post = (m: FromWorker) => self.postMessage(m);

// ---------------------------------------------------------------- Brücke zu externen Modellen

let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;
let bridge: BridgeInfo = { status: 'off', url: '', sent: 0, received: 0 };

function setBridge(patch: Partial<BridgeInfo>): void {
  bridge = { ...bridge, ...patch };
  post({ type: 'bridge', info: bridge });
}

function send(m: ToModel): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(m));
  bridge.sent++;
}

function externalNations(): string[] {
  if (!sim) return [];
  return sim.map.nations.filter((n) => sim!.state.nations[n.id].controller === 'external').map((n) => n.id);
}

/** Externe Nationen an die Brücke hängen; ohne offene Verbindung entscheidet die eingebaute KI. */
function attachControllers(): void {
  if (!sim) return;
  sim.controllers.clear();
  if (socket?.readyState !== WebSocket.OPEN) return;
  for (const id of externalNations()) {
    const q = new QueuedController();
    q.onObserve = (obs) => send({ type: 'observe', nation: id, obs });
    sim.controllers.set(id, q);
  }
  send({ type: 'controllers', nations: externalNations() });
}

function disconnect(): void {
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  const s = socket;
  socket = null;
  s?.close();
  attachControllers();
}

function connect(url: string): void {
  disconnect();
  if (!sim) return;
  setBridge({ status: 'connecting', url, message: undefined, sent: 0, received: 0 });
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    setBridge({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws || !sim) return;
    const s = sim.state;
    send({
      type: 'hello', protocol: PROTOCOL_VERSION,
      game: { id: s.id, name: s.name, mapId: s.mapId, time: s.time, playerNation: s.playerNation, difficulty: s.difficulty },
      nations: externalNations(),
      map: mapSummary(sim.map),
    });
    setBridge({ status: 'open', message: undefined });
    attachControllers();
  };
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    bridge.received++;
    try {
      onModel(JSON.parse(String(e.data)) as FromModel);
    } catch (err) {
      send({ type: 'error', message: 'Ungültige Nachricht: ' + (err instanceof Error ? err.message : String(err)) });
    }
  };
  ws.onerror = () => {
    if (socket === ws) setBridge({ status: 'error', message: 'Verbindung fehlgeschlagen' });
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    attachControllers();
    if (bridge.status !== 'error') setBridge({ status: 'error', message: 'Verbindung getrennt' });
    // erneut versuchen, solange das Spiel offen ist und die Adresse gilt
    reconnect = setTimeout(() => {
      if (sim && sim.state.bridgeUrl === url) connect(url);
    }, RECONNECT_MS);
  };
}

/** Nachricht eines Modells: Aktionen sofort ausführen, Ergebnis zurückmelden. */
function onModel(m: FromModel): void {
  if (!sim) return;
  if (m.type === 'observe') {
    if (sim.state.nations[m.nation]?.controller === 'external') send({ type: 'observe', nation: m.nation, obs: sim.observation(m.nation) });
    return;
  }
  if (m.type !== 'actions') return;
  if (sim.state.nations[m.nation]?.controller !== 'external') {
    send({ type: 'error', message: m.nation + ' wird nicht extern gesteuert' });
    return;
  }
  settle();
  for (const action of m.actions as Action[]) {
    const result = sim.apply(m.nation, action);
    send({ type: 'result', nation: m.nation, ref: m.ref, action, result });
  }
  snapshot();
}

async function loadMap(id: string): Promise<MapData> {
  let m = maps.get(id);
  if (!m) {
    const res = await fetch(new URL(`/maps/${id}.json`, self.location.origin));
    if (!res.ok) throw new Error(`Karte ${id} nicht gefunden`);
    m = (await res.json()) as MapData;
    maps.set(id, m);
  }
  return m;
}

async function save(): Promise<void> {
  if (!sim) return;
  sim.state.lastRealTime = Date.now();
  await saveGame(sim.state, metaOf(sim.state, sim.map));
  lastSave = Date.now();
}

function snapshot(): void {
  if (!sim) return;
  post({ type: 'snapshot', state: sim.state, rates: sim.rates[sim.state.playerNation] });
  if (bridge.status === 'open') post({ type: 'bridge', info: { ...bridge } });
  lastSnapshot = Date.now();
}

/** Holt die Zeit nach, die seit dem letzten Speichern vergangen ist. */
async function catchUp(): Promise<void> {
  const s = sim!.state;
  const startTime = s.time;
  for (;;) {
    const now = Date.now();
    if (s.paused) {
      s.lastRealTime = now;
      return;
    }
    const target = s.time + (now - s.lastRealTime) * s.speed;
    if (target - s.time < MINUTE) {
      s.lastRealTime = now;
      return;
    }
    while (s.time + MINUTE <= target) {
      sim!.advanceTo(Math.min(target, s.time + DAY));
      post({ type: 'catchup', done: s.time - startTime, total: target - startTime });
      await new Promise((r) => setTimeout(r, 0));
    }
    s.lastRealTime = now;
  }
}

function startLoop(): void {
  lastTick = Date.now();
  timer = setInterval(() => {
    if (!sim) return;
    const now = Date.now();
    const s = sim.state;
    if (!s.paused) sim.advance((now - lastTick) * s.speed);
    lastTick = now;
    s.lastRealTime = now;
    if (now - lastSnapshot >= SNAPSHOT_MS) snapshot();
    if (now - lastSave >= SAVE_MS) void save();
  }, TICK_MS);
}

async function open(stateId: string | null, created?: Parameters<typeof createGame>[1] & { mapId: string }): Promise<void> {
  let state;
  if (created) {
    const map = await loadMap(created.mapId);
    state = createGame(map, created);
    await saveGame(state, metaOf(state, map));
  } else {
    state = await loadGame(stateId!);
    if (!state) throw new Error('Spielstand nicht gefunden');
  }
  const map = await loadMap(state.mapId);
  if (state.provinces.length !== map.provinces.length) {
    throw new Error('Dieser Spielstand gehört zu einer älteren Kartenversion und kann nicht mehr geladen werden. Bitte im Hauptmenü löschen.');
  }
  sim = new Simulation(state, map);
  await catchUp();
  await save();
  snapshot();
  startLoop();
  // erst nach der Nachsimulation verbinden: bis dahin entscheidet die eingebaute KI
  if (state.bridgeUrl) connect(state.bridgeUrl);
  else setBridge({ status: 'off', url: '', message: undefined });
}

/** Vor einer Tempo-/Pausenänderung bis jetzt mit den alten Einstellungen rechnen. */
function settle(): void {
  if (!sim) return;
  const now = Date.now();
  if (!sim.state.paused) sim.advance((now - lastTick) * sim.state.speed);
  lastTick = now;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'open':
        await open(m.gameId);
        break;
      case 'create':
        await open(null, {
          ...m.options,
          id: crypto.randomUUID(),
          seed: Math.floor(Math.random() * 2 ** 31),
          now: Date.now(),
        });
        break;
      case 'action': {
        if (!sim) return;
        settle();
        const result = sim.apply(sim.state.playerNation, m.action);
        post({ type: 'actionResult', id: m.id, result });
        snapshot();
        if (result.ok) await save();
        break;
      }
      case 'setSpeed':
        if (!sim) return;
        settle();
        sim.state.speed = m.speed;
        snapshot();
        await save();
        break;
      case 'setPaused':
        if (!sim) return;
        settle();
        sim.state.paused = m.paused;
        snapshot();
        await save();
        break;
      case 'setController': {
        if (!sim) return;
        const n = sim.state.nations[m.nation];
        const allowed: ControllerKind[] = m.nation === sim.state.playerNation ? ['human', 'ai', 'external'] : ['ai', 'external'];
        if (!n || !allowed.includes(m.controller)) return;
        settle();
        n.controller = m.controller;
        attachControllers();
        snapshot();
        await save();
        break;
      }
      case 'setDifficulty':
        if (!sim) return;
        sim.state.difficulty = m.difficulty;
        snapshot();
        await save();
        break;
      case 'bridge':
        if (!sim) return;
        sim.state.bridgeUrl = m.url ?? undefined;
        if (m.url) connect(m.url);
        else {
          disconnect();
          setBridge({ status: 'off', url: '', message: undefined });
        }
        snapshot();
        await save();
        break;
      case 'save':
        await save();
        break;
      case 'close':
        if (timer) clearInterval(timer);
        timer = null;
        await save();
        disconnect();
        sim = null;
        post({ type: 'closed' });
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
