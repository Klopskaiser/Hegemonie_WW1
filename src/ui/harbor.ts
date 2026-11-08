import type { MapData } from '../game/mapdata.ts';

/**
 * Anzeigename eines Seepunkts als Hafenort: echter Name (z. B. „Ostsee“), sonst
 * die Himmelsrichtung vom Provinzmittelpunkt aus (Kartenkoordinaten: y wächst nach Süden).
 */
export function seaPointName(map: MapData, province: number, seaNode: number): string {
  const P = map.provinces.length;
  const s = map.seas[seaNode - P];
  const pc = map.provinces[province].center;
  if (s?.name && !/^Seepunkt \d+$/.test(s.name)) return s.name;
  const c = s?.center ?? pc;
  const ang = (Math.atan2(-(c[1] - pc[1]), c[0] - pc[0]) * 180) / Math.PI;
  const dirs = ['Osten', 'Nordosten', 'Norden', 'Nordwesten', 'Westen', 'Südwesten', 'Süden', 'Südosten'];
  return dirs[((Math.round(ang / 45) % 8) + 8) % 8];
}
