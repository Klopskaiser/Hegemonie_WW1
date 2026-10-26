import { useState } from 'react';
import { DIFFICULTY } from '../game/balance.ts';
import type { MapData } from '../game/mapdata.ts';
import type { ControllerKind, Difficulty, GameState } from '../game/types.ts';
import type { BridgeInfo } from '../worker/protocol.ts';
import { Window } from './common.tsx';
import { Flag } from './Flag.tsx';

const DEFAULT_URL = 'ws://127.0.0.1:8765';

const KIND_NAMES: Record<ControllerKind, string> = { human: 'Spieler', ai: 'KI', external: 'Extern' };

const STATUS_NAMES: Record<BridgeInfo['status'], string> = {
  off: 'nicht verbunden',
  connecting: 'verbinde …',
  open: 'verbunden',
  error: 'Fehler',
};

/** Steuerung: wer entscheidet für welche Nation, KI-Stärke und Verbindung zu externen Modellen. */
export function ControlPanel({ map, state, bridge, setController, setDifficulty, setBridge, onClose }: {
  map: MapData;
  state: GameState;
  bridge: BridgeInfo;
  setController(nation: string, controller: ControllerKind): void;
  setDifficulty(d: Difficulty): void;
  setBridge(url: string | null): void;
  onClose(): void;
}) {
  const [url, setUrl] = useState(state.bridgeUrl || bridge.url || DEFAULT_URL);
  const connected = bridge.status === 'open';
  const external = map.nations.filter((n) => state.nations[n.id].controller === 'external');
  const profile = (id: string) => state.aiProfiles[id];
  return (
    <Window title="Steuerung" onClose={onClose} className="side-panel">
      <div className="form-row">
        <label title="Wie oft und wie entschlossen die eingebaute KI handelt">
          KI-Stärke
          <select value={state.difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
            {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => <option key={d} value={d}>{DIFFICULTY[d].name}</option>)}
          </select>
        </label>
      </div>

      <h4>Externe Entscheidungsmodelle</h4>
      <div className="bridge-row">
        <input className="bridge-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={DEFAULT_URL} spellCheck={false} />
        {state.bridgeUrl
          ? <button className="btn small" onClick={() => setBridge(null)}>Trennen</button>
          : <button className="btn small primary" disabled={!/^wss?:\/\//.test(url)} onClick={() => setBridge(url.trim())}>Verbinden</button>}
      </div>
      <div className={'bridge-status ' + bridge.status}>
        <span className="dot" /> {STATUS_NAMES[bridge.status]}
        {bridge.message ? ` – ${bridge.message}` : ''}
        {connected && <span className="muted"> · gesendet {bridge.sent}, empfangen {bridge.received}</span>}
      </div>
      {external.length > 0 && !connected && (
        <p className="muted small">Ohne Verbindung übernimmt die eingebaute KI die extern gesteuerten Nationen.</p>
      )}

      <table className="table">
        <thead><tr><th>Nation</th><th>Steuerung</th><th title="Kriegslust / Vorsicht der eingebauten KI">Profil</th></tr></thead>
        <tbody>
          {map.nations.map((n) => {
            const ns = state.nations[n.id];
            const me = n.id === state.playerNation;
            const kinds: ControllerKind[] = me ? ['human', 'ai', 'external'] : ['ai', 'external'];
            const p = profile(n.id);
            return (
              <tr key={n.id} className={me ? 'me' : ''}>
                <td><Flag nation={n.id} /> {n.name}{ns.alive ? '' : ' (vernichtet)'}</td>
                <td>
                  <select value={ns.controller} disabled={!ns.alive} onChange={(e) => setController(n.id, e.target.value as ControllerKind)}>
                    {kinds.map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
                  </select>
                  {ns.controller === 'external' && !connected && <span className="muted small"> (KI)</span>}
                </td>
                <td className="small">{p ? `${p.aggression.toFixed(2)} / ${p.caution.toFixed(2)}` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">
        Extern gesteuerte Nationen erhalten jede Spielstunde eine Beobachtung über die Verbindung und schicken
        Aktionen zurück. Während der Nachsimulation entscheidet immer die eingebaute KI. Protokoll: docs/EXTERNAL_MODELS.md.
      </p>
    </Window>
  );
}
