# Bilder

Alle Bilder sind **quadratisch** (empfohlen 256 × 256 px, PNG). Fehlt eine Datei, zeigt das Spiel
einen Platzhalter mit Beschriftung. Neue Bilder einfach unter dem passenden Namen ablegen.

## Einheiten – `units/<typ>.png`

`infantry`, `artillery`, `armoredCar`, `tank`, `railgun`, `battleship`

`infantry_low` – Infanterie mit Truppenmoral unter 30 % (fehlt die Datei, wird `infantry` gezeigt)

Großes Portrait im Armeefenster (fehlt die Datei, gilt das Bild der Portrait-Einheit):

- `combat` – Truppen im Gefecht (Nahkampf, feuernd oder unter Beschuss), gleich welcher Art
- `embarked` – eingeschiffte Landtruppen (auf See und beim Ein-/Ausschiffen), nicht bei Schlachtschiffen

## Gebäude – `buildings/<gebäude>.png`

`railroad`, `harbor`, `tradepost`, `workshop`, `factory`, `manufactory`, `barracks`, `recruitment`, `office`, `fortress`

## Zeitung – `news/<art>-<1|2|3>.png`

Je Meldungsart drei Varianten; beim Erscheinen der Zeitung wird eine zufällig gewählt.

| Art | Meldung |
|---|---|
| `war` | Kriegserklärung |
| `peace` | Friedensschluss |
| `capital` | Hauptstadt gefallen |
| `eliminated` | Ein Staat verschwindet |
| `embargo` | Handelsembargo |
| `agreement` | Neues Abkommen (Durchmarschrecht, geteilte Karte) |
| `downgrade` | Beziehungen abgekühlt |
| `victory` | Der Sieger steht fest |
| `conquest` | Eroberte Städte |
| `battle` | Vernichtete Armeen (Schlachtberichte) |
| `economy` | Wirtschaftszahlen (Rohstoffförderung, Plätze 1–3) |
| `market` | Börse (reichste Staatskasse) |
| `quiet` | Ruhige Lage |
| `revolution` | Revolution: eine Provinz läuft über |
| `other` | sonstige Meldung |
