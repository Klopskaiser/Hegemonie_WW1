# Bilderliste für Hegemonie 1914

Alle Dateien liegen unter `public/images/` (Ordner existiert noch nicht). Quadratisch,
256 × 256 px PNG (Quellgeneration 1024 × 1024, dann herunterskalieren). Fehlt eine Datei,
zeigt das UI einen Beschriftungs-Platzhalter — es funktioniert also auch mit Teillieferungen.

**Insgesamt: 58 Bilder** (6 Einheiten + 10 Gebäude + 42 Zeitung).

## Einheitlicher Stil (für alle Prompts voranstellen)

> Black and white pen-and-ink engraving, woodcut illustration, 1914 war-poster style,
> high contrast grayscale, heavy hatching, centered single subject, aged paper texture
> background, square composition, no text, no watermark, no border.

Einheitlichkeit über: gleichen Stilblock + gleiches Modell/LoRA + feste Schrittzahl/Seed-Familie.
Nach der Generierung ohnehin alle Bilder programmatisch in Graustufen (ggf. Duotone) ziehen,
damit die Tonalität garantiert identisch ist.

## Einheiten — `units/<typ>.png` (6)

| Datei | Motiv |
|---|---|
| `infantry.png` | Sturmreihe von vier Soldaten mit Repetiergewehr und Seitengewehr, Rollpack, Marsch durchs Gelände |
| `artillery.png` | Feldhaubitze im Beschuss,和马-Mündungsfeuer, Rauch, Bedienungsmannschaft |
| `armoredCar.png` | früher Radpanzer mit MG auf dem Turm, Speichenräder, kantiger Aufbau |
| `tank.png` | Raupenanzer rautenförmig (Mark-V-artig), über zerklüfteten Boden, seitliche Ansicht |
| `railgun.png` | Eisenbahngeschütz auf Plattformwagen neben Dampflokomotive, Seitenansicht |
| `battleship.png` | Dreadnought im Profil, große Geschütze, Rauch aus den Schornsteinen, Meer |

## Gebäude — `buildings/<name>.png` (10)

| Datei | Motiv |
|---|---|
| `railroad.png` | Dampflokomotive auf Viadukt/Gleisen, Flügelsignal, Telegrafenmasten |
| `harbor.png` | Hafenmit Kränen, Seglern und Dampfschiff, Kaianlage |
| `tradepost.png` | Handelsplatz: Kontorhaus mit Warensäcken, Fässern, Waage |
| `workshop.png` | Mechanikerwerkstatt: Drehbank, Zahnräder, Amboss, Werkwand |
| `factory.png` | Fabrikhalle mit Sägezahn-Dach, Schornsteinen, Maschinen und Laufkran |
| `manufactory.png` | vorindustrielle Handwerksmanufaktur: mehrere Werktische, Spinnräder/Gestelle, Gesellen |
| `barracks.png` | Kasernengebäude mit Wachsoldat, Fahne, Pferd und Karre davor |
| `recruitment.png` | Anwerbeoffizier mit Trommel am Pranger/Marktplatz, Freiwillige treten vor |
| `office.png` | Amtsstube: Beamter mit Akten, Regale, Stempel — Behörde um 1914 |
| `fortress.png` | Sternförmige Festung mit Wall, Graben und Geschützen auf den Bastionen |

Hinweis: `tradepost` und `workshop` fehlen noch in `public/images/README.md` (Liste dort ist
älter als die Gebäude) — beim Einsortieren ergänzen.

## Zeitung — `news/<art>-<1|2|3>.png` (14 Arten × 3 Varianten = 42)

Variante = gleiches Motiv, andere Komposition/Seed (1 Art-Idee reicht, dreimal aussamen und
die besten drei nehmen). Motive:

| Art | Meldung | Motividee |
|---|---|---|
| `war` | Kriegserklärung | zwei gekreuzte Säbel über Kanäufen, trommelnder Grenadier |
| `peace` | Friedensschluss | Handschlag in Uniformärmeln über Kartenausschnitt, Olivenzweig |
| `capital` | Hauptstadt gefallen | brennende Skyline eines Palastviertels, fallende Flagge |
| `eliminated` | Ein Staat verschwindet | zerbrochener Adler/Wappenschild, verglühende Konturen |
| `embargo` | Handelsembargo | versiegeltes Tor / Kette über Straße und Gleis, Zöllner |
| `agreement` | Neues Abkommen | überkreuzte Federn über Dokument, Siegel und Bänder |
| `downgrade` | Beziehungen abgekühlt | zwei Rücken an Rücken stehende Offiziere, frostige Linien |
| `victory` | Sieger steht fest | Siegesallee mit Lorbeerkranz, posaunenengel-artige Siegesgöttin |
| `conquest` | Eroberte Städte | Stadtmauer mit hissender neuer Flagge, Leiter am Wall |
| `battle` | Vernichtete Armeen | Schlachtfeldrahmung: Gewehre im Boden, Helme, Rauch |
| `ranking` | Mächte im Vergleich | Säulenhalle unterschiedlicher Höhe, Zeiger/Balken |
| `quiet` | Ruhige Lage | schlafende Dorfwache, friedliches Tal mit Grenzschild |
| `revolution` | Provinz läuft über | Barrikade mit roter Fahne, Pflastersteine, Kirchturm dahinter |
| `other` | sonstige Meldung | Zeitungsdruckerpresse mit fliegenden Bögen (Universalbild) |

## Umsetzung (geplant)

- Modell: **Krea 2 Turbo** (liegt schon: `models/unet/krea2_turbo_fp8_scaled.safetensors`,
  Textencoder `qwen3vl_4b_bf16` vorhanden; VAE wird beim Setup geprüft), 8 Steps, CFG 1,
  1024 × 1024; optional Stil-LoRA `krea2_darkbrush`/`krea2_dotmatrix` für reines Monochrom.
- Batch pro Art über ComfyUI-API (Skill `creative/comfyui`, `run_batch.py --count 3 --randomize-seed`).
- Nachbearbeitung: Graustufen + Leuchtdichte-Normierung + Skalierung auf 256 px,
  Ablage unter `public/images/…` mit exakt obigen Dateinamen.
