// Nachrichtenformat zwischen Spiel und externen Entscheidungsmodellen (WebSocket, JSON).
// Beschreibung für Modellentwickler: docs/EXTERNAL_MODELS.md

import type { Action, ActionResult } from './actions.ts';
import type { Observation } from './controller.ts';
import type { MapData } from './mapdata.ts';
import type { Difficulty } from './types.ts';

export const PROTOCOL_VERSION = 1;

/** Unveränderliche Kartendaten, einmal mit `hello` übertragen */
export interface MapSummary {
  /** Bewegungsknoten: 0..P-1 Provinzen, P..P+S-1 Seegebiete */
  provinceCount: number;
  nations: { id: string; name: string; major: boolean; capital: number }[];
  provinces: {
    id: number; name: string; nation: string; center: [number, number]; capital: boolean; city: boolean;
    coastal: boolean; resource: string; double: boolean; neighbors: number[]; seas: number[];
  }[];
  seas: { id: number; node: number; name: string; center: [number, number]; seas: number[]; coasts: number[] }[];
}

export type ToModel =
  | {
    type: 'hello';
    protocol: number;
    game: { id: string; name: string; mapId: string; time: number; playerNation: string; difficulty: Difficulty };
    /** extern gesteuerte Nationen */
    nations: string[];
    map: MapSummary;
  }
  /** geänderte Zuordnung der extern gesteuerten Nationen */
  | { type: 'controllers'; nations: string[] }
  /** stündlich (Spielzeit) je extern gesteuerter Nation oder auf Anfrage */
  | { type: 'observe'; nation: string; obs: Observation }
  | { type: 'result'; nation: string; ref?: string | number; action: Action; result: ActionResult }
  | { type: 'error'; message: string };

export type FromModel =
  /** Aktionen werden sofort in der angegebenen Reihenfolge ausgeführt */
  | { type: 'actions'; nation: string; actions: Action[]; ref?: string | number }
  /** sofortige Beobachtung anfordern */
  | { type: 'observe'; nation: string };

export function mapSummary(map: MapData): MapSummary {
  const P = map.provinces.length;
  return {
    provinceCount: P,
    nations: map.nations.map((n) => ({ id: n.id, name: n.name, major: n.major, capital: n.capital })),
    provinces: map.provinces.map((p) => ({
      id: p.id, name: p.name, nation: p.nation, center: p.center, capital: p.capital, city: p.city,
      coastal: p.coastal, resource: p.resource, double: p.double, neighbors: p.neighbors, seas: p.seas,
    })),
    seas: map.seas.map((z, i) => ({ id: i, node: P + i, name: z.name, center: z.center, seas: z.seas, coasts: z.coasts })),
  };
}
