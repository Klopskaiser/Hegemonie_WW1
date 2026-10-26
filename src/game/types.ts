import type { Building, Category, Res, UnitType } from './balance.ts';
import type { Resource } from './mapdata.ts';

export type Stock = Record<Res, number>;

export interface Construction {
  building: Building;
  level: number;
  start: number;
  end: number;
}

export interface Order {
  unit: UnitType;
  /** gesetzt, sobald bezahlt und gestartet */
  start?: number;
  end?: number;
}

export interface ProvinceState {
  owner: string;
  morale: number;
  buildings: Record<Building, number>;
  construction: Construction | null;
  /** Bauschleife: geplante Gebäude, starten nacheinander (bezahlt wird beim Start) */
  buildQueue: Building[];
  queue: Order[];
  /** Fertigungsschleife: fertige Aufträge hinten wieder anstellen */
  repeat: boolean;
  /** Fortschritt des Wehramts (ab 1 entsteht eine Infanterie) */
  recruit: number;
  /** Aufständische halten die Provinz: keine Produktion */
  revolt?: boolean;
}

/** Marsch entlang eines Weges im Bewegungsnetz (Provinzen und Seegebiete). */
export interface Movement {
  /** Knoten des Weges; path[seg] -> path[seg + 1] ist der laufende Abschnitt */
  path: number[];
  seg: number;
  segStart: number;
  segEnd: number;
  /** Landung: am Ziel steigen die Landtruppen aus und folgen diesem Weg (beginnt am Seegebiet) */
  then?: number[];
  /** Start auf einem Weg: Anteil des ersten Abschnitts, der schon zurückgelegt ist */
  startFrac?: number;
  /** Ziel auf einem Weg: Anteil des letzten Abschnitts, bis zu dem marschiert wird */
  endFrac?: number;
}

/** Punkt auf dem Weg zwischen zwei benachbarten Knoten: Anteil f (0..1) von a nach b */
export interface RoadPos {
  a: number;
  b: number;
  f: number;
}

/** Besitzer der Aufständischen (keine Nation, mit allen verfeindet) */
export const REBELS = 'REB';

export interface Army {
  id: number;
  owner: string;
  /** Standort im Bewegungsnetz: Provinz (0..P-1) oder Seegebiet (P + Index) */
  node: number;
  units: Partial<Record<UnitType, number>>;
  /** steht auf einem Weg statt am Knoten; node ist dann der nähere Endpunkt */
  pos?: RoadPos | null;
  /** Nummer der Armee, je Nation eindeutig (für den Namen) */
  num?: number;
  /** Moral der Infanterie (0..1); Maschinen kennen keine Moral */
  morale?: number;
  /** Marsch mit angekündigter Kriegserklärung: betritt die Armee Gebiet dieser Nationen, herrscht Krieg */
  warOn?: string[] | null;
  /** abgetrennt von Armee `from` (Zeitpunkt `at`); ohne Befehl am selben Ort wird sie wieder eingegliedert */
  split?: { from: number; at: number } | null;
  /** Schaden an der jeweils vordersten Einheit eines Typs (< Lebenspunkte) */
  wounds?: Partial<Record<UnitType, number>>;
  move?: Movement | null;
  /** Fernkampfziel (Armee-ID) */
  target?: number | null;
  /** Ziel wurde selbständig erfasst (wird aufgegeben, sobald es außer Reichweite ist) */
  autoTarget?: boolean;
}

/** Beziehungsstufen, von schlecht nach gut */
export type Relation = 'war' | 'embargo' | 'peace' | 'rightOfWay' | 'sharedMap';

/** Angebot einer besseren Beziehung (Frieden, Durchmarschrecht, geteilte Karte) */
export interface Proposal {
  from: string;
  to: string;
  kind: Relation;
  time: number;
}

export interface MarketOffer {
  id: number;
  nation: string;
  /** sell: Rohstoff wird angeboten (zurückgelegt); buy: Geld wird zurückgelegt */
  side: 'sell' | 'buy';
  res: Resource;
  amount: number;
  /** Geld je Einheit */
  price: number;
  time: number;
}

/** Abgeschlossener Handel an der Börse */
export interface MarketTrade {
  time: number;
  seller: string;
  buyer: string;
  res: Resource;
  amount: number;
  price: number;
}

export interface MarketState {
  offers: MarketOffer[];
  nextId: number;
  /** letzter Handelspreis je Rohstoff */
  lastPrice: Partial<Record<Resource, number>>;
  /** Handelsprotokoll (neueste zuletzt, begrenzt) */
  trades: MarketTrade[];
}

/** Meldungsart der Zeitung (bestimmt das Bild: public/images/news/<kind>-<1..3>.png) */
export type NewsKind =
  | 'war' | 'peace' | 'capital' | 'eliminated' | 'embargo' | 'agreement' | 'downgrade' | 'victory'
  | 'conquest' | 'battle' | 'ranking' | 'quiet' | 'revolution' | 'other';

export interface NewsItem {
  title: string;
  text: string;
  kind?: NewsKind;
  /** Bildvariante 1–3, beim Erscheinen zufällig gewählt */
  variant?: number;
}

/** Tagesausgabe der Zeitung */
export interface Newspaper {
  day: number;
  items: NewsItem[];
  /** Besitzer aller Provinzen zum Erscheinen (Tageskarte) */
  owners: string[];
  ranking: { nation: string; points: number }[];
}

export type ControllerKind = 'human' | 'ai' | 'external';

export interface NationState {
  id: string;
  stock: Stock;
  controller: ControllerKind;
  /** Verbrauchsregler: Anteil (Prozent) jedes Rohstoffs am Provinzunterhalt seiner Kategorie, je Kategorie Summe 100 */
  consumption: Record<Resource, number>;
  alive: boolean;
  points: number;
  /** Engpässe seit dem letzten Tageswechsel */
  shortage: Record<Category, boolean>;
}

export interface GameEvent {
  time: number;
  /** undefined = für alle sichtbar */
  nation?: string;
  province?: number;
  text: string;
}

/** Strukturierte Zusatzangaben einer öffentlichen Meldung (für die Zeitung) */
export interface NewsInfo {
  kind?: 'conquest' | 'battle';
  /** Sieger bzw. Eroberer */
  by?: string;
  /** Verlierer bzw. bisheriger Besitzer */
  from?: string;
  /** Ort (Provinz, Stadt oder Seegebiet) */
  place?: string;
  /** Name der vernichteten Armee */
  army?: string;
}

/** Öffentliche Meldung für die nächste Zeitungsausgabe */
export interface NewsEvent extends NewsInfo {
  time: number;
  text: string;
}

export interface GameState {
  version: 1;
  id: string;
  name: string;
  mapId: string;
  playerNation: string;
  speed: number;
  paused: boolean;
  createdAt: number;
  /** Echtzeit (ms) des letzten Speicherns – Grundlage der Nachsimulation */
  lastRealTime: number;
  /** Spielzeit in ms seit Spielbeginn, immer ein Vielfaches einer Minute */
  time: number;
  rng: number;
  nations: Record<string, NationState>;
  provinces: ProvinceState[];
  armies: Army[];
  nextArmyId: number;
  events: GameEvent[];
  /** Beziehungen, symmetrisch; fehlender Eintrag = Frieden */
  relations: Record<string, Record<string, Relation>>;
  /** Beginn eines Krieges (Spielzeit), Schlüssel "A|B" alphabetisch */
  warSince: Record<string, number>;
  proposals: Proposal[];
  /** Waffenstillstand nach Friedensschluss bis (Spielzeit), Schlüssel "A|B" */
  truceUntil: Record<string, number>;
  market: MarketState;
  /** die letzten Zeitungsausgaben, älteste zuerst */
  newspapers: Newspaper[];
  /** Spielende: Sieger (Nation) bzw. null, solange das Spiel läuft */
  winner: string | null;
  /** öffentliche Meldungen seit der letzten Zeitungsausgabe */
  newsFeed: NewsEvent[];
  /** Stärke der eingebauten KI */
  difficulty: Difficulty;
  /** Persönlichkeit je KI-Nation */
  aiProfiles: Record<string, AIProfile>;
  /** WebSocket-Adresse für externe Entscheidungsmodelle (leer = aus) */
  bridgeUrl?: string;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface AIProfile {
  /** Kriegslust (0,7–1,3) */
  aggression: number;
  /** Vorsicht: größere Besatzungen und Überlegenheit vor Angriffen (0,8–1,2) */
  caution: number;
}

export interface GameMeta {
  id: string;
  name: string;
  mapId: string;
  mapName: string;
  playerNation: string;
  nationName: string;
  speed: number;
  paused: boolean;
  time: number;
  lastRealTime: number;
  createdAt: number;
}
