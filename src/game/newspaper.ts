// Tageszeitung: erscheint zum Tageswechsel mit den öffentlichen Meldungen seit der letzten Ausgabe
// (Kriegserklärungen, Eroberungen von Städten, vernichtete Armeen …), Rangliste und Tageskarte.

import { DAY } from './balance.ts';
import type { MapData } from './mapdata.ts';
import { nextRandom } from './rng.ts';
import type { GameState, Newspaper, NewsItem, NewsKind } from './types.ts';
import { provinceCounts } from './economy.ts';

const KEEP = 14;

export function publishNewspaper(state: GameState, map: MapData): Newspaper {
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  const items: NewsItem[] = [];
  const feed = state.newsFeed ?? [];
  state.newsFeed = [];

  // einfache Meldungen (Krieg, Frieden, Hauptstädte, Revolutionen …)
  for (const e of feed) {
    if (e.kind || /Spiel beginnt/.test(e.text)) continue;
    const [title, kind] = headline(e.text);
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

  // Schlachten: vernichtete Armeen (Namen verraten die ungefähre Größe)
  const battles = feed.filter((e) => e.kind === 'battle');
  if (battles.length) {
    const lines = battles.slice(0, 8).map((e) => e.text);
    if (battles.length > 8) lines.push(`Dazu ${battles.length - 8} weitere vernichtete Verbände.`);
    items.push({
      kind: 'battle',
      title: battles.length === 1 ? `Schlacht bei ${battles[0].place}` : 'Von den Schlachtfeldern',
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
  items.push({
    kind: 'ranking',
    title: 'Die Mächte im Vergleich',
    text: ranking.slice(0, 3).map((r, i) => `${i + 1}. ${name(r.nation)} (${r.provinces} Provinzen)`).join(' · '),
  });
  if (items.length === 1) items.unshift({ kind: 'quiet', title: 'Ruhige Lage in Europa', text: 'Die Kabinette beraten, die Armeen exerzieren. Größere Ereignisse blieben aus.' });
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

/** Kurze Schlagzeile und Meldungsart aus einer Ereignismeldung */
function headline(text: string): [string, NewsKind] {
  if (/^Revolution/.test(text)) return ['Revolution!', 'revolution'];
  if (/den Krieg/.test(text)) return ['Kriegserklärung!', 'war'];
  if (/^Frieden/.test(text)) return ['Friedensschluss', 'peace'];
  if (/Hauptstadt/.test(text)) return ['Hauptstadt gefallen!', 'capital'];
  if (/aufgehört zu existieren/.test(text)) return ['Ein Staat verschwindet', 'eliminated'];
  if (/Embargo/.test(text)) return ['Handelsembargo', 'embargo'];
  if (/vereinbaren/.test(text)) return ['Neues Abkommen', 'agreement'];
  if (/herab/.test(text)) return ['Beziehungen abgekühlt', 'downgrade'];
  if (/gewinnt|Sieg/.test(text)) return ['Der Sieger steht fest', 'victory'];
  return ['Meldung', 'other'];
}
