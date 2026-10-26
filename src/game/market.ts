// Börse: Nationen stellen Kauf- und Verkaufsangebote für Rohstoffe ein, andere nehmen sie an.
// Beim Einstellen wird die Ware (Verkauf) bzw. das Geld (Kauf) zurückgelegt. Bei Krieg oder
// Embargo ist kein Handel zwischen zwei Nationen möglich.

import { MARKET, RES_NAMES } from './balance.ts';
import { canTrade } from './diplomacy.ts';
import type { MapData, Resource } from './mapdata.ts';
import type { GameState, MarketOffer } from './types.ts';

export interface MarketContext {
  state: GameState;
  map: MapData;
  log(text: string, nation?: string): void;
  invalidate(): void;
}

export type MarketResult = { ok: true } | { ok: false; error: string };

/** Aktueller Kurs: letzter Handelspreis, sonst Richtpreis */
export function priceOf(state: GameState, res: Resource): number {
  return state.market.lastPrice[res] ?? MARKET.basePrice[res];
}

export function priceBounds(res: Resource): [number, number] {
  const base = MARKET.basePrice[res];
  return [round2(base * MARKET.minFactor), round2(base * MARKET.maxFactor)];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const nameOf = (map: MapData, id: string) => map.nations.find((n) => n.id === id)?.name ?? id;

/** Länge des Handelsprotokolls */
const TRADE_LOG = 300;

export function postOffer(
  ctx: MarketContext, nation: string, side: 'sell' | 'buy', res: Resource, amount: number, price: number,
): MarketResult {
  const { state } = ctx;
  amount = Math.floor(amount);
  price = round2(price);
  if (!(res in MARKET.basePrice)) return { ok: false, error: 'Unbekannter Rohstoff' };
  if (amount < MARKET.minAmount) return { ok: false, error: `Mindestens ${MARKET.minAmount} Einheiten` };
  const [lo, hi] = priceBounds(res);
  if (!(price >= lo && price <= hi)) return { ok: false, error: `Preis zwischen ${lo} und ${hi}` };
  if (state.market.offers.filter((o) => o.nation === nation).length >= MARKET.maxOffersPerNation) {
    return { ok: false, error: `Höchstens ${MARKET.maxOffersPerNation} Angebote gleichzeitig` };
  }
  const stock = state.nations[nation].stock;
  if (side === 'sell') {
    if (stock[res] < amount) return { ok: false, error: `Zu wenig ${RES_NAMES[res]}` };
    stock[res] -= amount;
  } else {
    const total = amount * price;
    if (stock.money < total) return { ok: false, error: 'Zu wenig Geld' };
    stock.money -= total;
  }
  state.market.offers.push({ id: state.market.nextId++, nation, side, res, amount, price, time: state.time });
  return { ok: true };
}

/** Zurückgelegte Ware bzw. zurückgelegtes Geld eines Angebots zurückgeben */
function refund(state: GameState, o: MarketOffer): void {
  const stock = state.nations[o.nation]?.stock;
  if (!stock) return;
  if (o.side === 'sell') stock[o.res] += o.amount;
  else stock.money += o.amount * o.price;
}

export function cancelOffer(ctx: MarketContext, nation: string, id: number): MarketResult {
  const { state } = ctx;
  const o = state.market.offers.find((x) => x.id === id);
  if (!o || o.nation !== nation) return { ok: false, error: 'Angebot nicht gefunden' };
  refund(state, o);
  state.market.offers = state.market.offers.filter((x) => x !== o);
  return { ok: true };
}

/** Angebot (ganz oder teilweise) annehmen. */
export function acceptOffer(ctx: MarketContext, nation: string, id: number, amount: number): MarketResult {
  const { state, map } = ctx;
  const o = state.market.offers.find((x) => x.id === id);
  if (!o) return { ok: false, error: 'Angebot nicht mehr vorhanden' };
  if (o.nation === nation) return { ok: false, error: 'Eigenes Angebot' };
  if (!canTrade(state, nation, o.nation)) return { ok: false, error: 'Kein Handel bei Krieg oder Embargo' };
  const take = Math.min(Math.floor(amount), o.amount);
  if (take < 1) return { ok: false, error: 'Ungültige Menge' };
  const me = state.nations[nation].stock;
  const other = state.nations[o.nation].stock;
  const total = take * o.price;
  if (o.side === 'sell') {
    // ich kaufe: Geld von mir, Ware aus der Rücklage
    if (me.money < total) return { ok: false, error: 'Zu wenig Geld' };
    me.money -= total;
    me[o.res] += take;
    other.money += total;
    ctx.log(`Börse: ${take.toLocaleString('de-DE')} ${RES_NAMES[o.res]} von ${nameOf(map, o.nation)} gekauft (${o.price} je Einheit).`, nation);
    ctx.log(`Börse: ${nameOf(map, nation)} kauft ${take.toLocaleString('de-DE')} ${RES_NAMES[o.res]} (${o.price} je Einheit).`, o.nation);
  } else {
    // ich verkaufe: Ware von mir, Geld aus der Rücklage
    if (me[o.res] < take) return { ok: false, error: `Zu wenig ${RES_NAMES[o.res]}` };
    me[o.res] -= take;
    me.money += total;
    other[o.res] += take;
    ctx.log(`Börse: ${take.toLocaleString('de-DE')} ${RES_NAMES[o.res]} an ${nameOf(map, o.nation)} verkauft (${o.price} je Einheit).`, nation);
    ctx.log(`Börse: ${nameOf(map, nation)} liefert ${take.toLocaleString('de-DE')} ${RES_NAMES[o.res]} (${o.price} je Einheit).`, o.nation);
  }
  o.amount -= take;
  if (o.amount <= 0) state.market.offers = state.market.offers.filter((x) => x !== o);
  state.market.lastPrice[o.res] = o.price;
  const [seller, buyer] = o.side === 'sell' ? [o.nation, nation] : [nation, o.nation];
  state.market.trades.push({ time: state.time, seller, buyer, res: o.res, amount: take, price: o.price });
  if (state.market.trades.length > TRADE_LOG) state.market.trades.splice(0, state.market.trades.length - TRADE_LOG);
  ctx.invalidate();
  return { ok: true };
}

/** Abgelaufene Angebote und Angebote ausgeschiedener Nationen entfernen (Rücklage zurück). */
export function expireOffers(state: GameState): void {
  const keep: MarketOffer[] = [];
  for (const o of state.market.offers) {
    const alive = state.nations[o.nation]?.alive;
    if (alive && state.time - o.time < MARKET.offerLifetime) keep.push(o);
    else if (alive) refund(state, o);
  }
  state.market.offers = keep;
  // diplomatische Angebote untergegangener Nationen (auch aus älteren Spielständen)
  const alive = (id: string) => !!state.nations[id]?.alive;
  if (state.proposals.some((p) => !alive(p.from) || !alive(p.to))) state.proposals = state.proposals.filter((p) => alive(p.from) && alive(p.to));
}

/** Angebote, die `nation` annehmen kann (kein Krieg/Embargo, nicht eigene), günstigste zuerst */
export function tradeableOffers(state: GameState, nation: string, res: Resource, side: 'sell' | 'buy'): MarketOffer[] {
  return state.market.offers
    .filter((o) => o.res === res && o.side === side && o.nation !== nation && canTrade(state, nation, o.nation))
    .sort((a, b) => (side === 'sell' ? a.price - b.price : b.price - a.price));
}
