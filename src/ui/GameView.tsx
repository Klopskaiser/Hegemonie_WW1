import { useEffect, useMemo, useState } from 'react';
import { ALL_RES, DAY, HOUR, RES_NAMES, SPEEDS } from '../game/balance.ts';
import { atWar } from '../game/diplomacy.ts';
import { nodeName } from '../game/graph.ts';
import { engagedTarget, isRangedOnly, nearestNode, planMove } from '../game/military.ts';
import { UNITS, type UnitType } from '../game/balance.ts';
import type { Army } from '../game/types.ts';
import { armyVisible, visibleNodes } from '../game/visibility.ts';
import { ArmyPanel } from './ArmyPanel.tsx';
import { Bar } from './common.tsx';
import { fmtDay, fmtDuration, fmtGameTime, fmtNum, fmtSigned, fmtSpeed } from './format.ts';
import { ResIcon } from './icons.tsx';
import { MapCanvas, type MapMode, type Shot } from './MapCanvas.tsx';
import { ProvincePanel } from './ProvincePanel.tsx';
import { ControlPanel } from './ControlPanel.tsx';
import { DiplomacyPanel } from './DiplomacyPanel.tsx';
import { GameOver } from './GameOver.tsx';
import { MarketPanel } from './MarketPanel.tsx';
import { NewspaperPanel } from './NewspaperPanel.tsx';
import { EconomyPanel, EventsPanel, netPerDay, ProvincesPanel, RankingPanel, type SidePanel } from './SidePanels.tsx';
import { useSession, type SessionStart } from './useSession.ts';

const MENU: { id: SidePanel; label: string; glyph: string; soon?: boolean }[] = [
  { id: 'provinces', label: 'Provinzen', glyph: '♜' },
  { id: 'economy', label: 'Wirtschaft', glyph: '⚒' },
  { id: 'ranking', label: 'Rangliste', glyph: '♛' },
  { id: 'events', label: 'Ereignisse', glyph: '✎' },
  { id: 'diplomacy', label: 'Diplomatie', glyph: '✉' },
  { id: 'newspaper', label: 'Zeitung', glyph: '☰' },
  { id: 'market', label: 'Börse', glyph: '⚖' },
  { id: 'control', label: 'Steuerung (KI und externe Modelle)', glyph: '⚙' },
];

export function GameView({ start, onExit }: { start: SessionStart; onExit(): void }) {
  const session = useSession(start);
  const { state, map, rates } = session;
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedArmy, setSelectedArmy] = useState<number | null>(null);
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const [panel, setPanel] = useState<SidePanel | null>(null);
  const [mode, setMode] = useState<MapMode>('political');
  const [focus, setFocus] = useState<{ province: number; seq: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [endSeen, setEndSeen] = useState(false);

  const owners = useMemo(() => state?.provinces.map((p) => p.owner) ?? [], [state]);
  const morale = useMemo(() => state?.provinces.map((p) => p.morale) ?? [], [state]);
  const visible = useMemo(() => (state && map ? visibleNodes(state, map, state.playerNation) : null), [state, map]);
  const armies = useMemo<Army[]>(
    () => (state && map && visible ? state.armies.filter((a) => armyVisible(state, map, state.playerNation, a, visible)) : []),
    [state, map, visible],
  );
  const battles = useMemo(() => {
    if (!state) return [];
    const out = new Set<number>();
    for (const a of armies) {
      if (a.move) continue;
      if (armies.some((b) => b !== a && !b.move && b.node === a.node && atWar(state, a.owner, b.owner))) out.add(a.node);
    }
    return [...out];
  }, [armies, state]);
  // laufende Fernkampfgefechte (für die Geschossanimation)
  const shots = useMemo<Shot[]>(() => {
    if (!state || !map) return [];
    const out: Shot[] = [];
    for (const a of armies) {
      const t = engagedTarget(state, map, a);
      if (!t || !armies.includes(t)) continue;
      for (const u of Object.keys(a.units) as UnitType[]) {
        if ((a.units[u] ?? 0) > 0 && UNITS[u].range > 0) {
          out.push({ key: `${a.id}-${t.id}-${u}`, kind: u, shooter: a.id, target: t.id });
        }
      }
    }
    return out;
  }, [armies, state, map]);
  const army = armies.find((a) => a.id === selectedArmy) ?? null;
  const ownArmy = army && state && army.owner === state.playerNation ? army : null;

  const preview = useMemo(() => {
    if (!ownArmy || hoverNode === null || !state || !map) return null;
    const from = nearestNode(map, ownArmy, state.time);
    if (from === hoverNode) return null;
    const r = planMove(state, map, ownArmy, from, hoverNode);
    if (!r) return { path: [from, hoverNode], label: `${nodeName(map, hoverNode)}: kein Weg` };
    const eta = state.paused ? `${Math.round(r.hours)} h Spielzeit` : fmtDuration((r.hours * HOUR) / state.speed);
    // Landung: Fahrt der Flotte, danach Weg der Truppen
    const path = r.then ? [...r.path, ...r.then.slice(1)] : r.path;
    return { path, label: `${r.then ? 'Landung: ' : ''}${nodeName(map, hoverNode)} · ${eta}` };
  }, [ownArmy, hoverNode, state, map]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedArmy(null);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (selectedArmy !== null && state && !state.armies.some((a) => a.id === selectedArmy)) setSelectedArmy(null);
  }, [state, selectedArmy]);

  const exit = async () => {
    setLeaving(true);
    await session.close();
    onExit();
  };

  if (session.error) {
    return (
      <div className="fullscreen-msg">
        <div className="window"><div className="window-body">
          <p>Fehler: {session.error}</p>
          <button className="btn" onClick={onExit}>Zurück zum Hauptmenü</button>
        </div></div>
      </div>
    );
  }

  if (!state || !map || !rates) {
    const c = session.catchup;
    return (
      <div className="fullscreen-msg">
        <div className="window catchup">
          <header className="window-title"><span>Die Welt hat sich weitergedreht …</span></header>
          <div className="window-body">
            {c ? (
              <>
                <p>Die Zeit seit deinem letzten Besuch wird nachgespielt: {fmtNum(c.done / DAY)} von {fmtNum(Math.max(1, c.total / DAY))} Spieltagen.</p>
                <Bar value={c.total > 0 ? c.done / c.total : 1} />
              </>
            ) : (
              <p>Spiel wird geladen …</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const nation = map.nations.find((n) => n.id === state.playerNation)!;
  const stock = state.nations[state.playerNation].stock;
  const incoming = state.proposals.filter((p) => p.to === state.playerNation).length;
  const jump = (id: number) => {
    setSelectedArmy(null);
    setSelected(id);
    setFocus((f) => ({ province: id, seq: (f?.seq ?? 0) + 1 }));
  };
  const selectArmy = (id: number) => {
    setSelectedArmy(id);
    setSelected(null);
  };
  /** Klick auf ein Armeesymbol: mit eigener Armee in der Hand ist eine fremde Armee ein Angriffsziel. */
  const onArmy = async (id: number) => {
    const other = armies.find((a) => a.id === id);
    if (ownArmy && other && other.owner !== state.playerNation) {
      // reine Fernkampfverbände beschießen, alle anderen marschieren zum Gegner
      const ranged = isRangedOnly(ownArmy) && atWar(state, state.playerNation, other.owner);
      const r = ranged
        ? await session.act({ type: 'attack', army: ownArmy.id, target: other.id })
        : await session.act({ type: 'move', army: ownArmy.id, to: nearestNode(map, other, state.time) });
      setNotice(r.ok ? null : r.error);
      return;
    }
    selectArmy(id);
  };
  const onNode = async (node: number | null) => {
    if (ownArmy) {
      if (node === null) return;
      const r = await session.act({ type: 'move', army: ownArmy.id, to: node });
      setNotice(r.ok ? null : r.error);
      return;
    }
    setSelectedArmy(null);
    setSelected(node !== null && node < map.provinces.length ? node : null);
  };
  const panelProps = { map, state, rates, onSelect: jump, onClose: () => setPanel(null) };

  return (
    <div className="game">
      <header className="topbar">
        <div className="tb-brand" title={state.name}>
          <span className="tb-flag" style={{ background: nation.color }} />
          <div>
            <div className="tb-nation">{nation.name}</div>
            <div className="tb-game">{state.name}</div>
          </div>
        </div>
        <div className="tb-res">
          {ALL_RES.map((r) => {
            const net = netPerDay(rates, r);
            return (
              <div key={r} className="tb-res-item" title={`${RES_NAMES[r]}: ${fmtNum(stock[r])}\nBilanz ${fmtSigned(net)} pro Tag`}>
                <ResIcon res={r} size={20} />
                <div>
                  <div className="tb-res-val">{fmtNum(stock[r])}</div>
                  <div className={'tb-res-net ' + (net < 0 ? 'neg' : 'pos')}>{fmtSigned(net)}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="tb-time">
          <div className="tb-date">{fmtGameTime(state.time)}</div>
          <div className="tb-controls">
            <button className={'btn small' + (state.paused ? ' active' : '')} disabled={!!state.winner} onClick={() => session.setPaused(!state.paused)}
              title={state.paused ? 'Fortsetzen' : 'Pausieren'}>
              {state.paused ? '▶ Weiter' : '❚❚ Pause'}
            </button>
            <select value={state.speed} onChange={(e) => session.setSpeed(Number(e.target.value))} title="Spielgeschwindigkeit">
              {SPEEDS.map((s) => <option key={s} value={s}>{fmtSpeed(s)}</option>)}
            </select>
          </div>
        </div>
        <button className="btn tb-exit" onClick={exit} disabled={leaving}>Hauptmenü</button>
      </header>

      <div className="game-body">
        <nav className="leftmenu">
          {MENU.map((m) => (
            <button key={m.id} className={'round-btn' + (panel === m.id ? ' active' : '')} disabled={m.soon} title={m.label}
              onClick={() => setPanel(panel === m.id ? null : (m.id as SidePanel))}>
              <span>{m.glyph}</span>
              {m.id === 'diplomacy' && incoming > 0 && <span className="badge">{incoming}</span>}
            </button>
          ))}
          <div className="leftmenu-sep" />
          {(['political', 'resources', 'morale'] as MapMode[]).map((mm) => (
            <button key={mm} className={'round-btn small' + (mode === mm ? ' active' : '')} onClick={() => setMode(mm)}
              title={mm === 'political' ? 'Politische Karte' : mm === 'resources' ? 'Rohstoffkarte' : 'Moralkarte'}>
              <span>{mm === 'political' ? 'P' : mm === 'resources' ? 'R' : 'M'}</span>
            </button>
          ))}
        </nav>

        <main className={'map-area' + (ownArmy ? ' targeting' : '')}>
          <MapCanvas map={map} owners={owners} morale={morale} armies={armies} time={state.time} nation={state.playerNation}
            visible={visible} provinces={state.provinces} selected={selected} selectedArmy={selectedArmy} battles={battles} preview={preview} shots={shots}
            mode={mode} focus={focus} onNode={onNode} onArmy={onArmy} onHoverNode={setHoverNode}
            onContext={() => setSelectedArmy(null)} />
          {state.paused && <div className="paused-badge">{state.winner ? 'Spielende' : 'Pausiert – die Welt steht still'}</div>}
          {notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>}
          <div className="map-footer">{map.name} · {fmtDay(state.time)} · Tempo {state.speed}×</div>
        </main>

        {panel === 'economy' && <EconomyPanel {...panelProps} act={session.act} />}
        {panel === 'ranking' && <RankingPanel {...panelProps} />}
        {panel === 'events' && <EventsPanel {...panelProps} />}
        {panel === 'provinces' && <ProvincesPanel {...panelProps} />}
        {panel === 'diplomacy' && <DiplomacyPanel map={map} state={state} act={session.act} onClose={() => setPanel(null)} />}
        {panel === 'market' && <MarketPanel map={map} state={state} rates={rates} act={session.act} onClose={() => setPanel(null)} />}
        {panel === 'newspaper' && <NewspaperPanel map={map} state={state} onClose={() => setPanel(null)} />}
        {panel === 'control' && (
          <ControlPanel map={map} state={state} bridge={session.bridge} setController={session.setController}
            setDifficulty={session.setDifficulty} setBridge={session.setBridge} onClose={() => setPanel(null)} />
        )}
        {state.winner && !endSeen && <GameOver map={map} state={state} onMenu={exit} onClose={() => setEndSeen(true)} />}

        {army ? (
          <ArmyPanel map={map} state={state} army={army} armies={armies} act={session.act} onSelectArmy={selectArmy}
            onClose={() => setSelectedArmy(null)} />
        ) : selected !== null && (
          <ProvincePanel map={map} state={state} id={selected} armies={armies} act={session.act} onSelectArmy={selectArmy}
            onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
