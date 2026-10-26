// Beispiel für ein externes Entscheidungsmodell: WebSocket-Server, mit dem sich das Spiel
// (Steuerung → Verbinden) verbindet. Absichtlich einfache Regeln – als Vorlage für eigene Modelle.
//
//   npx tsx scripts/example-model.ts [--port 8765]
//
// Protokoll: docs/EXTERNAL_MODELS.md

import { WebSocketServer, type WebSocket } from 'ws';
import type { Action } from '../src/game/actions.ts';
import type { FromModel, MapSummary, ToModel } from '../src/game/bridgeProtocol.ts';
import type { Observation } from '../src/game/controller.ts';

const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8765;

const wss = new WebSocketServer({ host: '127.0.0.1', port });
console.log(`Beispielmodell wartet auf ws://127.0.0.1:${port}`);

wss.on('connection', (ws: WebSocket) => {
  let map: MapSummary | null = null;
  let errors = 0;
  const send = (m: FromModel) => ws.send(JSON.stringify(m));
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as ToModel;
    switch (m.type) {
      case 'hello':
        map = m.map;
        console.log(`Verbunden mit „${m.game.name}" (Protokoll ${m.protocol}), steuere: ${m.nations.join(', ') || '–'}`);
        break;
      case 'controllers':
        console.log(`Steuere jetzt: ${m.nations.join(', ') || '–'}`);
        break;
      case 'observe': {
        if (!map) return;
        const actions = decide(map, m.obs);
        if (actions.length) send({ type: 'actions', nation: m.nation, actions, ref: m.obs.time });
        const t = m.obs.time / 3_600_000;
        console.log(`Tag ${Math.floor(t / 24) + 1}, ${t % 24} Uhr – ${m.nation}: ${actions.length ? actions.map((a) => a.type).join(', ') : 'keine Aktion'}`);
        break;
      }
      case 'result':
        if (!m.result.ok && ++errors <= 20) console.log(`${m.nation}: ${m.action.type} abgelehnt – ${m.result.error}`);
        break;
      case 'error':
        console.log('Fehler vom Spiel:', m.message);
        break;
    }
  });
  ws.on('close', () => console.log('Verbindung beendet'));
});

/** Einfache Regeln: Wehrämter erhalten, Fabrik in der Hauptstadt, Frieden annehmen, Nachbarprovinzen angreifen. */
function decide(map: MapSummary, obs: Observation): Action[] {
  const me = obs.nation;
  const actions: Action[] = [];
  const own = obs.provinces.filter((p) => p.owner === me);

  // Frieden annehmen, andere Angebote ablehnen
  for (const p of obs.proposals) actions.push({ type: 'answer', nation: p.from, accept: p.kind === 'peace' });

  // Bauen: zerstörte Wehrämter zuerst, dann eine Fabrik in der Hauptstadt
  const idle = own.filter((p) => !p.constructing);
  const noOffice = idle.find((p) => p.buildings?.recruitment === 0);
  const capital = map.nations.find((n) => n.id === me)?.capital;
  const cap = idle.find((p) => p.id === capital);
  if (noOffice && obs.stock.money > 3000) actions.push({ type: 'build', province: noOffice.id, building: 'recruitment' });
  else if (cap && (cap.buildings?.factory ?? 0) === 0 && obs.stock.money > 8000) actions.push({ type: 'build', province: cap.id, building: 'factory' });
  else {
    // sonst Eisenbahnen, solange Geld und Kohle reichen
    const noRail = idle.find((p) => (p.buildings?.railroad ?? 0) === 0);
    if (noRail && obs.stock.money > 6000 && (obs.ratesPerDay.coal ?? 0) > 300) actions.push({ type: 'build', province: noRail.id, building: 'railroad' });
  }

  // Truppen: im Krieg aus Provinzen mit mehr als 6 Einheiten in eine feindliche Nachbarprovinz ohne sichtbare Truppen
  if (!obs.enemies.length) return actions;
  const enemyAt = new Set(obs.armies.filter((a) => obs.enemies.includes(a.owner)).map((a) => a.node));
  const claimed = new Set<number>();
  for (const a of obs.armies) {
    if (a.owner !== me || a.moving || a.node >= map.provinceCount || a.target != null) continue;
    const count = Object.values(a.units).reduce((s, n) => s + n, 0);
    if (count <= 6) continue;
    const target = map.provinces[a.node].neighbors.find((n) => obs.enemies.includes(obs.provinces[n].owner) && !enemyAt.has(n) && !claimed.has(n));
    if (target === undefined) continue;
    claimed.add(target);
    // 3 Infanteristen bleiben als Besatzung zurück
    if ((a.units.infantry ?? 0) >= 3) actions.push({ type: 'split', army: a.id, units: { infantry: 3 } });
    actions.push({ type: 'move', army: a.id, to: target });
  }
  return actions;
}
