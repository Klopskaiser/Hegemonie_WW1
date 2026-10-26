// Diplomatische Beziehungen wie im Original: Krieg, Embargo (nach Krieg: Waffenstillstand),
// Frieden, Durchmarschrecht, geteilte Karte. Beziehungen gelten für beide Seiten gleich.
// Verschlechtern geht einseitig, Verbessern nur per Angebot und Annahme.

import { DAY } from './balance.ts';
import type { GameState, Relation } from './types.ts';
import { REBELS } from './types.ts';

/** Nach einem Friedensschluss erklärt die KI derselben Nation so lange keinen Krieg */
export const TRUCE = 5 * DAY;

export const RELATION_ORDER: Relation[] = ['war', 'embargo', 'peace', 'rightOfWay', 'sharedMap'];

export const RELATION_NAMES: Record<Relation, string> = {
  war: 'Krieg',
  embargo: 'Embargo',
  peace: 'Frieden',
  rightOfWay: 'Durchmarschrecht',
  sharedMap: 'Geteilte Karte',
};

export function relationRank(r: Relation): number {
  return RELATION_ORDER.indexOf(r);
}

export function relation(state: GameState, a: string, b: string): Relation {
  if (a === b) return 'sharedMap';
  return state.relations[a]?.[b] ?? 'peace';
}

export function atWar(state: GameState, a: string, b: string): boolean {
  if (a === b) return false;
  if (a === REBELS || b === REBELS) return true;
  return relation(state, a, b) === 'war';
}

/** Darf `a` das Gebiet von `b` betreten (Durchmarschrecht oder besser)? */
export function hasRightOfWay(state: GameState, a: string, b: string): boolean {
  return a === b || relationRank(relation(state, a, b)) >= relationRank('rightOfWay');
}

export function sharesMap(state: GameState, a: string, b: string): boolean {
  return a !== b && relation(state, a, b) === 'sharedMap';
}

/** Handel zwischen zwei Nationen möglich (weder Krieg noch Embargo) */
export function canTrade(state: GameState, a: string, b: string): boolean {
  return a === b || relationRank(relation(state, a, b)) >= relationRank('peace');
}

export function warKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function setRelation(state: GameState, a: string, b: string, r: Relation): void {
  const before = relation(state, a, b);
  (state.relations[a] ??= {})[b] = r;
  (state.relations[b] ??= {})[a] = r;
  if (r === 'war') state.warSince[warKey(a, b)] = state.time;
  else if (before === 'war') {
    delete state.warSince[warKey(a, b)];
    state.truceUntil[warKey(a, b)] = state.time + TRUCE;
  }
  // offene Angebote zwischen beiden sind damit erledigt
  state.proposals = state.proposals.filter((p) => !((p.from === a && p.to === b) || (p.from === b && p.to === a)));
}

export function enemiesOf(state: GameState, nation: string): string[] {
  return Object.entries(state.relations[nation] ?? {}).filter(([, r]) => r === 'war').map(([n]) => n);
}

export function warCount(state: GameState, nation: string): number {
  return enemiesOf(state, nation).filter((n) => state.nations[n]?.alive).length;
}

/** Bezeichnung aus Sicht des Spielers: Embargo nach einem Krieg heißt Waffenstillstand */
export function relationLabel(state: GameState, a: string, b: string): string {
  const r = relation(state, a, b);
  if (r === 'embargo' && (state.truceUntil[warKey(a, b)] ?? 0) > 0) return 'Waffenstillstand';
  return RELATION_NAMES[r];
}
