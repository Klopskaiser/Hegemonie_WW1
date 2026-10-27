import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBAT_MORALE_V2, DAY, DEFAULT_COMBAT_MORALE, HOUR, MILITARY, MINUTE, SUPERIORITY, UNITS } from '../src/game/balance.ts';
import { applyCombatMorale, armyHp, armyPosition, combatRound, forcedMarchWear, killPoints2, meleeOutput, meleePower, rangedPower, repairMachines, segmentHours, unitCount } from '../src/game/military.ts';
import { allRates, netRate, upkeepUse } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;

function setup() {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 7, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  const sim = new Simulation(state, map);
  const fr = map.provinces.find((p) => p.nation === 'FR' && !p.capital && (p.links ?? []).some((n) => map.provinces[n].nation === 'DE'))!;
  const q = fr.id, p = fr.links!.find((n) => map.provinces[n].nation === 'DE')!;
  sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
  const add = (a: Omit<Army, 'id'>): Army => {
    const x = { id: sim.state.nextArmyId++, ...a } as Army;
    sim.state.armies.push(x);
    return x;
  };
  const dist = (a: Army, b: Army) => {
    const u = armyPosition(map, a, sim.state.time), v = armyPosition(map, b, sim.state.time);
    return Math.hypot(u[0] - v[0], u[1] - v[1]);
  };
  return { sim, p, q, add, dist };
}

describe('Gewaltmarsch', () => {
  it('50 % schneller; im Marsch −4 % Moral je Stunde, Maschinen fallen aus, keine Reparatur', () => {
    const { sim, p, q, add } = setup();
    const a = add({ owner: 'DE', node: p, units: { infantry: 5, tank: 2 }, morale: 0.8, keepApart: true });
    const normal = segmentHours(sim.state, map, a, p, q);
    a.forcedMarch = true;
    expect(segmentHours(sim.state, map, a, p, q)).toBeCloseTo(normal / MILITARY.forcedMarchSpeed, 9);
    // Verschleiß im Marsch
    const far = map.provinces.find((x) => x.nation === 'DE' && x.id !== p && Math.hypot(x.center[0] - map.provinces[p].center[0], x.center[1] - map.provinces[p].center[1]) > 400)!;
    expect(sim.apply('DE', { type: 'move', army: a.id, to: far.id }).ok).toBe(true);
    sim.advance(HOUR);
    expect(a.morale).toBeCloseTo(0.76, 6);
    expect(a.wounds?.tank).toBeCloseTo(2 * UNITS.tank.hp * MILITARY.forcedMarchWear, 6);
    const w = a.wounds!.tank!;
    repairMachines(sim.state, map);
    expect(a.wounds!.tank).toBe(w);
    // nach 13 Marschstunden hat sich der erste Panzer aufgerieben (2 × 4 % = 8 % je Stunde)
    for (let k = 0; k < 12; k++) forcedMarchWear(sim.ctx);
    expect(a.units.tank ?? 0).toBeLessThan(2);
  });

  it('Umschalten im Marsch plant den Weg mit dem neuen Tempo', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const a = add({ owner: 'DE', node: p, units: { infantry: 5 }, keepApart: true });
    expect(sim.apply('DE', { type: 'move', army: a.id, to: q }).ok).toBe(true);
    const slow = a.move!.segEnd;
    expect(sim.apply('DE', { type: 'setMarch', army: a.id, forced: true }).ok).toBe(true);
    expect(a.move!.segEnd).toBeLessThan(slow);
  });
});

describe('Marschart und Angriff', () => {
  it('Normalmarsch zieht an Gegnern in Reichweite vorbei, der Angriffsmarsch hält und feuert', () => {
    for (const aggressive of [false, true]) {
      const { sim, p, q, add, dist } = setup();
      sim.apply('DE', { type: 'declareWar', nation: 'FR' });
      const foe = add({ owner: 'FR', node: q, units: { infantry: 3 } });
      const gun = add({ owner: 'DE', node: p, units: { artillery: 3 }, aggressive: aggressive || undefined });
      expect(sim.apply('DE', { type: 'move', army: gun.id, to: q }).ok).toBe(true);
      let stopped = false;
      for (let k = 0; k < 3 * 24 * 6 && gun.move; k++) {
        sim.advance(10 * MINUTE);
        // angehalten, um zu feuern – nicht erst in Nahkampfreichweite
        if (!gun.move && gun.target != null && dist(gun, foe) > MILITARY.meleeKm + 0.01) stopped = true;
      }
      if (aggressive) {
        expect(stopped).toBe(true);
        expect(gun.resume ?? null).not.toBeNull(); // zieht nach dem Feuern weiter
      } else expect(stopped).toBe(false);
    }
  });

  it('Angriff ohne Fernkampf verfolgt den Gegner bis in den Nahkampf', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const foe = add({ owner: 'FR', node: q, units: { infantry: 1 } });
    const a = add({ owner: 'DE', node: p, units: { infantry: 20 }, keepApart: true });
    expect(sim.apply('DE', { type: 'attack', army: a.id, target: foe.id }).ok).toBe(true);
    expect(a.chase).toBe(foe.id);
    expect(a.move).not.toBeNull();
    sim.advance(3 * DAY);
    expect(sim.state.armies.includes(foe)).toBe(false);
    expect(a.chase ?? null).toBeNull();
  });

  it('Angriff mit Fernkampf rückt nur bis in Reichweite heran und beschießt', () => {
    const { sim, p, q, add, dist } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const foe = add({ owner: 'FR', node: q, units: { infantry: 30 } });
    const gun = add({ owner: 'DE', node: p, units: { artillery: 3, infantry: 2 }, keepApart: true });
    expect(sim.apply('DE', { type: 'attack', army: gun.id, target: foe.id }).ok).toBe(true);
    for (let k = 0; k < 3 * 24 * 6 && (gun.move || dist(gun, foe) > UNITS.artillery.range); k++) sim.advance(10 * MINUTE);
    expect(gun.move ?? null).toBeNull();
    const d = dist(gun, foe);
    expect(d).toBeLessThanOrEqual(UNITS.artillery.range);
    expect(d).toBeGreaterThan(MILITARY.meleeKm);
    expect(gun.target).toBe(foe.id);
  });
});

describe('Verbände im Umkreis von 1 km', () => {
  it('stehende Armeen werden zusammengefasst, abgeteilte nicht', () => {
    const { sim, add } = setup();
    const berlin = prov('Berlin');
    const garrison = sim.state.armies.find((a) => a.owner === 'DE' && a.node === berlin)!;
    const n0 = unitCount(garrison);
    const extra = add({ owner: 'DE', node: berlin, units: { infantry: 4 } });
    const apart = add({ owner: 'DE', node: berlin, units: { infantry: 3 }, keepApart: true });
    sim.advance(10 * MINUTE);
    expect(sim.state.armies.includes(extra)).toBe(false);
    expect(unitCount(garrison)).toBe(n0 + 4);
    expect(sim.state.armies.includes(apart)).toBe(true);
    // per Teilen entstandene Armeen bleiben getrennt
    const r = sim.apply('DE', { type: 'split', army: garrison.id, units: { infantry: 2 } });
    if (!r.ok) throw new Error(r.error);
    sim.advance(10 * MINUTE);
    expect(sim.state.armies.some((a) => a.id === r.army)).toBe(true);
  });

  it('eine Armee mit unterbrochenem Marschbefehl kämpft im Verband und zieht danach mit ihrem Anteil weiter', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    add({ owner: 'FR', node: q, units: { infantry: 2 } });
    const big = add({ owner: 'DE', node: q, units: { infantry: 20 } });
    const late = add({ owner: 'DE', node: q, units: { infantry: 6 }, resume: { node: p } });
    sim.advance(10 * MINUTE);
    expect(sim.state.armies.includes(late)).toBe(false);
    expect(big.parts?.map((x) => x.id)).toEqual([late.id]);
    sim.advance(DAY);
    const again = sim.state.armies.find((a) => a.id === late.id);
    expect(again).toBeDefined();
    expect(unitCount(again!)).toBeGreaterThan(0);
    expect(unitCount(again!)).toBeLessThanOrEqual(6);
    expect(big.parts ?? null).toBeNull();
    // zieht zu seinem Ziel weiter (oder ist schon dort)
    expect(again!.move !== null || again!.node === p).toBe(true);
  });
});

describe('Durchmarsch durch einen laufenden Kampf', () => {
  it('die Truppen am Ort bleiben dort, nur die durchziehende Armee zieht mit ihrem Anteil weiter', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const r = map.provinces[q].links!.find((n) => n !== p && map.provinces[n].nation === 'FR')!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== r);
    sim.state.provinces[q].buildings.fortress = 0;
    add({ owner: 'FR', node: q, units: { infantry: 12 } });
    const fighter = add({ owner: 'DE', node: q, units: { infantry: 25 } });
    // größere Armee etwa 5 km vor der Stadt, Befehl: durch die Stadt zum nächsten Ort
    const c = map.provinces[q].center;
    let f = 0;
    for (; f < 1; f += 0.0005) {
      const passer: Army = { id: -1, owner: 'DE', node: q, pos: { a: q, b: p, f }, units: { infantry: 1 } };
      const pt = armyPosition(map, passer, 0);
      if (Math.hypot(pt[0] - c[0], pt[1] - c[1]) >= 5) break;
    }
    const passer = add({ owner: 'DE', node: q, pos: { a: q, b: p, f }, units: { infantry: 40 } });
    expect(sim.apply('DE', { type: 'move', army: passer.id, to: r }).ok).toBe(true);
    sim.advance(2 * DAY);
    expect(sim.state.provinces[q].owner).toBe('DE');
    // in der eroberten Provinz steht die kämpfende Armee noch (im Umkreis der Stadt)
    const stay = sim.state.armies.filter((a) => a.owner === 'DE' && !a.move && unitCount(a) > 0 && (() => {
      const pt = armyPosition(map, a, sim.state.time);
      return Math.hypot(pt[0] - c[0], pt[1] - c[1]) <= MILITARY.meleeKm;
    })());
    expect(stay.length).toBeGreaterThan(0);
    expect(stay.some((a) => a.id === fighter.id)).toBe(true);
    // die durchziehende Armee ist weitergezogen (unterwegs oder schon am Ziel)
    const again = sim.state.armies.find((a) => a.id === passer.id)!;
    expect(again).toBeDefined();
    expect(again.move !== null || again.node === r).toBe(true);
  });
});

describe('Kampfkraft im Armeefenster', () => {
  it('entspricht dem Schaden der Kampfrunde und folgt der aktuellen Moral', () => {
    const { sim, p, add } = setup();
    const a = add({ owner: 'DE', node: p, units: { infantry: 10 }, morale: 0.7, keepApart: true });
    // 1,2 × 70 % = 0,84 je Infanterist: Angriff 1, Verteidigung 1,5
    expect(meleePower(a, map, false)).toBeCloseTo(10 * 1 * 0.84, 9);
    expect(meleePower(a, map, true)).toBeCloseTo(10 * 1.5 * 0.84, 9);
    // in der eigenen Provinz verteidigt sie: genau der Wert der Kampfrunde
    expect(meleeOutput(sim.state, map, a)).toBeCloseTo(meleePower(a, map, true), 9);
    expect(armyHp(a)).toBeCloseTo(10 * UNITS.infantry.hp * 0.84, 9);
    a.morale = 0.35;
    expect(meleePower(a, map, false)).toBeCloseTo(10 * 0.42, 9);
    // große Armeen: nur die vordersten 20 Plätze voll, danach abnehmend
    const big = add({ owner: 'DE', node: p, units: { infantry: 60 }, morale: 1, keepApart: true });
    expect(meleePower(big, map, false)).toBeLessThan(60 * 1.2);
    // Artillerie: im Nahkampf halb, Fernkampf voll
    const gun = add({ owner: 'DE', node: p, units: { artillery: 4 }, keepApart: true });
    expect(meleePower(gun, map, false)).toBeCloseTo(4 * UNITS.artillery.attack * MILITARY.meleeRangedFactor, 9);
    expect(rangedPower(gun, map)).toBeCloseTo(4 * UNITS.artillery.attack, 9);
  });
});

describe('Verbrauchsregler stur', () => {
  it('fehlt ein eingestellter Rohstoff, springt kein anderer ein: Engpass, das Holz wird aufgestapelt', () => {
    const { sim } = setup();
    // eine Nation ohne eigenes Eisen, aber mit Holz
    const rates0 = allRates(sim.state, map);
    const id = Object.keys(rates0).find((n) => rates0[n].prod.iron === 0 && rates0[n].prod.lumber > rates0[n].upkeep)!;
    expect(id).toBeDefined();
    const n = sim.state.nations[id];
    // 100 % Eisen ohne Eisen: Holz bleibt unangetastet (nur fester Unterhalt), Baustoffe im Engpass
    expect(sim.apply(id, { type: 'setConsumption', category: 'materials', shares: { iron: 100, lumber: 0 } }).ok).toBe(true);
    n.stock.iron = 0;
    n.stock.lumber = 5000;
    let r = allRates(sim.state, map)[id];
    expect(upkeepUse(r, 'lumber')).toBe(0);
    let before = n.stock.lumber;
    sim.advance(12 * HOUR);
    expect(n.stock.lumber - before).toBeCloseTo(netRate(r, 'lumber') / 2, -1);
    expect(n.stock.lumber).toBeGreaterThan(before);
    expect(n.shortage.materials).toBe(true);
    // 25 % Eisen, 75 % Holz: Holz zahlt nur seine 75 %, die angezeigte Rate stimmt mit dem Vorrat überein
    expect(sim.apply(id, { type: 'setConsumption', category: 'materials', shares: { iron: 25, lumber: 75 } }).ok).toBe(true);
    n.stock.iron = 0;
    r = allRates(sim.state, map)[id];
    expect(upkeepUse(r, 'lumber')).toBeCloseTo(0.75 * r.upkeep, 6);
    before = n.stock.lumber;
    sim.advance(6 * HOUR);
    expect(n.stock.lumber - before).toBeCloseTo(netRate(r, 'lumber') / 4, -1);
  });
});

describe('Besatzung nach einer Eroberung aus 1 km', () => {
  it('ein unterbrochener Marsch geht nach der Eroberung weiter, eine Einheit bleibt in der Stadt', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const r = map.provinces[q].links!.find((n) => n !== p && map.provinces[n].nation === 'FR')!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== r);
    sim.state.provinces[q].buildings.fortress = 0;
    add({ owner: 'FR', node: q, units: { infantry: 1 } });
    const a = add({ owner: 'DE', node: p, units: { infantry: 10 }, keepApart: true });
    expect(sim.apply('DE', { type: 'move', army: a.id, to: r }).ok).toBe(true);
    for (let k = 0; k < 3 * 24 * 6 && sim.state.provinces[q].owner !== 'DE'; k++) sim.advance(10 * MINUTE);
    expect(sim.state.provinces[q].owner).toBe('DE');
    sim.advance(HOUR);
    const garrison = sim.state.armies.filter((x) => x.owner === 'DE' && x !== a && x.node === q && !x.pos && !x.move);
    expect(garrison.reduce((t, x) => t + unitCount(x), 0)).toBe(1);
    expect(a.move !== null || a.node === r).toBe(true);
  });

  it('eine einzelne letzte Einheit bleibt in der Stadt, ihr gemerkter Marschbefehl verfällt', () => {
    const { sim, p, q, add } = setup();
    sim.state.provinces[q].owner = 'DE';
    const one = add({ owner: 'DE', node: q, units: { infantry: 1 }, resume: { node: p }, keepApart: true });
    sim.advance(10 * MINUTE);
    expect(one.move ?? null).toBeNull();
    expect(one.node).toBe(q);
    expect(one.resume ?? null).toBeNull();
  });

  it('zieht die Armee weiter, bleibt eine Einheit in der eroberten Stadt', () => {
    const { sim, p, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const r = map.provinces[q].links!.find((n) => n !== p && map.provinces[n].nation === 'FR')!;
    sim.state.provinces[q].buildings.fortress = 0;
    const foe = add({ owner: 'FR', node: q, units: { infantry: 1 } });
    const a = add({ owner: 'DE', node: p, units: { infantry: 10 }, keepApart: true });
    expect(sim.apply('DE', { type: 'attack', army: a.id, target: foe.id }).ok).toBe(true);
    for (let k = 0; k < 3 * 24 * 6 && sim.state.provinces[q].owner !== 'DE'; k++) sim.advance(10 * MINUTE);
    expect(sim.state.provinces[q].owner).toBe('DE');
    // erobert aus der Nähe: die Armee rückt in die Stadt ein
    expect(a.move ?? null).toBeNull();
    expect(a.pos ?? null).toBeNull();
    expect(a.node).toBe(q);
    const n0 = unitCount(a);
    // sofort weiter zur nächsten Stadt
    expect(sim.apply('DE', { type: 'move', army: a.id, to: r }).ok).toBe(true);
    const garrison = sim.state.armies.filter((x) => x.owner === 'DE' && x !== a && x.node === q && !x.pos && !x.move);
    expect(garrison.map((x) => unitCount(x))).toEqual([1]);
    expect(unitCount(a)).toBe(n0 - 1);
  });
});

describe('Zwei Armeen aus verschiedenen Richtungen', () => {
  it('werden in der Schlacht um dieselbe Stadt zusammengefasst, auch wenn sie mehr als 1 km auseinander stehen', () => {
    const { sim, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    // französische Stadt mit zwei Wegen, deren 1-km-Punkte mehr als 1 km auseinander liegen
    const pt = (q: number, n: number) => {
      const c = map.provinces[q].center;
      for (let f = 0; f <= 1; f += 0.0005) {
        const x = armyPosition(map, { id: -1, owner: 'DE', node: q, pos: { a: q, b: n, f }, units: { infantry: 1 } }, 0);
        if (Math.hypot(x[0] - c[0], x[1] - c[1]) >= 1) return x;
      }
      return c;
    };
    const fr = map.provinces.find((p) => {
      if (p.nation !== 'FR' || p.capital || (p.links ?? []).length < 2) return false;
      const [a, b] = [pt(p.id, p.links![0]), pt(p.id, p.links![1])];
      return Math.hypot(a[0] - b[0], a[1] - b[1]) > 1.2;
    })!;
    const q = fr.id, [r1, r2] = fr.links!;
    for (const r of [r1, r2]) sim.state.provinces[r].owner = 'DE';
    sim.state.armies = sim.state.armies.filter((a) => ![q, r1, r2].includes(a.node));
    sim.state.provinces[q].buildings.fortress = 5;
    add({ owner: 'FR', node: q, units: { infantry: 60 } });
    const a1 = add({ owner: 'DE', node: r1, units: { infantry: 20 } });
    const a2 = add({ owner: 'DE', node: r2, units: { infantry: 15 } });
    expect(sim.apply('DE', { type: 'move', army: a1.id, to: q }).ok).toBe(true);
    expect(sim.apply('DE', { type: 'move', army: a2.id, to: q }).ok).toBe(true);
    // bis beide angekommen sind und eine die andere aufnimmt: in dem Moment wächst die verbleibende sprunghaft
    let jump = 0;
    for (let k = 0; k < 4 * 24 * 60 + 10 && [a1, a2].filter((x) => sim.state.armies.includes(x)).length === 2; k++) {
      const before = new Map([a1, a2].map((x) => [x, unitCount(x)]));
      sim.advance(MINUTE);
      const gone = [a1, a2].find((x) => !sim.state.armies.includes(x));
      const kept = [a1, a2].find((x) => sim.state.armies.includes(x));
      if (gone && kept) jump = unitCount(kept) - before.get(kept)!;
    }
    const both = [a1, a2].filter((x) => sim.state.armies.includes(x));
    expect(both.length).toBe(1);
    expect(jump).toBeGreaterThan(0);
  });
});

describe('Kampfmoral Mechanik 2', () => {
  it('ist die Vorgabe; Mechanik 1 nur noch ausdrücklich', () => {
    expect(DEFAULT_COMBAT_MORALE).toBe(2);
    const opt = { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 7, now: 0 };
    expect(createGame(map, opt).combatMorale).toBeUndefined();
    expect(createGame(map, { ...opt, combatMorale: 1 }).combatMorale).toBe(1);
    const x: Army = { id: 1, owner: 'DE', node: 0, units: { infantry: 10 }, morale: 0.5 };
    applyCombatMorale(new Map([[x, { foes: 1, shelled: false, kills: 0 }]]));
    expect(x.morale! - 0.5).toBeCloseTo(-COMBAT_MORALE_V2.base, 9);
  });

  it('Verlust −2,5 %, Beschuss oder zweite Armee −1,5 % mehr, höchstens −4 %; Zuwachs 1/2/3, dann je 2 Abschüsse, höchstens +5 %', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 20, 4.9].map(killPoints2)).toEqual([0, 1, 2, 3, 3, 4, 4, 5, 5, 5, 3]);
    const cases: [Partial<{ foes: number; shelled: boolean; kills: number }>, number][] = [
      [{ foes: 1 }, -0.025],
      [{ foes: 2 }, -0.04],
      [{ foes: 1, shelled: true }, -0.04],
      [{ foes: 3, shelled: true }, -0.04],
      [{ shelled: true }, -0.025], // nur beschossen bzw. Fernkampf gegen Fernkampf
      [{ foes: 1, kills: 7 }, 0.025],
      [{ kills: 7 }, 0.05], // Schütze ohne Gegenwehr
      [{ foes: 1, kills: 4 }, 0.005],
    ];
    for (const [e, d] of cases) {
      const x: Army = { id: 1, owner: 'DE', node: 0, units: { infantry: 10 }, morale: 0.5 };
      applyCombatMorale(new Map([[x, { foes: 0, shelled: false, kills: 0, ...e }]]), 2);
      expect(x.morale! - 0.5, JSON.stringify(e)).toBeCloseTo(d, 9);
    }
  });

  it('Maschinen zählen für die Moral als ein Abschuss wie Infanterie', () => {
    const { sim, p, q, add } = setup();
    sim.state.combatMorale = 2;
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.state.provinces[q].buildings.fortress = 0;
    // ein Panzer gegen eine starke Armee: fällt er, zählt das einfach
    const target = add({ owner: 'FR', node: q, units: { tank: 1 }, wounds: { tank: 49.9 } });
    const a = add({ owner: 'DE', node: q, units: { infantry: 20 }, keepApart: true });
    void p;
    const tally = new Map();
    combatRound(sim.ctx, tally);
    expect(sim.state.armies.includes(target)).toBe(false);
    expect(tally.get(a)?.kills).toBeCloseTo(1, 6);
    expect(a.kills).toBeCloseTo(1, 6);
  });
});

describe('Übermacht im Nahkampf', () => {
  it('doppelt so viele Einheiten (Verbündete addiert): +0,5 Punkte für die Überlegenen, −0,3 für die Unterlegenen, außerhalb der Grenzen', () => {
    const { sim, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.apply('AU', { type: 'declareWar', nation: 'FR' });
    sim.state.provinces[q].buildings.fortress = 0;
    const fr = add({ owner: 'FR', node: q, units: { infantry: 10 }, keepApart: true });
    const de = add({ owner: 'DE', node: q, units: { infantry: 10 }, keepApart: true });
    const au = add({ owner: 'AU', node: q, units: { infantry: 5, tank: 5 }, keepApart: true });
    const tally = new Map();
    combatRound(sim.ctx, tally);
    // 20 Einheiten (DE + AU, nach Anzahl, Panzer zählen wie Infanterie) gegen 10
    expect(tally.get(de)?.boost).toBeCloseTo(SUPERIORITY.boost, 9);
    expect(tally.get(au)?.boost).toBeCloseTo(SUPERIORITY.boost, 9);
    expect(tally.get(fr)?.boost).toBeCloseTo(-SUPERIORITY.malus, 9);
    // die Übermacht kommt zu den gedeckelten Werten hinzu: höchstens −4 %, dazu −0,3
    const x: Army = { id: 1, owner: 'FR', node: 0, units: { infantry: 10 }, morale: 0.5 };
    applyCombatMorale(new Map([[x, { foes: 3, shelled: true, kills: 0, boost: -SUPERIORITY.malus }]]), 1);
    expect(x.morale! - 0.5).toBeCloseTo(-0.043, 9);
  });

  it('knapp unter doppelt so vielen: keine Wirkung; abgeschaltet: keine Wirkung', () => {
    const { sim, q, add } = setup();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const fr = add({ owner: 'FR', node: q, units: { infantry: 10 }, keepApart: true });
    const de = add({ owner: 'DE', node: q, units: { infantry: 19 }, keepApart: true });
    let tally = new Map();
    combatRound(sim.ctx, tally);
    expect(tally.get(de)?.boost ?? 0).toBe(0);
    expect(tally.get(fr)?.boost ?? 0).toBe(0);
    de.units.infantry = 40;
    sim.state.superiority = false;
    tally = new Map();
    combatRound(sim.ctx, tally);
    expect(tally.get(de)?.boost ?? 0).toBe(0);
  });
});
