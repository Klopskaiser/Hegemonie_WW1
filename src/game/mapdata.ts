// Statische Kartendaten (vom Build-Skript erzeugt, im Spiel nur gelesen).

export type Resource = 'grain' | 'fish' | 'iron' | 'lumber' | 'coal' | 'oil' | 'gas';
export const RESOURCES: Resource[] = ['grain', 'fish', 'iron', 'lumber', 'coal', 'oil', 'gas'];

export interface MapNation {
  id: string;
  name: string;
  color: string;
  /** Großmacht (volle KI) oder Kleinstaat (defensive KI). */
  major: boolean;
  capital: number;
}

export interface MapProvince {
  id: number;
  name: string;
  nation: string;
  /** Multipolygon; jeder Ring als flaches Array [x0,y0,x1,y1,...] in km. */
  polys: number[][][];
  /** Lage der Stadt bzw. des Provinzzentrums (km). */
  center: [number, number];
  lonlat: [number, number];
  /** Mitte der Provinz (für Rohstoffsymbole) */
  mid: [number, number];
  area: number;
  city: boolean;
  capital: boolean;
  coastal: boolean;
  resource: Resource;
  double: boolean;
  neighbors: number[];
  /** angrenzende Seegebiete (Index in MapData.seas) */
  seas: number[];
}

export interface MapSea {
  id: number;
  name: string;
  polys: number[][][];
  center: [number, number];
  /** benachbarte Seegebiete */
  seas: number[];
  /** angrenzende Küstenprovinzen */
  coasts: number[];
}

export interface MapBorder {
  a: number;
  /** -1 = Küste */
  b: number;
  /** Segmente als flaches Array [x1,y1,x2,y2, ...] */
  segs: number[];
}

export interface MapData {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  nations: MapNation[];
  provinces: MapProvince[];
  borders: MapBorder[];
  seas: MapSea[];
  /** Grenzlinien zwischen Seegebieten als Segmente [x1,y1,x2,y2, ...] */
  seaBorders: number[];
}

export function distanceKm(map: MapData, a: number, b: number): number {
  const pa = map.provinces[a].center, pb = map.provinces[b].center;
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
}
