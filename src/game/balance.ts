// Zentrale Spielwerte. Angelehnt an Supremacy 1914 (Stand ca. 2015); exakte
// Originalwerte sind nicht vollständig belegt, daher eigene, abgestimmte Zahlen.

import type { Resource } from './mapdata.ts';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const TICKS_PER_DAY = DAY / MINUTE;

export type Res = Resource | 'money';
export const ALL_RES: Res[] = ['money', 'grain', 'fish', 'iron', 'lumber', 'coal', 'oil', 'gas'];
export type Cost = Partial<Record<Res, number>>;

export const RES_NAMES: Record<Res, string> = {
  money: 'Geld', grain: 'Getreide', fish: 'Fisch', iron: 'Eisen', lumber: 'Holz',
  coal: 'Kohle', oil: 'Öl', gas: 'Gas',
};

export type Category = 'food' | 'materials' | 'energy';
export const CATEGORY_OF: Record<Resource, Category> = {
  grain: 'food', fish: 'food', iron: 'materials', lumber: 'materials', coal: 'energy', oil: 'energy', gas: 'energy',
};
export const CATEGORY_NAMES: Record<Category, string> = { food: 'Nahrung', materials: 'Baustoffe', energy: 'Energie' };
export const CATEGORIES: Category[] = ['food', 'materials', 'energy'];
export const CATEGORY_RES: Record<Category, Resource[]> = {
  food: ['grain', 'fish'], materials: ['iron', 'lumber'], energy: ['coal', 'oil', 'gas'],
};

// ---------------------------------------------------------------- Provinzen

export const PROVINCE = {
  /** Rohstoffproduktion pro Tag bei 100 % Moral */
  resourceBase: 3150,
  /** Geld pro Tag bei 100 % Moral; Doppelprovinz das Doppelte */
  money: 1600,
  /** Unterhalt je Provinz und Tag in jeder Kategorie (Nahrung, Baustoffe, Energie), verteilt nach Verbrauchsregler */
  upkeep: 800,
};

// ---------------------------------------------------------------- Gebäude

export type Building = 'railroad' | 'harbor' | 'tradepost' | 'fortress' | 'workshop' | 'factory' | 'manufactory' | 'barracks' | 'recruitment' | 'office';
export const BUILDING_ORDER: Building[] = ['railroad', 'harbor', 'tradepost', 'workshop', 'factory', 'manufactory', 'barracks', 'recruitment', 'office', 'fortress'];

export interface BuildingDef {
  name: string;
  maxLevel: number;
  /** nur in Küstenprovinzen */
  coastal?: boolean;
  /** nur in Provinzen ohne Küste (dort ist kein Hafen möglich) */
  inland?: boolean;
  cost(level: number): Cost;
  hours(level: number): number;
  /** Produktionsbonus der erreichten Stufe (0.33 = +33 %) */
  prodBonus(level: number): number;
  /** Moralbonus der erreichten Stufe */
  morale(level: number): number;
  upkeep?: Cost;
  /** kann abgeschaltet werden (spart den Unterhalt, wirkt dann aber auch nicht) */
  switchable?: boolean;
  /** erst ab diesem Spieltag baubar (Tag 1 = Spielbeginn) */
  fromDay?: number;
  /** Leben je Stufe: so viele Treffer im Kampf, bis die oberste Stufe zerstört ist (Standard 2) */
  lives?: number;
  /** andere Gebäude als Bauvoraussetzung */
  requires?: Partial<Record<Building, number>>;
  /** schließt sich mit diesen Gebäuden in derselben Provinz aus */
  excludes?: Building[];
  describe(level: number): string;
}

const FACTORY_BONUS = [0, 0.08, 0.16, 0.25, 0.33];
export const FORTRESS_REDUCTION = [0, 0.33, 0.5, 0.6, 0.67, 0.75];

export const BUILDINGS: Record<Building, BuildingDef> = {
  railroad: {
    name: 'Eisenbahn', maxLevel: 1,
    cost: () => ({ money: 10000, lumber: 5000, iron: 3000, coal: 1000 }),
    hours: () => 72,
    prodBonus: (l) => (l >= 1 ? 0.33 : 0),
    morale: (l) => (l >= 1 ? 0.07 : 0),
    upkeep: { coal: 500 },
    switchable: true,
    fromDay: 3,
    lives: 3,
    describe: () => 'Produktion +33 %, Truppen ×2,5 schneller, Moral +7 %. Unterhalt 500 Kohle/Tag.',
  },
  harbor: {
    name: 'Hafen', maxLevel: 1, coastal: true, fromDay: 3, lives: 3,
    cost: () => ({ money: 10000, lumber: 10000 }),
    hours: () => 72,
    prodBonus: (l) => (l >= 1 ? 0.25 : 0),
    morale: (l) => (l >= 1 ? 0.07 : 0),
    describe: () => 'Produktion +25 %, Moral +7 %, ermöglicht Schiffe und Einschiffen.',
  },
  tradepost: {
    name: 'Handelsposten', maxLevel: 1, inland: true, lives: 1,
    cost: () => ({ money: 12000, iron: 500, lumber: 2500 }),
    hours: () => 48,
    prodBonus: (l) => (l >= 1 ? 0.07 : 0),
    morale: (l) => (l >= 1 ? 0.03 : 0),
    upkeep: { fish: 20 },
    describe: () => 'Rohstoffproduktion +7 % (nicht Geld), Moral +3 %. Nur in Provinzen ohne Küste. Unterhalt 20 Fisch/Tag.',
  },
  workshop: {
    name: 'Werkstatt', maxLevel: 1, lives: 1,
    cost: () => ({ money: 5000, iron: 1500, lumber: 500 }),
    hours: () => 24,
    prodBonus: () => 0,
    morale: (l) => (l >= 1 ? 0.01 : 0),
    describe: () => `Mechanische Einheiten (alles außer Infanterie) werden ${Math.round(WORKSHOP_SPEEDUP * 100)} % schneller gebaut, Moral +1 %. Voraussetzung für die Fabrik.`,
  },
  factory: {
    name: 'Fabrik', maxLevel: 4, fromDay: 3,
    requires: { workshop: 1 },
    cost: () => ({ money: 10000, iron: 2500, lumber: 2500, oil: 2500 }),
    hours: () => 48,
    prodBonus: (l) => FACTORY_BONUS[l],
    morale: (l) => 0.025 * l,
    excludes: ['manufactory'],
    describe: (l) => `Produktion +${Math.round(FACTORY_BONUS[l] * 100)} %. ${['', 'Artillerie und Panzerwagen', 'Panzer', 'Eisenbahngeschütz und Schlachtschiff', 'kürzeste Bauzeiten'][l]}; jede Stufe verkürzt die Bauzeit.`,
  },
  manufactory: {
    name: 'Manufaktur', maxLevel: 4,
    cost: () => ({ money: 10000, iron: 2000, lumber: 2000, gas: 3000 }),
    hours: () => 50,
    prodBonus: (l) => 0.11 * l,
    morale: (l) => 0.025 * l,
    excludes: ['factory'],
    describe: (l) => `Rohstoffproduktion +${11 * l} % (nicht Geld), Moral +${(2.5 * l).toLocaleString('de-DE')} %. Keine Fabrik: stellt keine Einheiten her; nicht zusammen mit einer Fabrik.`,
  },
  barracks: {
    name: 'Kaserne', maxLevel: 2,
    cost: () => ({ money: 4000, grain: 1500, lumber: 1500 }),
    hours: () => 24,
    prodBonus: () => 0,
    morale: () => 0,
    requires: { recruitment: 1 },
    upkeep: { grain: 1000, money: 1000 },
    switchable: true,
    describe: (l) => `Infanterie bei 100 % Moral alle ${RECRUIT_HOURS[l]} h (mit Wehramt; ohne halb so schnell, Doppelprovinz doppelt so schnell). Unterhalt 1000 Getreide und 1000 Geld je Stufe und Tag.`,
  },
  recruitment: {
    name: 'Wehramt', maxLevel: 1, switchable: true, lives: 1,
    cost: () => ({ money: 2000, lumber: 125, iron: 125 }),
    hours: () => 1 / 6,
    prodBonus: () => 0,
    morale: () => 0,
    upkeep: { money: 500 },
    describe: () => `Stellt kostenlos Infanterie auf, bei 100 % Moral alle ${RECRUIT_HOURS[0]} h (Doppelprovinz doppelt so schnell). Ohne Wehramt und Kaserne keine Infanterie. Unterhalt 500 Geld/Tag.`,
  },
  office: {
    name: 'Bauamt', maxLevel: 1, switchable: true, lives: 1,
    cost: () => ({ money: 30000, lumber: 500 }),
    hours: () => 48,
    prodBonus: () => 0,
    morale: () => 0.02,
    upkeep: { money: 2000 },
    describe: () => `Bauzeiten von Gebäuden in dieser Provinz −${Math.round(OFFICE_SPEEDUP * 100)} %, Moral +2 %. Unterhalt 2000 Geld/Tag.`,
  },
  fortress: {
    name: 'Festung', maxLevel: 5, lives: 1,
    cost: () => ({ money: 4000, iron: 2000 }),
    hours: (l) => 8 * l,
    prodBonus: () => 0,
    morale: (l) => 0.05 * l,
    describe: (l) => `Schadensminderung ${Math.round(FORTRESS_REDUCTION[l] * 100)} %, Moral +${5 * l} %${l >= 2 ? ', Truppen verborgen' : ''}.`,
  },
};

/** Passt das Gebäude zur Lage der Provinz (Küste bzw. Binnenland)? */
export function siteAllows(b: Building, coastal: boolean): boolean {
  const def = BUILDINGS[b];
  return (!def.coastal || coastal) && (!def.inland || !coastal);
}

/** Leben je Stufe eines Gebäudes */
export function buildingLives(b: Building): number {
  return BUILDINGS[b].lives ?? 2;
}

/** Werkstatt: mechanische Einheiten werden um diesen Anteil schneller gebaut (Bautempo × 1,1) */
export const WORKSHOP_SPEEDUP = 0.1;
/** Bauamt: verkürzt Gebäudebauzeiten in seiner Provinz um diesen Anteil */
export const OFFICE_SPEEDUP = 0.25;
/** Bauschleife: höchstens so viele geplante Gebäude je Provinz (ohne den laufenden Bau) */
export const BUILD_QUEUE_LIMIT = 6;

/**
 * Stunden je Infanterie mit Wehramt bei 100 % Moral, je Kasernenstufe (0, 1, 2); die Moral wirkt anteilig,
 * Doppelprovinzen stellen doppelt so schnell auf
 */
export const RECRUIT_HOURS = [32, 21, 16];
/** Kaserne ohne Wehramt: halbes Tempo */
export const RECRUIT_WITHOUT_OFFICE = 0.5;
/** Kampf in einer Provinz: Wahrscheinlichkeit je Stunde und Gebäude, eine Stufe zu verlieren */
export const BUILDING_DAMAGE_CHANCE = 0.05;
/** Abbruch eines Baus, einer Fertigung oder einer Hauptstadtverlegung: Anteil der Kosten, der zurückkommt */
export const BUILD_REFUND = 1;

/** Hauptstadt verlegen: Kosten und Dauer (je Nation höchstens eine Verlegung gleichzeitig) */
export const CAPITAL_MOVE = {
  cost: { money: 20000, lumber: 5000, iron: 5000, grain: 5000, coal: 5000 } as Cost,
  hours: 48,
};

// ---------------------------------------------------------------- Einheiten

export type UnitType = 'infantry' | 'artillery' | 'armoredCar' | 'tank' | 'railgun' | 'battleship';
export const UNIT_ORDER: UnitType[] = ['infantry', 'artillery', 'armoredCar', 'tank', 'railgun', 'battleship'];

export interface UnitDef {
  name: string;
  short: string;
  cost: Cost;
  /** Bauzeit in Stunden auf der Mindest-Fabrikstufe; jede weitere Stufe −25 % davon */
  hours: number;
  requires: Partial<Record<Building, number>>;
  /** wird nicht gefertigt, sondern vom Wehramt/der Kaserne aufgestellt */
  auto?: boolean;
  /** km/h im eigenen Gebiet */
  speed: number;
  attack: number;
  defense: number;
  hp: number;
  /** Reichweite in km, 0 = Nahkampf */
  range: number;
  upkeep: Cost;
  naval?: boolean;
  railOnly?: boolean;
  /** Sichtweite in km, falls größer als die übliche (MILITARY.viewRange) */
  sight?: number;
}

export const UNITS: Record<UnitType, UnitDef> = {
  infantry: {
    name: 'Infanterie', short: 'Inf', cost: {}, hours: 0,
    requires: {}, auto: true, speed: 36, attack: 1, defense: 1.5, hp: 20, range: 0, upkeep: { grain: 18 },
  },
  artillery: {
    name: 'Artillerie', short: 'Art', cost: { money: 10000, iron: 3000, oil: 2000 }, hours: 96,
    requires: { factory: 1 }, speed: 25, attack: 2.5, defense: 0.8, hp: 15, range: 65, upkeep: { oil: 15 },
  },
  armoredCar: {
    name: 'Panzerwagen', short: 'PzW', cost: { money: 7000, iron: 2000, oil: 1500 }, hours: 16,
    requires: { factory: 1 }, speed: 72, attack: 2, defense: 1.5, hp: 25, range: 0, upkeep: { oil: 15 },
  },
  tank: {
    name: 'Panzer', short: 'Pz', cost: { money: 20000, iron: 5000, oil: 2500 }, hours: 36,
    requires: { factory: 2 }, speed: 36, attack: 4, defense: 3, hp: 50, range: 0, upkeep: { oil: 30 },
  },
  railgun: {
    name: 'Eisenbahngeschütz', short: 'EBG', cost: { money: 50000, iron: 10000, lumber: 5000, coal: 5000, oil: 10000 }, hours: 62,
    requires: { factory: 3, railroad: 1 }, speed: 12.5, attack: 6, defense: 1, hp: 30, range: 200,
    upkeep: { oil: 10, coal: 40 }, railOnly: true, sight: 200,
  },
  battleship: {
    name: 'Schlachtschiff', short: 'SS', cost: { money: 50000, iron: 15000, coal: 10000, oil: 5000 }, hours: 96,
    requires: { factory: 3, harbor: 1 }, speed: 30, attack: 5, defense: 4, hp: 80, range: 100, upkeep: { oil: 30, coal: 30 }, naval: true, sight: 200,
  },
};


// ---------------------------------------------------------------- Militär

export const MILITARY = {
  /** Geschwindigkeitsfaktor je Gebiet: eigenes, mit Durchmarschrecht/Bündnis, sonst (feindlich oder ohne Wegerecht) */
  territory: { own: 1, foreign: 0.7, enemy: 0.5 },
  /** Eisenbahn im eigenen Gebiet */
  railFactor: 2.5,
  /** eingeschiffte Landtruppen (Transportschiffe) */
  transportSpeed: 21,
  /** Ein- bzw. Ausschiffen; mit befreundetem Hafen am Ort nur halb so lange */
  embarkHours: 2,
  harborEmbarkFactor: 0.5,
  /** Sichtweite eigener Armeen (km); Eisenbahngeschütze und Schlachtschiffe siehe UNITS.sight */
  viewRange: 100,
  /** Fernkampfeinheiten im Nahkampf */
  meleeRangedFactor: 0.5,
  /**
   * Nahkampfreichweite (km): stehende Armeen im Krieg, die so nahe beieinander sind, kämpfen (auch auf See);
   * marschierende bleiben stehen, sobald sie so nahe kommen; Städte werden aus dieser Entfernung erobert.
   * Zugleich Flächenschaden: jeder Treffer (Nah- und Fernkampf) trifft alle Gegner in diesem Umkreis voll.
   */
  meleeKm: 1,
  /** Gewaltmarsch: Tempo-Faktor; im Marsch je Stunde dieser Anteil Moral (Infanterie) bzw. Lebenspunkte (Maschinen, können ausfallen) */
  forcedMarchSpeed: 1.5,
  forcedMarchWear: 0.04,
  /** Nahkampf je Armee: die stärksten Einheiten zuerst; bis Platz `meleeFull` voll, danach linear weniger, ab Platz `meleeMax` + 1 nichts */
  meleeFull: 20,
  meleeMax: 50,
  /** Maschinen (alles außer Infanterie) reparieren sich zum Tageswechsel außerhalb von Kämpfen um diesen Anteil der fehlenden Lebenspunkte */
  repairShare: 1 / 7,
  /** mindestens so viel der vollen Lebenspunkte je Tag, damit Maschinen ganz heil werden */
  repairMin: 0.05,
  /** Landtruppen auf See kämpfen mit halber Stärke (Schlachtschiffe voll) */
  seaFactor: 0.5,
  /** Zufallsstreuung des Schadens (±) */
  randomSpread: 0.25,
  /** Moral einer frisch eroberten Provinz; Rückeroberung am selben Tag: DEFECTION.morale */
  conquestMorale: 0.25,
  /** Hauptstadt erobert: Moralbonus für den Sieger, Abzug für den Verlierer */
  capitalMoraleBonus: 0.1,
  capitalMoralePenalty: 0.15,
  /** Aufständische je Aufstand */
  rebelUnits: [2, 4] as [number, number],
};
export const QUEUE_LIMIT = 10;
/** Jede Fabrikstufe über der Mindeststufe verkürzt die Bauzeit um diesen Anteil des Startwerts */
export const FACTORY_SPEEDUP = 0.25;

// ---------------------------------------------------------------- Moral

export const MORALE = {
  base: 0.85,
  /** Abzug je `distanceStep` km Entfernung zur Hauptstadt ab `distanceFree` km; ohne Hauptstadt der volle Abzug */
  distancePerStep: 0.01,
  distanceStep: 100,
  distanceFree: 300,
  distanceMax: 0.3,
  /** Kämpfe in der Provinz seit dem letzten Tageswechsel: fester Abzug am Moralziel (unabhängig von der Dauer) */
  battle: 0.15,
  /** jede Kampfrunde in der Provinz (höchstens einmal je Stunde) senkt die Moral sofort um diesen Wert */
  battleHit: 0.0075,
  /** je angrenzende eigene Provinz mit Moral unter DEFECTION.threshold */
  unrestNeighbor: 0.02,
  /** je angrenzende eigene Provinz mit mindestens `calmMorale` Moral */
  calmNeighbor: 0.01,
  calmMorale: 0.91,
  /** eigene Truppen mit mehr als `garrisonStrength` Stärke in der Stadt */
  garrison: 0.03,
  garrisonStrength: 20,
  /** Kriegserklärung: Abzug am Moralziel des Erklärenden für so viele Tage (mehrere Erklärungen zählen nicht mehrfach) */
  declareWar: 0.05,
  declareWarDays: 2,
  warEach: 0.05,
  warMax: 0.25,
  shortage: { food: 0.15, materials: 0.05, energy: 0.1 } as Record<Category, number>,
  min: 0.05,
  /** Anteil der Lücke zum Zielwert, der pro Tag geschlossen wird; mindestens minStep (sonst die Restlücke), höchstens maxStep je Tag */
  adapt: 0.35,
  minStep: 0.03,
  maxStep: 0.1,
  revolt: 0.25,
};

// ---------------------------------------------------------------- Truppenmoral (nur Infanterie)

export const TROOP_MORALE = {
  /** Startwert neu aufgestellter Armeen ohne Provinzbezug */
  start: 0.7,
  /** Ziel auf See, auf Wegen oder in fremdem Gebiet, wenn Getreide da ist */
  neutral: 0.5,
  /** Getreidemangel: Abzug am Ziel und zusätzlicher Abzug je Tag, solange die Moral über dem Ziel liegt */
  hungerTarget: 0.2,
  hunger: 0.05,
  /** Annäherung an das Ziel je Tageswechsel: volle Lücke, höchstens so viel */
  rise: { max: 0.1 },
  fall: { max: 0.08 },
  /**
   * Je Kampfrunde (stündlich): Nahkampf −2 %, gegen zwei und mehr Armeen −1 % zusätzlich, beschossen −2 %
   * (egal wie viele Schützen). Zusammen höchstens lossMax, egal wie viele Armeen beteiligt sind.
   */
  melee: 0.02,
  outnumbered: 0.01,
  shelled: 0.02,
  lossMax: 0.04,
  /** Zuwachs je vernichteter feindlicher Einheit, höchstens killMax je Runde (gegen den Verlust gerechnet; Mechanik 1) */
  perKill: 0.01,
  killMax: 0.04,
  /** Kampfkraft (und Lebenspunkte) der Infanterie: 1,2 × Moral – 10 % → 0,12, 100 % → 1,2 (1,0 bei 83,3 %) */
  strength: [[0, 0], [1, 1.2]] as [number, number][],
  min: 0.1,
};

/**
 * Übermacht im Nahkampf: hat eine Seite einer Schlacht mindestens `ratio`-mal so viele Einheiten wie die andere
 * (Verbündete addiert, gezählt nach Einheiten, nicht nach Stärke) und mindestens `minGap` Einheiten mehr, bekommt
 * jede ihrer Armeen je Runde `boost`
 * Moral, jede Armee der unterlegenen Seite verliert `malus` – zusätzlich und außerhalb der Rundengrenzen.
 */
export const SUPERIORITY = { ratio: 2, minGap: 8, boost: 0.005, malus: 0.003 };

/** Rechenweise der Kampfmoral, wenn der Spielstand keine festlegt (1: TROOP_MORALE, 2: COMBAT_MORALE_V2) */
export const DEFAULT_COMBAT_MORALE = 2;

/**
 * Kampfmoral, Mechanik 2 (Vorgabe, im Spielstand wählbar): im Kampf je Runde base (Nahkampf, beschossen
 * oder Fernkampf gegen Fernkampf); Beschuss zusätzlich zum Nahkampf oder eine zweite gegnerische Armee bringen
 * extra, zusammen höchstens lossMax. Zuwachs: die ersten fullKills Punkte je 1 Abschuss, jeder weitere Punkt bis
 * maxPoints kostet killsPerExtra Abschüsse (abgerundet). Jede vernichtete Einheit zählt als ein Abschuss.
 */
export const COMBAT_MORALE_V2 = {
  base: 0.025,
  extra: 0.015,
  lossMax: 0.04,
  fullKills: 3,
  killsPerExtra: 2,
  maxPoints: 5,
};

// ---------------------------------------------------------------- Überlaufen von Provinzen

export const DEFECTION = {
  /** unter dieser Provinzmoral droht das Überlaufen (Rebellionsfaust auf der Karte) */
  threshold: 0.33,
  /** Wahrscheinlichkeit je Tageswechsel: 1 % knapp unter der Schwelle, 33 % bei 0 % Moral (linear) */
  minChance: 0.01,
  maxChance: 0.33,
  /** je angefangene 5 Kampfstärke eigener Truppen in der Stadt 1 Prozentpunkt weniger */
  strengthPerPoint: 5,
  /** Moral der Provinz beim neuen Herrn */
  morale: 0.4,
  /** Anteil der Einheiten in der Stadt, die mit überlaufen (der Rest fällt; mindestens eine wechselt) */
  unitShare: 0.25,
};

// ---------------------------------------------------------------- KI

export const DIFFICULTY = {
  /** interval: Stunden zwischen KI-Entscheidungen; war: Faktor auf Kriegslust; attack: nötige Überlegenheit; heavy: Eisenbahngeschütze/Schlachtschiffe */
  easy: { name: 'Leicht', interval: 6, war: 0.5, attack: 1.6, heavy: false },
  normal: { name: 'Normal', interval: 3, war: 1, attack: 1.3, heavy: true },
  hard: { name: 'Schwer', interval: 2, war: 1.4, attack: 1.15, heavy: true },
} as const;

// ---------------------------------------------------------------- Siegpunkte

export const POINTS = { rural: 1, city: 3, capital: 5, perBuildingLevel: 0.2 };

// ---------------------------------------------------------------- Spielstart

/** Startvorrat für alle Nationen gleich; +START_BONUS beim häufigsten eigenen Rohstoff */
export const START_STOCK: Record<Res, number> = {
  money: 100000, grain: 6000, fish: 6000, iron: 6000, lumber: 6000, coal: 6000, oil: 6000, gas: 6000,
};
export const START_BONUS = 1000;
/** Moral aller Provinzen und Truppen bei Spielbeginn */
export const START_MORALE = 0.7;
export const START_INFANTRY = 10;

export const SPEEDS = [1, 2, 4, 8, 24, 96, 288];

// ---------------------------------------------------------------- Börse

export const MARKET = {
  /** Richtpreis in Geld je Einheit (Startwert der Kurse) */
  basePrice: { grain: 1, fish: 1, lumber: 1, iron: 1.5, coal: 1.5, gas: 1.5, oil: 2 } as Record<Resource, number>,
  /** Angebote gelten unbegrenzt; die KI zieht eigene Angebote nach dieser Zeit zurück und stellt sie neu ein */
  aiRefresh: 3 * 24 * 3600_000,
  /** Preisgrenzen relativ zum Richtpreis */
  minFactor: 0.2,
  /** Höchstpreis je Einheit (Geld), für alle Rohstoffe */
  maxPrice: 1000,
  /** Mindestmenge eines Angebots */
  minAmount: 100,
  maxOffersPerNation: 8,
};

// ---------------------------------------------------------------- Sieg

/** Anteil aller Provinzen der Karte, der zum Sieg reicht (geprüft am Tageswechsel) */
export const VICTORY_SHARE = 0.7;
