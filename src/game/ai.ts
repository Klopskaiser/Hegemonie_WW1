// Eingebaute KI: Wirtschaft (Gebäude nach Rendite), Fertigung, Börse, Diplomatie (Kriegsziele, Bündnisse,
// Bündnisfall, Verrat) und strategische Truppenführung (Fronten, Verteidigung, Sammeln vor dem Angriff,
// Artilleriebatterien hinter der Front, Landungen, Flotten, Eisenbahngeschütze).
// Persönlichkeit je Nation (state.aiProfiles) und Schwierigkeitsgrad (state.difficulty).

import { checkBuild, checkProduce, canAfford, pay, plannedBuildings, type Action, checkRepair } from './actions.ts';
import {
  BUILDINGS, CATEGORIES, CATEGORY_RES, DAY, DIFFICULTY, HOUR, MARKET, PROVINCE, UNITS, CAPITAL_MOVE, FORTRESS_REDUCTION, START_INFANTRY,
  type Building, type Cost, type Res, type UnitType,
} from './balance.ts';
import type { Controller, NationView } from './controller.ts';
import { atWar, enemiesOf, relation, relationRank, warKey } from './diplomacy.ts';
import { netRate, provinceOutput, toShares, activeCapital, capitalOf, provincePoints } from './economy.ts';
import { distanceKm, RESOURCES, type MapData, type Resource } from './mapdata.ts';
import { priceBounds, priceOf, tradeableOffers } from './market.ts';
import { isSea, nodeDist } from './graph.ts';
import { armyPower, fracBefore, isNaval, isRailOnly, pathsFrom, pathTo, unitCount, type PathTree } from './military.ts';
import type { AIProfile, Army, GameState, Relation } from './types.ts';
import { armyVisible, visibleNodes, type Sight } from './visibility.ts';

/** Friedenszeit zu Spielbeginn, bevor KI-Großmächte Kriege beginnen (gegen Kleinstaaten) */
const PEACE_TIME = 3 * DAY;
/** ab dann auch Kriege zwischen Großmächten (vorher Aufbau und Kleinstaaten) */
const MAJOR_WAR_TIME = 6 * DAY;

const MONEY_RESERVE = 1500;
/** längster Angriffs- bzw. Verlegungsweg in Stunden */
const REACH_HOURS = 72;
/** Mindeststärke eines Angriffs auf feindliche Provinzen (≈ 10 Infanteristen); kleinere Überschüsse sammeln sich */
const MIN_STRIKE = 12;
/** Mindestrendite eines Gebäudes: Ertrag je Tag in Promille der Baukosten (11 ≈ in 90 Tagen bezahlt) */
const MIN_BUILD_SCORE = 11;
const DEFAULT_PROFILE: AIProfile = { aggression: 1, caution: 1 };
const FACTORY_BONUS = [0, 0.08, 0.16, 0.25, 0.33];

/** Lagebild einer Nation für eine Entscheidungsrunde */
interface Situation {
  state: GameState;
  map: MapData;
  nation: string;
  major: boolean;
  profile: AIProfile;
  diff: (typeof DIFFICULTY)[keyof typeof DIFFICULTY];
  day: number;
  own: number[];
  enemies: string[];
  /** sichtbare feindliche Kampfkraft je Knoten (nur stehende Armeen) */
  hostile: Map<number, number>;
  /** sichtbare feindliche Armeen auf dem Marsch in eine eigene Provinz: Kampfkraft je Zielprovinz */
  incoming: Map<number, number>;
  /** eigene Frontprovinzen (grenzen an Kriegsgegner oder werden bedroht) mit Bedrohung */
  front: Map<number, number>;
  /** eigene Kampfkraft je Knoten, inklusive Armeen auf dem Weg dorthin */
  friendly: Map<number, number>;
  /** eigene Sicht (Nebel des Krieges) */
  vis: Sight;
  /** Kampfkraft aller Armeen je Nation */
  power: Map<string, number>;
  /** Nationen mit gemeinsamer Landgrenze */
  landNeighbors: Set<string>;
  /** Tagesbilanz eines Rohstoffs */
  net: (r: Resource) => number;
  foodShort: boolean;
  /** Spitzenreiter nach Provinzen, wenn er klar vorne liegt (gemeinsames Ziel für Bündnisse) */
  leader: string | null;
  /** Landgrenzen zwischen allen Nationen */
  borders: Map<string, Set<string>>;
  /** Einkaufsliste der Bauplanung: Rohstoffe, an denen lohnende Bauten scheitern (die Börse kauft sie zu) */
  wanted: Partial<Record<Resource, number>>;
  /** Baustoffe (Holz, Eisen) knapp: Bilanz negativ */
  materialsShort: boolean;
}

const isMajorNation = (map: MapData, id: string) => !!map.nations.find((n) => n.id === id)?.major;

/**
 * Börsenpreis für die Planung, gedämpft (Wurzel des Abstands zum Richtpreis): knappe Rohstoffe zählen spürbar mehr,
 * einzelne Ausreißer an der Börse werfen aber nicht die ganze Bauplanung um
 */
function fairPrice(state: GameState, r: Resource): number {
  const base = MARKET.basePrice[r];
  return base * Math.sqrt(priceOf(state, r) / base);
}

/** Wert von Kosten zu (gedämpften) Börsenpreisen (Geld 1:1) */
function costValue(state: GameState, cost: Cost): number {
  let v = 0;
  for (const r of Object.keys(cost) as Res[]) v += (cost[r] ?? 0) * (r === 'money' ? 1 : fairPrice(state, r as Resource));
  return Math.max(1, v);
}

/** Ist das eine reine Fernkampftruppe (Artilleriebatterie), die nicht in den Nahkampf gehört? */
const isBattery = (a: Army) => !isNaval(a) && !isRailOnly(a) && unitCount(a) > 0
  && Object.keys(a.units).every((u) => UNITS[u as UnitType].range > 0 && !UNITS[u as UnitType].naval);

export class BasicAI implements Controller {
  readonly name = 'Standard-KI';

  decide(view: NationView): Action[] {
    const sit = this.situation(view);
    const actions: Action[] = [];
    this.build(view, sit, actions);
    this.produce(view, sit, actions);
    this.diplomacy(view, sit, actions);
    this.alliances(view, sit, actions);
    this.trade(view, sit, actions);
    this.consumption(view, actions);
    const busy = new Set<number>();
    this.military(view, sit, actions, busy);
    this.batteries(view, sit, actions, busy);
    this.fleets(view, sit, actions);
    this.railguns(view, sit, actions);
    return actions;
  }

  private situation(view: NationView): Situation {
    const state = view.state as GameState;
    const { map, nation } = view;
    const own: number[] = [];
    state.provinces.forEach((ps, i) => ps.owner === nation && own.push(i));
    const enemies = enemiesOf(state, nation).filter((e) => state.nations[e]?.alive);
    const vis = visibleNodes(state, map, nation);
    const hostile = new Map<number, number>();
    const friendly = new Map<number, number>();
    const incoming = new Map<number, number>();
    const power = new Map<string, number>();
    for (const b of state.armies) {
      const p = armyPower(b);
      power.set(b.owner, (power.get(b.owner) ?? 0) + p);
      if (b.owner === nation) {
        const at = b.move ? b.move.path[b.move.path.length - 1] : b.node;
        friendly.set(at, (friendly.get(at) ?? 0) + p);
        continue;
      }
      if (!atWar(state, nation, b.owner) || !armyVisible(state, map, nation, b, vis)) continue;
      if (b.move) {
        // anrückender Feind: zählt für die Provinz, auf die er zuhält (auch eine Landung)
        const dest = b.move.then?.length ? b.move.then[b.move.then.length - 1] : b.move.path[b.move.path.length - 1];
        if (!isSea(map, dest) && state.provinces[dest].owner === nation) incoming.set(dest, (incoming.get(dest) ?? 0) + p);
        continue;
      }
      hostile.set(b.node, (hostile.get(b.node) ?? 0) + p);
    }
    const borders = new Map<string, Set<string>>();
    state.provinces.forEach((ps, i) => {
      for (const n of map.provinces[i].neighbors) {
        const o = state.provinces[n].owner;
        if (o !== ps.owner) (borders.get(ps.owner) ?? borders.set(ps.owner, new Set()).get(ps.owner)!).add(o);
      }
    });
    const landNeighbors = borders.get(nation) ?? new Set<string>();
    const front = new Map<number, number>();
    for (const i of own) {
      const ns = map.provinces[i].neighbors;
      const enemyNeighbors = ns.filter((n) => atWar(state, nation, state.provinces[n].owner)).length;
      const threat = (hostile.get(i) ?? 0) + (incoming.get(i) ?? 0) + ns.reduce((t, n) => t + (hostile.get(n) ?? 0), 0);
      // auch ohne sichtbare Feinde gilt eine Grenze zum Kriegsgegner als Front
      if (enemyNeighbors > 0 || threat > 0) front.set(i, threat + enemyNeighbors * 2);
    }
    const stock = state.nations[nation].stock;
    const net = (r: Resource) => netRate(view.rates, r);
    const foodShort = net('grain') < 0 || net('fish') < 0 || stock.grain < 3000;
    // Spitzenreiter: deutlich mehr Provinzen als die nächstbeste Nation
    const count = new Map<string, number>();
    for (const ps of state.provinces) count.set(ps.owner, (count.get(ps.owner) ?? 0) + 1);
    const ranked = [...count.entries()].filter(([n]) => n !== nation && state.nations[n]?.alive).sort((a, b) => b[1] - a[1]);
    const leader = ranked.length > 1 && ranked[0][1] >= Math.max(ranked[1][1] * 1.4, own.length * 1.3, 14) ? ranked[0][0] : null;
    return {
      state, map, nation,
      major: isMajorNation(map, nation),
      profile: state.aiProfiles?.[nation] ?? DEFAULT_PROFILE,
      diff: DIFFICULTY[state.difficulty ?? 'normal'],
      day: state.time / DAY,
      own, enemies, hostile, incoming, front, friendly, vis, power, landNeighbors, net, foodShort, leader, borders,
      wanted: {}, materialsShort: net('lumber') < 0 || net('iron') < 0,
    };
  }

  // ------------------------------------------------ Bauen

  /**
   * Wert eines Rohstoffs für die Bauplanung: Börsenpreis mal Bedarf. Nahrung zählt bei Mangel doppelt bis dreifach,
   * Baumaterial (Holz, Eisen) am Anfang fast doppelt – so werden zuerst die Provinzen ausgebaut, die den weiteren
   * Ausbau bezahlen. Große Überschüsse zählen weniger.
   */
  private resValue(sit: Situation, r: Resource): number {
    const n = sit.net(r), stock = sit.state.nations[sit.nation].stock[r];
    let w = 1;
    if (r === 'grain' || r === 'fish') {
      if (n < 0) w = stock < -n * 5 ? 3 : 2;
      else if (n > 3000 && stock > 40000) w = 0.6;
    } else {
      // Baustoffe: bei Mangel immer zuerst (Holz und Eisen bezahlen jeden weiteren Ausbau), sonst am Anfang
      if (r === 'lumber' || r === 'iron') w = sit.materialsShort ? 2 : sit.day < 12 ? 1.8 : 1.2;
      else if ((r === 'coal' || r === 'oil') && n < 0) w = 1.8;
      if (n > 4000 && stock > 80000) w *= 0.6;
    }
    return fairPrice(sit.state, r) * w;
  }

  /** Provinzen für Fabriken: Großmächte die Hauptstadt und zwei weitere Städte, Kleinstaaten die Hauptstadt */
  private factorySites(sit: Situation): Set<number> {
    const { state, map, own, major } = sit;
    const max = major ? 3 : 1;
    const sites = new Set<number>();
    for (const i of own) {
      const pl = plannedBuildings(state.provinces[i]);
      if (pl.factory > 0 || (pl.workshop > 0 && pl.manufactory === 0)) sites.add(i);
    }
    const rank = (i: number) => (map.provinces[i].capital ? 1e6 : 0) + (map.provinces[i].city ? 1e5 : 0) + (map.provinces[i].double ? 5e4 : 0)
      + (sit.front.has(i) ? -2e5 : 0);
    for (const i of [...own].sort((a, b) => rank(b) - rank(a))) {
      if (sites.size >= max) break;
      if (plannedBuildings(state.provinces[i]).manufactory > 0) continue;
      sites.add(i);
    }
    return sites;
  }

  /** Bewertung eines Gebäudes: Ertrag je Tag in Promille der Baukosten plus strategische Punkte im selben Maßstab */
  private buildScore(sit: Situation, i: number, b: Building, level: number, cost: Cost, sites: Set<number>, heavySite: number | null): number {
    const { state, map, major, front, nation } = sit;
    const ps = state.provinces[i], mp = map.provinces[i];
    const size = mp.double ? 2 : 1;
    const out = provinceOutput(map, ps, i);
    const v = this.resValue(sit, mp.resource);
    const base = PROVINCE.resourceBase * size * ps.morale;
    const prod = (d: number) => base * d * v;
    const morale = (d: number) => d * (PROVINCE.resourceBase * size * (1 + out.bonus) * v + PROVINCE.moneyPerMoralePct * 100 * size);
    const threat = front.get(i) ?? 0;
    // echte Bedrohung: sichtbare Feinde hier, nebenan oder im Anmarsch (nicht schon jede Grenze zum Kriegsgegner)
    const danger = (sit.hostile.get(i) ?? 0) + (sit.incoming.get(i) ?? 0) + mp.neighbors.reduce((t, n) => t + (sit.hostile.get(n) ?? 0), 0);
    const atWarNow = sit.enemies.length > 0;
    let gain = 0, extra = 0;
    switch (b) {
      case 'railroad': {
        const coalTight = sit.net('coal') < BUILDINGS.railroad.upkeep!.coal! && mp.resource !== 'coal';
        gain = prod(0.33) + morale(0.07) - BUILDINGS.railroad.upkeep!.coal! * fairPrice(state, 'coal') * (coalTight ? 2 : 1);
        // Schienen bringen Truppen schnell an die Front und tragen die Eisenbahngeschütze
        if (major && (front.has(i) || mp.capital)) extra += 6;
        break;
      }
      case 'harbor': {
        gain = prod(0.25) + morale(0.07);
        const anyHarbor = sit.own.some((k) => plannedBuildings(state.provinces[k]).harbor > 0);
        if (major && !anyHarbor) extra += 8; // Flotte und Landungen
        break;
      }
      case 'tradepost':
        gain = prod(0.08) + out.money * 0.08 + morale(0.02) - BUILDINGS.tradepost.upkeep!.fish! * fairPrice(state, 'fish') * (sit.net('fish') < 0 ? 3 : 1);
        break;
      case 'manufactory':
        if (sites.has(i)) return 0; // Fabrikstandorte bleiben frei
        gain = prod(0.11) + morale(0.025);
        break;
      case 'workshop':
        // nur als Voraussetzung einer geplanten Fabrik (Stufe 2 nur am Standort schwerer Fertigung im Krieg)
        if (!sites.has(i)) return 0;
        if (level === 1) extra = 60;
        else if (major && atWarNow && ps.buildings.factory >= 2) extra = 8;
        else return 0;
        break;
      case 'factory':
        if (!sites.has(i)) return 0;
        gain = prod(FACTORY_BONUS[level] - FACTORY_BONUS[level - 1]) + morale(0.025);
        if (level === 1) extra = major ? 40 : 25;
        else if (level === 2 && major) extra = 15;
        else if (level === 3 && major && sit.diff.heavy && i === heavySite && sit.day >= 6) extra = 30;
        break;
      case 'barracks': {
        // Kaserne: mehr Infanterie, kostet 1000 Getreide am Tag – nur bei klarem Überschuss
        if (sit.net('grain') < BUILDINGS.barracks.upkeep!.grain! * 1.5) return 0;
        extra = (level === 1 ? 25 : 15) * ps.morale * (threat > 0 || mp.capital ? 1.4 : 1);
        break;
      }
      // zerstörtes Wehramt im Kernland hat Vorrang; in erobertem Land nur bei Getreideüberschuss (jede Infanterie isst)
      case 'recruitment': extra = mp.nation === nation || sit.net('grain') > 1500 ? 200 : 0; break;
      case 'fortress': {
        const maxFortress = state.difficulty === 'hard' ? 3 : 2;
        if (mp.capital && level <= 2 && (atWarNow || danger > 0)) extra = 25;
        else if (danger > 0 && level <= maxFortress) extra = Math.min(30, 12 + danger * 0.1) * sit.profile.caution / level;
        else if (atWarNow && level === 1 && mp.city && mp.neighbors.some((n) => atWar(state, nation, state.provinces[n].owner))) extra = 8;
        // Festungen kosten Eisen – bei knappen Baustoffen haben Eisenbahn und Co. Vorrang (außer in der Hauptstadt)
        if (sit.materialsShort && !mp.capital) extra *= 0.5;
        break;
      }
      case 'office':
        if (mp.capital && state.nations[nation].stock.money > 150000) extra = 10;
        break;
    }
    return (gain > 0 ? (1000 * gain) / costValue(state, cost) : 0) + extra;
  }

  private build(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, own, major, front } = sit;
    const real = state.nations[nation].stock;
    // beschädigte Gebäude zuerst reparieren (sie wirken sonst nicht)
    for (const i of own) {
      for (const b of Object.keys(state.provinces[i].damage ?? {}) as Building[]) {
        if (checkRepair(state, nation, i, b).ok) actions.push({ type: 'repair', province: i, building: b });
      }
    }
    // Hauptstadt verloren: in die wertvollste sichere eigene Provinz verlegen
    if (capitalOf(state, map, nation) === null && !state.nations[nation].capitalMove && canAfford(real, CAPITAL_MOVE.cost)) {
      const safe = own.filter((i) => !front.get(i) && !state.provinces[i].revolt);
      const pick = (safe.length ? safe : own).reduce<number | null>((b, i) => (b === null || provincePoints(map, state.provinces[i], i) > provincePoints(map, state.provinces[b], b) ? i : b), null);
      if (pick !== null) actions.push({ type: 'moveCapital', province: pick });
    }
    // Kasernen (1000 Getreide je Stufe und Tag) und Wehrämter: bei Getreidemangel abschalten, bei Überschuss wieder an.
    // Großmächte lassen ihre Wehrämter immer an – statt die Truppen auszudünnen, erobern sie Getreideland.
    const grainNet = sit.net('grain');
    const starving = grainNet < 0 && real.grain < -grainNet * 5, plenty = grainNet > 1500 && real.grain > 10000;
    for (const i of own) {
      const ps = state.provinces[i];
      for (const b of ['barracks', 'recruitment'] as const) {
        if (ps.buildings[b] <= 0) continue;
        if (b === 'recruitment' && major) {
          if (ps.off?.[b]) actions.push({ type: 'switchBuilding', province: i, building: b, on: true });
          continue;
        }
        if (!ps.off?.[b] && starving) actions.push({ type: 'switchBuilding', province: i, building: b, on: false });
        else if (ps.off?.[b] && plenty) actions.push({ type: 'switchBuilding', province: i, building: b, on: true });
      }
    }
    // Parallelbau: Grundzahl nach Provinzen, mit voller Kasse mehr
    const stock = { ...real };
    const constructing = own.filter((i) => state.provinces[i].construction).length;
    let slots = Math.min(5, Math.max(1, Math.ceil(own.length / (major ? 5 : 8))) + Math.floor(Math.max(0, stock.money - 40000) / 40000)) - constructing;
    if (slots <= 0) return;
    const reserve = MONEY_RESERVE + (sit.enemies.length ? 8000 : 0);
    const sites = this.factorySites(sit);
    const capital = activeCapital(state, map, nation);
    const heavySite = sites.has(capital) ? capital : [...sites][0] ?? null;
    const cands: { province: number; building: Building; score: number; cost: Cost }[] = [];
    for (const i of own) {
      const ps = state.provinces[i];
      if (ps.construction || ps.buildQueue.length) continue;
      for (const b of Object.keys(BUILDINGS) as Building[]) {
        const chk = checkBuild(state, map, nation, i, b);
        if (!chk.ok) continue;
        const score = this.buildScore(sit, i, b, chk.level, chk.cost, sites, heavySite) * (0.95 + view.random() * 0.1);
        if (score >= MIN_BUILD_SCORE) cands.push({ province: i, building: b, score, cost: chk.cost });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const used = new Set<number>();
    let blocked = 0;
    for (const c of cands) {
      if (slots <= 0) break;
      if (used.has(c.province)) continue;
      if (stock.money - (c.cost.money ?? 0) < reserve) continue;
      if (!canAfford(stock, c.cost)) {
        // Geld da, Rohstoffe fehlen: für die besten Vorhaben auf die Einkaufsliste
        if (blocked++ < 3) {
          for (const r of RESOURCES) {
            const lack = (c.cost[r] ?? 0) - stock[r];
            if (lack > 0) sit.wanted[r] = Math.max(sit.wanted[r] ?? 0, lack + 1000);
          }
        }
        continue;
      }
      actions.push({ type: 'build', province: c.province, building: c.building });
      pay(stock, c.cost);
      used.add(c.province);
      slots--;
    }
  }

  // ------------------------------------------------ Fertigung (Infanterie entsteht automatisch)

  private produce(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, own, enemies, major } = sit;
    const stock = { ...state.nations[nation].stock };
    let infantry = 0, machines = 0, queued = 0;
    const count: Partial<Record<UnitType, number>> = {};
    for (const a of state.armies) {
      if (a.owner !== nation) continue;
      for (const [u, n] of Object.entries(a.units) as [UnitType, number][]) {
        count[u] = (count[u] ?? 0) + n;
        if (u === 'infantry') infantry += n;
        else if (!UNITS[u].naval) machines += n;
      }
    }
    const free = new Set(own.filter((i) => state.provinces[i].queue.length === 0));
    for (const i of own) {
      for (const o of state.provinces[i].queue) {
        count[o.unit] = (count[o.unit] ?? 0) + 1;
        if (!UNITS[o.unit].naval) queued++;
      }
    }
    const oil = sit.net('oil');
    const order = (unit: UnitType): boolean => {
      const cost = UNITS[unit].cost;
      if (!canAfford(stock, cost)) return false;
      const site = [...free].find((i) => checkProduce(state, map, nation, i, unit).ok);
      if (site === undefined) return false;
      actions.push({ type: 'enqueue', province: site, unit });
      pay(stock, cost);
      free.delete(site);
      count[unit] = (count[unit] ?? 0) + 1;
      return true;
    };

    // schwere Einheiten: Großmächte im Krieg – Eisenbahngeschütze gegen Landnachbarn, Schlachtschiffe gegen Küstenmächte
    if (major && sit.diff.heavy && enemies.length) {
      const landFoe = enemies.some((e) => sit.landNeighbors.has(e));
      const enemyCoast = enemies.some((e) => state.provinces.some((ps, i) => ps.owner === e && map.provinces[i].coastal));
      const wants: [UnitType, number][] = [['railgun', landFoe ? 2 : 0], ['battleship', enemyCoast ? 3 : 0]];
      for (const [unit, limit] of wants) {
        if ((count[unit] ?? 0) >= limit) continue;
        if (stock.money < (UNITS[unit].cost.money ?? 0) + 20000) continue;
        if (oil < (unit === 'battleship' ? 30 : 10)) continue;
        if (order(unit)) break;
      }
    }

    // Technik-Anteil der Landtruppen: im Frieden wenig (Geld geht in den Ausbau), im Krieg ein knappes Drittel
    const share = enemies.length ? 0.3 : major ? 0.15 : 0.1;
    const threshold = enemies.length ? 12000 : 45000;
    let budget = 2;
    while (budget-- > 0 && machines + queued < (infantry + machines) * share && stock.money > threshold && oil > -150) {
      // Mischung: Artillerie für den Fernkampf, Panzerwagen und Panzer für den Nahkampf
      const art = count.artillery ?? 0, car = count.armoredCar ?? 0, tank = count.tank ?? 0;
      const mech = art + car + tank + 1;
      let unit: UnitType = art / mech < 0.4 ? 'artillery' : 'armoredCar';
      if (unit === 'armoredCar' && oil > 80 && tank <= car && view.random() < 0.6) unit = 'tank';
      if (oil <= 0) unit = 'artillery';
      if (!order(unit) && !(unit !== 'artillery' && order('artillery'))) break;
      queued++;
    }
  }

  // ------------------------------------------------ Diplomatie

  private diplomacy(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, major, enemies, profile, diff, power } = sit;
    const pow = (n: string) => power.get(n) ?? 0;
    const mine = pow(nation);
    const stock = state.nations[nation].stock;
    // Wert eines Tributs zu Börsenpreisen (Geld zählt 1:1); nur, was der Anbieter auch zahlen kann
    const worth = (p: { from: string; tribute?: Partial<Record<Res, number>> }) => {
      if (!p.tribute || !canAfford(state.nations[p.from].stock, p.tribute)) return 0;
      return (Object.keys(p.tribute) as Res[]).reduce((s, r) => s + p.tribute![r]! * (r === 'money' ? 1 : fairPrice(state, r as Resource)), 0);
    };
    // Angebote beantworten – nach Interessenlage, nicht nach Zufall
    for (const p of state.proposals.filter((x) => x.to === nation)) {
      const theirs = pow(p.from);
      const w = worth(p);
      let accept: boolean;
      if (p.kind === 'peace') {
        const age = state.time - (state.warSince[warKey(nation, p.from)] ?? state.time);
        // der Stärkere nimmt nur gegen Tribut oder bei einem zweiten, wichtigeren Krieg an, der Schwächere gern
        const price = 15000 * profile.aggression * Math.max(1, mine / Math.max(1, theirs));
        const otherWar = enemies.some((e) => e !== p.from && pow(e) > theirs);
        accept = mine < theirs * 0.9 || w >= price || otherWar || (age > 6 * DAY && w >= price * 0.4);
      } else {
        const common = this.commonEnemy(sit, p.from) || this.commonRival(sit, p.from);
        const threat = sit.landNeighbors.has(p.from) && theirs > mine * 1.3;
        const room = this.allyCount(state, nation) < (major ? 2 : 1) && this.allyCount(state, p.from) < (isMajorNation(map, p.from) ? 2 : 1);
        if (p.kind === 'rightOfWay') accept = w >= 8000 || (common && !threat);
        else accept = w >= 15000 || (common && !threat && room);
      }
      actions.push({ type: 'answer', nation: p.from, accept });
    }
    // selbst Frieden anbieten: klar unterlegen (mit Tribut), in einem festgefahrenen Krieg oder an zwei Fronten
    const firstRound = state.time % DAY < diff.interval * HOUR;
    for (const e of enemies) {
      if (!firstRound || state.proposals.some((p) => p.from === nation && p.to === e)) continue;
      const theirs = pow(e);
      const age = state.time - (state.warSince[warKey(nation, e)] ?? state.time);
      const losing = mine < theirs * 0.5;
      const stalemate = age > 8 * DAY && mine < theirs * 1.3 && mine > theirs * 0.7;
      const twoFronts = enemies.length > 1 && enemies.some((x) => x !== e && pow(x) > theirs) && age > 2 * DAY;
      if (!(losing && view.random() < 0.5) && !(stalemate && view.random() < 0.25) && !(twoFronts && view.random() < 0.3)) continue;
      const share = losing ? 0.3 : mine < theirs ? 0.1 : 0;
      const money = Math.floor(Math.min(stock.money * share, 50000) / 1000) * 1000;
      actions.push({ type: 'propose', nation: e, kind: 'peace', ...(money >= 5000 ? { tribute: { money } } : {}) });
    }
    if (!major || state.time < PEACE_TIME) return;

    // ---- Verrat: ein schwacher, anderswo gebundener Bündnispartner an der eigenen Grenze ist eine Gelegenheit
    if (!enemies.length && profile.aggression >= 1) {
      for (const n of sit.landNeighbors) {
        const rel = relation(state, nation, n);
        if (rel !== 'rightOfWay' && rel !== 'sharedMap') continue;
        if (this.commonEnemy(sit, n) || !state.nations[n]?.alive) continue;
        const tied = enemiesOf(state, n).some((x) => state.nations[x]?.alive);
        if (!tied || mine < pow(n) * 2.2 * profile.caution) continue;
        if (view.random() < 0.02 * profile.aggression * diff.war) {
          actions.push({ type: 'downgrade', nation: n, to: 'peace' });
          actions.push({ type: 'declareWar', nation: n });
          return;
        }
      }
    }

    // ---- Kriegsziele: zuerst Kleinstaaten in Reichweite (Landnachbarn oder über See erreichbar), erst wenn dort
    // nichts mehr zu holen ist, größere Staaten. Bewertet nach Stärke (inkl. Verbündeter, gebundene Gegner,
    // Schutzmächte), Beute (Baustoffe bei Mangel, Nahrung bei Hunger) und Spitzenreiter. Höchstens zwei Kriege,
    // davon höchstens einer gegen eine Großmacht.
    const majorWars = enemies.filter((e) => isMajorNation(map, e)).length;
    if (enemies.length >= 2) return;
    const hungry = sit.net('grain') < 0 || stock.grain < 3000;
    // Reichweite: Marschstunden einer Infanterie ab der Hauptstadt (auch mit Einschiffen)
    const capital = activeCapital(state, map, nation);
    const reach = pathsFrom(state, map, { id: -1, owner: nation, node: capital, units: { infantry: 1 } }, capital, undefined, REACH_HOURS * 1.5);
    const candidates = new Set(sit.landNeighbors);
    for (let i = 0; i < map.provinces.length; i++) {
      const o = state.provinces[i].owner;
      if (o !== nation && !isMajorNation(map, o) && isFinite(reach.hours[i])) candidates.add(o);
    }
    const ownSet = new Set(sit.own);
    const loot = (k: number) => {
      const mp = map.provinces[k];
      let v = mp.capital ? 3 : mp.city ? 2 : 1;
      if (hungry && (mp.resource === 'grain' || mp.resource === 'fish')) v *= 2;
      if (sit.materialsShort && (mp.resource === 'lumber' || mp.resource === 'iron')) v *= 1.6;
      return v;
    };
    type Target = { n: string; score: number; partner: string | null; alone: boolean };
    let bestMinor: Target | null = null;
    let bestMajor: Target | null = null;
    for (const n of candidates) {
      if (!state.nations[n]?.alive || enemies.includes(n)) continue;
      if ((state.truceUntil[warKey(nation, n)] ?? 0) > state.time) continue;
      if (relationRank(relation(state, nation, n)) >= relationRank('rightOfWay')) continue; // Freunde nur per Verrat
      const isMajor = isMajorNation(map, n);
      if (isMajor && (majorWars > 0 || state.time < MAJOR_WAR_TIME)) continue;
      // Gegner samt Schutzmächten (Bündnispartner mit geteilter Karte stehen ihm bei)
      let theirs = pow(n) * (enemiesOf(state, n).some((x) => state.nations[x]?.alive) ? 0.65 : 1);
      for (const [x, r] of Object.entries(state.relations[n] ?? {})) if (r === 'sharedMap' && x !== nation && state.nations[x]?.alive) theirs += pow(x) * 0.4;
      const allies = this.alliedPower(sit, n);
      const threshold = (isMajor ? 1.3 : 1.8) * profile.caution;
      const ratio = (mine + allies) / Math.max(1, theirs);
      // möglicher Partner für ein gemeinsames Vorgehen (Bündnisangebot, falls es allein nicht reicht)
      const partner = ratio < threshold && isMajor ? this.partnerAgainst(sit, n) : null;
      const ratioWith = partner ? (mine + allies + pow(partner) * 0.6) / Math.max(1, theirs) : ratio;
      if (ratioWith < threshold) continue;
      // Beute: Provinzen des Gegners an unserer Grenze, bei Kleinstaaten auch die über See erreichbaren
      let gain = 0;
      state.provinces.forEach((ps, k) => {
        if (ps.owner !== n) return;
        const adjacent = map.provinces[k].neighbors.some((x) => ownSet.has(x));
        if (adjacent) gain += loot(k);
        else if (!isMajor && isFinite(reach.hours[k])) gain += loot(k) * 0.7;
      });
      if (gain <= 0) continue;
      const score = gain * (n === sit.leader ? 1.5 : 1) * Math.min(3, ratioWith / threshold);
      const entry: Target = { n, score, partner: ratio >= threshold ? null : partner, alone: ratio >= threshold };
      if (isMajor) { if (!bestMajor || score > bestMajor.score) bestMajor = entry; }
      else if (!bestMinor || score > bestMinor.score) bestMinor = entry;
    }
    const best: Target | null = bestMinor ?? bestMajor;
    if (!best) return;
    if (!best.alone && best.partner) {
      // erst den Partner gewinnen: Bündnis (geteilte Karte) anbieten; der Krieg folgt, sobald es steht
      const rel = relation(state, nation, best.partner);
      if (rel !== 'sharedMap' && !state.proposals.some((p) => p.from === nation && p.to === best!.partner) && this.offerDay(sit, best.partner)) {
        actions.push({ type: 'propose', nation: best.partner, kind: rel === 'peace' ? 'rightOfWay' : 'sharedMap' });
      }
      return;
    }
    // Zeitpunkt würfeln, das Ziel nicht: im Schnitt binnen ein, zwei Tagen nach Eintreten der Gelegenheit
    const chance = 0.05 * profile.aggression * diff.war * (hungry ? 2 : 1) * (diff.interval / 3);
    if (view.random() < chance) actions.push({ type: 'declareWar', nation: best.n });
  }

  /** Kampfkraft befreundeter Nationen, die gegen `target` ins Gewicht fällt (schon im Krieg mit ihm oder Bündnispartner an seiner Grenze) */
  private alliedPower(sit: Situation, target: string): number {
    const { state, nation, power } = sit;
    let sum = 0;
    for (const [x, p] of power) {
      if (x === nation || x === target || !state.nations[x]?.alive) continue;
      if (atWar(state, x, target)) sum += p * (relation(state, nation, x) === 'sharedMap' ? 0.6 : 0.3);
      else if (relation(state, nation, x) === 'sharedMap' && this.bordersNation(sit, x, target)) sum += p * 0.3;
    }
    return sum;
  }

  /** Grenzen zwei Nationen an Land aneinander? */
  private bordersNation(sit: Situation, a: string, b: string): boolean {
    return sit.borders.get(a)?.has(b) ?? false;
  }

  /** Großmacht, die ebenfalls an `target` grenzt, mit uns nicht verfeindet und mit ihm nicht befreundet ist */
  private partnerAgainst(sit: Situation, target: string): string | null {
    const { state, map, nation, power } = sit;
    let best: string | null = null, bp = 0;
    for (const n of map.nations) {
      const x = n.id;
      if (!n.major || x === nation || x === target || !state.nations[x]?.alive) continue;
      if (atWar(state, nation, x) || relationRank(relation(state, x, target)) >= relationRank('rightOfWay')) continue;
      if (!this.bordersNation(sit, x, target)) continue;
      if (enemiesOf(state, x).filter((e) => state.nations[e]?.alive).length >= 2) continue;
      const p = power.get(x) ?? 0;
      if (p > bp) { bp = p; best = x; }
    }
    return best;
  }

  /** Haben wir und `other` einen gemeinsamen Kriegsgegner? */
  private commonEnemy(sit: Situation, other: string): boolean {
    return sit.enemies.some((e) => atWar(sit.state, other, e));
  }

  /**
   * Gemeinsamer Rivale: eine Großmacht an beider Grenze, die der Spitzenreiter ist oder mit einem von beiden im Krieg
   * liegt und mindestens so stark ist wie der Stärkere von beiden
   */
  private commonRival(sit: Situation, other: string): boolean {
    const { state, map, nation, power } = sit;
    const strongest = Math.max(power.get(nation) ?? 0, power.get(other) ?? 0);
    for (const r of sit.landNeighbors) {
      if (r === other || !isMajorNation(map, r) || !state.nations[r]?.alive) continue;
      if (!this.bordersNation(sit, other, r)) continue;
      if (r !== sit.leader && !atWar(state, nation, r) && !atWar(state, other, r)) continue;
      if ((power.get(r) ?? 0) >= strongest * 0.8) return true;
    }
    return false;
  }

  /** Anzahl der Bündnispartner (geteilte Karte) */
  private allyCount(state: GameState, nation: string): number {
    return Object.entries(state.relations[nation] ?? {}).filter(([n, r]) => r === 'sharedMap' && state.nations[n]?.alive).length;
  }

  /** Bündnisangebote nur an einem von fünf Tagen je Partner und dann nur in der ersten Runde (kein Dauerangebot) */
  private offerDay(sit: Situation, partner: string): boolean {
    let h = 0;
    for (const c of sit.nation + partner) h = (h * 31 + c.charCodeAt(0)) | 0;
    const day = Math.floor(sit.state.time / DAY);
    return (day + Math.abs(h)) % 5 === 0 && sit.state.time % DAY < sit.diff.interval * HOUR;
  }

  /**
   * Bündnispolitik: Bündnisfall (Partner im Krieg mit einem gemeinsamen Nachbarn → beistehen), Schutzsuche der
   * Kleinstaaten bei einer Großmacht und Bündnisse gegen einen gemeinsamen Rivalen.
   */
  private alliances(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, major, enemies, power, profile } = sit;
    const mine = power.get(nation) ?? 0;
    // Bündnisfall: Partner mit geteilter Karte führt Krieg gegen einen unserer Nachbarn
    if (state.time >= PEACE_TIME && enemies.length < 2) {
      for (const [f, rel] of Object.entries(state.relations[nation] ?? {}) as [string, Relation][]) {
        if (rel !== 'sharedMap' || !state.nations[f]?.alive) continue;
        for (const y of enemiesOf(state, f)) {
          if (y === nation || !state.nations[y]?.alive || atWar(state, nation, y)) continue;
          if (!sit.landNeighbors.has(y)) continue;
          if (relationRank(relation(state, nation, y)) >= relationRank('rightOfWay')) continue;
          if ((state.truceUntil[warKey(nation, y)] ?? 0) > state.time) continue;
          if (isMajorNation(map, y) && (enemies.some((e) => isMajorNation(map, e)) || state.time < MAJOR_WAR_TIME)) continue;
          const ratio = (mine + (power.get(f) ?? 0) * 0.7) / Math.max(1, power.get(y) ?? 0);
          // Kleinstaaten stehen nur bei, wenn es sicher aussieht
          if (ratio < (major ? 1 : 1.6) * profile.caution) continue;
          if (view.random() < (major ? 0.25 : 0.12)) {
            actions.push({ type: 'declareWar', nation: y });
            return;
          }
        }
      }
    }
    if (state.proposals.some((p) => p.from === nation)) return;
    if (!major) {
      // Kleinstaat in Gefahr (Krieg oder übermächtiger Nachbar): Schutz bei einem Rivalen des Bedrohers suchen
      const threats = [...sit.landNeighbors].filter((n) => isMajorNation(map, n) && (atWar(state, nation, n) || (power.get(n) ?? 0) > mine * 4));
      for (const t of threats) {
        let pick: string | null = null, bp = 0;
        for (const n of map.nations) {
          const x = n.id;
          if (!n.major || x === t || !state.nations[x]?.alive || atWar(state, nation, x)) continue;
          if (relation(state, nation, x) === 'sharedMap' || relationRank(relation(state, x, t)) >= relationRank('rightOfWay')) continue;
          if (!this.bordersNation(sit, x, t)) continue;
          const p = power.get(x) ?? 0;
          if (p > bp) { bp = p; pick = x; }
        }
        if (pick && this.offerDay(sit, pick)) {
          actions.push({ type: 'propose', nation: pick, kind: relation(state, nation, pick) === 'peace' ? 'rightOfWay' : 'sharedMap' });
          return;
        }
      }
      return;
    }
    // Großmacht: Bündnis mit einem Nachbarn des gemeinsamen Rivalen (vor allem gegen den Spitzenreiter)
    for (const n of map.nations) {
      const x = n.id;
      if (!n.major || x === nation || !state.nations[x]?.alive || atWar(state, nation, x)) continue;
      if (relation(state, nation, x) === 'sharedMap') continue;
      if (relation(state, nation, x) === 'rightOfWay' && (this.allyCount(state, nation) >= 2 || this.allyCount(state, x) >= 2)) continue;
      if (!this.commonRival(sit, x) && !this.commonEnemy(sit, x)) continue;
      if (!this.offerDay(sit, x)) continue;
      actions.push({ type: 'propose', nation: x, kind: relation(state, nation, x) === 'peace' ? 'rightOfWay' : 'sharedMap' });
      return;
    }
  }

  // ------------------------------------------------ Verbrauchsregler

  /**
   * Provinzunterhalt auf die Rohstoffe verteilen, die reichlich vorhanden sind: Gewicht je Rohstoff
   * = Vorrat plus fünf Tage Bilanz ohne Provinzunterhalt; Öl wird für Einheiten geschont.
   */
  private consumption(view: NationView, actions: Action[]): void {
    const state = view.state as GameState;
    const { nation, rates } = view;
    const n = state.nations[nation];
    for (const cat of CATEGORIES) {
      const weights: Partial<Record<Resource, number>> = {};
      for (const r of CATEGORY_RES[cat]) {
        const free = rates.prod[r] - rates.cons[r];
        // Öl wird für Einheiten geschont, Getreide für die Infanterie (die nur Getreide isst)
        weights[r] = Math.max(0, n.stock[r] + 5 * free) * (r === 'oil' ? 0.3 : r === 'grain' ? 0.4 : 1);
      }
      // Nahrung: reicht beides nicht, deckt Fisch den Provinzunterhalt allein
      if (cat === 'food' && !(weights.grain! > 0) && !(weights.fish! > 0)) weights.fish = 1;
      const shares = toShares(cat, weights);
      const change = CATEGORY_RES[cat].some((r) => Math.abs((shares[r] ?? 0) - (n.consumption[r] ?? 0)) >= 10);
      if (change) actions.push({ type: 'setConsumption', category: cat, shares });
    }
  }

  // ------------------------------------------------ Börse

  /**
   * Börse: Engpässe zukaufen (vorhandene Angebote, sonst eigenes Kaufgesuch), auf Kaufgesuche
   * liefern und Überschüsse anbieten. Großzügiger, je voller die Kasse ist.
   */
  private trade(view: NationView, sit: Situation, actions: Action[]): void {
    const state = view.state as GameState;
    const { nation, rates } = view;
    const stock = state.nations[nation].stock;
    // eigene Angebote gelten unbegrenzt: nach einer Weile zurückziehen und zum aktuellen Kurs neu einstellen
    const stale = state.market.offers.filter((o) => o.nation === nation && state.time - o.time >= MARKET.aiRefresh);
    for (const o of stale) actions.push({ type: 'cancelOffer', id: o.id });
    const mine = state.market.offers.filter((o) => o.nation === nation && !stale.includes(o));
    let slots = MARKET.maxOffersPerNation - mine.length;
    let budget = stock.money - 15000;
    // mit voller Kasse dürfen Käufe teurer sein
    const rich = 1 + Math.min(2, stock.money / 500000);
    const round = (v: number, r: Resource) => {
      const [lo, hi] = priceBounds(r);
      return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
    };
    for (const r of RESOURCES) {
      const net = netRate(rates, r);
      const price = priceOf(state, r);
      // kaufen, wenn der Vorrat bei dieser Bilanz in wenigen Tagen aufgebraucht ist – mit voller Kasse auch
      // Baumaterial und Öl auf Vorrat, damit das Geld in Ausbau und Technik fließt statt zu liegen
      const stockpile = stock.money > 150000 && (r === 'lumber' || r === 'iron' || r === 'oil') ? 25000 : 0;
      const wanted = stock.money > 30000 ? (sit.wanted[r] ?? 0) + Math.max(0, stock[r]) : 0;
      const short = (net < 0 && stock[r] < -net * 5) || stock[r] < Math.max(3000, stockpile) || stock[r] < wanted;
      if (short) {
        // Zahlungsbereitschaft nach Dringlichkeit (Vielfaches des Richtpreises), mit voller Kasse mehr. Die Kurse
        // bleiben frei – die KI bietet nur nicht blind über dem letzten Kurs hinterher, wenn ihr der Rohstoff das
        // nicht wert ist (sonst schaukeln sich die Gebote gegenseitig bis zum Höchstpreis hoch).
        const food = r === 'grain' || r === 'fish';
        const urgency = food && net < 0 && stock[r] < -net * 3 ? 15 : net < 0 && stock[r] < -net * 5 ? 6 : wanted || stockpile ? 4 : 3;
        const willing = MARKET.basePrice[r] * urgency * rich;
        let need = Math.max(3000, -net * 4, stockpile, wanted) - Math.max(0, stock[r]);
        for (const offer of tradeableOffers(state, nation, r, 'sell')) {
          if (need < 100 || budget <= 0 || offer.price > willing) break;
          const amount = Math.min(offer.amount, need, Math.floor(budget / offer.price));
          if (amount < 100) break;
          actions.push({ type: 'acceptOffer', id: offer.id, amount });
          budget -= amount * offer.price;
          need -= amount;
        }
        // nichts Passendes: eigenes Kaufgesuch
        if (need >= MARKET.minAmount && slots > 0 && !mine.some((o) => o.side === 'buy' && o.res === r)) {
          const bid = round(Math.min(price * (1.05 + view.random() * 0.15), willing), r);
          const amount = Math.min(Math.floor(need), Math.floor(Math.max(0, budget) / bid), 20000);
          if (amount >= 500) {
            actions.push({ type: 'postOffer', side: 'buy', res: r, amount, price: bid });
            budget -= amount * bid;
            slots--;
          }
        }
        continue;
      }
      if (net < -100 || stock[r] <= 10000) continue;
      // auf Kaufgesuche anderer liefern
      let spare = stock[r] - 8000;
      for (const bid of tradeableOffers(state, nation, r, 'buy')) {
        if (spare < 100 || bid.price < price * 0.85) break;
        const amount = Math.min(bid.amount, spare);
        actions.push({ type: 'acceptOffer', id: bid.id, amount });
        spare -= amount;
      }
      // Überschuss anbieten
      if (spare > 5000 && slots > 0 && !mine.some((o) => o.side === 'sell' && o.res === r)) {
        const amount = Math.min(20000, Math.floor(spare * 0.6));
        actions.push({ type: 'postOffer', side: 'sell', res: r, amount, price: round(price * (0.9 + view.random() * 0.25), r) });
        slots--;
      }
    }
  }

  // ------------------------------------------------ Landtruppen

  /**
   * Je Standort: Artillerie als eigene Batterie abteilen, Besatzung zurücklassen und mit dem Überschuss
   * eigene Provinzen verteidigen (Kleinstaaten ziehen dafür alles Verfügbare heran), angreifen (auch über See),
   * sich vor einem lohnenden, aber zu starken Ziel sammeln oder als Reserve an die bedrohteste Front ziehen.
   */
  private military(_view: NationView, sit: Situation, actions: Action[], busy: Set<number>): void {
    const { state, map, nation, major, profile, diff, hostile, incoming, front, friendly } = sit;
    const mine = state.armies.filter((a) => a.owner === nation && !a.move && unitCount(a) > 0 && !isNaval(a));
    // Armeen am selben Ort zusammenlegen – Batterien nur mit Batterien
    const byNode = new Map<number, Army[]>();
    for (const a of mine) (byNode.get(a.node) ?? byNode.set(a.node, []).get(a.node)!).push(a);
    for (const group of byNode.values()) {
      for (const kind of [false, true]) {
        const merge = group.filter((a) => !a.target && !isRailOnly(a) && isBattery(a) === kind && !a.pos).sort((x, y) => armyPower(y) - armyPower(x));
        for (let k = 1; k < merge.length; k++) actions.push({ type: 'merge', army: merge[k].id, into: merge[0].id });
      }
    }
    const threatened = new Map<number, number>();
    for (const i of sit.own) {
      const t = (hostile.get(i) ?? 0) + (incoming.get(i) ?? 0);
      if (t > 0) threatened.set(i, t);
    }
    if (!sit.enemies.length && !threatened.size) return;

    const capital = activeCapital(state, map, nation);
    const superiority = diff.attack * profile.caution / Math.sqrt(profile.aggression);
    // übliche Besatzung, mit der in nicht einsehbaren Provinzen zu rechnen ist
    const assumed = armyPower({ id: 0, owner: nation, node: 0, units: { infantry: START_INFANTRY } });
    /** erwartete Verteidigung einer feindlichen Provinz: sichtbare Truppen, sonst die übliche Besatzung; Festung zählt mit */
    const defence = (n: number): number => {
      const ps = state.provinces[n];
      let d = hostile.get(n) ?? 0;
      const hidden = !sit.vis.has(n) || (ps.buildings.fortress >= 2 && !sit.vis.full.has(n));
      if (hidden) d = Math.max(d, assumed);
      return d / Math.max(0.25, 1 - FORTRESS_REDUCTION[ps.buildings.fortress]);
    };
    const hungry = sit.foodShort;
    for (const [node, group] of byNode) {
      if (isSea(map, node)) continue; // Truppen auf See führen ihren Befehl aus
      const land = group.filter((x) => !x.target && !isRailOnly(x) && !isBattery(x) && !x.pos);
      if (!land.length) continue;
      const a = land.reduce((x, y) => (armyPower(y) > armyPower(x) ? y : x));
      if ((hostile.get(node) ?? 0) > 0) continue; // Kampf am Ort: bleiben
      const units: Partial<Record<UnitType, number>> = {};
      for (const g of land) for (const u of Object.keys(g.units) as UnitType[]) units[u] = (units[u] ?? 0) + g.units[u]!;
      // Artillerie gehört nicht in den Nahkampf: als eigene Batterie abteilen (zieht der Armee hinterher)
      const guns = units.artillery ?? 0;
      const melee = Object.entries(units).filter(([u]) => UNITS[u as UnitType].range === 0).reduce((t, [, n]) => t + (n ?? 0), 0);
      if (guns > 0 && melee > 0) {
        actions.push({ type: 'split', army: a.id, units: { artillery: Math.min(guns, a.units.artillery ?? 0) }, apart: true });
        delete units.artillery;
      }
      const total = Object.entries(units).filter(([u]) => u !== 'artillery').reduce((t, [, n]) => t + (n ?? 0), 0);
      const border = map.provinces[node].neighbors.some((n) => state.provinces[n].owner !== nation);
      const near = map.provinces[node].neighbors.reduce((t, n) => t + (hostile.get(n) ?? 0), 0) + (incoming.get(node) ?? 0);
      // Besatzung: Großmächte knapp (der Rest greift an), Kleinstaaten ebenfalls knapp, damit Verstärkung frei wird
      const base = major
        ? node === capital ? 6 : front.has(node) ? 4 : border ? 3 : 1
        : node === capital ? 6 : front.has(node) ? 4 : border ? 2 : 1;
      // Kleinstaaten halten nur die Grundbesatzung und ziehen den Rest zusammen (sonst bliebe bei einem Feind
      // nebenan jede Provinz für sich und keine bekäme Verstärkung)
      const keepCount = Math.ceil((major ? Math.max(base, (near * 1.2) / 1.25) : base) * profile.caution);
      if (total - keepCount < 2) continue;
      const keep: Partial<Record<UnitType, number>> = {};
      let left = keepCount;
      for (const u of ['infantry', 'armoredCar', 'tank'] as UnitType[]) {
        const k = Math.min(left, units[u] ?? 0);
        if (k > 0) { keep[u] = k; left -= k; }
      }
      // die Batterie geht nicht mit; was bleibt, ist die Besatzung plus die Artillerie (abgeteilt)
      const meleeUnits: Partial<Record<UnitType, number>> = {};
      for (const [u, n] of Object.entries(units) as [UnitType, number][]) if (u !== 'artillery') meleeUnits[u] = n - (keep[u] ?? 0);
      const power = armyPower({ id: 0, owner: nation, node, units: meleeUnits });
      if (power <= 0) continue;
      const tree = pathsFrom(state, map, a, node, undefined, REACH_HOURS);
      const viaSea = (n: number) => pathTo(tree, n)?.some((k) => isSea(map, k)) ?? false;

      let best: { node: number; score: number } | null = null;
      // 1. Verteidigung: eigene Provinzen mit Eindringlingen oder anrückenden Feinden. Kleinstaaten ziehen dafür
      // alles heran, auch wenn es allein nicht reicht (gemeinsam mit der Besatzung und hinter der Festung)
      for (const [n, threat] of threatened) {
        if (n === node) continue;
        const hours = tree.hours[n];
        if (!isFinite(hours) || hours > REACH_HOURS || viaSea(n)) continue;
        const there = friendly.get(n) ?? 0;
        if (there >= threat * superiority) continue; // reicht schon
        if (major && power + there < threat * 0.7 && n !== capital) continue;
        const value = (map.provinces[n].capital ? 4 : map.provinces[n].city ? 2.5 : 1.5) + (map.provinces[n].nation === nation ? 1 : 0);
        const score = value / (3 + hours) * 1.5;
        if (!best || score > best.score) best = { node: n, score };
      }
      // 2. Angriff: feindliche Provinzen (Kleinstaaten holen nur eigenes Land zurück)
      let wish: { node: number; score: number; need: number } | null = null;
      for (let n = 0; n < map.provinces.length; n++) {
        const ps = state.provinces[n];
        if (!atWar(state, nation, ps.owner)) continue;
        if (!major && map.provinces[n].nation !== nation) continue;
        const hours = tree.hours[n];
        if (!isFinite(hours) || hours > REACH_HOURS) continue;
        const sea = viaSea(n);
        if (sea && !major) continue;
        const vsMinor = major && !isMajorNation(map, ps.owner);
        const need = Math.max(MIN_STRIKE, defence(n) * superiority * (vsMinor ? 0.8 : 1));
        const mp = map.provinces[n];
        // Wert: Hauptstadt und Städte, eigenes Kernland, Nahrung bei Hunger, Baumaterial am Anfang
        let value = (mp.capital ? 3 : mp.city ? 2 : 1) + (mp.nation === nation ? 2 : 0);
        if (hungry && (mp.resource === 'grain' || mp.resource === 'fish')) value *= 1.8;
        if (sit.materialsShort && (mp.resource === 'lumber' || mp.resource === 'iron')) value *= 1.6;
        else if (sit.day < 12 && (mp.resource === 'lumber' || mp.resource === 'iron')) value *= 1.2;
        const score = value / (4 + hours + (sea ? 12 : 0));
        if (power >= need) {
          if (!best || score > best.score) best = { node: n, score };
        } else if (major && !sea && (!wish || score > wish.score)) wish = { node: n, score, need };
      }
      // 3. Sammeln: lohnendes Ziel, für das es allein nicht reicht – an der angrenzenden eigenen Provinz mit den
      // meisten eigenen Kräften zusammenziehen (statt einzeln anzurennen oder untätig zu bleiben)
      if (!best && wish) {
        let stage: { node: number; score: number } | null = null;
        for (const k of map.provinces[wish.node].neighbors) {
          if (state.provinces[k].owner !== nation || (hostile.get(k) ?? 0) > 0) continue;
          const hours = k === node ? 0 : tree.hours[k];
          if (!isFinite(hours) || hours > REACH_HOURS) continue;
          const score = (friendly.get(k) ?? 0) + 1 / (1 + hours);
          if (!stage || score > stage.score) stage = { node: k, score };
        }
        if (stage && stage.node !== node) best = { node: stage.node, score: 0 };
        else if (stage) continue; // hier sammeln: warten, bis genug beisammen ist
      }
      // 4. Reserve: an die bedrohteste Front, an der die eigenen Kräfte nicht reichen
      if (!best && !front.has(node)) {
        for (const [f, threat] of front) {
          const hours = tree.hours[f];
          if (!isFinite(hours) || hours > REACH_HOURS || viaSea(f)) continue;
          const lack = threat * 1.3 - (friendly.get(f) ?? 0);
          if (lack <= 0) continue;
          const score = lack / (6 + hours);
          if (!best || score > best.score) best = { node: f, score };
        }
      }
      if (!best) continue;
      const path = pathTo(tree, best.node);
      if (!path || path.length < 2) continue;
      friendly.set(best.node, (friendly.get(best.node) ?? 0) + power);
      if (Object.keys(keep).length) actions.push({ type: 'split', army: a.id, units: keep });
      actions.push({ type: 'move', army: a.id, to: best.node });
      busy.add(a.id);
      // Batterien am Ort folgen einem Angriff bis kurz vor das Ziel (in Schussweite, nicht in den Nahkampf)
      if (atWar(state, nation, state.provinces[best.node].owner)) {
        const prev = path[path.length - 2];
        for (const b of group) if (isBattery(b) && !b.target) this.sendBattery(sit, b, prev, best.node, actions, busy);
      }
    }
  }

  /** Batterie an den Punkt vor dem Ziel schicken, von dem aus sie es gerade noch beschießt */
  private sendBattery(sit: Situation, b: Army, prev: number, target: number, actions: Action[], busy: Set<number>): void {
    if (busy.has(b.id) || isSea(sit.map, prev)) return;
    const range = Math.min(...Object.keys(b.units).map((u) => UNITS[u as UnitType].range));
    const f = fracBefore(sit.map, prev, target, range * 0.75);
    actions.push({ type: 'setMarch', army: b.id, aggressive: true });
    actions.push(f > 0.02 && f < 0.98
      ? { type: 'move', army: b.id, to: prev, toward: target, frac: f }
      : { type: 'move', army: b.id, to: prev });
    busy.add(b.id);
  }

  /**
   * Untätige Batterien: dorthin, wo gekämpft wird – vor eine feindliche Provinz, auf die eigene Truppen zuhalten
   * oder vor der sie stehen; sonst an die bedrohteste eigene Front (dort feuern sie auf Angreifer).
   */
  private batteries(_view: NationView, sit: Situation, actions: Action[], busy: Set<number>): void {
    const { state, map, nation, friendly, front } = sit;
    if (!sit.enemies.length) return;
    for (const b of state.armies) {
      if (b.owner !== nation || b.move || b.target != null || !isBattery(b) || busy.has(b.id)) continue;
      if (isSea(map, b.node)) continue;
      const tree: PathTree = pathsFrom(state, map, b, b.node, undefined, REACH_HOURS);
      let best: { prev: number; target: number; score: number } | null = null;
      for (let n = 0; n < map.provinces.length; n++) {
        if (!atWar(state, nation, state.provinces[n].owner)) continue;
        const ours = friendly.get(n) ?? 0;
        if (ours <= 0) continue; // nur dort, wo eigene Truppen angreifen
        for (const k of map.provinces[n].neighbors) {
          if (state.provinces[k].owner !== nation) continue;
          const hours = k === b.node ? 0 : tree.hours[k];
          if (!isFinite(hours) || hours > REACH_HOURS) continue;
          const score = ours / (4 + hours);
          if (!best || score > best.score) best = { prev: k, target: n, score };
        }
      }
      if (best) {
        this.sendBattery(sit, b, best.prev, best.target, actions, busy);
        continue;
      }
      // keine Offensive: an die bedrohteste Front
      let f: { node: number; score: number } | null = null;
      for (const [k, threat] of front) {
        const hours = k === b.node ? 0 : tree.hours[k];
        if (!isFinite(hours) || hours > REACH_HOURS) continue;
        const score = threat / (6 + hours);
        if (!f || score > f.score) f = { node: k, score };
      }
      if (f && f.node !== b.node && (b.pos || !front.has(b.node))) {
        actions.push({ type: 'move', army: b.id, to: f.node });
        busy.add(b.id);
      }
    }
  }

  // ------------------------------------------------ Flotten

  /** Flotten im Krieg: feindliche Flotten stellen, sonst vor feindlichen Küsten Stellung beziehen. */
  private fleets(_view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, hostile } = sit;
    if (!sit.enemies.length) return;
    const P = map.provinces.length;
    for (const a of state.armies) {
      if (a.owner !== nation || !isNaval(a) || a.move || a.target != null || unitCount(a) === 0) continue;
      // Flotten mit Truppen an Bord warten auf den Landungsbefehl
      if (Object.keys(a.units).some((u) => !UNITS[u as UnitType].naval && (a.units[u as UnitType] ?? 0) > 0)) continue;
      const power = armyPower(a);
      const tree = pathsFrom(state, map, a, a.node, undefined, REACH_HOURS);
      let best: { node: number; score: number } | null = null;
      for (let k = 0; k < map.seas.length; k++) {
        const z = map.seas[k];
        const node = P + k;
        const hours = tree.hours[node];
        if (!isFinite(hours) || hours > REACH_HOURS) continue;
        const enemyFleet = hostile.get(node) ?? 0;
        if (enemyFleet > power) continue;
        // Ziele in Schussweite: feindliche Küstenprovinzen und Truppen darin
        let value = enemyFleet > 0 ? 6 : 0;
        for (const c of z.coasts) {
          if (!atWar(state, nation, state.provinces[c].owner)) continue;
          value += 1 + Math.min(4, (hostile.get(c) ?? 0) / 10);
        }
        if (value <= 0) continue;
        const score = value / (6 + hours);
        if (!best || score > best.score) best = { node, score };
      }
      if (best && best.node !== a.node) actions.push({ type: 'move', army: a.id, to: best.node });
    }
  }

  // ------------------------------------------------ Eisenbahngeschütze

  /** Eisenbahngeschütze auf der eigenen Bahn an die Front fahren, wo viele Feinde in Reichweite stehen. */
  private railguns(_view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, hostile, own } = sit;
    if (!sit.enemies.length) return;
    const range = UNITS.railgun.range;
    const enemyLand = state.provinces.flatMap((ps, i) => (atWar(state, nation, ps.owner) ? [i] : []));
    const inRange = (p: number) => {
      let v = 0;
      for (const [n, h] of hostile) if (nodeDist(map, p, n) <= range) v += h;
      for (const e of enemyLand) if (distanceKm(map, p, e) <= range) v += 2;
      return v;
    };
    for (const a of state.armies) {
      if (a.owner !== nation || !isRailOnly(a) || a.move || a.target != null || isSea(map, a.node)) continue;
      const tree = pathsFrom(state, map, a, a.node, undefined, REACH_HOURS);
      const here = inRange(a.node);
      let best: { node: number; score: number } | null = null;
      for (const p of own) {
        const hours = tree.hours[p];
        if (!isFinite(hours) || hours > REACH_HOURS || (hostile.get(p) ?? 0) > 0) continue;
        const score = inRange(p) / (1 + hours / 24);
        if (!best || score > best.score) best = { node: p, score };
      }
      if (best && best.node !== a.node && best.score > here * 1.2) actions.push({ type: 'move', army: a.id, to: best.node });
    }
  }
}
