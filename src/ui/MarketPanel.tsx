import { useState } from 'react';
import type { Action, ActionResult } from '../game/actions.ts';
import { MARKET, RES_NAMES } from '../game/balance.ts';
import { canTrade } from '../game/diplomacy.ts';
import type { NationRates } from '../game/economy.ts';
import { netRate } from '../game/economy.ts';
import { RESOURCES, type MapData, type Resource } from '../game/mapdata.ts';
import { priceBounds, priceOf } from '../game/market.ts';
import type { GameState, MarketOffer } from '../game/types.ts';
import { Window } from './common.tsx';
import { fmtDuration, fmtNum, fmtSigned, fmtGameTime } from './format.ts';
import { Flag } from './Flag.tsx';
import { ResIcon } from './icons.tsx';

export function MarketPanel({ map, state, rates, act, onClose }: {
  map: MapData;
  state: GameState;
  rates: NationRates;
  act(a: Action): Promise<ActionResult>;
  onClose(): void;
}) {
  const me = state.playerNation;
  const stock = state.nations[me].stock;
  const [res, setRes] = useState<Resource>('grain');
  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const [amount, setAmount] = useState(1000);
  const [price, setPrice] = useState<number | null>(null);
  const [take, setTake] = useState<Record<number, number>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [allTrades, setAllTrades] = useState(false);
  const run = async (a: Action) => {
    const r = await act(a);
    setMsg(r.ok ? null : r.error);
  };
  const nation = (id: string) => map.nations.find((n) => n.id === id);
  const course = priceOf(state, res);
  const [lo, hi] = priceBounds(res);
  const ask = price ?? course;
  const net = netRate(rates, res);
  const others = state.market.offers.filter((o) => o.res === res && o.nation !== me);
  const sells = others.filter((o) => o.side === 'sell').sort((a, b) => a.price - b.price);
  const buys = others.filter((o) => o.side === 'buy').sort((a, b) => b.price - a.price);
  const mine = state.market.offers.filter((o) => o.nation === me);
  const age = (o: MarketOffer) => fmtDuration((state.time - o.time) / state.speed);

  const row = (o: MarketOffer) => {
    const n = nation(o.nation);
    const ok = canTrade(state, me, o.nation);
    const max = o.side === 'sell' ? Math.min(o.amount, Math.floor(stock.money / o.price)) : Math.min(o.amount, Math.floor(stock[o.res]));
    const value = Math.min(take[o.id] ?? o.amount, o.amount);
    return (
      <tr key={o.id} className={ok ? '' : 'blocked'} title={ok ? '' : 'Kein Handel: Krieg oder Embargo'}>
        <td><Flag nation={o.nation} height={11} /> {n?.name ?? o.nation}</td>
        <td>{fmtNum(o.amount)}</td>
        <td>{o.price.toFixed(2)}</td>
        <td className="btn-cell">
          <input type="number" className="num" min={1} max={o.amount} value={value}
            onChange={(e) => setTake({ ...take, [o.id]: Number(e.target.value) })} />
          <button className="btn small" disabled={!ok || max < 1}
            onClick={() => run({ type: 'acceptOffer', id: o.id, amount: Math.min(value, max) })}>
            {o.side === 'sell' ? 'Kaufen' : 'Liefern'}
          </button>
        </td>
      </tr>
    );
  };

  return (
    <Window title="Börse" onClose={onClose} className="side-panel">
      <div className="res-tabs">
        {RESOURCES.map((r) => (
          <button key={r} className={'res-tab' + (r === res ? ' active' : '')} title={RES_NAMES[r]} onClick={() => { setRes(r); setPrice(null); }}>
            <ResIcon res={r} size={18} />
          </button>
        ))}
      </div>
      <div className="market-head">
        <b>{RES_NAMES[res]}</b>
        <span>Kurs <b>{course.toFixed(2)}</b> Geld/Einheit</span>
        <span className="muted small">Vorrat {fmtNum(stock[res])} · Bilanz {fmtSigned(net)}/Tag · Geld {fmtNum(stock.money)}</span>
      </div>

      <h4>Verkaufsangebote</h4>
      {sells.length === 0 ? <div className="muted small">Keine Angebote.</div> : (
        <table className="table"><thead><tr><th>Anbieter</th><th>Menge</th><th>Preis</th><th></th></tr></thead>
          <tbody>{sells.map(row)}</tbody></table>
      )}
      <h4>Kaufgesuche</h4>
      {buys.length === 0 ? <div className="muted small">Keine Gesuche.</div> : (
        <table className="table"><thead><tr><th>Käufer</th><th>Menge</th><th>Preis</th><th></th></tr></thead>
          <tbody>{buys.map(row)}</tbody></table>
      )}

      <h4>Eigenes Angebot einstellen</h4>
      <div className="market-form">
        <select value={side} onChange={(e) => setSide(e.target.value as 'sell' | 'buy')}>
          <option value="sell">Verkaufen</option>
          <option value="buy">Kaufen</option>
        </select>
        <label>Menge <input type="number" className="num" min={MARKET.minAmount} step={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
        <label>Preis <input type="number" className="num" min={lo} max={hi} step={0.05} value={ask} onChange={(e) => setPrice(Number(e.target.value))} /></label>
        <button className="btn small" onClick={() => run({ type: 'postOffer', side, res, amount, price: ask })}>Einstellen</button>
      </div>
      <div className="muted small">
        Summe {fmtNum(amount * ask)} Geld. {side === 'sell' ? 'Die Ware' : 'Das Geld'} wird bis zum Handel zurückgelegt.
        Preis {lo}–{hi}. Angebote gelten, bis sie erfüllt oder zurückgezogen sind.
      </div>

      {mine.length > 0 && (
        <>
          <h4>Eigene Angebote</h4>
          <table className="table"><tbody>
            {mine.map((o) => (
              <tr key={o.id}>
                <td><ResIcon res={o.res} size={14} /> {o.side === 'sell' ? 'Verkauf' : 'Kauf'}</td>
                <td>{fmtNum(o.amount)}</td>
                <td>{o.price.toFixed(2)}</td>
                <td className="small muted">seit {age(o)}</td>
                <td><button className="btn small" onClick={() => run({ type: 'cancelOffer', id: o.id })}>Zurückziehen</button></td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
      {msg && <div className="error">{msg}</div>}

      <h4>Handelsprotokoll</h4>
      <label className="small">
        <input type="checkbox" checked={allTrades} onChange={(e) => setAllTrades(e.target.checked)} /> alle Rohstoffe
      </label>
      {(() => {
        const trades = state.market.trades.filter((t) => allTrades || t.res === res).slice(-40).reverse();
        if (!trades.length) return <div className="muted small">Noch keine Abschlüsse.</div>;
        return (
          <table className="table trade-log">
            <thead><tr><th>Zeit</th><th>Verkäufer</th><th>Käufer</th><th>Menge</th><th>Preis</th></tr></thead>
            <tbody>
              {trades.map((t, k) => (
                <tr key={k} className={t.seller === me || t.buyer === me ? 'me' : ''}>
                  <td className="small">{fmtGameTime(t.time)}</td>
                  <td><Flag nation={t.seller} height={11} /> {nation(t.seller)?.name ?? t.seller}</td>
                  <td><Flag nation={t.buyer} height={11} /> {nation(t.buyer)?.name ?? t.buyer}</td>
                  <td><ResIcon res={t.res} size={13} /> {fmtNum(t.amount)}</td>
                  <td>{t.price.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })()}
    </Window>
  );
}
