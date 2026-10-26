import type { MapData } from '../game/mapdata.ts';

export interface MapInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export const MAPS: MapInfo[] = [
  { id: 'europe', name: 'Europa 1914', description: '14 Spielernationen mit je 10 Provinzen und zehn neutrale Kleinstaaten, 177 Provinzen.', available: true },
  { id: 'world', name: 'Weltkarte', description: 'Alle Kontinente, rund dreißig Nationen. Folgt mit Meilenstein M5.', available: false },
  { id: 'asia', name: 'Asien', description: 'Von Persien bis Japan. Folgt mit Meilenstein M5.', available: false },
];

const cache = new Map<string, Promise<MapData>>();

/** Karte neu laden lassen (nach dem Speichern im Karteneditor) */
export function forgetMap(id: string): void {
  cache.delete(id);
}

export function loadMap(id: string): Promise<MapData> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(`/maps/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`Karte ${id} nicht gefunden`);
      return r.json() as Promise<MapData>;
    });
    cache.set(id, p);
  }
  return p;
}
