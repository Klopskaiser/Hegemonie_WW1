import { useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { relation, RELATION_NAMES, relationLabel, warKey } from '../game/diplomacy.ts';
import type { MapData } from '../game/mapdata.ts';
import type { GameState, Relation } from '../game/types.ts';
import { Window } from './common.tsx';
import { fmtDay } from './format.ts';
import { Flag } from './Flag.tsx';

interface Option {
  id: string;
  label: string;
  action: Action;
  /** Rückfrage nötig (Krieg, Embargo) */
  confirm?: boolean;
}

/** Mögliche Schritte je nach Beziehung: verschlechtern geht sofort, verbessern per Angebot. */
function options(state: GameState, me: string, other: string): Option[] {
  const r = relation(state, me, other);
  const offered = (kind: Relation) => state.proposals.some((p) => p.from === me && p.to === other && p.kind === kind);
  const out: Option[] = [];
  const propose = (kind: Relation, label: string) => {
    if (!offered(kind)) out.push({ id: 'p-' + kind, label, action: { type: 'propose', nation: other, kind } });
  };
  if (r === 'war' || r === 'embargo') propose('peace', 'Frieden anbieten');
  if (r === 'peace') propose('rightOfWay', 'Durchmarschrecht anbieten');
  if (r === 'peace' || r === 'rightOfWay') propose('sharedMap', 'Geteilte Karte anbieten');
  if (r === 'sharedMap') out.push({ id: 'd-row', label: 'Karte nicht mehr teilen', action: { type: 'downgrade', nation: other, to: 'rightOfWay' } });
  if (r === 'rightOfWay' || r === 'sharedMap') out.push({ id: 'd-peace', label: 'Durchmarschrecht entziehen', action: { type: 'downgrade', nation: other, to: 'peace' } });
  if (r === 'peace' || r === 'rightOfWay' || r === 'sharedMap') {
    out.push({ id: 'd-emb', label: 'Handelsembargo verhängen', action: { type: 'downgrade', nation: other, to: 'embargo' }, confirm: true });
  }
  if (r !== 'war') out.push({ id: 'war', label: 'Krieg erklären', action: { type: 'declareWar', nation: other }, confirm: true });
  return out;
}

export function DiplomacyPanel({ map, state, act, onClose }: {
  map: MapData;
  state: GameState;
  act(a: Action): Promise<ActionResult>;
  onClose(): void;
}) {
  const me = state.playerNation;
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (a: Action) => {
    const r = await act(a);
    setMsg(r.ok ? null : r.error);
    setConfirm(null);
  };
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  const incoming = state.proposals.filter((p) => p.to === me);
  const outgoing = state.proposals.filter((p) => p.from === me);
  const count = (id: string) => state.provinces.filter((p) => p.owner === id).length;
  return (
    <Window title="Diplomatie" onClose={onClose} className="side-panel diplomacy-panel">
      {incoming.length > 0 && (
        <>
          <h4>Angebote an uns</h4>
          {incoming.map((p) => (
            <div key={p.from} className="army-row">
              <span>{name(p.from)} bietet <b>{RELATION_NAMES[p.kind]}</b> an.</span>
              <button className="btn small" onClick={() => run({ type: 'answer', nation: p.from, accept: true })}>Annehmen</button>
              <button className="btn small" onClick={() => run({ type: 'answer', nation: p.from, accept: false })}>Ablehnen</button>
            </div>
          ))}
        </>
      )}
      {outgoing.length > 0 && (
        <div className="muted small">
          Offene Angebote: {outgoing.map((p) => `${RELATION_NAMES[p.kind]} an ${name(p.to)}`).join(', ')}
        </div>
      )}
      <table className="table">
        <thead><tr><th>Nation</th><th>Beziehung</th><th>Prov.</th><th></th></tr></thead>
        <tbody>
          {map.nations.filter((n) => n.id !== me).map((n) => {
            const alive = state.nations[n.id].alive;
            const rel = relation(state, me, n.id);
            const since = state.warSince[warKey(me, n.id)];
            const opts = alive ? options(state, me, n.id) : [];
            const selected = opts.find((o) => o.id === choice[n.id]) ?? opts[0];
            return (
              <tr key={n.id} className={rel === 'war' ? 'war' : ''}>
                <td><Flag nation={n.id} /> {n.name}</td>
                <td className="small">
                  {!alive ? 'vernichtet' : rel === 'war' ? `Krieg seit ${fmtDay(since ?? 0)}` : relationLabel(state, me, n.id)}
                </td>
                <td>{count(n.id)}</td>
                <td className="btn-cell">
                  {selected && (confirm === n.id ? (
                    <>
                      <button className="btn small danger" onClick={() => run(selected.action)}>Ja: {selected.label}</button>
                      <button className="btn small" onClick={() => setConfirm(null)}>Nein</button>
                    </>
                  ) : (
                    <>
                      <select value={selected.id} onChange={(e) => setChoice({ ...choice, [n.id]: e.target.value })}>
                        {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                      <button className="btn small" onClick={() => (selected.confirm ? setConfirm(n.id) : run(selected.action))}>OK</button>
                    </>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {msg && <div className="error">{msg}</div>}
      <p className="muted small">
        Krieg: Kampf und Eroberung, kein Handel. Embargo: kein Handel. Frieden: Handel, aber kein Betreten fremden Gebiets.
        Durchmarschrecht: Truppen dürfen durchziehen, Häfen gelten als befreundet. Geteilte Karte: zusätzlich gemeinsame Sicht.
        Verschlechtern geht sofort, Verbessern nur, wenn die andere Seite annimmt. Jeder Krieg senkt die Moral um 5 % (höchstens 25 %).
      </p>
    </Window>
  );
}
