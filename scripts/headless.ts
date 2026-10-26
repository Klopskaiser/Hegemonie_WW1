// Headless-Runner: Partien ohne Browser.
//
//   npx tsx scripts/headless.ts batch [--games 4] [--days 60] [--seed 1] [--difficulty normal]
//                                     [--record runs.jsonl] [--obs] [--map europe]
//     Reine KI-Partien hintereinander, Zusammenfassung je Partie; mit --record werden alle
//     KI-Entscheidungen als JSON-Zeilen aufgezeichnet (--obs: mit Beobachtung, sehr groß).
//
//   npx tsx scripts/headless.ts stdio --agents DE,FR [--seed 1] [--step-hours 6] [--max-days 120]
//     JSON-Zeilen über stdin/stdout für externe Modelle (z. B. Python), siehe docs/EXTERNAL_MODELS.md.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DIFFICULTY } from '../src/game/balance.ts';
import { mapSummary } from '../src/game/bridgeProtocol.ts';
import type { MapData } from '../src/game/mapdata.ts';
import type { Difficulty } from '../src/game/types.ts';
import { HeadlessEnv, RecordingController } from '../src/headless/env.ts';

const [mode, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (!k.startsWith('--')) continue;
  const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
  args.set(k.slice(2), v);
}
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const difficulty = (args.get('difficulty') ?? 'normal') as Difficulty;
if (!(difficulty in DIFFICULTY)) fail(`Unbekannte KI-Stärke: ${difficulty} (easy, normal, hard)`);
const mapId = args.get('map') ?? 'europe';
const mapFile = path.join(import.meta.dirname, '..', 'public', 'maps', `${mapId}.json`);
if (!fs.existsSync(mapFile)) fail(`Karte nicht gefunden: ${mapFile}`);
const map: MapData = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

function fail(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

if (mode === 'batch') batch();
else if (mode === 'stdio') stdio();
else fail('Aufruf: npx tsx scripts/headless.ts batch|stdio [Optionen] (Details im Dateikopf)');

function batch(): void {
  const games = num('games', 1), days = num('days', 60), seed0 = num('seed', 1);
  const recordFile = args.get('record');
  const out = recordFile ? fs.createWriteStream(recordFile) : null;
  const withObs = args.get('obs') === 'true';
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  for (let g = 0; g < games; g++) {
    const seed = seed0 + g;
    const env = new HeadlessEnv(map, { seed, difficulty, maxDays: days, stepHours: 24 });
    const t0 = performance.now();
    env.reset(seed, out ? (nation, ctrl) => new RecordingController(ctrl, (rec) => out.write(JSON.stringify({ game: g, seed, ...rec }) + '\n'), withObs) : undefined);
    let r;
    do r = env.step(); while (!r.done);
    const ranking = Object.entries(r.info.score).sort((a, b) => b[1] - a[1]);
    const ms = Math.round(performance.now() - t0);
    console.log(`Partie ${g + 1} (Seed ${seed}): ${r.info.day - 1} Tage in ${ms} ms`
      + (r.info.winner ? `, Sieger ${name(r.info.winner)}` : ', kein Sieger'));
    console.log('  ' + ranking.slice(0, 6).map(([n, p]) => `${n} ${Math.round(p)} (${r.info.provinces[n] ?? 0} Prov.)`).join(' · '));
    out?.write(JSON.stringify({ game: g, seed, final: { day: r.info.day, winner: r.info.winner, score: r.info.score, provinces: r.info.provinces } }) + '\n');
  }
  out?.end();
}

/**
 * Protokoll (eine JSON-Zeile je Nachricht):
 *   -> {"type":"ready","agents":[..],"map":{..}}
 *   <- {"cmd":"reset","seed":7}            -> {"type":"reset","obs":{..}}
 *   <- {"cmd":"step","actions":{"DE":[..]}} -> {"type":"step","obs":{..},"reward":{..},"done":false,"info":{..}}
 *   <- {"cmd":"close"}
 * Fehler: {"type":"error","message":".."}
 */
function stdio(): void {
  const agents = (args.get('agents') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!agents.length) fail('--agents fehlt (z. B. --agents DE,FR)');
  let env: HeadlessEnv;
  try {
    env = new HeadlessEnv(map, { agents, seed: num('seed', 1), difficulty, stepHours: num('step-hours', 6), maxDays: num('max-days', 120) });
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e));
  }
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
  let started = false;
  send({ type: 'ready', agents, stepHours: env.stepHours, maxDays: env.maxDays, map: mapSummary(map) });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const m = JSON.parse(line);
      switch (m.cmd) {
        case 'reset':
          send({ type: 'reset', obs: env.reset(m.seed ?? num('seed', 1)) });
          started = true;
          break;
        case 'step':
          if (!started) throw new Error('zuerst reset senden');
          send({ type: 'step', ...env.step(m.actions ?? {}) });
          break;
        case 'close':
          rl.close();
          break;
        default:
          throw new Error(`unbekannter Befehl: ${m.cmd}`);
      }
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  });
}
