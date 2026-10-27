// Simulationskern: fester Minutentakt, damit Live-Spiel und Nachsimulation
// unabhängig von der Aufteilung der Zeitschritte identisch verlaufen.

import {
  applyAction, buildBlocker, buildHours, canAfford, pay, requirementsMet, unitHours,
  type Action, type ActionContext, type ActionResult,
} from './actions.ts';
import { BasicAI } from './ai.ts';
import { DEFAULT_COMBAT_MORALE, ALL_RES, BUILDINGS, CATEGORIES, CATEGORY_OF, CATEGORY_RES, DAY, DEFECTION, DIFFICULTY, HOUR, MINUTE, TICKS_PER_DAY, TROOP_MORALE, UNITS, VICTORY_SHARE,
  type Category, type UnitType,
} from './balance.ts';
import { observe, type Controller, type NationView, type Observation } from './controller.ts';
import { allRates, defaultConsumption, moraleTarget, provincePoints, recruitHours, stepMorale, type NationRates, provinceCounts, focusShares } from './economy.ts';
import type { MapData } from './mapdata.ts';
import {
  applyCombatMorale, combatRound, type CombatTally, defections, encounters, forcedMarchWear, mergeNearby, pursue, splitParts, engageRanged, isNaval, mixMorale, processArrivals, rangedRound, updateRevoltFlags, nextTroopMorale, repairMachines, resumeOrders, troopTarget,
} from './military.ts';
import { harborSea, isSea } from './graph.ts';
import { expireOffers } from './market.ts';
import { publishNewspaper } from './newspaper.ts';
import { numberArmies, unitName } from './names.ts';
import { nextRandom } from './rng.ts';
import { migrate } from './state.ts';
import { REBELS, type GameState, type NewsInfo } from './types.ts';

const EVENT_LIMIT = 300;

/** Aktionen, die nur Armeen bewegen oder umgruppieren: kein Einfluss auf die Wirtschaftsraten */
const MOVE_ONLY = new Set<Action['type']>(['move', 'stop', 'attack', 'setMarch', 'split', 'merge', 'rejoin', 'rename']);

export class Simulation {
  rates: Record<string, NationRates> = {};
  private perTick: Record<string, number[]> = {};
  /** Provinzunterhalt je Kategorie und Takt; Anteile je Rohstoff (Reihenfolge wie CATEGORY_RES) */
  private upkeepPerTick: Record<string, number> = {};
  private shareList: Record<string, number[][]> = {};
  controllers = new Map<string, Controller>();
  private dirty = true;
  /** Wirtschaftsraten neu berechnen (siehe invalidateRates) */
  private ratesDirty = true;
  /** KI-Runde läuft: Raten erst danach neu berechnen */
  private batch = false;
  private nextEvent = 0;
  private carry = 0;
  private readonly defaultAI = new BasicAI();
  private readonly nationIds: string[];

  constructor(public state: GameState, public map: MapData) {
    migrate(state);
    this.nationIds = map.nations.map((n) => n.id);
    for (const id of this.nationIds) state.nations[id].consumption ??= defaultConsumption(map, id);
    // Schiffe aus älteren Spielständen, die noch in Häfen liegen, aufs Wasser setzen
    for (const a of state.armies) {
      if (isNaval(a) && !isSea(map, a.node)) {
        a.node = harborSea(map, a.node) ?? a.node;
        a.move = null;
      }
    }
    this.refresh();
  }

  invalidate = (): void => {
    this.dirty = true;
  };

  /**
   * Wirtschaftlich relevante Änderung (Besitz, Gebäude, Einheitenzahl, Moral, Regler): die Raten werden beim
   * nächsten refresh neu berechnet. Bewegungen, Anhalten oder Zusammenlegen brauchen das nicht (nur invalidate).
   * Unabhängig davon werden die Raten zu jeder vollen Spielstunde neu berechnet.
   */
  invalidateRates = (): void => {
    this.dirty = true;
    this.ratesDirty = true;
  };

  log = (text: string, nation?: string, province?: number, news?: NewsInfo): void => {
    this.state.events.push({ time: this.state.time, nation, province, text });
    // öffentliche Meldungen sammeln sich bis zur nächsten Zeitungsausgabe
    if (!nation) (this.state.newsFeed ??= []).push({ time: this.state.time, text, ...news });
    if (this.state.events.length > EVENT_LIMIT) this.state.events.splice(0, this.state.events.length - EVENT_LIMIT);
  };

  /** Kontext für Aktionen und Militär (Zufall nur aus dem Spielstand). */
  readonly ctx: ActionContext = (() => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const sim = this;
    return {
      get state() { return sim.state; },
      get map() { return sim.map; },
      invalidate: () => sim.invalidate(),
      invalidateRates: () => sim.invalidateRates(),
      log: (t: string, n?: string, p?: number, news?: NewsInfo) => sim.log(t, n, p, news),
      random: () => nextRandom(sim.state),
      newArmyId: () => sim.state.nextArmyId++,
    };
  })();

  apply(nation: string, action: Action): ActionResult {
    const r = applyAction(this.ctx, nation, action);
    if (r.ok && !MOVE_ONLY.has(action.type)) this.ratesDirty = true;
    if (r.ok && action.type === 'setConsumptionFocus') this.applyFocus(nation);
    if (r.ok && action.type === 'enqueue') this.startOrder(action.province);
    if (r.ok && action.type === 'cancelBuild') this.startBuild(action.province);
    this.refresh();
    return r;
  }

  /** Spielzeit um `ms` vorrücken (Bruchteile einer Minute werden übertragen). */
  advance(ms: number): void {
    this.carry += ms;
    const ticks = Math.floor(this.carry / MINUTE);
    this.carry -= ticks * MINUTE;
    for (let i = 0; i < ticks && !this.state.winner; i++) this.tick();
  }

  /** Bis zu einem Spielzeitpunkt simulieren (für die Nachsimulation). */
  advanceTo(time: number): void {
    while (this.state.time + MINUTE <= time && !this.state.winner) this.tick();
  }

  // ---------------------------------------------------------------- Takt

  private refresh(): void {
    if (!this.dirty) return;
    numberArmies(this.state);
    // während der KI-Runde rechnen die Raten erst am Ende neu (die Befehle einer Nation ändern nur ihre eigenen)
    if (this.ratesDirty && !this.batch) {
      this.ratesDirty = false;
      this.rates = allRates(this.state, this.map);
      for (const id of this.nationIds) {
        const r = this.rates[id];
        this.perTick[id] = ALL_RES.map((res) => (r.prod[res] - r.cons[res]) / TICKS_PER_DAY);
        this.upkeepPerTick[id] = r.upkeep / TICKS_PER_DAY;
        this.shareList[id] = CATEGORIES.map((c) => CATEGORY_RES[c].map((res) => r.shares[res]));
      }
    }
    let next = Infinity;
    for (const ps of this.state.provinces) {
      if (ps.construction && ps.construction.end < next) next = ps.construction.end;
      const o = ps.queue[0];
      if (o?.end !== undefined && o.end < next) next = o.end;
    }
    for (const a of this.state.armies) if (a.move && a.move.segEnd < next) next = a.move.segEnd;
    this.nextEvent = next;
    this.dirty = false;
  }

  private tick(): void {
    const s = this.state;
    s.time += MINUTE;
    if (s.time % HOUR === 0) this.invalidateRates();
    this.refresh();
    this.economy();
    if (s.time >= this.nextEvent) {
      this.completions();
      processArrivals(this.ctx);
      this.dirty = true;
    }
    if (encounters(this.ctx)) this.dirty = true;
    this.capitalMoves();
    if (s.time % (10 * MINUTE) === 0) {
      this.startWaitingOrders();
      engageRanged(this.ctx);
      // Verbände: nach dem Kampf Teile abteilen, Befehle fortsetzen, verfolgen, Stehende zusammenfassen
      splitParts(this.ctx);
      resumeOrders(this.ctx);
      pursue(this.ctx);
      mergeNearby(this.ctx);
    }
    if (s.time % HOUR === 0) {
      // Nah- und Fernkampf derselben Stunde: Moral gemeinsam und gedeckelt
      const tally: CombatTally = new Map();
      combatRound(this.ctx, tally);
      rangedRound(this.ctx, tally);
      applyCombatMorale(tally, s.combatMorale ?? DEFAULT_COMBAT_MORALE);
      forcedMarchWear(this.ctx);
      if (updateRevoltFlags(s)) this.dirty = true;
      expireOffers(s);
      this.recruitInfantry();
      for (const id of this.nationIds) this.applyFocus(id);
      this.runControllers();
    }
    if (s.time % DAY === 0) this.dayChange();
    this.refresh();
  }

  private economy(): void {
    for (const id of this.nationIds) {
      const n = this.state.nations[id];
      if (!n.alive) continue;
      const d = this.perTick[id];
      const st = n.stock;
      for (let k = 0; k < ALL_RES.length; k++) {
        const res = ALL_RES[k];
        const v = st[res] + d[k];
        if (v < 0) {
          if (res !== 'money') n.shortage[CATEGORY_OF[res]] = true;
          st[res] = 0;
        } else st[res] = v;
      }
      // Provinzunterhalt stur nach Verbrauchsregler: jeder Rohstoff zahlt nur seinen eingestellten Anteil.
      // Fehlt er, springen die anderen nicht ein – es entsteht ein Engpass (Moral sinkt), dafür lässt sich
      // ein Rohstoff gezielt aufstapeln (z. B. Holz auf 0 % stellen, um bauen zu können).
      const u = this.upkeepPerTick[id];
      const shares = this.shareList[id];
      for (let c = 0; c < CATEGORIES.length; c++) {
        const list = CATEGORY_RES[CATEGORIES[c]];
        const sh = shares[c];
        let need = u;
        for (let k = 0; k < list.length; k++) {
          if (sh[k] <= 0) continue;
          const take = Math.min(st[list[k]], u * sh[k]);
          st[list[k]] -= take;
          need -= take;
        }
        if (need > 1e-9) n.shortage[CATEGORIES[c]] = true;
      }
    }
  }

  private completions(): void {
    const s = this.state;
    s.provinces.forEach((ps, i) => {
      const c = ps.construction;
      if (c && c.end <= s.time) {
        ps.buildings[c.building] = c.level;
        ps.construction = null;
        const def = BUILDINGS[c.building];
        this.log(`${def.name}${def.maxLevel > 1 ? ' Stufe ' + c.level : ''} in ${this.map.provinces[i].name} fertiggestellt.`, ps.owner, i);
        this.invalidateRates();
        this.startBuild(i);
      }
      const o = ps.queue[0];
      if (o?.end !== undefined && o.end <= s.time) {
        ps.queue.shift();
        this.spawn(i, ps.owner, o.unit, 1);
        this.log(`${UNITS[o.unit].name} in ${this.map.provinces[i].name} aufgestellt.`, ps.owner, i);
        if (ps.repeat) ps.queue.push({ unit: o.unit });
        this.dirty = true;
        this.startOrder(i);
      }
    });
  }

  /** Startet den vordersten Auftrag, falls bezahlbar und möglich. */
  private startOrder(i: number): void {
    const ps = this.state.provinces[i];
    const o = ps.queue[0];
    if (!o || o.start !== undefined) return;
    if (requirementsMet(this.state, this.map, i, o.unit)) return;
    const stock = this.state.nations[ps.owner].stock;
    const cost = UNITS[o.unit].cost;
    if (!canAfford(stock, cost)) return;
    pay(stock, cost);
    o.start = this.state.time;
    o.end = this.state.time + Math.round(unitHours(this.state, i, o.unit) * HOUR);
    this.dirty = true;
  }

  /**
   * Bauschleife: das nächste geplante Gebäude beginnen, sobald nichts im Bau ist und die Kosten
   * gedeckt sind. Nicht mehr mögliche Einträge (Höchststufe, Voraussetzung fehlt) entfallen.
   */
  private startBuild(i: number): void {
    const ps = this.state.provinces[i];
    while (!ps.construction && ps.buildQueue.length) {
      const b = ps.buildQueue[0];
      const blocker = buildBlocker(this.map, i, b, ps.buildings);
      if (blocker) {
        ps.buildQueue.shift();
        this.log(`Geplanter Bau ${BUILDINGS[b].name} in ${this.map.provinces[i].name} entfällt: ${blocker}.`, ps.owner, i);
        continue;
      }
      const level = ps.buildings[b] + 1;
      const cost = BUILDINGS[b].cost(level);
      const stock = this.state.nations[ps.owner].stock;
      if (!canAfford(stock, cost)) return;
      pay(stock, cost);
      ps.buildQueue.shift();
      ps.construction = { building: b, level, start: this.state.time, end: this.state.time + Math.round(buildHours(ps, b, level) * HOUR) };
      this.dirty = true;
    }
  }

  private startWaitingOrders(): void {
    for (let i = 0; i < this.state.provinces.length; i++) {
      const ps = this.state.provinces[i];
      const o = ps.queue[0];
      if (o && o.start === undefined) this.startOrder(i);
      if (!ps.construction && ps.buildQueue.length) this.startBuild(i);
    }
  }

  spawn(province: number, owner: string, unit: UnitType, count: number): void {
    const s = this.state;
    const naval = !!UNITS[unit].naval;
    // Schiffe entstehen im Wasser vor dem Hafen
    const node = naval ? harborSea(this.map, province) ?? province : province;
    let army = s.armies.find((a) => a.owner === owner && a.node === node && !a.move && !a.pos && !a.target && isNaval(a) === naval);
    if (!army) {
      army = { id: s.nextArmyId++, owner, node, units: {} };
      s.armies.push(army);
    }
    // neue Infanterie bringt die Moral ihrer Provinz mit
    if (unit === 'infantry') army.morale = mixMorale(army, count, s.provinces[province]?.morale ?? TROOP_MORALE.start);
    army.units[unit] = (army.units[unit] ?? 0) + count;
    // Schlachtschiffe und Eisenbahngeschütze tragen eigene Namen
    if ((unit === 'battleship' || unit === 'railgun') && !army.name) army.name = unitName(s, this.map, owner, unit);
    this.invalidateRates();
  }

  /** Stündlich: Wehramt und Kaserne stellen Infanterie auf (ohne Kosten). */
  private recruitInfantry(): void {
    this.state.provinces.forEach((ps, i) => {
      const h = recruitHours(ps, this.map.provinces[i].double);
      if (h === null) return;
      ps.recruit += 1 / h;
      while (ps.recruit >= 1) {
        ps.recruit -= 1;
        this.spawn(i, ps.owner, 'infantry', 1);
      }
    });
  }

  /**
   * Wer entscheidet für eine Nation: ein registrierter Controller, sonst die eingebaute KI.
   * Externe Nationen ohne verbundenes Modell (z. B. während der Nachsimulation) übernimmt die KI;
   * die Spielernation nur, wenn sie ausdrücklich auf KI gestellt ist.
   */
  controllerOf(id: string): Controller | null {
    const n = this.state.nations[id];
    if (n.controller === 'human') return null;
    const own = this.controllers.get(id);
    if (own) return own;
    return n.controller === 'ai' || id !== this.state.playerNation ? this.defaultAI : null;
  }

  /** Aktuelle Beobachtung einer Nation (für externe Modelle). */
  observation(id: string): Observation {
    this.refresh();
    return observe({ state: this.state, map: this.map, nation: id, rates: this.rates[id], random: () => nextRandom(this.state) });
  }

  /** Regler mit Fokus nach den aktuellen Raten einstellen (siehe focusShares) */
  private applyFocus(id: string): void {
    const n = this.state.nations[id];
    if (!n.consumptionFocus || !n.alive) return;
    this.refresh();
    const r = this.rates[id];
    if (!r) return;
    let changed = false;
    for (const cat of Object.keys(n.consumptionFocus) as Category[]) {
      const focus = n.consumptionFocus[cat];
      if (!focus) continue;
      const shares = focusShares(cat, focus, r);
      for (const x of CATEGORY_RES[cat]) {
        if ((n.consumption[x] ?? 0) !== (shares[x] ?? 0)) {
          n.consumption[x] = shares[x] ?? 0;
          changed = true;
        }
      }
    }
    if (changed) {
      this.invalidateRates();
      this.refresh();
    }
  }

  private runControllers(): void {
    this.batch = true;
    try {
      this.runControllersBatch();
    } finally {
      this.batch = false;
    }
    this.refresh();
  }

  private runControllersBatch(): void {
    const hour = Math.floor(this.state.time / HOUR);
    const interval = DIFFICULTY[this.state.difficulty].interval;
    this.nationIds.forEach((id, idx) => {
      const n = this.state.nations[id];
      if (!n.alive || n.controller === 'human') return;
      const ctrl = this.controllerOf(id);
      if (!ctrl) return;
      if (ctrl === this.defaultAI && (hour + idx) % interval !== 0) return;
      this.refresh();
      const view: NationView = {
        state: this.state, map: this.map, nation: id, rates: this.rates[id],
        random: () => nextRandom(this.state),
      };
      for (const a of ctrl.decide(view)) this.apply(id, a);
    });
  }

  /**
   * Tageswechsel: Moral der Infanterie nähert sich ihrem Ziel – in eigener Provinz deren Moral,
   * auf See, auf Wegen oder in fremdem Gebiet 50 %, ohne Getreide deutlich weniger.
   */
  /** Verlegung der Hauptstadt abschließen */
  private capitalMoves(): void {
    for (const id of this.nationIds) {
      const n = this.state.nations[id];
      const m = n.capitalMove;
      if (!m || m.end > this.state.time) continue;
      n.capitalMove = null;
      if (this.state.provinces[m.province].owner !== id) continue;
      n.capital = m.province;
      const name = this.map.nations.find((x) => x.id === id)?.name ?? id;
      this.log(`${name} verlegt die Hauptstadt nach ${this.map.provinces[m.province].name}.`, undefined, m.province);
      this.invalidateRates();
    }
  }

  private troopMorale(): void {
    const s = this.state;
    for (const a of s.armies) {
      if (a.owner === REBELS || !(a.units.infantry ?? 0)) continue;
      a.morale =nextTroopMorale(a.morale ?? TROOP_MORALE.start, troopTarget(s, this.map, a));
    }
  }

  private dayChange(): void {
    const s = this.state;
    const targets = s.provinces.map((_, i) => moraleTarget(s, this.map, i).target);
    s.provinces.forEach((ps, i) => {
      ps.morale = stepMorale(ps.morale, targets[i]);
      delete ps.fought;
      delete ps.battleDays; // aus älteren Spielständen
      if (ps.morale < DEFECTION.threshold) this.log(`Unruhen in ${this.map.provinces[i].name} (Moral ${Math.round(ps.morale * 100)} %): Die Provinz droht überzulaufen.`, ps.owner, i);
    });
    this.troopMorale();
    repairMachines(s, this.map);
    defections(this.ctx);
    for (const id of this.nationIds) {
      const n = s.nations[id];
      for (const c of Object.keys(n.shortage) as Category[]) {
        if (n.shortage[c]) this.log(`Engpass bei ${c === 'food' ? 'Nahrung' : c === 'materials' ? 'Baustoffen' : 'Energie'}: Die Moral sinkt.`, id);
      }
      n.points = 0;
    }
    s.provinces.forEach((ps, i) => (s.nations[ps.owner].points += provincePoints(this.map, ps, i)));
    for (const id of this.nationIds) {
      const n = s.nations[id];
      n.shortage = { food: false, materials: false, energy: false };
      n.alive = s.provinces.some((p) => p.owner === id);
    }
    this.checkVictory();
    publishNewspaper(s, this.map);
    this.invalidateRates();
  }

  /**
   * Scheidet ein menschlicher Spieler aus, endet das Spiel ebenfalls (Sieger ist der Punktbeste).
   * Scheidet der Spieler aus, endet das Spiel ebenfalls (Sieger ist der Punktbeste).
   */
  private checkVictory(): void {
    const s = this.state;
    if (s.winner) return;
    // Sieg: wer VICTORY_SHARE aller Provinzen hält; Rangfolge nach Zahl der Provinzen
    const count = provinceCounts(s);
    const best = this.map.nations.filter((n) => s.nations[n.id].alive).sort((a, b) => (count[b.id] ?? 0) - (count[a.id] ?? 0))[0];
    let winner: string | null = null;
    if (best && (count[best.id] ?? 0) >= VICTORY_SHARE * s.provinces.length) winner = best.id;
    else if (s.nations[s.playerNation].controller === 'human' && !s.nations[s.playerNation].alive && best) winner = best.id;
    if (!winner) return;
    s.winner = winner;
    s.paused = true;
    const name = this.map.nations.find((n) => n.id === winner)?.name ?? winner;
    this.log(`${name} gewinnt den Kampf um die Vorherrschaft!`);
  }
}
