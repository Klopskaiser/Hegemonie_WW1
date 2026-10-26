// Kartenkonfiguration "Europa 1914": Grenzen von 1914 als Zuordnung moderner
// Natural-Earth-Regionen (Admin-1) zu Nationen.

import type { MapConfig } from '../mapconfig.ts';

const ALSACE_LORRAINE = ['FR-57', 'FR-67', 'FR-68'];
const PRUSSIAN_POLAND = ['PL-WP', 'PL-PM', 'PL-KP', 'PL-ZP', 'PL-LB', 'PL-DS', 'PL-OP', 'PL-SL', 'PL-WN'];
const RUSSIAN_POLAND = ['PL-MZ', 'PL-LD', 'PL-LU', 'PL-PD', 'PL-SK'];
const GALICIA_POLAND = ['PL-MA', 'PL-PK'];
const AUSTRIAN_UKRAINE = ['UA-46', 'UA-26', 'UA-61', 'UA-77', 'UA-21'];
const TRANSYLVANIA_BANAT_BUKOVINA = [
  'RO-TM', 'RO-CS', 'RO-AR', 'RO-BH', 'RO-SM', 'RO-MM', 'RO-SJ', 'RO-CJ', 'RO-BN', 'RO-MS',
  'RO-HR', 'RO-CV', 'RO-BV', 'RO-SB', 'RO-AB', 'RO-HD', 'RO-SV',
];
const VOJVODINA = ['RS-01', 'RS-02', 'RS-03', 'RS-04', 'RS-05', 'RS-06', 'RS-07'];
const AUSTRIAN_ITALY = ['IT-TN', 'IT-BZ', 'IT-TS', 'IT-GO'];
const RUSSIAN_TURKEY = ['TR-36', 'TR-75', 'TR-08'];
const ROMANIAN_BULGARIA = ['BG-08', 'BG-19'];

const BY_COUNTRY: Record<string, string> = {
  DEU: 'DE',
  AUT: 'AU', HUN: 'AU', CZE: 'AU', SVK: 'AU', SVN: 'AU', HRV: 'AU', BIH: 'AU', LIE: 'AU',
  FRA: 'FR', MCO: 'FR',
  MAR: 'MG', DZA: 'MG', ESH: 'MG', MRT: 'MG', MLI: 'MG',
  TUN: 'LY', LBY: 'LY', NER: 'LY', TCD: 'LY',
  EGY: 'EG', SDN: 'EG',
  GBR: 'GB', IRL: 'GB', IMN: 'GB', JEY: 'GB', GGY: 'GB',
  ITA: 'IT', SMR: 'IT', VAT: 'IT', MLT: 'IT',
  RUS: 'RU', BLR: 'RU', UKR: 'RU', LTU: 'RU', LVA: 'RU', EST: 'RU', FIN: 'RU', ALD: 'RU', MDA: 'RU',
  GEO: 'RU', ARM: 'RU', AZE: 'RU', KAZ: 'RU', TKM: 'RU', UZB: 'RU', POL: 'RU',
  TUR: 'OT', SYR: 'OT', LBN: 'OT', ISR: 'OT', PSX: 'OT', JOR: 'OT', IRQ: 'OT', SAU: 'OT', KWT: 'OT',
  IRN: 'OT', CYP: 'OT', CYN: 'OT', ESB: 'OT', WSB: 'OT',
  ESP: 'ES', AND: 'ES', GIB: 'ES',
  SWE: 'SE',
  ROU: 'RO',
  NLD: 'NL',
  BEL: 'BE', LUX: 'BE',
  CHE: 'CH',
  DNK: 'DK', ISL: 'DK', FRO: 'DK',
  NOR: 'NO',
  PRT: 'PT',
  SRB: 'SR', KOS: 'SR', MKD: 'SR',
  MNE: 'MN',
  ALB: 'AL',
  GRC: 'GR',
  BGR: 'BG',
};

const OVERRIDES: Record<string, string> = {};
for (const c of ALSACE_LORRAINE) OVERRIDES[c] = 'DE';
for (const c of PRUSSIAN_POLAND) OVERRIDES[c] = 'DE';
OVERRIDES['RU-KGD'] = 'DE';
OVERRIDES['LT-KL'] = 'DE';
for (const c of RUSSIAN_POLAND) OVERRIDES[c] = 'RU';
for (const c of [...GALICIA_POLAND, ...AUSTRIAN_UKRAINE, ...TRANSYLVANIA_BANAT_BUKOVINA, ...VOJVODINA, ...AUSTRIAN_ITALY]) {
  OVERRIDES[c] = 'AU';
}
for (const c of RUSSIAN_TURKEY) OVERRIDES[c] = 'RU';
for (const c of ROMANIAN_BULGARIA) OVERRIDES[c] = 'RO';

const config: MapConfig = {
  id: 'europe',
  name: 'Europa 1914',
  center: [20, 50],
  lonLatBox: [-45, 18, 80, 82],
  // Ostrand knapp westlich des Kaspischen Meeres
  rect: [-2800, -2450, 2040, 2250],
  majorProvinces: 10,
  /** Zielfläche einer Provinz bei Kleinstaaten (km², gewichtet mit cellFactor) */
  minorCellArea: 18000,
  minorMaxProvinces: 9,
  cellFactor(lon, lat) {
    let f = 1;
    if (lat < 33.5) f *= 5; // Wüstenrand Nordafrikas/Arabiens
    if (lon > 35.5 && lat < 37.5 && !(lon < 36.6 && lat > 31)) f *= 3; // Syrien/Irak/Arabien
    if (lon > 40 && lat > 45) f *= 1.6; // Russland jenseits der Wolga
    if (lat > 62) f *= 2.5; // hoher Norden
    return f;
  },
  assign(p) {
    const iso = p.iso_3166_2 as string;
    if (iso && OVERRIDES[iso]) return OVERRIDES[iso];
    return BY_COUNTRY[p.adm0_a3 as string] ?? null;
  },
  overrideCodes: Object.keys(OVERRIDES),
  nations: [
    { id: 'DE', name: 'Deutsches Reich', color: '#8e9aa6', major: true, capital: 'Berlin' },
    { id: 'AU', name: 'Österreich-Ungarn', color: '#d8c47e', major: true, capital: 'Vienna' },
    { id: 'FR', name: 'Frankreich', color: '#7b97c9', major: true, capital: 'Paris' },
    { id: 'GB', name: 'Großbritannien', color: '#c86a5e', major: true, capital: 'London' },
    { id: 'IT', name: 'Italien', color: '#8cba72', major: true, capital: 'Rome' },
    { id: 'RU', name: 'Russisches Reich', color: '#5f9877', major: true, capital: 'St. Petersburg' },
    { id: 'OT', name: 'Osmanisches Reich', color: '#cf9f5e', major: true, capital: 'Istanbul' },
    { id: 'ES', name: 'Spanien', color: '#e3b9a0', major: true, capital: 'Madrid' },
    { id: 'SE', name: 'Schweden', color: '#69adbb', major: true, capital: 'Stockholm' },
    { id: 'RO', name: 'Rumänien', color: '#b493c4', major: true, capital: 'Bucharest' },
    { id: 'MG', name: 'Marokko', color: '#b8643f', major: true, capital: 'Rabat' },
    { id: 'LY', name: 'Libyen', color: '#9a8c5c', major: true, capital: 'Tripoli' },
    { id: 'EG', name: 'Ägypten', color: '#d39bb0', major: true, capital: 'Cairo' },
    { id: 'NL', name: 'Niederlande', color: '#e6a160', major: false, capital: 'Amsterdam' },
    { id: 'BE', name: 'Belgien', color: '#c6b25f', major: false, capital: 'Brussels' },
    { id: 'CH', name: 'Schweiz', color: '#e3c7c3', major: false, capital: 'Bern' },
    { id: 'DK', name: 'Dänemark', color: '#d88f8a', major: false, capital: 'Kobenhavn' },
    { id: 'NO', name: 'Norwegen', color: '#a3b9d6', major: true, capital: 'Oslo' },
    { id: 'PT', name: 'Portugal', color: '#a7c69a', major: false, capital: 'Lisbon' },
    { id: 'SR', name: 'Serbien', color: '#a8866e', major: false, capital: 'Belgrade' },
    { id: 'MN', name: 'Montenegro', color: '#937d9c', major: false, capital: 'Podgorica' },
    { id: 'AL', name: 'Albanien', color: '#b5a57c', major: false, capital: 'Tirana' },
    { id: 'GR', name: 'Griechenland', color: '#93c1df', major: false, capital: 'Athens' },
    { id: 'BG', name: 'Bulgarien', color: '#a3b38a', major: false, capital: 'Sofia' },
  ],
  adjust: {
    resources: {
      'Luleå': 'lumber', 'Sundsvall': 'lumber', // Schweden: mehr Holz
      'Ajaccio': 'lumber', // Korsika: Wald statt Eisen
      'Palermo': 'oil', 'Ploiești': 'oil', 'Bukarest': 'grain', // Öl Sizilien, Rumänien am echten Ölfeld
      'Cork': 'fish', 'Bari': 'fish', 'Vlora': 'fish', // mehr Fisch
      'Danzig': 'fish', 'Barcelona': 'fish', 'Alexandria': 'fish', // Küsten-Getreide wird Fischfang
      'Mailand': 'iron', 'Agadir': 'iron',
      // Ausgleich (Ziel: Getreide 45, Fisch 22, Eisen 33, Holz 33, Kohle 34, Gas 27, Öl 16 Symbole)
      'Hamburg': 'fish', 'Turm Severin': 'coal', 'Samsun': 'lumber', 'Agram': 'lumber', 'Bergen': 'fish',
      'Montpellier': 'grain', 'Valencia': 'grain', 'Jaffa': 'grain',
      'Glasgow': 'iron', 'Dresden': 'iron', 'Bilbao': 'iron', 'Athen': 'iron',
      'Konstanza': 'gas', 'Niš': 'lumber', 'Kragujevac': 'coal', 'Tromsø': 'iron', 'Mo i Rana': 'gas',
    },
    // Doppel-Öl im Sirte-Becken und im Kaukasus; jede Großmacht hat genau 2 Doppelprovinzen
    doubles: {
      add: ['Sirte', 'Jerewan', 'Hamburg', 'Turm Severin', 'Samsun', 'Agram', 'Bergen', 'Tromsø', 'Kragujevac'],
      remove: ['Bani Walid', 'Samara', 'Niš'],
    },
  },
  oilLimit: { MG: 2, LY: 2, EG: 2, RU: 2, NO: 1, AL: 1 },
  hotspots: [
    // Kohle
    { r: 'coal', at: [7.1, 51.5] }, { r: 'coal', at: [7.0, 49.3] }, { r: 'coal', at: [18.9, 50.3] },
    { r: 'coal', at: [2.9, 50.4] }, { r: 'coal', at: [4.4, 50.4] }, { r: 'coal', at: [-3.4, 51.7] },
    { r: 'coal', at: [-1.5, 53.6] }, { r: 'coal', at: [-1.6, 55.0] }, { r: 'coal', at: [-4.0, 55.9] },
    { r: 'coal', at: [38.0, 48.0] }, { r: 'coal', at: [18.3, 49.8] }, { r: 'coal', at: [-5.8, 43.3] },
    { r: 'coal', at: [31.8, 41.4] }, { r: 'coal', at: [13.0, 50.8] },
    // Eisen
    { r: 'iron', at: [6.0, 49.2] }, { r: 'iron', at: [20.2, 67.8] }, { r: 'iron', at: [-2.9, 43.2] },
    { r: 'iron', at: [33.4, 47.9] }, { r: 'iron', at: [14.9, 47.5] }, { r: 'iron', at: [-3.2, 54.5] },
    { r: 'iron', at: [10.4, 42.8] }, { r: 'iron', at: [-0.5, 48.8] }, { r: 'iron', at: [8.1, 35.9] },
    { r: 'iron', at: [15.0, 60.1] }, { r: 'iron', at: [58.0, 52.5] },
    // Öl – nur an historischen Ölorten (z. T. erst nach 1914 erschlossen)
    { r: 'oil', at: [45.7, 43.3] }, { r: 'oil', at: [40.1, 44.6] }, // Grosny, Maikop
    { r: 'oil', at: [48.5, 53.2] }, { r: 'oil', at: [53.7, 63.6] }, // Wolga (Sysran), Uchta
    { r: 'oil', at: [26.0, 44.9] }, { r: 'oil', at: [23.4, 49.3] }, // Ploiești, Boryslaw
    { r: 'oil', at: [43.1, 36.3] }, { r: 'oil', at: [7.9, 48.95] }, // Mossul, Pechelbronn
    { r: 'oil', at: [19.6, 40.6] }, { r: 'oil', at: [5.7, 58.95] }, // Patos (Albanien), Stavanger (Nordsee)
    { r: 'oil', at: [-5.7, 34.2] }, { r: 'oil', at: [6.1, 31.7] }, // Sidi Kacem, Hassi Messaoud
    { r: 'oil', at: [9.5, 28.0] }, { r: 'oil', at: [9.2, 31.7] }, // In Amenas, El Borma
    { r: 'oil', at: [19.5, 29.5] }, { r: 'oil', at: [21.5, 28.5] }, // Sirte-Becken
    { r: 'oil', at: [33.0, 28.5] }, { r: 'oil', at: [28.8, 30.4] }, // Golf von Suez, Westliche Wüste
    // Kornkammern
    { r: 'grain', at: [33.0, 49.0] }, { r: 'grain', at: [38.5, 52.0] }, { r: 'grain', at: [44.0, 52.5] },
    { r: 'grain', at: [19.5, 47.0] }, { r: 'grain', at: [25.5, 44.3] }, { r: 'grain', at: [10.5, 45.0] },
    { r: 'grain', at: [2.0, 48.5] }, { r: 'grain', at: [17.0, 52.5] }, { r: 'grain', at: [-5.0, 37.5] },
    { r: 'grain', at: [31.0, 30.8] }, { r: 'grain', at: [33.0, 39.0] }, { r: 'grain', at: [-7.5, 33.0] },
    { r: 'grain', at: [36.5, 34.5] }, { r: 'grain', at: [10.0, 36.0] }, { r: 'grain', at: [28.0, 47.0] },
    // Gas
    { r: 'gas', at: [6.8, 53.2] }, { r: 'gas', at: [24.4, 46.5] }, { r: 'gas', at: [10.5, 45.0] },
    { r: 'gas', at: [9.2, 52.8] }, { r: 'gas', at: [3.3, 32.9] }, { r: 'gas', at: [36.4, 49.4] },
    { r: 'gas', at: [46.0, 51.5] }, { r: 'gas', at: [-1.9, 53.7] }, { r: 'gas', at: [16.0, 48.5] },
  ],
  seaCount: 45,
  seaNames: [
    { name: 'Nordsee', at: [3, 56] }, { name: 'Ostsee', at: [19, 56.5] }, { name: 'Bottnischer Meerbusen', at: [20, 62.5] },
    { name: 'Finnischer Meerbusen', at: [26, 59.8] }, { name: 'Skagerrak', at: [9, 58] }, { name: 'Ärmelkanal', at: [-2, 50] },
    { name: 'Irische See', at: [-5, 53.8] }, { name: 'Keltische See', at: [-8, 50] }, { name: 'Nordatlantik', at: [-15, 58] },
    { name: 'Atlantik', at: [-15, 47] }, { name: 'Biskaya', at: [-5, 45.5] }, { name: 'Atlantik vor Portugal', at: [-13, 39] },
    { name: 'Atlantik vor Marokko', at: [-12, 31] }, { name: 'Europäisches Nordmeer', at: [5, 68] }, { name: 'Islandsee', at: [-14, 68] },
    { name: 'Barentssee', at: [38, 71] }, { name: 'Weißes Meer', at: [38, 65.5] }, { name: 'Alboran-See', at: [-3.5, 36] },
    { name: 'Balearen-See', at: [3, 40] }, { name: 'Ligurisches Meer', at: [9, 43.5] }, { name: 'Tyrrhenisches Meer', at: [12.5, 40] },
    { name: 'Adria', at: [15.5, 43] }, { name: 'Ionisches Meer', at: [18.5, 37.5] }, { name: 'Ägäis', at: [25, 38.5] },
    { name: 'Marmarameer', at: [28, 40.7] }, { name: 'Schwarzes Meer', at: [34, 43] }, { name: 'Asowsches Meer', at: [36.5, 46] },
    { name: 'Levantinisches Meer', at: [32, 34] }, { name: 'Libysches Meer', at: [24, 33] }, { name: 'Große Syrte', at: [18, 32] },
    { name: 'Straße von Sizilien', at: [12, 36.5] }, { name: 'Golf von Gabès', at: [11, 34] }, { name: 'Rotes Meer', at: [34, 27.5] },
    { name: 'Golf von Bothnien', at: [21, 64.5] }, { name: 'Kattegat', at: [11.5, 56.5] },
  ],
  // Sizilien ist eine Provinz (Palermo); die zweite süditalienische Provinz liegt auf dem Festland
  ownIslands: [[13.36, 38.12]],
  // Patras auf die Peloponnes, damit der Weg nach Kalamata im eigenen Gebiet bleibt
  cityAt: { Patras: [21.74, 38.24] },
  // Samsun: ein Hafen nahe der Stadt zum Schwarzen Meer II
  seaLinks: { Samsun: ['Schwarzes Meer II'] },
  renames: {
    'Istanbul': 'Konstantinopel', 'Saint Petersburg': 'St. Petersburg', 'Kaliningrad': 'Königsberg',
    'Wroclaw': 'Breslau', 'Gdansk': 'Danzig', 'Szczecin': 'Stettin', 'Poznan': 'Posen',
    'Bydgoszcz': 'Bromberg', 'Olsztyn': 'Allenstein', 'Katowice': 'Kattowitz', 'Lviv': 'Lemberg',
    'Chernivtsi': 'Czernowitz', 'Bratislava': 'Pressburg', 'Ljubljana': 'Laibach', 'Zagreb': 'Agram',
    'Tallinn': 'Reval', 'Tartu': 'Dorpat', 'Helsinki': 'Helsingfors', 'Oslo': 'Kristiania',
    'Kaunas': 'Kowno', 'Vilnius': 'Wilna', 'Kiev': 'Kiew', 'Dnipro': 'Jekaterinoslaw',
    'Dnipropetrovsk': 'Jekaterinoslaw', 'Donetsk': 'Jusowka', 'Tbilisi': 'Tiflis', 'Ankara': 'Angora',
    'Thessaloniki': 'Saloniki', 'Izmir': 'Smyrna', 'Volgograd': 'Zarizyn', 'Nizhny Novgorod': 'Nischni Nowgorod',
    'Klaipeda': 'Memel', 'Cluj-Napoca': 'Klausenburg', 'Timisoara': 'Temeswar', 'Brasov': 'Kronstadt',
    'Sibiu': 'Hermannstadt', 'Novi Sad': 'Neusatz', 'Bolzano': 'Bozen', 'Trieste': 'Triest',
    'Rijeka': 'Fiume', 'Gorizia': 'Görz', 'Krasnodar': 'Jekaterinodar', 'Ulyanovsk': 'Simbirsk',
    'Kirov': 'Wjatka', 'Samara': 'Samara', 'Tel Aviv-Yafo': 'Jaffa', 'Kharkiv': 'Charkow',
    'Odesa': 'Odessa', 'Zaporizhzhya': 'Alexandrowsk', 'Mykolayiv': 'Nikolajew', 'Tolyatti': 'Stawropol',
    'Sankt-Peterburg': 'St. Petersburg',
  },
};

export default config;
