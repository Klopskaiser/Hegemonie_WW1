import { useEffect, useMemo, useState, useRef } from 'react';
import { ALL_RES, DAY, HOUR, RES_NAMES, SPEEDS } from '../game/balance.ts';
import { atWar } from '../game/diplomacy.ts';
import { nodeName } from '../game/graph.ts';
import { armyLocation, engagedTarget, isRangedOnly, planRoute, routePoints, type MoveTarget } from '../game/military.ts';
import type { Action } from '../game/actions.ts';
import { MultiArmyPanel } from './MultiArmyPanel.tsx';
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
import { Flag } from './Flag.tsx';

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
  const [selectedArmies, setSelectedArmies] = useState<number[]>([]);
  const [hoverTarget, setHoverTarget] = useState<MoveTarget | null>(null);
  /** nach dem Teilen auszuwählende Armee (sobald sie im Spielstand auftaucht) */
  const [pendingSelect, setPendingSelect] = useState<number | null>(null);
  const prevSelection = useRef<number[]>([]);
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
  const chosen = useMemo(() => armies.filter((a) => selectedArmies.includes(a.id)), [armies, selectedArmies]);
  const own = useMemo(() => (state ? chosen.filter((a) => a.owner === state.playerNation) : []), [chosen, state]);
  const army = chosen.length === 1 ? chosen[0] : null;

  // Marschvorschau für die ausgewählten eigenen Armeen zum Ziel unter dem Mauszeiger
  const previews = useMemo(() => {
    if (!own.length || !hoverTarget || !state || !map) return [];
    const dest = 'node' in hoverTarget ? nodeName(map, hoverTarget.node)
      : `Weg ${nodeName(map, hoverTarget.road.a)} – ${nodeName(map, hoverTarget.road.b)}`;
    let longest = 0;
    const out = own.slice(0, 12).map((a) => {
      const r = planRoute(state, map, a, state.time, hoverTarget);
      if (!r) return { pts: [] as [number, number][], label: '' };
      longest = Math.max(longest, r.hours);
      const pts = routePoints(map, r.path, r.startFrac ?? 0, r.endFrac ?? 1);
      if (r.then) pts.push(...routePoints(map, r.then).slice(1));
      return { pts, label: '', landing: !!r.then };
    });
    const first = out.find((x) => x.pts.length > 1);
    if (!first) return [{ pts: [], label: `${dest}: kein Weg` }];
    const eta = state.paused ? `${Math.round(longest)} h Spielzeit` : fmtDuration((longest * HOUR) / state.speed);
    first.label = `${'landing' in first && first.landing ? 'Landung: ' : ''}${dest} · ${eta}${own.length > 1 ? ` (${own.length} Armeen)` : ''}`;
    return out;
  }, [own, hoverTarget, state, map]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedArmies([]);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (pendingSelect === null || !state?.armies.some((a) => a.id === pendingSelect)) return;
    setSelectedArmies([pendingSelect]);
    setPendingSelect(null);
  }, [state, pendingSelect]);

  // abgetrennte Armeen, die ohne Befehl abgewählt werden, gliedern sich wieder ein
  useEffect(() => {
    const prev = prevSelection.current;
    prevSelection.current = selectedArmies;
    if (!state) return;
    for (const id of prev) {
      if (selectedArmies.includes(id)) continue;
      const a = state.armies.find((x) => x.id === id);
      if (a && a.owner === state.playerNation && a.split && !a.move) void session.act({ type: 'rejoin', army: id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArmies]);

  useEffect(() => {
    if (!state || !selectedArmies.length) return;
    const alive = selectedArmies.filter((id) => state.armies.some((a) => a.id === id));
    if (alive.length !== selectedArmies.length) setSelectedArmies(alive);
  }, [state, selectedArmies]);

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
    setSelectedArmies([]);
    setSelected(id);
    setFocus((f) => ({ province: id, seq: (f?.seq ?? 0) + 1 }));
  };
  const selectArmy = (id: number) => {
    setSelectedArmies([id]);
    setSelected(null);
  };
  /** Linksklick auf einen Nadelkopf: auswählen (mit Umschalt hinzufügen/entfernen) */
  const onArmy = (id: number, add: boolean) => {
    setSelected(null);
    setSelectedArmies((cur) => (add ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));
  };
  /** Lasso: eigene Armeen im Lasso auswählen (mit Umschalt zur Auswahl hinzufügen) */
  const onLasso = (ids: number[], add: boolean) => {
    if (!ids.length && add) return;
    setSelected(null);
    setSelectedArmies((cur) => (add ? [...new Set([...cur, ...ids])] : ids));
  };
  /** Linksklick auf die Karte: Provinz auswählen, Armeeauswahl aufheben */
  const onNode = (node: number | null) => {
    setSelectedArmies([]);
    setSelected(node !== null && node < map.provinces.length ? node : null);
  };
  const moveAction = (id: number, t: MoveTarget): Action => ('node' in t
    ? { type: 'move', army: id, to: t.node }
    : { type: 'move', army: id, to: t.road.a, toward: t.road.b, frac: t.road.f });
  /** Rechtsklick: alle ausgewählten eigenen Armeen marschieren dorthin bzw. greifen an */
  const onTarget = async (t: MoveTarget | { army: number }) => {
    if (!own.length) return;
    const errors: string[] = [];
    for (const a of own) {
      let action: Action;
      if ('army' in t) {
        const other = armies.find((b) => b.id === t.army);
        if (!other || other.id === a.id) continue;
        // reine Fernkampfverbände beschießen Feinde, alle anderen marschieren zum Ziel
        action = isRangedOnly(a) && atWar(state, state.playerNation, other.owner)
          ? { type: 'attack', army: a.id, target: other.id }
          : moveAction(a.id, armyLocation(other, state.time));
      } else action = moveAction(a.id, t);
      const r = await session.act(action);
      if (!r.ok) errors.push(r.error);
    }
    setNotice(errors.length ? (own.length > 1 ? `${errors.length} von ${own.length} Armeen: ${errors[0]}` : errors[0]) : null);
  };
  const panelProps = { map, state, rates, onSelect: jump, onClose: () => setPanel(null) };

  return (
    <div className="game">
      <header className="topbar">
        <div className="tb-brand" title={state.name}>
          <span className="tb-flag"><Flag nation={nation.id} height={26} title={nation.name} /></span>
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

        <main className={'map-area' + (own.length ? ' targeting' : '')}>
          <MapCanvas map={map} owners={owners} morale={morale} armies={armies} time={state.time} nation={state.playerNation}
            visible={visible} provinces={state.provinces} selected={selected} selectedArmies={selectedArmies} battles={battles}
            previews={previews} shots={shots} mode={mode} focus={focus} onNode={onNode} onArmy={onArmy}
            onHoverTarget={setHoverTarget} onTarget={onTarget} onLasso={onLasso} />
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
          <ArmyPanel map={map} state={state} army={army} armies={armies} act={session.act} onSelectArmy={selectArmy} onSplit={setPendingSelect}
            onClose={() => setSelectedArmies([])} />
        ) : chosen.length > 1 ? (
          <MultiArmyPanel map={map} state={state} armies={chosen} act={session.act} onSelectArmy={selectArmy}
            onClose={() => setSelectedArmies([])} />
        ) : selected !== null && (
          <ProvincePanel map={map} state={state} id={selected} armies={armies} act={session.act} onSelectArmy={selectArmy}
            onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
