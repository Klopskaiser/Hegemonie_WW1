import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTY, SPEEDS } from '../game/balance.ts';
import type { MapData } from '../game/mapdata.ts';
import type { Difficulty, GameMeta } from '../game/types.ts';
import { SCENARIOS, type Scenario } from '../game/state.ts';
import { deleteGame, listGames } from '../persist/db.ts';
import { Swatch, Window } from './common.tsx';
import { fmtDay, fmtDuration, fmtSpeed } from './format.ts';
import { MapCanvas } from './MapCanvas.tsx';
import { loadMap, MAPS } from './maps.ts';
import type { SessionStart } from './useSession.ts';

export function MainMenu({ onOpen }: { onOpen(start: SessionStart): void }) {
  const [games, setGames] = useState<GameMeta[]>([]);
  const [now, setNow] = useState(Date.now());
  const [mapId, setMapId] = useState('europe');
  const [map, setMap] = useState<MapData | null>(null);
  const [nation, setNation] = useState('DE');
  const [name, setName] = useState('');
  const [speed, setSpeed] = useState(4);
  const [scenario, setScenario] = useState<Scenario>('standard');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    listGames().then(setGames);
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadMap(mapId).then(setMap);
  }, [mapId]);

  const owners = useMemo(() => map?.provinces.map((p) => p.nation) ?? [], [map]);
  const nationInfo = map?.nations.find((n) => n.id === nation);
  const provCount = map?.provinces.filter((p) => p.nation === nation).length ?? 0;

  const start = () => {
    if (!map || !nationInfo) return;
    const count = games.filter((g) => g.mapId === mapId).length + 1;
    onOpen({
      kind: 'create',
      options: { mapId, playerNation: nation, speed, scenario, difficulty, name: name.trim() || `${map.name} – ${nationInfo.name} #${count}` },
    });
  };

  const estTime = (g: GameMeta) => (g.paused ? g.time : g.time + (now - g.lastRealTime) * g.speed);

  return (
    <div className="menu">
      <header className="menu-header">
        <h1>Hegemonie 1914</h1>
        <div className="menu-sub">Echtzeit-Strategie um die Vorherrschaft – nach dem Vorbild von Supremacy 1914</div>
      </header>
      <div className="menu-body">
        <Window title="Neues Spiel" className="menu-new">
          <div className="map-choice">
            {MAPS.map((m) => (
              <button key={m.id} className={'map-card' + (mapId === m.id ? ' active' : '')} disabled={!m.available}
                onClick={() => setMapId(m.id)}>
                <b>{m.name}</b>
                <span className="small">{m.description}</span>
              </button>
            ))}
          </div>
          <div className="new-grid">
            <div className="preview">
              {map && <MapCanvas map={map} owners={owners} highlightNation={nation} compact
                onSelect={(id) => id !== null && setNation(map.provinces[id].nation)} />}
              <div className="muted small">Klicke auf die Karte oder wähle aus der Liste.</div>
            </div>
            <div className="nation-list">
              {map?.nations.map((n) => (
                <button key={n.id} className={'nation-item' + (nation === n.id ? ' active' : '')} onClick={() => setNation(n.id)}>
                  <Swatch color={n.color} />
                  <span>{n.name}</span>
                  <span className="muted small">{n.major ? 'Großmacht' : 'Kleinstaat'}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="form-row">
            <label>
              Spielname
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={map && nationInfo ? `${map.name} – ${nationInfo.name}` : ''} />
            </label>
            <label title={SCENARIOS.find((x) => x.id === scenario)?.description}>
              Szenario
              <select value={scenario} onChange={(e) => setScenario(e.target.value as Scenario)}>
                {SCENARIOS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label title="Wie oft und wie entschlossen die KI-Gegner handeln">
              KI-Stärke
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
                {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => <option key={d} value={d}>{DIFFICULTY[d].name}</option>)}
              </select>
            </label>
            <label>
              Geschwindigkeit
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => <option key={s} value={s}>{fmtSpeed(s)}</option>)}
              </select>
            </label>
          </div>
          <div className="form-row end">
            <span className="muted small">{nationInfo ? `${nationInfo.name}: ${provCount} Provinzen` : ''}</span>
            <button className="btn primary" disabled={!map || !nationInfo} onClick={start}>Spiel starten</button>
          </div>
        </Window>

        <Window title={`Laufende Spiele (${games.length})`} className="menu-games">
          {games.length === 0 && <p className="muted">Noch keine Spiele. Alle Spiele laufen weiter, auch wenn sie nicht geöffnet sind – beim Öffnen wird die verstrichene Zeit nachsimuliert.</p>}
          <ul className="game-list">
            {games.map((g) => {
              const behind = g.paused ? 0 : now - g.lastRealTime;
              return (
                <li key={g.id} className="game-item">
                  <div className="game-info">
                    <b>{g.name}</b>
                    <span className="small">{g.mapName} · {g.nationName}</span>
                    <span className="small muted">
                      {fmtDay(estTime(g))} · {g.speed}× · {g.paused ? 'pausiert' : `läuft (zuletzt geöffnet vor ${fmtDuration(behind)})`}
                    </span>
                  </div>
                  <div className="game-actions">
                    {confirmDelete === g.id ? (
                      <>
                        <span className="small">Wirklich löschen?</span>
                        <button className="btn small danger" onClick={async () => {
                          await deleteGame(g.id);
                          setConfirmDelete(null);
                          setGames(await listGames());
                        }}>Ja</button>
                        <button className="btn small" onClick={() => setConfirmDelete(null)}>Nein</button>
                      </>
                    ) : (
                      <>
                        <button className="btn primary" onClick={() => onOpen({ kind: 'open', gameId: g.id })}>Fortsetzen</button>
                        <button className="btn small" onClick={() => setConfirmDelete(g.id)} title="Spiel löschen">✕</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Window>
      </div>
    </div>
  );
}
