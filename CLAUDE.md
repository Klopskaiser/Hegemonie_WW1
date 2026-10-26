# Projekt: Hegemonie 1914 (Browsergame)

> ⚠️ **Sonderfall – kein proALPHA/ABL.** Reine Web-App (React/TypeScript/Vite). Es gelten
> **nicht**: ABL-Coderichtlinien, PROPATH-Logik, MCP-Server (`lit-studio`, `lit-dev` usw.
> nicht aufrufen). Die globalen Regeln der Benutzer-`CLAUDE.md` (Datenschutz, keine
> automatischen Commits usw.) bleiben gültig. Verifikation über `npm`, Vitest und den Browser.

## Überblick

Singleplayer-Nachbau von **Supremacy 1914** (Stand ca. 2015, ohne Goldmark-Funktionen) mit
eigenen Grafiken und eigenem Namen. Echtzeit (1× = Spieltag 24 h), einstellbares Tempo,
Pause pro Spiel, mehrere parallele Spiele mit Nachsimulation beim Öffnen (ohne Obergrenze).
Optik bewusst nach dem **alten** Flash-Interface (Holz/Pergament/Gold), nicht dem neuen Design.

## Befehle

```bash
npm run dev          # Dev-Server auf http://127.0.0.1:5180
npm run lint         # tsc --noEmit
npm test             # Vitest (tests/)
npm run map:europe   # Karte aus Natural-Earth-Daten neu erzeugen -> data/maps/europe.base.json + public/maps/europe.json
                     # (wendet die Vorgaben aus dem Karteneditor an: scripts/maps/europe.edits.json)
npx tsx scripts/bench.ts   # Simulationsgeschwindigkeit messen
npm run headless -- batch --games 4 --days 60 --record runs.jsonl   # KI-Partien ohne Browser
npm run headless -- stdio --agents DE   # JSON-Zeilen-Schnittstelle für Modelle (Python)
npm run model:example   # Beispielmodell als WebSocket-Server auf ws://127.0.0.1:8765
```

Rohdaten (Natural Earth, Public Domain) liegen in `data/raw/` (admin1, places); nur für den
Kartenbau nötig, nicht zur Laufzeit.

## Architektur

- `src/game/` – reine Simulation ohne DOM, deterministisch.
  - `balance.ts` alle Spielwerte (Gebäude, Einheiten, Moral, Tempo). Werte hier ändern.
  - `sim.ts` `Simulation`: fester **Minutentakt**, Ereignisse (Bau/Fertigung), stündliche
    Controller-Aufrufe, Tageswechsel (Moral, Wehramt, Siegpunkte). Live-Lauf und
    Nachsimulation liefern bitgleiche Ergebnisse (Test in `tests/sim.test.ts`).
  - `actions.ts` einzige Schreibschnittstelle (Bauen, Fertigung, Fertigungsschleife …).
  - `controller.ts` Schnittstelle für Entscheider (Mensch/KI/extern), `QueuedController` und
    `observe()` für externe Entscheidungsmodelle.
  - `ai.ts` eingebaute KI: Wirtschaft, Rekrutierung, Krieg/Frieden, Börse, Fronten/Reserven,
    Landungen, Flotten, Eisenbahngeschütze; Profile (`state.aiProfiles`) und Stärke (`DIFFICULTY`).
  - `bridgeProtocol.ts` Nachrichten für externe Modelle (WebSocket); Doku `docs/EXTERNAL_MODELS.md`.
  - `military.ts` Wegfindung (`planRoute`, Ziele auch auf Wegen), Marsch, Nah-/Fernkampf, Truppenmoral,
    Eroberung, Überlaufen von Provinzen. `names.ts` Armeenamen und -nummern.
  - `graph.ts` Bewegungsnetz: Knoten 0..P-1 Provinzen, P.. Seegebiete; Landwege knicken an der Grenze
    (`edgePoints`, `edgePoint`). `visibility.ts` Nebel des Krieges (`Sight`: ganz einsehbare
    Provinzen + Sichtkreise um Armeen).
  - `diplomacy.ts` Beziehungsstufen (Krieg, Embargo, Frieden, Durchmarsch, geteilte Karte).
  - `market.ts` Börse (Angebote mit Rücklage), `newspaper.ts` Tageszeitung; Sieg in `sim.ts`.
  - `economy.ts` Produktion, Verbrauch, Moral, Siegpunkte.
  - Zufall nur über `state.rng` (`rng.ts`), nie `Math.random()` in der Simulation.
- `src/worker/simWorker.ts` – führt das aktive Spiel aus: Nachsimulation, Echtzeitschleife,
  Speichern alle 15 s und nach jeder Spieleraktion, WebSocket-Brücke zu externen Modellen.
- `src/headless/env.ts` – `HeadlessEnv` (reset/step) und `RecordingController`; CLI
  `scripts/headless.ts`, Beispielmodell `scripts/example-model.ts` (devDependency `ws`).
- `src/persist/db.ts` – IndexedDB (`meta` für das Menü, `saves` für den Zustand).
- `src/ui/` – React-Oberfläche, `MapCanvas.tsx` zeichnet die Karte auf Canvas (Lasso, Rechtsklick-Befehle).
  `MapEditor.tsx` Karteneditor (nur Dev-Server, Endpunkte in `vite.config.ts`, Logik in `src/game/mapedits.ts`).
  Bilder unter `public/images` (Platzhalter, solange Dateien fehlen; Liste in `public/images/README.md`).
- `scripts/build-map.ts` + `scripts/maps/<id>.ts` – Kartenpipeline: Admin-1-Regionen →
  Grenzen von 1914 → Topologie/Vereinfachung → Projektion (km) → feste Provinzzahl je Nation
  (Großmacht 10, Kleinstaat nach Fläche) per gewichtetem k-Means + Voronoi → Nachbarn,
  Küsten, Ressourcen, Doppelprovinzen. Neue Karte = alte Spielstände ungültig (Worker meldet das).

## Stand der Meilensteine

Plan und Entscheidungen: `plans/PLAN.md`.
- M0 Gerüst + Europakarte – erledigt
- M1 Wirtschaft, Bau, Moral, Fertigungsschleife, Spielstände, Nachsimulation, Pause, Menü – erledigt
- M2 Bewegung, Kampf, Eroberung, Nebel, Aufstände, Seegebiete, Krieg/Frieden – erledigt
- M3 Diplomatie-Stufen, Börse, Zeitung, Siegbedingung – erledigt (Balancing folgt)
- M4 strategische KI (Profile, Schwierigkeit, Fronten, Landungen, Flotten), externe Modelle
  per WebSocket, Headless-Runner – erledigt
- Extraliste (zurückgestellt): Balancing nach Vorgaben des Auftraggebers, danach M5 Welt- und Asienkarte
