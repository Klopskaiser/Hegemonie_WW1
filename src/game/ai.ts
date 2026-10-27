// Eingebaute KI: Wirtschaft, Rekrutierung, Krieg und Frieden, Börse und strategische
// Truppenführung (Fronten, Reserven, Landungen, Flotten, Eisenbahngeschütze).
// Persönlichkeit je Nation (state.aiProfiles) und Schwierigkeitsgrad (state.difficulty).

import { checkBuild, checkProduce, canAfford, type Action, checkRepair } from './actions.ts';
import { BUILDINGS, CATEGORIES, CATEGORY_RES, DAY, DIFFICULTY, MARKET, UNITS, type Building, type UnitType, CAPITAL_MOVE, FORTRESS_REDUCTION, START_INFANTRY, type Res } from './balance.ts';
import type { Controller, NationView } from './controller.ts';
import { atWar, enemiesOf, relation, warKey } from './diplomacy.ts';
import { netRate, provinceOutput, toShares, activeCapital, capitalOf, provincePoints } from './economy.ts';
import { distanceKm, RESOURCES, type MapData, type Resource } from './mapdata.ts';
import { priceBounds, priceOf, tradeableOffers } from './market.ts';
import { isSea, nodeDist } from './graph.ts';
import { armyPower, isNaval, isRailOnly, pathsFrom, pathTo, unitCount } from './military.ts';
import type { AIProfile, Army, GameState } from './types.ts';
import { armyVisible, visibleNodes, type Sight } from './visibility.ts';

/** Friedenszeit zu Spielbeginn, bevor KI-Großmächte Kriege beginnen */
const PEACE_TIME = 3 * DAY;

const MONEY_RESERVE = 1500;
/** längster Angriffs- bzw. Verlegungsweg in Stunden */
const REACH_HOURS = 72;
/** Mindeststärke eines Angriffs auf feindliche Provinzen (≈ 10 Infanteristen); kleinere Überschüsse sammeln sich */
const MIN_STRIKE = 12;
const DEFAULT_PROFILE: AIProfile = { aggression: 1, caution: 1 };

/** Lagebild einer Nation für eine Entscheidungsrunde */
interface Situation {
  state: GameState;
  map: MapData;
  nation: string;
  major: boolean;
  profile: AIProfile;
  diff: (typeof DIFFICULTY)[keyof typeof DIFFICULTY];
  own: number[];
  enemies: string[];
  /** sichtbare feindliche Kampfkraft je Knoten (nur stehende Armeen) */
  hostile: Map<number, number>;
  /** eigene Frontprovinzen (grenzen an Kriegsgegner) mit Bedrohung */
  front: Map<number, number>;
  /** eigene Kampfkraft je Knoten, inklusive Armeen auf dem Weg dorthin */
  friendly: Map<number, number>;
  /** eigene Sicht (Nebel des Krieges) */
  vis: Sight;
}

export class BasicAI implements Controller {
  readonly name = 'Standard-KI';

  decide(view: NationView): Action[] {
    const sit = this.situation(view);
    const actions: Action[] = [];
    this.build(view, sit, actions);
    this.produce(view, sit, actions);
    this.diplomacy(view, sit, actions);
    if (sit.major) this.friendship(view, actions);
    this.trade(view, actions);
    this.consumption(view, actions);
    this.military(view, sit, actions);
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
    for (const b of state.armies) {
      if (b.owner === nation) {
        const at = b.move ? b.move.path[b.move.path.length - 1] : b.node;
        friendly.set(at, (friendly.get(at) ?? 0) + armyPower(b));
        continue;
      }
      if (!atWar(state, nation, b.owner) || b.move || !armyVisible(state, map, nation, b, vis)) continue;
      hostile.set(b.node, (hostile.get(b.node) ?? 0) + armyPower(b));
    }
    const front = new Map<number, number>();
    for (const i of own) {
      const ns = map.provinces[i].neighbors;
      const enemyNeighbors = ns.filter((n) => atWar(state, nation, state.provinces[n].owner)).length;
      const threat = (hostile.get(i) ?? 0) + ns.reduce((t, n) => t + (hostile.get(n) ?? 0), 0);
      // auch ohne sichtbare Feinde gilt eine Grenze zum Kriegsgegner als Front
      if (enemyNeighbors > 0 || threat > 0) front.set(i, threat + enemyNeighbors * 2);
    }
    return {
      state, map, nation,
      major: map.nations.find((n) => n.id === nation)?.major ?? false,
      profile: state.aiProfiles?.[nation] ?? DEFAULT_PROFILE,
      diff: DIFFICULTY[state.difficulty ?? 'normal'],
      own, enemies, hostile, front, friendly, vis,
    };
  }

  // ------------------------------------------------ Bauen

  private build(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, own, major, front } = sit;
    const stock = state.nations[nation].stock;
    // beschädigte Gebäude zuerst reparieren (sie wirken sonst nicht)
    for (const i of own) {
      for (const b of Object.keys(state.provinces[i].damage ?? {}) as Building[]) {
        if (checkRepair(state, nation, i, b).ok) actions.push({ type: 'repair', province: i, building: b });
      }
    }
    // Hauptstadt verloren: in die wertvollste sichere eigene Provinz verlegen
    if (capitalOf(state, map, nation) === null && !state.nations[nation].capitalMove && canAfford(stock, CAPITAL_MOVE.cost)) {
      const safe = own.filter((i) => !front.get(i) && !state.provinces[i].revolt);
      const pick = (safe.length ? safe : own).reduce<number | null>((b, i) => (b === null || provincePoints(map, state.provinces[i], i) > provincePoints(map, state.provinces[b], b) ? i : b), null);
      if (pick !== null) actions.push({ type: 'moveCapital', province: pick });
    }
    const net = (r: 'coal' | 'oil' | 'fish') => netRate(view.rates, r);
    const building = own.filter((i) => state.provinces[i].construction).length;
    const maxParallel = Math.max(1, Math.ceil(own.length / (major ? 6 : 10)));
    if (building >= maxParallel) return;
    const factories = own.filter((i) => state.provinces[i].buildings.factory > 0).length;
    // Nahrungslage: Getreide ernährt die Infanterie, Fisch den Provinzunterhalt
    const grainNet = netRate(view.rates, 'grain'), fishNet = netRate(view.rates, 'fish');
    const foodShort = grainNet < 0 || fishNet < 0 || stock.grain < 3000;
    // Kasernen (1000 Getreide je Stufe und Tag) und Wehrämter (jede neue Infanterie isst 18 Getreide am Tag):
    // bei Getreidemangel abschalten, bei Überschuss wieder an
    const starving = grainNet < 0 && stock.grain < -grainNet * 5, plenty = grainNet > 1500 && stock.grain > 10000;
    for (const i of own) {
      const ps = state.provinces[i];
      for (const b of ['barracks', 'recruitment'] as const) {
        if (ps.buildings[b] <= 0) continue;
        if (!ps.off?.[b] && starving) actions.push({ type: 'switchBuilding', province: i, building: b, on: false });
        else if (ps.off?.[b] && plenty) actions.push({ type: 'switchBuilding', province: i, building: b, on: true });
      }
    }
    const maxFortress = state.difficulty === 'hard' ? 3 : 2;
    let best: { province: number; building: Building; score: number } | null = null;
    for (const i of own) {
      const ps = state.provinces[i];
      if (ps.construction) continue;
      const mp = map.provinces[i];
      const out = provinceOutput(map, ps, i);
      const border = mp.neighbors.some((n) => state.provinces[n].owner !== nation);
      const threat = front.get(i) ?? 0;
      for (const b of Object.keys(BUILDINGS) as Building[]) {
        const chk = checkBuild(state, map, nation, i, b);
        if (!chk.ok) continue;
        if ((stock.money - (chk.cost.money ?? 0)) < MONEY_RESERVE) continue;
        let score = 0;
        const base = out.amount / (1 + out.bonus);
        switch (b) {
          case 'railroad': score = base * 0.33 * (net('coal') < BUILDINGS.railroad.upkeep!.coal! && mp.resource !== 'coal' ? 0.3 : 1); break;
          case 'harbor': score = base * 0.25; break;
          // Handelsposten: kleiner Produktionsbonus, kostet Fisch – nur wenn genug Fisch übrig ist
          case 'tradepost': score = base * 0.07 * (net('fish') < 3 * BUILDINGS.tradepost.upkeep!.fish! ? 0.2 : 1); break;
          // Werkstatt: Voraussetzung für die Fabrik (bevorzugt in Städten), beschleunigt vorhandene Fabriken
          case 'workshop': {
            const wantFactory = factories < (major ? 3 : 1) && ps.buildings.manufactory === 0;
            score = (wantFactory ? 820 : 0) + (mp.city ? 300 : 0) + (ps.buildings.factory > 0 ? 400 : 0);
            if (!wantFactory && ps.buildings.factory === 0) score *= 0.2;
            break;
          }
          case 'factory': {
            const gain = (BUILDINGS.factory.prodBonus(chk.level) - BUILDINGS.factory.prodBonus(chk.level - 1)) * base;
            // erste Fabriken ermöglichen Artillerie und Fahrzeuge, Stufe 3 die schweren Einheiten
            const unlock = chk.level === 1 && factories < (major ? 3 : 1) ? 800 : 0;
            const heavy = chk.level === 3 && major && sit.diff.heavy && mp.capital ? 500 : 0;
            score = (mp.city ? gain + 300 : gain) + unlock + heavy;
            if (chk.level > (major ? 3 : 1)) score *= 0.3;
            break;
          }
          // Manufaktur: mehr Rohstoffe, aber keine Einheiten – eher auf dem Land, Fabriken in Städten
          case 'manufactory': score = base * 0.1 * (mp.city ? 0.4 : 1) * (chk.level > 2 ? 0.5 : 1); break;
          // Kaserne verdoppelt/verdreifacht die Infanterie einer Provinz: lohnt bei guter Moral
          case 'barracks': score = (chk.level === 1 ? 650 : 450) * ps.morale * (border || mp.capital ? 1.2 : 1) * (threat > 0 ? 1.3 : 1); break;
          // zerstörtes Wehramt hat Vorrang
          case 'recruitment': score = 1500; break;
          case 'fortress':
            if (mp.capital && chk.level <= 2) score = 600;
            // bedrohte Frontprovinzen befestigen, umso eher je stärker der Feind davor steht
            else if (threat > 0 && chk.level <= maxFortress) score = (250 + threat * 15) * sit.profile.caution / chk.level;
            else if (border && chk.level === 1 && mp.city) score = 350;
            break;
        }
        // Nahrung knapp: Wirtschaftsgebäude in Getreide- und Fischprovinzen bevorzugen, Kasernen erst bei Getreideüberschuss
        const food = mp.resource === 'grain' || mp.resource === 'fish';
        if (foodShort && food && (b === 'railroad' || b === 'harbor' || b === 'factory' || b === 'manufactory')) score *= 2.5;
        if (b === 'barracks' && grainNet < BUILDINGS.barracks.upkeep!.grain! * 1.5) score = 0;
        score *= 0.9 + view.random() * 0.2;
        if (score > 0 && (!best || score > best.score)) best = { province: i, building: b, score };
      }
    }
    if (best) actions.push({ type: 'build', province: best.province, building: best.building });
  }

  // ------------------------------------------------ Fertigung (Infanterie entsteht automatisch)

  private produce(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, own, enemies } = sit;
    const stock = state.nations[nation].stock;
    const net = (r: 'coal' | 'oil') => netRate(view.rates, r);
    // Ziel: etwa ein Viertel der Truppen maschinell (Artillerie, Panzerwagen, Panzer), im Krieg mehr
    let infantry = 0, machines = 0, queued = 0;
    const heavy: Partial<Record<UnitType, number>> = {};
    for (const a of state.armies) {
      if (a.owner !== nation) continue;
      for (const [u, n] of Object.entries(a.units) as [UnitType, number][]) {
        if (u === 'infantry') infantry += n;
        else machines += n;
        if (u === 'railgun' || u === 'battleship') heavy[u] = (heavy[u] ?? 0) + n;
      }
    }
    for (const i of own) {
      for (const o of state.provinces[i].queue) {
        queued++;
        if (o.unit === 'railgun' || o.unit === 'battleship') heavy[o.unit] = (heavy[o.unit] ?? 0) + 1;
      }
    }

    // schwere Einheiten: nur Großmächte im Krieg mit voller Kasse
    if (sit.major && sit.diff.heavy && enemies.length) {
      const enemyCoast = enemies.some((e) => state.provinces.some((ps, i) => ps.owner === e && map.provinces[i].coastal));
      for (const unit of ['railgun', 'battleship'] as UnitType[]) {
        const limit = unit === 'railgun' ? 2 : enemyCoast ? 3 : 0;
        if ((heavy[unit] ?? 0) >= limit) continue;
        const cost = UNITS[unit].cost;
        if (stock.money < (cost.money ?? 0) + 15000 || !canAfford(stock, cost)) continue;
        if (unit === 'battleship' && net('oil') < 50) continue;
        const site = own.find((i) => state.provinces[i].queue.length === 0 && checkProduce(state, map, nation, i, unit).ok);
        if (site !== undefined) {
          actions.push({ type: 'enqueue', province: site, unit });
          return;
        }
      }
    }

    const wanted = (infantry + machines) * (enemies.length ? 0.35 : 0.25);
    if (machines + queued >= wanted || stock.money <= 3000) return;
    const sites = own.filter((i) => state.provinces[i].queue.length === 0 && state.provinces[i].buildings.factory > 0);
    if (!sites.length) return;
    const i = sites[Math.floor(view.random() * sites.length)];
    const ps = state.provinces[i];
    const roll = view.random();
    let unit: UnitType = roll < 0.5 ? 'artillery' : 'armoredCar';
    if (ps.buildings.factory >= 2 && roll > 0.75 && net('oil') > 100) unit = 'tank';
    if (unit !== 'artillery' && net('oil') <= 0) unit = 'artillery';
    if (checkProduce(state, map, nation, i, unit).ok && canAfford(stock, UNITS[unit].cost)) {
      actions.push({ type: 'enqueue', province: i, unit });
    }
  }

  // ------------------------------------------------ Diplomatie

  private diplomacy(view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, major, enemies, profile, diff } = sit;
    const power = (n: string) => state.armies.filter((a) => a.owner === n).reduce((s, a) => s + armyPower(a), 0);
    const mine = power(nation);
    const stock = state.nations[nation].stock;
    // Wert eines Tributs zu Börsenpreisen (Geld zählt 1:1); nur, was der Anbieter auch zahlen kann
    const worth = (p: { from: string; tribute?: Partial<Record<Res, number>> }) => {
      if (!p.tribute || !canAfford(state.nations[p.from].stock, p.tribute)) return 0;
      return (Object.keys(p.tribute) as Res[]).reduce((s, r) => s + p.tribute![r]! * (r === 'money' ? 1 : priceOf(state, r as Resource)), 0);
    };
    // Angebote beantworten
    for (const p of state.proposals.filter((x) => x.to === nation)) {
      const theirs = power(p.from);
      const w = worth(p);
      let accept: boolean;
      if (p.kind === 'peace') {
        const age = state.time - (state.warSince[warKey(nation, p.from)] ?? state.time);
        // der Stärkere nimmt nur selten an, der Schwächere gern; ein ordentlicher Tribut macht Frieden attraktiv
        const price = 15000 * profile.aggression * Math.max(1, mine / Math.max(1, theirs));
        accept = mine < theirs * 0.9 || w >= price || (age > 6 * DAY && view.random() < (0.25 + w / price) / profile.aggression);
      } else {
        // Durchmarsch/geteilte Karte: nicht mit deutlich stärkeren Nationen – außer gegen Tribut
        accept = (theirs < mine * 1.5 && view.random() < (p.kind === 'rightOfWay' ? 0.5 : 0.3)) || w >= (p.kind === 'rightOfWay' ? 8000 : 15000);
      }
      actions.push({ type: 'answer', nation: p.from, accept });
    }
    // selbst Frieden anbieten: klar unterlegen (mit Tribut) oder in einem festgefahrenen Krieg
    for (const e of enemies) {
      if (state.proposals.some((p) => p.from === nation && p.to === e)) continue;
      const theirs = power(e);
      const age = state.time - (state.warSince[warKey(nation, e)] ?? state.time);
      const losing = mine < theirs * 0.5;
      const stalemate = age > 8 * DAY && mine < theirs * 1.3 && mine > theirs * 0.7;
      if (!(losing && view.random() < 0.2) && !(stalemate && view.random() < 0.05)) continue;
      // Tribut: ein Teil der Kasse, umso mehr, je klarer die Unterlegenheit
      const share = losing ? 0.3 : mine < theirs ? 0.1 : 0;
      const money = Math.floor(Math.min(stock.money * share, 50000) / 1000) * 1000;
      actions.push({ type: 'propose', nation: e, kind: 'peace', ...(money >= 5000 ? { tribute: { money } } : {}) });
    }
    // Kriegserklärungen: nur Großmächte, nach der Friedenszeit, höchstens ein Krieg zugleich
    if (!major || enemies.length > 0 || state.time < PEACE_TIME) return;
    const neighbors = new Set<string>();
    for (const i of sit.own) {
      for (const n of map.provinces[i].neighbors) {
        const o = state.provinces[n].owner;
        if (o !== nation) neighbors.add(o);
      }
    }
    let best: { n: string; ratio: number } | null = null;
    for (const n of neighbors) {
      if ((state.truceUntil[warKey(nation, n)] ?? 0) > state.time) continue;
      const ratio = mine / Math.max(1, power(n));
      const isMajor = map.nations.find((x) => x.id === n)?.major;
      // vorsichtige Nationen wollen mehr Überlegenheit
      if (ratio < (isMajor ? 1.6 : 2) * profile.caution) continue;
      if (!best || ratio > best.ratio) best = { n, ratio };
    }
    if (!best) return;
    const isMajor = map.nations.find((x) => x.id === best!.n)?.major;
    const chance = (isMajor ? 0.01 : 0.04) * profile.aggression * diff.war * diff.interval / 3;
    if (view.random() < chance) actions.push({ type: 'declareWar', nation: best.n });
  }

  /** Gelegentlich entfernten Großmächten Durchmarschrecht anbieten (Großmächte, im Frieden). */
  private friendship(view: NationView, actions: Action[]): void {
    const state = view.state as GameState;
    const { map, nation } = view;
    if (view.random() > 0.01) return;
    const neighbors = new Set<string>();
    state.provinces.forEach((ps, i) => {
      if (ps.owner === nation) for (const n of map.provinces[i].neighbors) neighbors.add(state.provinces[n].owner);
    });
    const options = map.nations.filter((n) => n.major && n.id !== nation && state.nations[n.id].alive && !neighbors.has(n.id)
      && relation(state, nation, n.id) === 'peace' && !state.proposals.some((p) => p.from === nation && p.to === n.id));
    if (!options.length) return;
    const pick = options[Math.floor(view.random() * options.length)];
    actions.push({ type: 'propose', nation: pick.id, kind: 'rightOfWay' });
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
  private trade(view: NationView, actions: Action[]): void {
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
    const rich = Math.min(2.5, 1.4 + stock.money / 200000);
    const round = (v: number, r: Resource) => {
      const [lo, hi] = priceBounds(r);
      return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
    };
    for (const r of RESOURCES) {
      const net = netRate(rates, r);
      const price = priceOf(state, r);
      // kaufen, wenn der Vorrat bei dieser Bilanz in wenigen Tagen aufgebraucht ist
      const short = (net < 0 && stock[r] < -net * 5) || stock[r] < 3000;
      if (short) {
        let need = Math.max(3000, -net * 4) - Math.max(0, stock[r]);
        for (const offer of tradeableOffers(state, nation, r, 'sell')) {
          if (need < 100 || budget <= 0 || offer.price > price * rich) break;
          const amount = Math.min(offer.amount, need, Math.floor(budget / offer.price));
          if (amount < 100) break;
          actions.push({ type: 'acceptOffer', id: offer.id, amount });
          budget -= amount * offer.price;
          need -= amount;
        }
        // nichts Passendes: eigenes Kaufgesuch
        if (need >= MARKET.minAmount && slots > 0 && !mine.some((o) => o.side === 'buy' && o.res === r)) {
          const bid = round(price * (1.05 + view.random() * 0.15), r);
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
   * Je Standort: Besatzung zurücklassen, mit dem Überschuss angreifen (auch über See) oder
   * als Reserve an die bedrohteste Front verlegen.
   */
  private military(_view: NationView, sit: Situation, actions: Action[]): void {
    const { state, map, nation, major, profile, diff, hostile, front, friendly } = sit;
    const mine = state.armies.filter((a) => a.owner === nation && !a.move && unitCount(a) > 0 && !isNaval(a));
    // Armeen am selben Ort zusammenlegen
    const byNode = new Map<number, Army[]>();
    for (const a of mine) (byNode.get(a.node) ?? byNode.set(a.node, []).get(a.node)!).push(a);
    for (const group of byNode.values()) {
      const merge = group.filter((a) => !a.target && !isRailOnly(a)).sort((x, y) => armyPower(y) - armyPower(x));
      for (let k = 1; k < merge.length; k++) actions.push({ type: 'merge', army: merge[k].id, into: merge[0].id });
    }
    if (!sit.enemies.length) return;

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
    for (const [node, group] of byNode) {
      if (isSea(map, node)) continue; // Truppen auf See führen ihren Befehl aus
      const land = group.filter((x) => !x.target && !isRailOnly(x));
      if (!land.length) continue;
      const a = land.reduce((x, y) => (armyPower(y) > armyPower(x) ? y : x));
      if ((hostile.get(node) ?? 0) > 0) continue; // Kampf am Ort: bleiben
      // Die Armeen am Ort werden vorher zusammengelegt, daher zählt die ganze Gruppe.
      const units: Partial<Record<UnitType, number>> = {};
      for (const g of land) for (const u of Object.keys(g.units) as UnitType[]) units[u] = (units[u] ?? 0) + g.units[u]!;
      const total = Object.values(units).reduce((t, n) => t + (n ?? 0), 0);
      const border = map.provinces[node].neighbors.some((n) => state.provinces[n].owner !== nation);
      // Besatzung: mindestens 8/4/2 (Front 5), bei sichtbarer Bedrohung 120 % der Feindstärke
      const near = map.provinces[node].neighbors.reduce((t, n) => t + (hostile.get(n) ?? 0), 0);
      const base = node === capital ? 8 : front.has(node) ? 5 : border ? 4 : 2;
      const keepCount = Math.ceil(Math.max(base, (near * 1.2) / 1.25) * profile.caution);
      if (total - keepCount < 2) continue;
      const keep: Partial<Record<UnitType, number>> = {};
      let left = keepCount;
      for (const u of ['infantry', 'artillery', 'armoredCar', 'tank'] as UnitType[]) {
        const k = Math.min(left, units[u] ?? 0);
        if (k > 0) { keep[u] = k; left -= k; }
      }
      const power = land.reduce((s, x) => s + armyPower(x), 0) - armyPower({ ...a, units: keep });
      if (power <= 0) continue;
      const tree = pathsFrom(state, map, a, node);
      const viaSea = (n: number) => pathTo(tree, n)?.some((k) => isSea(map, k)) ?? false;

      // 1. Angriff: feindliche Provinzen oder eigene Provinzen mit Eindringlingen
      let best: { node: number; score: number } | null = null;
      for (let n = 0; n < map.provinces.length; n++) {
        const ps = state.provinces[n];
        const own = ps.owner === nation;
        const threat = hostile.get(n) ?? 0;
        if (!(atWar(state, nation, ps.owner) || (own && threat > 0))) continue;
        // Kleinstaaten verteidigen nur und holen ihr eigenes Land zurück
        if (!major && !own && map.provinces[n].nation !== nation) continue;
        const hours = tree.hours[n];
        if (!isFinite(hours) || hours > REACH_HOURS) continue;
        // eigene Provinzen mit Eindringlingen: genug Überlegenheit; feindliche: auch die nicht sichtbare
        // Besatzung und Festung einrechnen und nie mit Kleinsttrupps
        if (own ? power < threat * superiority : power < Math.max(MIN_STRIKE, defence(n) * superiority)) continue;
        // Landungen nur für Großmächte und mit spürbarem Aufschlag gegenüber dem Landweg
        const sea = viaSea(n);
        if (sea && !major) continue;
        const value = (map.provinces[n].capital ? 3 : map.provinces[n].city ? 2 : 1) + (own ? 2 : 0);
        const score = value / (4 + hours + (sea ? 12 : 0));
        if (!best || score > best.score) best = { node: n, score };
      }

      // 2. Reserve: an die bedrohteste Front, an der die eigenen Kräfte nicht reichen
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
      // 3. Sammeln: zu kleine Überschüsse ziehen zur stärksten eigenen Armee an der Front, statt einzeln anzugreifen
      if (!best && power < MIN_STRIKE && sit.enemies.length) {
        const here = friendly.get(node) ?? 0;
        for (const f of front.keys()) {
          if (f === node) continue;
          const hours = tree.hours[f];
          if (!isFinite(hours) || hours > REACH_HOURS || viaSea(f)) continue;
          const there = friendly.get(f) ?? 0;
          if (there <= here) continue;
          const score = there / (6 + hours);
          if (!best || score > best.score) best = { node: f, score };
        }
      }
      if (!best) continue;
      const path = pathTo(tree, best.node);
      if (!path || path.length < 2) continue;
      friendly.set(best.node, (friendly.get(best.node) ?? 0) + power);
      actions.push({ type: 'split', army: a.id, units: keep });
      actions.push({ type: 'move', army: a.id, to: best.node });
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
      const tree = pathsFrom(state, map, a, a.node);
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
      const tree = pathsFrom(state, map, a, a.node);
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
