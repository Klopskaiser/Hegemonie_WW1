import type { MapData } from '../game/mapdata.ts';

export interface MapInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
}

export const MAPS: MapInfo[] = [
  { id: 'europe', name: 'Europa 1914', description: '14 Spielernationen mit je 10 Provinzen und fünfzehn neutrale Kleinstaaten, 189 Provinzen.', available: true },
  { id: 'europa_real', name: 'Europa 1914 – Seeknoten', description: 'Wie Europa 1914, aber ohne Seegebiete: Schiffe fahren über ein Netz aus Knotenpunkten, jeder Hafen liegt am nächsten Knoten.', available: true },
  { id: 'world', name: 'Weltkarte', description: 'Alle Kontinente, rund dreißig Nationen. Folgt mit Meilenstein M5.', available: false },
  { id: 'asia', name: 'Asien', description: 'Von Persien bis Japan. Folgt mit Meilenstein M5.', available: false },
];

/**
 * Kartenliste fürs Menü: feste Karten plus die aus dem Karten-Zeichner exportierten (public/maps/custom.json).
 * Ein Eintrag mit der ID einer festen Karte ersetzt deren Name und Beschreibung.
 */
export async function loadMapList(): Promise<MapInfo[]> {
  try {
    const r = await fetch('/maps/custom.json', { cache: 'no-store' });
    if (!r.ok) return MAPS;
    const custom = (await r.json()) as { id: string; name: string; description: string }[];
    const list = MAPS.map((m) => {
      const c = custom.find((x) => x.id === m.id);
      return c ? { ...m, name: c.name, description: c.description || m.description, available: true } : m;
    });
    const extra = custom.filter((c) => !MAPS.some((m) => m.id === c.id)).map((c) => ({ ...c, description: c.description || 'Eigene Karte aus dem Karten-Zeichner.', available: true }));
    const firstLocked = list.findIndex((m) => !m.available);
    if (firstLocked < 0) return [...list, ...extra];
    return [...list.slice(0, firstLocked), ...extra, ...list.slice(firstLocked)];
  } catch {
    return MAPS;
  }
}

const cache = new Map<string, Promise<MapData>>();

/** Karte neu laden lassen (nach dem Speichern im Karteneditor) */
export function forgetMap(id: string): void {
  cache.delete(id);
}

export function loadMap(id: string): Promise<MapData> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(`/maps/${id}.json`, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`Karte ${id} nicht gefunden`);
      return r.json() as Promise<MapData>;
    });
    cache.set(id, p);
  }
  return p;
}
