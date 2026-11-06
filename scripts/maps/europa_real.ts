// Kartenkonfiguration "Europa 1914 – Seeknoten": Landzuschnitt wie "europe", auf See aber keine Seegebiete,
// sondern Knotenpunkte. Benachbarte Knoten sind verbunden, jede Küstenprovinz hat genau einen Hafen am
// nächstgelegenen Knoten.

import type { MapConfig } from '../mapconfig.ts';
import europe from './europe.ts';

const config: MapConfig = {
  ...europe,
  id: 'europa_real',
  name: 'Europa 1914 – Seeknoten',
  seed: 'europe',
  seaNodes: { count: 200 },
  // feste Häfen der Europakarte beziehen sich auf Seegebietsnamen – hier gibt es nur Knoten
  seaLinks: undefined,
};

export default config;
