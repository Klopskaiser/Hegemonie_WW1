// Tageszeitung: erscheint zum Tageswechsel mit den öffentlichen Meldungen seit der letzten Ausgabe
// (Kriegserklärungen, Eroberungen von Städten, vernichtete Armeen …), Wirtschaftszahlen, Börse und Tageskarte.

import { DAY } from './balance.ts';
import type { MapData } from './mapdata.ts';
import { nextRandom } from './rng.ts';
import { type GameState, type Newspaper, type NewsItem, type NewsKind } from './types.ts';
import { allRates, provinceCounts } from './economy.ts';
import { RESOURCES } from './mapdata.ts';

const KEEP = 14;

export function publishNewspaper(state: GameState, map: MapData): Newspaper {
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  const items: NewsItem[] = [];
  const feed = state.newsFeed ?? [];
  state.newsFeed = [];

  // einfache Meldungen (Krieg, Frieden, Hauptstädte, Revolutionen …); Abkommen außer dem Frieden (Durchmarsch,
  // Bündnis, Embargo, Herabstufung, Tribut) sind nicht öffentlich
  for (const e of feed) {
    if (e.kind || /Spiel beginnt/.test(e.text)) continue;
    const [title, kind] = headline(e.text);
    if (kind === 'embargo' || kind === 'agreement' || kind === 'downgrade' || /Tribut/.test(e.text)) continue;
    // Plünderung gehört zum Fall der Hauptstadt (eigene Meldung nur, falls diese fehlt)
    if (/plündert/.test(e.text)) {
      const fall = [...items].reverse().find((it) => it.kind === 'capital');
      if (fall) {
        fall.text += ` ${e.text}`;
        continue;
      }
    }
    items.push({ title, text: e.text, kind });
  }

  // eroberte Städte, je Eroberer und Verlierer zusammengefasst
  const conquests = new Map<string, string[]>();
  for (const e of feed) {
    if (e.kind !== 'conquest' || !e.by || !e.from || !e.place) continue;
    const key = `${e.by}|${e.from}`;
    (conquests.get(key) ?? conquests.set(key, []).get(key)!).push(e.place);
  }
  for (const [key, places] of conquests) {
    const [by, from] = key.split('|');
    const list = places.length === 1 ? places[0] : `${places.slice(0, -1).join(', ')} und ${places.at(-1)}`;
    items.push({
      kind: 'conquest',
      title: places.length === 1 ? `${places[0]} gefallen` : `${name(by)} rückt vor`,
      text: `${name(by)} erobert ${places.length === 1 ? 'die Stadt' : 'die Städte'} ${list} von ${name(from)}${places.length === 1 ? ` (Provinz ${places[0]})` : ''}.`,
    });
  }

  // Kriege: laufender Verlustzähler je Krieg seit Kriegsbeginn (jede verlorene Einheit, Infanterie wie Maschine,
  // zählt 1000 Mann) – gemeldet werden Kriege mit neuen Verlusten seit der letzten Ausgabe; dazu vernichtete Armeen
  delete state.battleLosses;
  const wars = Object.entries(state.warLosses ?? {})
    .filter(([key]) => state.warSince[key] !== undefined)
    .map(([key, w]) => {
      const [a, b] = key.split('|');
      const sides = [a, b].map((n) => [n, w.losses[n] ?? 0] as [string, number]).sort((x, y) => y[1] - x[1]);
      const total = sides[0][1] + sides[1][1];
      const fresh = Math.round(total) > Math.round(w.reported ?? 0);
      w.reported = total;
      return { sides, total, fresh };
    })
    .filter((x) => x.fresh)
    .sort((x, y) => y.total - x.total);
  const battles = feed.filter((e) => e.kind === 'battle');
  if (wars.length || battles.length) {
    const lines = wars.slice(0, 6).map((x) =>
      `Krieg ${name(x.sides[0][0])} – ${name(x.sides[1][0])}: bisher ${x.sides.map(([n, k]) => `${name(n)} ${men(k)} Mann`).join(' und ')} Verluste.`);
    if (wars.length > 6) lines.push(`Dazu ${wars.length - 6} weitere Kriege mit zusammen ${men(wars.slice(6).reduce((t, x) => t + x.total, 0))} Mann Verlusten.`);
    lines.push(...battles.slice(0, 8).map((e) => e.text));
    if (battles.length > 8) lines.push(`Dazu ${battles.length - 8} weitere vernichtete Verbände.`);
    items.push({
      kind: 'battle',
      title: wars.length === 1 ? `Krieg ${name(wars[0].sides[0][0])} – ${name(wars[0].sides[1][0])}` : 'Von den Fronten',
      text: lines.join(' '),
    });
  }
  // Schlagzeile nach Gewicht
  const weight: Partial<Record<NewsKind, number>> = {
    victory: 0, capital: 1, war: 2, eliminated: 3, revolution: 4, conquest: 5, peace: 6, battle: 7,
  };
  items.sort((a, b) => (weight[a.kind ?? 'other'] ?? 9) - (weight[b.kind ?? 'other'] ?? 9));

  const count = provinceCounts(state);
  const ranking = map.nations
    .filter((n) => state.nations[n.id].alive)
    .map((n) => ({ nation: n.id, provinces: count[n.id] ?? 0 }))
    .sort((a, b) => b.provinces - a.provinces);
  // ohne Ereignisse: ruhige Lage als Aufmacher (vor den festen Rubriken)
  if (items.length === 0) items.push({ kind: 'quiet', title: 'Ruhige Lage in Europa', text: 'Die Kabinette beraten, die Armeen exerzieren. Größere Ereignisse blieben aus.' });

  // feste Rubriken: Wirtschaftszahlen (Rohstoffförderung je Tag, alle Rohstoffe zusammen, nur Ertrag) und Börse
  // (reichste Staatskasse); die Rangliste nach Provinzen ist jederzeit einsehbar und steht nicht mehr im Blatt
  const alive = map.nations.filter((n) => state.nations[n.id]?.alive);
  const rates = allRates(state, map);
  const output = alive
    .map((n) => ({ nation: n.id, t: RESOURCES.reduce((sum, r) => sum + (rates[n.id]?.prod[r] ?? 0), 0) }))
    .sort((a, b) => b.t - a.t || a.nation.localeCompare(b.nation));
  if (output.length) {
    items.push({
      kind: 'economy',
      title: 'Wirtschaftszahlen',
      text: `Rohstoffförderung je Tag: ${output.slice(0, 3).map((x, i) => `${i + 1}. ${name(x.nation)} ${thousands(x.t)} Tonnen`).join(' · ')}.`,
    });
  }
  const richest = alive
    .map((n) => ({ nation: n.id, money: state.nations[n.id].stock.money }))
    .sort((a, b) => b.money - a.money || a.nation.localeCompare(b.nation))[0];
  if (richest) {
    items.push({
      kind: 'market',
      title: 'Börse',
      text: `Die reichste Staatskasse hat ${name(richest.nation)} mit ${thousands(richest.money)} Pfund.`,
    });
  }
  // je Meldung eine von drei Bildvarianten
  for (const it of items) it.variant = 1 + Math.floor(nextRandom(state) * 3);

  const paper: Newspaper = {
    day: Math.floor(state.time / DAY) + 1,
    items,
    owners: state.provinces.map((p) => p.owner),
    ranking,
  };
  state.newspapers.push(paper);
  if (state.newspapers.length > KEEP) state.newspapers.splice(0, state.newspapers.length - KEEP);
  return paper;
}

/** ganze Zahl mit Tausenderpunkt (unabhängig von der Spracheinstellung) */
function thousands(v: number): string {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** verlorene Einheiten als Gefallene: je Einheit 1000 Mann, mit Tausenderpunkt (unabhängig von der Spracheinstellung) */
function men(units: number): string {
  return String(Math.round(units) * 1000).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Kurze Schlagzeile und Meldungsart aus einer Ereignismeldung */
function headline(text: string): [string, NewsKind] {
  if (/^Revolution/.test(text)) return ['Revolution!', 'revolution'];
  if (/den Krieg/.test(text)) return ['Kriegserklärung!', 'war'];
  // Truppen treffen auf dem Weg aufeinander: Krieg ohne Erklärung
  if (/^Zusammenstoß/.test(text)) return ['Krieg ausgebrochen!', 'war'];
  if (/^Frieden/.test(text)) return ['Friedensschluss', 'peace'];
  if (/verlegt die Hauptstadt/.test(text)) return ['Neue Hauptstadt', 'other'];
  if (/plündert/.test(text)) return ['Hauptstadt geplündert', 'capital'];
  if (/Hauptstadt .* gefallen/.test(text)) return ['Hauptstadt gefallen!', 'capital'];
  if (/aufgehört zu existieren/.test(text)) return ['Ein Staat verschwindet', 'eliminated'];
  if (/Embargo/.test(text)) return ['Handelsembargo', 'embargo'];
  if (/vereinbaren/.test(text)) return ['Neues Abkommen', 'agreement'];
  if (/herab/.test(text)) return ['Beziehungen abgekühlt', 'downgrade'];
  if (/gewinnt|Sieg/.test(text)) return ['Der Sieger steht fest', 'victory'];
  return ['Meldung', 'other'];
}
