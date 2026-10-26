import type { Resource } from '../src/game/mapdata.ts';

export interface MapConfigNation {
  id: string;
  name: string;
  color: string;
  major: boolean;
  /** NAMEASCII der Hauptstadt in ne_10m_populated_places */
  capital: string;
}

export interface MapConfig {
  id: string;
  name: string;
  /** Projektionszentrum [lon, lat] */
  center: [number, number];
  /** Grober Filter für Natural-Earth-Regionen [lon0, lat0, lon1, lat1] */
  lonLatBox: [number, number, number, number];
  /** Kartenausschnitt in km nach der Projektion [x0, y0, x1, y1] */
  rect: [number, number, number, number];
  /** Provinzen je Spielernation (Großmacht) */
  majorProvinces: number;
  /** Zielfläche einer Provinz bei Kleinstaaten in km² */
  minorCellArea: number;
  minorMaxProvinces: number;
  /** Gewichtung der Fläche: Faktor > 1 = dünner besiedelt, weniger Provinzen */
  cellFactor(lon: number, lat: number): number;
  assign(props: Record<string, unknown>): string | null;
  overrideCodes: string[];
  nations: MapConfigNation[];
  hotspots: { r: Resource; at: [number, number] }[];
  /** Feste Vorgaben nach der automatischen Verteilung (Provinzname -> Rohstoff, Doppelprovinzen) */
  adjust?: {
    resources?: Record<string, Resource>;
    doubles?: { add: string[]; remove: string[] };
  };
  /** Höchstzahl Ölprovinzen je Nation (Standard: Großmacht 1, Kleinstaat 0; nur wo ein Ölort liegt) */
  oilLimit?: Record<string, number>;
  /** ungefähre Zahl der Seegebiete und Namenspunkte [lon, lat] */
  seaCount: number;
  seaNames: { name: string; at: [number, number] }[];
  /** Historische Ortsnamen, Schlüssel = NAMEASCII */
  renames: Record<string, string>;
}
