import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_RES, DAY, HOUR, MILITARY, MINUTE, MORALE, UNITS } from '../src/game/balance.ts';
import { applyCombatMorale, applyDamage, armyLocation, armyPosition, boardingWait, combatRound, conquer, rangedRound, damageBuildings, defections, harborLeg, inMelee, markFight, maxRange, meleeOutput, repairMachines, troopTarget, unitHp } from '../src/game/military.ts';
import { activeLevel, capitalOf, moraleTarget, nationRates, recruitHours, stepMorale, totalUse, useSources } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { edgeParts, edgePoint, nodePos } from '../src/game/graph.ts';
import { segmentHours } from '../src/game/military.ts';
import { checkRepair, requiredWars } from '../src/game/actions.ts';
import { priceBounds } from '../src/game/market.ts';
import { atWar } from '../src/game/diplomacy.ts';
import { armyName } from '../src/game/names.ts';
import { armyVisible, visibleNodes } from '../src/game/visibility.ts';
import { makeRng } from '../src/game/rng.ts';
import { Simulation } from '../src/game/sim.ts';
import { BasicAI } from '../src/game/ai.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;
function newSim() {
  const state = createGame(map, { id: 't', name: 'Test', playerNation: 'DE', speed: 1, seed: 5, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  return new Simulation(state, map);
}

describe('Abschaltbare Gebäude', () => {
  it('abgeschaltete Kaserne kostet kein Getreide und rekrutiert nicht schneller', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const ps = sim.state.provinces[berlin];
    ps.buildings.barracks = 2;
    ps.buildings.recruitment = 1;
    const on = nationRates(sim.state, map, 'DE').cons.grain;
    const fast = recruitHours(ps)!;
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'barracks', on: false }).ok).toBe(true);
    expect(nationRates(sim.state, map, 'DE').cons.grain).toBe(on - 2000);
    expect(recruitHours(ps)!).toBeGreaterThan(fast);
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'barracks', on: true }).ok).toBe(true);
    expect(nationRates(sim.state, map, 'DE').cons.grain).toBe(on);
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'fortress', on: false }).ok).toBe(false);
  });

  it('abgeschaltete Eisenbahn: kein Kohleunterhalt, kein Tempo- und Produktionsbonus', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const ps = sim.state.provinces[berlin];
    ps.buildings.railroad = 1;
    const n = map.provinces[berlin].links!.find((x) => map.provinces[x].nation === 'DE')!;
    const a: Army = { id: 999, owner: 'DE', node: berlin, units: { infantry: 1 } };
    const fast = segmentHours(sim.state, map, a, berlin, n);
    const coal = nationRates(sim.state, map, 'DE').cons.coal;
    const prod = nationRates(sim.state, map, 'DE').prod[map.provinces[berlin].resource];
    sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'railroad', on: false });
    expect(segmentHours(sim.state, map, a, berlin, n)).toBeGreaterThan(fast);
    expect(nationRates(sim.state, map, 'DE').cons.coal).toBe(coal - 500);
    expect(nationRates(sim.state, map, 'DE').prod[map.provinces[berlin].resource]).toBeLessThan(prod);
  });
});

describe('Verbrauch nach Verursachern', () => {
  it('die Quellen ergeben zusammen den Gesamtverbrauch; Einheiten je Typ zusammengefasst', () => {
    const sim = newSim();
    sim.state.provinces[prov('Berlin')].buildings.barracks = 1;
    const src = useSources(sim.state, map, 'DE');
    const r = nationRates(sim.state, map, 'DE');
    for (const res of ALL_RES) expect(src[res].reduce((s, x) => s + x.amount, 0)).toBeCloseTo(totalUse(r, res), 6);
    expect(src.grain.filter((s) => s.label.startsWith('Infanterie'))).toHaveLength(1);
    expect(src.grain.some((s) => s.label.startsWith('Kaserne'))).toBe(true);
  });
});

describe('Moral, Abschüsse, Namen', () => {
  it('Kämpfe in der Provinz senken das Moralziel fest um 15 % bis zum Tageswechsel, je Kampfstunde sofort −0,75 %', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const before = moraleTarget(sim.state, map, berlin).target;
    const ps = sim.state.provinces[berlin];
    const penalty = () => moraleTarget(sim.state, map, berlin).parts.find((p) => p.label.startsWith('Kämpfe'))?.value ?? 0;
    ps.fought = true;
    expect(penalty()).toBeCloseTo(-0.15, 9);
    expect(moraleTarget(sim.state, map, berlin).target).toBeCloseTo(Math.max(MORALE.min, before - MORALE.battle), 6);
    // auch nach Tagen mit Kampf bleibt es bei −15 %
    for (let d = 0; d < 3; d++) {
      sim.advance(DAY);
      expect(ps.fought).toBeUndefined();
      ps.fought = true;
      expect(penalty()).toBeCloseTo(-0.15, 9);
    }
    // ohne Kampf kein Abzug
    ps.fought = false;
    expect(penalty()).toBe(0);
    // Sofortabzug: höchstens einmal je Spielstunde
    const m0 = ps.morale;
    markFight(sim.state, berlin);
    markFight(sim.state, berlin);
    expect(ps.morale).toBeCloseTo(m0 - 0.0075, 9);
    sim.state.time += HOUR;
    markFight(sim.state, berlin);
    expect(ps.morale).toBeCloseTo(m0 - 0.015, 9);
  });

  it('Moral nähert sich dem Ziel mit mindestens 3 Punkten je Tag (oder der Restlücke), höchstens 10', () => {
    expect(stepMorale(0.25, 0.85)).toBeCloseTo(0.35, 9); // 35 % von 60 = 21 → höchstens 10
    expect(stepMorale(0.8, 0.85)).toBeCloseTo(0.83, 9); // 35 % von 5 = 1,75 → mindestens 3
    expect(stepMorale(0.83, 0.85)).toBeCloseTo(0.85, 9); // Restlücke 2 < 3
    expect(stepMorale(0.85, 0.8)).toBeCloseTo(0.82, 9); // abwärts ebenso
  });

  it('Armeen zählen Abschüsse; Schlachtschiffe bekommen Namen und lassen sich umbenennen', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'DK' });
    const target = map.provinces.find((p) => p.nation === 'DK' && p.neighbors.some((n) => map.provinces[n].nation === 'DE'))!;
    const from = target.neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== target.id && a.node !== from);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: target.id, units: { infantry: 40 } };
    const dk: Army = { id: sim.state.nextArmyId++, owner: 'DK', node: target.id, units: { infantry: 5 } };
    sim.state.armies.push(de, dk);
    sim.advance(6 * HOUR);
    expect(de.kills ?? 0).toBeGreaterThan(0);

    const kiel = map.provinces.find((p) => p.nation === 'DE' && p.coastal)!.id;
    sim.spawn(kiel, 'DE', 'battleship', 1);
    const ship = sim.state.armies.find((a) => a.owner === 'DE' && a.units.battleship)!;
    expect(ship.name).toMatch(/^SMS /);
    expect(armyName(ship)).toBe(ship.name);
    expect(sim.apply('DE', { type: 'rename', army: ship.id, name: 'SMS Testschiff' }).ok).toBe(true);
    expect(armyName(ship)).toBe('SMS Testschiff');
    sim.apply('DE', { type: 'rename', army: ship.id, name: '' });
    expect(ship.name).toBeUndefined();
  });
});

describe('Provinzmoral und Hauptstadt', () => {
  it('Moralziel: Grundwert 85 %, kein Hauptstadtbonus, Entfernung 1 % je 100 km (höchstens 30 %), Nachbarn −2 %/+1 %', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const cap = moraleTarget(sim.state, map, berlin);
    expect(cap.parts[0]).toEqual({ label: 'Grundwert', value: 0.85 });
    expect(cap.parts.some((p) => p.label === 'Hauptstadt')).toBe(false);
    const far = map.provinces.filter((p) => p.nation === 'DE' && !p.capital)
      .map((p) => ({ p, d: Math.hypot(p.center[0] - map.provinces[berlin].center[0], p.center[1] - map.provinces[berlin].center[1]) }))
      .sort((x, y) => y.d - x.d)[0];
    const dist = moraleTarget(sim.state, map, far.p.id).parts.find((x) => x.label === 'Entfernung zur Hauptstadt');
    if (far.d > MORALE.distanceFree) expect(dist!.value).toBeCloseTo(-Math.min(0.3, ((far.d - MORALE.distanceFree) / 100) * 0.01), 6);
    const n = map.provinces[berlin].neighbors.find((x) => map.provinces[x].nation === 'DE')!;
    sim.state.provinces[n].morale = 0.2;
    expect(moraleTarget(sim.state, map, berlin).parts.find((p) => p.label.startsWith('Unruhe'))!.value).toBeCloseTo(-0.02, 9);
    // zufriedene Nachbarn (mindestens 91 % Moral): +1 % je Provinz
    sim.state.provinces[n].morale = 0.9;
    expect(moraleTarget(sim.state, map, berlin).parts.some((p) => p.label.startsWith('Zufriedene'))).toBe(false);
    sim.state.provinces[n].morale = 0.91;
    expect(moraleTarget(sim.state, map, berlin).parts.find((p) => p.label.startsWith('Zufriedene'))!.value).toBeCloseTo(0.01, 9);
    // starke Besatzung (mehr als 20 Stärke in der Stadt): +3 %
    const garrison = () => moraleTarget(sim.state, map, berlin).parts.find((p) => p.label === 'Starke Besatzung')?.value;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== berlin);
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { infantry: 19 } });
    expect(garrison()).toBeUndefined(); // 19 Infanterie = Stärke 19,95, nicht mehr als 20
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { infantry: 1 } });
    expect(garrison()).toBeCloseTo(0.03, 9);
  });

  it('Moral ändert sich je Tag um höchstens 10 Prozentpunkte', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    sim.state.provinces[berlin].morale = 0.2;
    sim.advance(DAY);
    expect(sim.state.provinces[berlin].morale).toBeCloseTo(0.3, 9);
  });

  it('eroberte Provinzen starten bei 25 %, Rückeroberung am selben Tag bei 40 %', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'DK' });
    const t = map.provinces.find((p) => p.nation === 'DK' && !p.capital)!.id;
    const ps = sim.state.provinces[t];
    ps.morale = 0.9;
    conquer(sim.ctx, t, 'DE');
    expect(ps.morale).toBe(0.25);
    conquer(sim.ctx, t, 'DK');
    expect(ps.morale).toBe(0.4);
  });

  it('Hauptstadt verlegen: kostet, dauert 48 h, nur eine Verlegung gleichzeitig; Abbruch erstattet alles', () => {
    const sim = newSim();
    const target = prov('Hamburg'), other = map.provinces.find((p) => p.nation === 'DE' && !p.capital && p.id !== target)!.id;
    const stock = sim.state.nations.DE.stock;
    Object.assign(stock, { money: 50000, lumber: 20000, iron: 20000, grain: 20000, coal: 20000 });
    const money = stock.money;
    expect(sim.apply('DE', { type: 'moveCapital', province: target }).ok).toBe(true);
    expect(stock.money).toBe(money - 20000);
    expect(sim.apply('DE', { type: 'moveCapital', province: other }).ok).toBe(false);
    sim.advance(47 * HOUR);
    expect(capitalOf(sim.state, map, 'DE')).toBe(prov('Berlin'));
    sim.advance(2 * HOUR);
    expect(capitalOf(sim.state, map, 'DE')).toBe(target);
    expect(moraleTarget(sim.state, map, target).parts.some((p) => p.label === 'Entfernung zur Hauptstadt')).toBe(false);
    // Abbruch
    expect(sim.apply('DE', { type: 'moveCapital', province: other }).ok).toBe(true);
    const before = stock.money;
    expect(sim.apply('DE', { type: 'cancelCapitalMove' }).ok).toBe(true);
    expect(stock.money).toBe(before + 20000);
  });
});

describe('Untergang einer Nation', () => {
  it('Angebote der untergegangenen Nation (diplomatisch und an der Börse) verschwinden', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'MN' });
    sim.state.proposals.push({ from: 'MN', to: 'DE', kind: 'peace', time: 0 }, { from: 'FR', to: 'MN', kind: 'peace', time: 0 }, { from: 'FR', to: 'DE', kind: 'peace', time: 0 });
    sim.state.market.offers.push({ id: 900, nation: 'MN', side: 'sell', res: 'grain', amount: 100, price: 1, time: 0 });
    for (const [i, p] of sim.state.provinces.entries()) if (p.owner === 'MN') conquer(sim.ctx, i, 'DE');
    expect(sim.state.nations.MN.alive).toBe(false);
    expect(sim.state.proposals).toEqual([{ from: 'FR', to: 'DE', kind: 'peace', time: 0 }]);
    expect(sim.state.market.offers.some((o) => o.nation === 'MN')).toBe(false);
  });
});

describe('Spielbeginn', () => {
  it('alle Provinzen und Truppen starten mit 70 % Moral', () => {
    const sim = newSim();
    expect(sim.state.provinces.every((p) => p.morale === 0.7)).toBe(true);
    expect(sim.state.armies.every((a) => a.morale === 0.7)).toBe(true);
  });
});

describe('Kampf am Ort, fortgesetzte Befehle, Besatzung, Bahn zum Hafen', () => {
  /** Landweg von einer deutschen zu einer Provinz der Nation `to` */
  const border = (to: string) => {
    for (const p of map.provinces) {
      if (p.nation !== 'DE') continue;
      const q = (p.links ?? []).find((n) => map.provinces[n].nation === to);
      if (q !== undefined) return [p.id, q] as const;
    }
    throw new Error('kein Grenzweg');
  };

  it('eine Armee auf dem Weg vor einer Stadt kämpft nicht mit der Besatzung und erobert sie nicht', () => {
    const sim = newSim();
    const [p, q] = border('FR');
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    const garrison: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 1 } };
    const road: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: q, pos: { a: p, b: q, f: 0.8 }, units: { infantry: 20 } };
    sim.state.armies.push(garrison, road);
    expect(inMelee(sim.state, map, road)).toBe(false);
    combatRound(sim.ctx);
    expect(garrison.units.infantry).toBe(1);
    expect(sim.state.provinces[q].owner).toBe('FR');
  });

  it('nach einem Kampf auf dem Weg zieht die Armee zu ihrem Ziel weiter', () => {
    const sim = newSim();
    const [p, q] = border('FR');
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 40 } };
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: p, pos: { a: p, b: q, f: 0.4 }, units: { infantry: 2 } };
    sim.state.armies.push(de, fr);
    expect(sim.apply('DE', { type: 'move', army: de.id, to: q }).ok).toBe(true);
    sim.advance(3 * DAY);
    expect(sim.state.armies.includes(fr)).toBe(false);
    expect(de.node).toBe(q);
    expect(de.pos ?? null).toBeNull();
    expect(sim.state.provinces[q].owner).toBe('DE');
  });

  it('läuft eine leere Stadt über, stellt der neue Herr eine Infanterie hinein', () => {
    const sim = newSim();
    const t = map.provinces.find((p) => p.nation === 'DE' && !p.capital && p.neighbors.some((n) => map.provinces[n].nation !== 'DE'))!.id;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== t);
    sim.state.provinces[t].morale = 0;
    for (let k = 0; k < 200 && sim.state.provinces[t].owner === 'DE'; k++) defections(sim.ctx);
    const owner = sim.state.provinces[t].owner;
    expect(owner).not.toBe('DE');
    const here = sim.state.armies.filter((a) => a.node === t && a.owner === owner);
    expect(here.reduce((s, a) => s + (a.units.infantry ?? 0), 0)).toBeGreaterThanOrEqual(1);
  });

  it('eigene Eisenbahn verkürzt den Weg zum Hafenpunkt', () => {
    const sim = newSim();
    const mp = map.provinces.find((p) => p.nation === 'DE' && (p.seaLinks ?? p.seas).length > 0)!;
    const sea = map.provinces.length + (mp.seaLinks ?? mp.seas)[0];
    const a: Army = { id: 998, owner: 'DE', node: mp.id, units: { infantry: 2 } };
    const slow = segmentHours(sim.state, map, a, mp.id, sea);
    sim.state.provinces[mp.id].buildings.railroad = 1;
    expect(segmentHours(sim.state, map, a, mp.id, sea)).toBeLessThan(slow);
    expect(segmentHours(sim.state, map, a, sea, mp.id)).toBeLessThan(slow);
  });
});

describe('Bauabbruch', () => {
  it('ein abgebrochener Bau erstattet die vollen Kosten', () => {
    const sim = newSim();
    sim.state.time = 2 * DAY;
    const berlin = prov('Berlin');
    sim.state.provinces[berlin].buildings.workshop = 1;
    const stock = sim.state.nations.DE.stock;
    const before = { ...stock };
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'factory' }).ok).toBe(true);
    expect(stock.money).toBeLessThan(before.money);
    expect(sim.apply('DE', { type: 'cancelBuild', province: berlin }).ok).toBe(true);
    for (const r of ALL_RES) expect(stock[r]).toBeCloseTo(before[r], 6);
  });
});

describe('Ein- und Ausschiffen angreifbar', () => {
  it('wer beim Einschiffen am Hafenpunkt gestellt wird, kämpft mit halber Stärke ohne Fernkampf und schifft danach weiter ein', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const mp = map.provinces.find((p) => p.nation === 'DE' && (p.seaLinks ?? []).length > 0)!;
    const sea = map.provinces.length + mp.seaLinks![0];
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: mp.id, units: { infantry: 10, artillery: 2 }, morale: 1 };
    sim.state.armies.push(de);
    expect(sim.apply('DE', { type: 'move', army: de.id, to: sea }).ok).toBe(true);
    // bis in die Wartezeit am Hafenpunkt
    const land = harborLeg(map, mp.id, sea) / UNITS.artillery.speed;
    sim.advance(Math.ceil((land + 0.5) * HOUR));
    const loc = armyLocation(de, sim.state.time);
    expect('road' in loc).toBe(true);
    const f = 'road' in loc ? loc.road.f : 0;
    // Franzosen kurz vor dem Hafenpunkt auf demselben Weg, Ziel: die wartende Armee
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: mp.id, pos: { a: mp.id, b: sea, f: f - 0.002 }, units: { infantry: 30 }, morale: 1 };
    sim.state.armies.push(fr);
    expect(sim.apply('FR', { type: 'move', army: fr.id, to: mp.id, toward: sea, frac: f }).ok).toBe(true);
    sim.advance(5 * MINUTE);
    expect(de.move ?? null).toBeNull();
    expect(de.boarding).toBe(true);
    expect(fr.boarding).toBeFalsy();
    expect(maxRange(de, map)).toBe(0);
    const full = meleeOutput(sim.state, map, { ...de, boarding: undefined });
    expect(meleeOutput(sim.state, map, de)).toBeLessThan(full);
    expect(de.resume).toBeTruthy();
  });
});

describe('Mehrere Angreifer, Abzug im Frieden', () => {
  it('greifen zwei nicht verfeindete Nationen dieselbe Stadt an, erobert die stärkere; die andere zieht ohne Krieg ab', () => {
    const sim = newSim();
    const ch = map.provinces.find((p) => p.nation === 'CH' && p.neighbors.some((n) => map.provinces[n].nation === 'DE'))!.id;
    sim.apply('DE', { type: 'declareWar', nation: 'CH' });
    sim.apply('IT', { type: 'declareWar', nation: 'CH' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== ch);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: ch, units: { infantry: 30 } };
    const it: Army = { id: sim.state.nextArmyId++, owner: 'IT', node: ch, units: { infantry: 10 } };
    const sw: Army = { id: sim.state.nextArmyId++, owner: 'CH', node: ch, units: { infantry: 2 } };
    sim.state.armies.push(de, it, sw);
    for (let k = 0; k < 10 && sim.state.provinces[ch].owner === 'CH'; k++) combatRound(sim.ctx);
    expect(sim.state.provinces[ch].owner).toBe('DE');
    expect(sim.state.armies.includes(it)).toBe(true);
    // Italien zieht in eigenes Gebiet ab: kein Krieg mit Deutschland nötig
    const home = map.provinces.find((p) => p.nation === 'IT')!.id;
    expect(requiredWars(sim.state, map, it, { node: home })).toEqual([]);
    expect(sim.apply('IT', { type: 'move', army: it.id, to: home }).ok).toBe(true);
    expect(atWar(sim.state, 'IT', 'DE')).toBe(false);
  });

  it('Wege und Wegpunkte im Friedensgebiet verlangen keinen Krieg, fremde Städte schon', () => {
    const sim = newSim();
    const p = map.provinces.find((x) => x.nation === 'DE' && (x.links ?? []).some((n) => map.provinces[n].nation === 'NL'))!;
    const nl = p.links!.find((n) => map.provinces[n].nation === 'NL')!;
    const a: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: nl, pos: { a: p.id, b: nl, f: 0.8 }, units: { infantry: 5 } };
    sim.state.armies.push(a);
    expect(requiredWars(sim.state, map, a, { node: p.id })).toEqual([]);
    expect(requiredWars(sim.state, map, a, { road: { a: p.id, b: nl, f: 0.95 } })).toEqual([]);
    expect(requiredWars(sim.state, map, a, { node: nl })).toEqual(['NL']);
  });
});

describe('Nahkampfbegrenzung und zufällige Treffer', () => {
  it('Beispiel: 2 Panzer + 100 Infanterie machen 5,6 mehr Schaden als 110 Infanterie (100 % Moral)', () => {
    const sim = newSim();
    // neutraler Ort an Land (keine eigene Provinz → Angriffswerte)
    const at = map.provinces.find((p) => p.nation === 'FR')!.id;
    const a: Army = { id: 1, owner: 'DE', node: at, units: { tank: 2, infantry: 100 }, morale: 1 };
    const b: Army = { id: 2, owner: 'IT', node: at, units: { infantry: 110 }, morale: 1 };
    expect(meleeOutput(sim.state, map, b)).toBeCloseTo(35 * 1.2, 9);
    expect(meleeOutput(sim.state, map, a) - meleeOutput(sim.state, map, b)).toBeCloseTo(5.6, 9);
    // unter 20 Einheiten zählt jede voll
    expect(meleeOutput(sim.state, map, { ...b, units: { infantry: 10 } })).toBeCloseTo(12, 9);
  });

  it('Treffer werden je Einheit ausgewürfelt: viele Infanteristen schützen den Panzer', () => {
    let tankLost = 0, infLost = 0;
    const rnd = makeRng(7);
    for (let k = 0; k < 50; k++) {
      const a: Army = { id: 1, owner: 'DE', node: 0, units: { tank: 1, infantry: 100 } };
      applyDamage(a, 200, rnd);
      tankLost += 1 - (a.units.tank ?? 0);
      infLost += 100 - (a.units.infantry ?? 0);
    }
    expect(tankLost).toBeLessThan(10);
    expect(infLost / 50).toBeGreaterThanOrEqual(8);
  });
});

describe('Lebenspunkte der Infanterie nach Moral', () => {
  it('2,4 bei 10 % Moral, 20 bei 83,3 %, 24 bei 100 %', () => {
    const rnd = makeRng(1);
    const inf = (morale: number): Army => ({ id: 1, owner: 'DE', node: 0, units: { infantry: 1 }, morale });
    expect(unitHp(inf(0.1), 'infantry')).toBeCloseTo(2.4, 9);
    expect(unitHp(inf(1 / 1.2), 'infantry')).toBeCloseTo(20, 9);
    expect(unitHp(inf(1), 'infantry')).toBeCloseTo(24, 9);
    const strong = inf(1);
    applyDamage(strong, 23, rnd);
    expect(strong.units.infantry).toBe(1);
    const weak = inf(0.1);
    applyDamage(weak, 2.4, rnd);
    expect(weak.units.infantry ?? 0).toBe(0);
    // Panzer: unabhängig von der Moral
    expect(unitHp({ id: 2, owner: 'DE', node: 0, units: { tank: 1 }, morale: 0.1 }, 'tank')).toBe(50);
  });
});

describe('Reparatur', () => {
  it('Maschinen bekommen zum Tageswechsel 1/7 der fehlenden Lebenspunkte zurück, Infanterie nicht; im Nahkampf keine Reparatur', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    // getrennt gehalten, sonst würde sie mit der Besatzung Berlins zusammengefasst
    const a: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { tank: 2, infantry: 5 }, wounds: { tank: 35, infantry: 10 }, keepApart: true };
    sim.state.armies.push(a);
    sim.advance(DAY);
    expect(a.wounds!.tank).toBeCloseTo(30, 9);
    expect(a.wounds!.infantry).toBe(10);
    // kleine Wunden: mindestens 5 % von 50 = 2,5 je Tag, bis sie ganz verheilt sind
    const b: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { tank: 1 }, wounds: { tank: 4 } };
    sim.state.armies.push(b);
    repairMachines(sim.state, map);
    expect(b.wounds!.tank).toBeCloseTo(1.5, 9);
    repairMachines(sim.state, map);
    expect(b.wounds!.tank).toBeUndefined();
    // im Nahkampf: keine Reparatur
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'FR', node: berlin, units: { infantry: 1 } });
    const before = a.wounds!.tank!;
    repairMachines(sim.state, map);
    expect(a.wounds!.tank).toBe(before);
  });
});

describe('Ein-/Ausschiffen umkehren', () => {
  it('zeigt die Restzeit; Umkehr dauert so lange wie schon vergangen, Fortsetzung nur die Restzeit', () => {
    const setup = () => {
      const sim = newSim();
      const mp = map.provinces[prov('Hamburg')];
      const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: mp.id, units: { infantry: 5 } };
      sim.state.armies.push(de);
      // erstes Seegebiet auf dem Weg aufs Wasser als Ziel (direkter Hafenweg)
      sim.apply('DE', { type: 'move', army: de.id, to: map.provinces.length + mp.seaLinks![0] });
      const sea = de.move!.path[1];
      sim.apply('DE', { type: 'move', army: de.id, to: sea });
      expect(de.move!.path).toEqual([mp.id, sea]);
      const land = harborLeg(map, mp.id, sea) / UNITS.infantry.speed;
      sim.advance(Math.ceil((land + 0.5) * HOUR));
      return { sim, de, mp, sea };
    };
    // Restzeit
    let { sim, de, mp, sea } = setup();
    const bw = boardingWait(map, de, sim.state.time)!;
    expect(bw.landing).toBe(false);
    expect(bw.elapsed).toBeGreaterThan(0.4);
    expect(bw.elapsed + bw.remaining).toBeCloseTo(MILITARY.embarkHours, 1);
    // Umkehr zurück an Land: Wartezeit = bisher vergangen
    expect(sim.apply('DE', { type: 'move', army: de.id, to: mp.id }).ok).toBe(true);
    const back = boardingWait(map, de, sim.state.time)!;
    expect(back.landing).toBe(true);
    expect(back.remaining).toBeCloseTo(bw.elapsed, 1);
    // Fortsetzung aufs Wasser: nur die Restzeit
    ({ sim, de, mp, sea } = setup());
    const bw2 = boardingWait(map, de, sim.state.time)!;
    expect(sim.apply('DE', { type: 'move', army: de.id, to: sea }).ok).toBe(true);
    expect(boardingWait(map, de, sim.state.time)!.remaining).toBeCloseTo(bw2.remaining, 1);
  });
});

describe('Zielmoral unterwegs', () => {
  it('auf eigenem Gebiet (auch unterwegs) gilt die Provinzmoral, erst hinter der Grenze 50 %', () => {
    const sim = newSim();
    const [p, q] = (() => {
      for (const x of map.provinces) {
        if (x.nation !== 'DE') continue;
        const y = (x.links ?? []).find((n) => map.provinces[n].nation === 'FR');
        if (y !== undefined) return [x.id, y];
      }
      throw new Error('kein Grenzweg');
    })();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.provinces[p].morale = 0.9;
    const [l1, len] = edgeParts(map, p, q);
    const near: Army = { id: 1, owner: 'DE', node: p, pos: { a: p, b: q, f: (l1 / len) * 0.5 }, units: { infantry: 1 } };
    const far: Army = { id: 2, owner: 'DE', node: q, pos: { a: p, b: q, f: (l1 + (len - l1) * 0.5) / len }, units: { infantry: 1 } };
    expect(troopTarget(sim.state, map, near).target).toBeCloseTo(0.9, 9);
    expect(troopTarget(sim.state, map, far).target).toBeCloseTo(0.5, 9);
  });
});

describe('Gebäudeleben und Reparatur', () => {
  it('Treffer zerstören stufenweise von oben; beschädigt wirkt nicht; Reparatur kostet anteilig', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const ps = sim.state.provinces[berlin];
    ps.buildings.factory = 2;
    ps.buildings.railroad = 1;
    ps.buildings.fortress = 2;
    const hit = { ...sim.ctx, random: () => 0 };
    damageBuildings(hit, berlin);
    // Fabrik (2 Leben) und Eisenbahn (3) beschädigt, Festung (1 Leben) verliert gleich eine Stufe
    expect(ps.damage).toMatchObject({ factory: 1, railroad: 1 });
    expect(ps.buildings.fortress).toBe(1);
    expect(activeLevel(ps, 'factory')).toBe(0);
    damageBuildings(hit, berlin);
    expect(ps.buildings.factory).toBe(1);
    expect(ps.damage?.factory).toBeUndefined();
    expect(ps.damage?.railroad).toBe(2);
    // Eisenbahn mit 1/3 Leben kostet 2/3 des Preises
    const rep = checkRepair(sim.state, 'DE', berlin, 'railroad');
    expect(rep.cost.money).toBe(Math.ceil(10000 * 2 / 3));
    sim.state.nations.DE.stock.money = 100000;
    expect(sim.apply('DE', { type: 'repair', province: berlin, building: 'railroad' }).ok).toBe(true);
    expect(activeLevel(ps, 'railroad')).toBe(1);
  });

  it('Börse: Höchstpreis 1000 je Einheit', () => {
    expect(priceBounds('grain')[1]).toBe(1000);
    expect(priceBounds('oil')[1]).toBe(1000);
  });
});

describe('Vorbeimarsch an einem laufenden Kampf', () => {
  const border = () => {
    for (const p of map.provinces) {
      if (p.nation !== 'DE') continue;
      const q = (p.links ?? []).find((n) => map.provinces[n].nation === 'FR');
      if (q !== undefined) return [p.id, q] as const;
    }
    throw new Error('kein Grenzweg');
  };

  it('eine dritte Armee, die über den Weg an der Kampfstelle vorbeizieht, wird gestellt', () => {
    const sim = newSim();
    const [p, q] = border();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    // Kampf mitten auf dem Weg
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, pos: { a: p, b: q, f: 0.5 }, units: { infantry: 40 } };
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: p, pos: { a: p, b: q, f: 0.5 }, units: { infantry: 40 } };
    // französischer Nachschub zieht von der eigenen Stadt aus über den Weg nach Deutschland
    const third: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 10 } };
    sim.state.armies.push(de, fr, third);
    expect(sim.apply('FR', { type: 'move', army: third.id, to: p }).ok).toBe(true);
    sim.advance(DAY);
    // nicht vorbeigekommen: Deutschland hält die Stadt p, der Nachschub steht an der Kampfstelle (oder ist gefallen)
    expect(sim.state.provinces[p].owner).toBe('DE');
    if (sim.state.armies.includes(third)) expect(third.node === p && !third.pos).toBe(false);
  });

  it('eine dritte Armee, die durch eine umkämpfte Stadt marschieren will, bleibt dort stehen', () => {
    const sim = newSim();
    const [p, q] = border();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 40 } };
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: p, units: { infantry: 40 } };
    const beyond = map.provinces[p].links!.find((n) => n !== q && map.provinces[n].nation === 'DE')!;
    // hinter der Stadt keine Besatzung: käme der Nachschub durch, würde er die Provinz sofort erobern
    sim.state.armies = sim.state.armies.filter((a) => a.node !== beyond);
    const third: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 10 } };
    sim.state.armies.push(de, fr, third);
    expect(sim.apply('FR', { type: 'move', army: third.id, to: beyond }).ok).toBe(true);
    sim.advance(DAY);
    expect(sim.state.provinces[beyond].owner).toBe('DE');
  });
});

describe('KI: keine Kleinsttrupps in den Tod', () => {
  it('ein kleiner Überschuss greift eine nicht einsehbare feindliche Provinz nicht an, ein großer schon', () => {
    const decide = (extra: number) => {
      const sim = newSim();
      sim.apply('DE', { type: 'declareWar', nation: 'FR' });
      const p = map.provinces.find((x) => x.nation === 'DE' && (x.links ?? []).some((n) => map.provinces[n].nation === 'FR'))!;
      // Grenzprovinz mit Besatzung + Überschuss; die französische Provinz dahinter liegt im Nebel
      sim.state.armies = sim.state.armies.filter((a) => a.node !== p.id);
      sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: p.id, units: { infantry: 5 + extra }, morale: 1 });
      const view = { state: sim.state, map, nation: 'DE', rates: nationRates(sim.state, map, 'DE'), random: () => 0.5 };
      // Märsche in feindliches Gebiet (Sammeln in eigenen Provinzen ist erlaubt)
      return new BasicAI().decide(view).filter((x) => x.type === 'move' && sim.state.provinces[x.to]?.owner !== 'DE');
    };
    expect(decide(3)).toEqual([]);
    expect(decide(30).length).toBeGreaterThan(0);
  });
});

describe('Diplomatie: Tribut und Kriegserklärung', () => {
  it('Tribut wird erst bei Annahme gezahlt; die KI nimmt Frieden gegen ordentlichen Tribut an', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const de = sim.state.nations.DE.stock, fr = sim.state.nations.FR.stock;
    de.money = 100000;
    expect(sim.apply('DE', { type: 'propose', nation: 'FR', kind: 'peace', tribute: { money: 60000, coal: 1000 } }).ok).toBe(true);
    expect(de.money).toBe(100000);
    const frBefore = fr.money;
    // die französische KI entscheidet: deutlich stärker, aber der Tribut lohnt sich
    const view = { state: sim.state, map, nation: 'FR', rates: nationRates(sim.state, map, 'FR'), random: () => 0.99 };
    const answer = new BasicAI().decide(view).find((a) => a.type === 'answer');
    expect(answer).toMatchObject({ nation: 'DE', accept: true });
    expect(sim.apply('FR', answer!).ok).toBe(true);
    expect(atWar(sim.state, 'DE', 'FR')).toBe(false);
    expect(de.money).toBe(40000);
    expect(fr.money).toBe(frBefore + 60000);
    // nicht bezahlbarer Tribut wird abgelehnt
    expect(sim.apply('DE', { type: 'propose', nation: 'IT', kind: 'rightOfWay', tribute: { money: 999999 } }).ok).toBe(false);
  });

  it('wer den Krieg erklärt, verliert 2 Tage lang 5 % Moralziel, auch bei mehreren Erklärungen nur einmal', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const before = moraleTarget(sim.state, map, berlin).target;
    sim.apply('DE', { type: 'declareWar', nation: 'DK' });
    const t = moraleTarget(sim.state, map, berlin);
    expect(t.parts.find((p) => p.label === 'Kriegserklärung')?.value).toBeCloseTo(-0.05, 9);
    // dazu kommt der übliche Abzug für den Krieg selbst
    expect(t.target).toBeCloseTo(before - 0.05 - MORALE.warEach, 6);
    // die angegriffene Seite bekommt keinen Erklärungsabzug
    const dk = map.provinces.find((p) => p.nation === 'DK')!.id;
    expect(moraleTarget(sim.state, map, dk).parts.some((p) => p.label.startsWith('Kriegserklärung'))).toBe(false);
    sim.apply('DE', { type: 'declareWar', nation: 'NL' });
    expect(moraleTarget(sim.state, map, berlin).parts.filter((p) => p.label.startsWith('Kriegserklärung')).map((p) => p.value)).toEqual([-0.05]);
    sim.advance(2 * DAY + 1);
    expect(moraleTarget(sim.state, map, berlin).parts.some((p) => p.label.startsWith('Kriegserklärung'))).toBe(false);
  });
});

describe('KI: Nahrung', () => {
  it('schaltet Kasernen bei Getreidemangel ab und deckt den Provinzunterhalt mit Fisch', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    sim.state.provinces[berlin].buildings.barracks = 2;
    sim.state.provinces[berlin].buildings.recruitment = 1;
    sim.state.nations.DE.stock.grain = 100;
    sim.invalidate();
    sim.advance(60_000);
    const view = { state: sim.state, map, nation: 'DE', rates: nationRates(sim.state, map, 'DE'), random: () => 0.5 };
    const acts = new BasicAI().decide(view);
    expect(acts).toContainEqual({ type: 'switchBuilding', province: berlin, building: 'barracks', on: false });
    // Großmächte lassen ihre Wehrämter an (sie erobern lieber), Kleinstaaten schalten sie ab
    expect(acts).not.toContainEqual({ type: 'switchBuilding', province: berlin, building: 'recruitment', on: false });
    const ams = prov('Amsterdam');
    sim.state.nations.NL.stock.grain = 100;
    sim.state.provinces[ams].buildings.barracks = 2;
    sim.invalidate();
    sim.advance(60_000);
    const nl = new BasicAI().decide({ state: sim.state, map, nation: 'NL', rates: nationRates(sim.state, map, 'NL'), random: () => 0.5 });
    expect(nl).toContainEqual({ type: 'switchBuilding', province: ams, building: 'recruitment', on: false });
    const food = acts.find((a) => a.type === 'setConsumption' && a.category === 'food');
    if (food && food.type === 'setConsumption') expect(food.shares.fish ?? 0).toBeGreaterThan(food.shares.grain ?? 0);
    // keine neuen Kasernen ohne Getreideüberschuss
    expect(acts.some((a) => a.type === 'build' && a.building === 'barracks')).toBe(false);
  });
});

describe('Wehramt abschaltbar', () => {
  it('abgeschaltetes Wehramt stellt keine Infanterie auf; mit Kaserne geht es halb so schnell weiter', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const ps = sim.state.provinces[berlin];
    ps.buildings.recruitment = 1;
    ps.buildings.barracks = 0;
    expect(recruitHours(ps)).not.toBeNull();
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'recruitment', on: false }).ok).toBe(true);
    expect(recruitHours(ps)).toBeNull();
    ps.buildings.barracks = 1;
    const half = recruitHours(ps)!;
    sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'recruitment', on: true });
    expect(recruitHours(ps)!).toBeCloseTo(half / 2, 6);
  });
});

describe('Festung und Sicht', () => {
  it('Festung ab Stufe 2 verbirgt die Besatzung – aber nicht vor Truppen in derselben Provinz', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const p = map.provinces.find((x) => x.nation === 'DE' && (x.links ?? []).some((n) => map.provinces[n].nation === 'FR'))!;
    const q = p.links!.find((n) => map.provinces[n].nation === 'FR')!;
    sim.state.provinces[q].buildings.fortress = 2;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== q);
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 5 } };
    sim.state.armies.push(fr);
    // deutsche Späher direkt vor der Grenze, noch im eigenen Gebiet: Besatzung verborgen
    const [l1, len] = edgeParts(map, p.id, q);
    const scout: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p.id, pos: { a: p.id, b: q, f: (l1 / len) * 0.99 }, units: { infantry: 1 } };
    sim.state.armies.push(scout);
    let vis = visibleNodes(sim.state, map, 'DE');
    const near = Math.hypot(...([0, 1].map((k) => map.provinces[q].center[k] - armyPosition(map, scout, sim.state.time)[k]) as [number, number]));
    if (near <= 100) expect(armyVisible(sim.state, map, 'DE', fr, vis)).toBe(false);
    // deutsche Truppen in der Stadt (im Kampf): Besatzung sichtbar
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: q, units: { infantry: 10 } });
    vis = visibleNodes(sim.state, map, 'DE');
    expect(armyVisible(sim.state, map, 'DE', fr, vis)).toBe(true);
  });
});

describe('Kampfmoral und Flächenschaden', () => {
  const army = (owner: string, node: number, infantry: number, morale = 0.7): Army => ({ id: Math.floor(Math.random() * 1e9), owner, node, units: { infantry }, morale });

  it('Mechanik 1, Moral je Kampfrunde: Verluste höchstens −4 %, Abschüsse höchstens +4 %', () => {
    const a = (m = 0.5) => army('DE', 0, 10, m);
    const cases: [Partial<{ foes: number; shelled: boolean; kills: number }>, number][] = [
      [{ foes: 1 }, -0.02], // Nahkampf
      [{ foes: 2 }, -0.03], // gegen mehrere Armeen
      [{ foes: 100 }, -0.03], // egal wie viele
      [{ shelled: true }, -0.02], // nur Beschuss, egal wie viele Schützen
      [{ foes: 5, shelled: true }, -0.04], // Höchstwert
      [{ foes: 1, kills: 10 }, 0.02], // im Nahkampf netto höchstens +2 %
      [{ kills: 10 }, 0.04], // Schütze ohne Gegenwehr
      [{ foes: 3, shelled: true, kills: 2 }, -0.02],
    ];
    for (const [e, d] of cases) {
      const x = a();
      applyCombatMorale(new Map([[x, { foes: 0, shelled: false, kills: 0, ...e }]]), 1);
      expect(x.morale! - 0.5, JSON.stringify(e)).toBeCloseTo(d, 9);
    }
  });

  it('jede gegnerische Armee im Umkreis von 1 km bekommt den vollen Nahkampfschaden', () => {
    const sim = newSim();
    const fr = map.provinces.find((p) => p.nation === 'FR' && !p.capital && (p.links ?? []).length)!;
    const q = fr.id, p = fr.links![0];
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    sim.state.provinces[q].buildings.fortress = 0;
    const attacker = army('DE', q, 20);
    const big = army('FR', q, 60), small = army('FR', q, 10);
    // auf dem Weg: etwa 0,5 km und etwa 2 km vor der Stadt
    const at = (km: number): Army => {
      const x = army('FR', q, 30);
      const city = armyPosition(map, x, 0);
      let f = 1;
      x.pos = { a: p, b: q, f };
      while (f > 0) {
        const pt = armyPosition(map, x, 0);
        if (Math.hypot(pt[0] - city[0], pt[1] - city[1]) >= km) break;
        f -= 0.0005;
        x.pos = { a: p, b: q, f };
      }
      return x;
    };
    const near = at(0.5), far = at(2);
    sim.state.armies.push(attacker, big, small, near, far);
    const hp = (x: Army) => x.units.infantry! * unitHp(x, 'infantry') - (x.wounds?.infantry ?? 0);
    const h0 = new Map([big, small, near, far].map((x) => [x, hp(x)]));
    // Moral erst danach anwenden, sonst ändern sich die Lebenspunkte je Infanterist
    const tally = new Map();
    combatRound(sim.ctx, tally);
    const loss = (x: Army) => h0.get(x)! - hp(x);
    expect(loss(big)).toBeGreaterThan(0);
    // voller Schaden statt Aufteilung nach Stärke: beide Armeen am Ort verlieren gleich viel
    expect(loss(small)).toBeCloseTo(loss(big), 6);
    expect(loss(near)).toBeCloseTo(loss(big), 6);
    expect(loss(far)).toBe(0);
    // die Armee 0,5 km vor der Stadt ist im Nahkampf (gegen eine Armee), der Angreifer gegen drei
    expect(tally.get(near)?.foes).toBe(1);
    expect(tally.get(attacker)?.foes).toBe(3);
    expect(tally.has(far)).toBe(false);
  });

  it('Beschuss trifft alle Gegner im Umkreis des Ziels voll und zählt einmal je Stunde', () => {
    const sim = newSim();
    const fr = map.provinces.find((p) => p.nation === 'FR' && !p.capital && (p.links ?? []).length)!;
    const q = fr.id, p = fr.links![0];
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    sim.state.provinces[q].buildings.fortress = 0;
    const target = army('FR', q, 40), other = army('FR', q, 5);
    // zwei Artillerien knapp vor der Stadt (außerhalb des Umkreises), beide auf dasselbe Ziel
    const gun = (): Army => {
      const g: Army = { ...army('DE', q, 0), units: { artillery: 5 }, target: target.id };
      const city = armyPosition(map, g, 0);
      for (let f = 1; f > 0; f -= 0.001) {
        g.pos = { a: p, b: q, f };
        const pt = armyPosition(map, g, 0);
        if (Math.hypot(pt[0] - city[0], pt[1] - city[1]) >= 10) break;
      }
      return g;
    };
    const g1 = gun(), g2 = gun();
    sim.state.armies.push(target, other, g1, g2);
    const hp = (x: Army) => x.units.infantry! * unitHp(x, 'infantry') - (x.wounds?.infantry ?? 0);
    const h0 = new Map([target, other].map((x) => [x, hp(x)]));
    const tally = new Map();
    rangedRound(sim.ctx, tally);
    const lossT = h0.get(target)! - hp(target), lossO = h0.get(other)! - hp(other);
    expect(lossT).toBeGreaterThan(0);
    expect(lossO).toBeCloseTo(lossT, 6);
    expect(tally.get(target)).toMatchObject({ shelled: true, foes: 0 });
    expect(tally.get(other)).toMatchObject({ shelled: true });
  });
});

describe('Nahkampfreichweite 1 km', () => {
  const setup = () => {
    const sim = newSim();
    const fr = map.provinces.find((p) => p.nation === 'FR' && !p.capital && (p.links ?? []).some((n) => map.provinces[n].nation === 'DE'))!;
    const q = fr.id, p = fr.links!.find((n) => map.provinces[n].nation === 'DE')!;
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    sim.state.provinces[q].buildings.fortress = 0;
    // Anteil auf dem Weg q→p, der km von der Stadt q entfernt liegt
    const roadAt = (km: number) => {
      const c = nodePos(map, q);
      for (let f = 0; f <= 1; f += 0.0002) {
        const pt = edgePoint(map, q, p, f);
        if (Math.hypot(pt[0] - c[0], pt[1] - c[1]) >= km) return f;
      }
      return 1;
    };
    return { sim, p, q, roadAt };
  };

  it('Artillerie dicht vor einer Stadt ist im Nahkampf gebunden, weiter weg nicht', () => {
    const { sim, p, q, roadAt } = setup();
    const garrison: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 1 } };
    const close: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: q, pos: { a: q, b: p, f: roadAt(0.8) }, units: { artillery: 2 } };
    const away: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: q, pos: { a: q, b: p, f: roadAt(1.5) }, units: { artillery: 2 } };
    sim.state.armies.push(garrison, close, away);
    expect(inMelee(sim.state, map, close)).toBe(true);
    expect(inMelee(sim.state, map, away)).toBe(false);
    expect(inMelee(sim.state, map, garrison)).toBe(true);
  });

  it('wer sich auf 1 km nähert, bleibt stehen, kämpft und erobert die Stadt aus dieser Entfernung', () => {
    const { sim, p, q } = setup();
    const garrison: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 1 } };
    const army: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 20 } };
    sim.state.armies.push(garrison, army);
    expect(sim.apply('DE', { type: 'move', army: army.id, to: q }).ok).toBe(true);
    for (let k = 0; k < 5 * 24 * 60 && army.move; k++) sim.advance(MINUTE);
    expect(army.move).toBeNull();
    const at = armyPosition(map, army, sim.state.time), c = nodePos(map, q);
    const dist = Math.hypot(at[0] - c[0], at[1] - c[1]);
    expect(dist).toBeLessThanOrEqual(1.0001);
    expect(dist).toBeGreaterThan(0.3);
    expect(inMelee(sim.state, map, army)).toBe(true);
    sim.advance(DAY);
    expect(sim.state.armies.includes(garrison)).toBe(false);
    expect(sim.state.provinces[q].owner).toBe('DE');
  });
});
