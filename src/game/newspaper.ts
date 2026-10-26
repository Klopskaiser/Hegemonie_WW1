// Tageszeitung: erscheint zum Tageswechsel mit den öffentlichen Ereignissen des Tages,
// einer Eroberungsbilanz (Grenzen gegenüber der Vorausgabe), Rangliste und Tageskarte.

import { DAY } from './balance.ts';
import type { MapData } from './mapdata.ts';
import type { GameState, Newspaper, NewsItem } from './types.ts';

const KEEP = 14;

export function publishNewspaper(state: GameState, map: MapData): Newspaper {
  const name = (id: string) => map.nations.find((n) => n.id === id)?.name ?? id;
  const since = state.time - DAY;
  const items: NewsItem[] = [];

  // öffentliche Meldungen des vergangenen Tages
  for (const e of state.events) {
    if (e.nation || e.time < since) continue;
    if (/Spiel beginnt/.test(e.text)) continue;
    items.push({ title: headline(e.text), text: e.text });
  }

  // Eroberungen: Grenzen gegenüber der Vorausgabe (bzw. Spielbeginn)
  const before = state.newspapers.at(-1)?.owners ?? map.provinces.map((p) => p.nation);
  const gains = new Map<string, number>();
  state.provinces.forEach((ps, i) => {
    if (before[i] !== ps.owner) {
      const key = `${ps.owner}|${before[i]}`;
      gains.set(key, (gains.get(key) ?? 0) + 1);
    }
  });
  for (const [key, n] of gains) {
    const [winner, loser] = key.split('|');
    items.push({
      title: `${name(winner)} rückt vor`,
      text: `${name(winner)} hat ${n === 1 ? 'eine Provinz' : `${n} Provinzen`} von ${name(loser)} eingenommen.`,
    });
  }

  const ranking = map.nations
    .filter((n) => state.nations[n.id].alive)
    .map((n) => ({ nation: n.id, points: Math.round(state.nations[n.id].points) }))
    .sort((a, b) => b.points - a.points);
  items.push({
    title: 'Die Mächte im Vergleich',
    text: ranking.slice(0, 3).map((r, i) => `${i + 1}. ${name(r.nation)} (${r.points} Siegpunkte)`).join(' · '),
  });
  if (items.length === 1) items.unshift({ title: 'Ruhige Lage in Europa', text: 'Die Kabinette beraten, die Armeen exerzieren. Größere Ereignisse blieben aus.' });

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

/** Kurze Schlagzeile aus einer Ereignismeldung */
function headline(text: string): string {
  if (/den Krieg/.test(text)) return 'Kriegserklärung!';
  if (/^Frieden/.test(text)) return 'Friedensschluss';
  if (/Hauptstadt/.test(text)) return 'Hauptstadt gefallen!';
  if (/aufgehört zu existieren/.test(text)) return 'Ein Staat verschwindet';
  if (/Embargo/.test(text)) return 'Handelsembargo';
  if (/vereinbaren/.test(text)) return 'Neues Abkommen';
  if (/herab/.test(text)) return 'Beziehungen abgekühlt';
  if (/gewinnt|Sieg/.test(text)) return 'Der Sieger steht fest';
  return 'Meldung';
}
