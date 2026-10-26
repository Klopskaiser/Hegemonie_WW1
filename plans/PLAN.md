# Plan Hegemonie 1914

## Vorgaben des Auftraggebers

- Nachbau von Supremacy 1914, Stand ca. 2015, alle Spielmechaniken, keine Goldmark-Funktionen.
- Singleplayer mit sinnvollen KI-Gegnern; Schnittstelle für Entscheidungsmodelle, die später
  KI-Rollen übernehmen können.
- Hauptmenü mit Kartenwahl: Europa, Weltkarte, Asien.
- Mehrere Spiele gleichzeitig; nur eins sichtbar, die anderen laufen weiter (umgesetzt als
  Spielstand + Nachsimulation beim Laden, **ohne Obergrenze**).
- Spiel läuft wie im Original auch, wenn es nicht geöffnet ist (Zeitdifferenz nachsimulieren).
- **Pause pro Spiel** (Abweichung vom Original, gewünscht).
- Spielgeschwindigkeit einstellbar.
- Einheiten: Infanterie, Artillerie, Panzer, Eisenbahngeschütz, Schlachtschiff,
  **Panzerwagen** (Fabrik 1, Stärke 2, doppelt so schnell wie Infanterie, halbe Panzerkosten).
  Weitere Fahrzeuge eventuell später.
- Gebäude: Eisenbahn, Wehramt, Kaserne (1–2), Festung (1–5), Fabrik (1–4), Hafen.
- **Fertigungsschleife pro Provinz**: Warteschlange + Schalter „Wiederholen“.
- Look & Feel des **alten** Supremacy-Interfaces, nicht das neue Design.

## Meilensteine

1. **M0 – Gerüst und Kartenpipeline** ✔
2. **M1 – Wirtschaftskern** ✔ – Zeit/Takt, Rohstoffe, Gebäude, Moral, Tageswechsel,
   Fertigung mit Schleife, Spielstände, mehrere Spiele, Nachsimulation, Pause, Tempo, Menü.
3. **M2 – Militär** ✔ – Armeen bewegen (Land, Bahn ×2,5, See mit Einschiffen), Kampf
   (stündliche Runden, Fernkampf, Festungsminderung, Moraleinfluss), Eroberung, Nebel des
   Krieges, Aufstände/Rebellen, Seezonen.
4. **M3 – Diplomatie, Börse, Zeitung, Sieg** ✔ – Krieg, Embargo/Waffenstillstand, Frieden,
   Durchmarschrecht, geteilte Karte; Börse mit Angeboten; tägliche Zeitung; Siegpunkte-Schwelle.
5. **M4 – KI und Controller** ✔ – strategische KI (Fronten, Diplomatie, Handel), externe
   Controller per WebSocket, Headless-Runner (`reset`/`step`) für Training/Batch.

## Extraliste (zurückgestellt)

- **M5 – Welt- und Asienkarte.** Erst nach dem Balancing; Reihenfolge legt der Auftraggeber fest.
- **Balancing** – Vorgaben kommen schrittweise vom Auftraggeber. Bekannt: Nahrung wird überall
  knapp, Kohle häuft sich an, Infanterie wächst stark (über 18.000 nach 40 Tagen).

## Entscheidungen

- Werte in `src/game/balance.ts` sind eigene Abstimmung; Originalwerte waren nur teilweise belegt
  (Quellen: Fan-Wikis, offizielles Forum/Hilfecenter, Guides – teils widersprüchlich).
- Stärkeskala der Einheiten nach älterer Version: Infanterie ≈ 1, Panzerwagen 2, Panzer 4.
- Nahrung wird anteilig zur Produktion aus Getreide und Fisch verbraucht.
- Europakarte: 13 Spielernationen + 11 neutrale Kleinstaaten, 176 Provinzen (Wunsch: 160–180).
  Spielernationen: Deutsches Reich, Österreich-Ungarn, Frankreich, Großbritannien, Italien,
  Russland, Osmanisches Reich, Spanien, Schweden, Rumänien sowie in Afrika Marokko (Marokko +
  Algerien, Hauptstadt Rabat), Libyen (Libyen + Tunesien) und Ägypten. Frankreich, Italien und GB haben keine
  Kolonien mehr auf der Karte; Malta → Italien, Zypern → Osmanisches Reich, Island → Dänemark.
  Nicht streng historisch, wo es dem Spiel dient. Persien gibt es nicht.
- Kartenrand: gerades Rechteck, Ostrand knapp westlich des Kaspischen Meeres. Jedes Land im
  Ausschnitt gehört einer Nation (das Kartenskript bricht sonst ab) – keine grauen Reste.
- Inseln: mittelgroße Inseln (5.000–15.000 km², z. B. Korsika, Zypern, Kreta) sind genau eine
  eigene Provinz; kleinere Inseln gehören zur nächstgelegenen Provinz.
- Städte: Hauptstadt plus die größten Städte ab 300.000 Einwohnern, höchstens 30 % der Provinzen.
- **Jede Spielernation (Mensch oder KI) hat 10 Provinzen mit genau 2 Doppelprovinzen.**
  Neutrale Kleinstaaten haben weniger (1–9 nach Fläche, ab 3 Provinzen eine Doppelprovinz).
  Provinzen dürfen unterschiedlich groß sein (Russland und Wüstengebiete haben große Provinzen).
- Provinzbildung: gewichtetes k-Means (Wüste/Norden dünner) + Voronoi, Hauptstadt als fester Punkt.
- Rohstoffe (`scripts/resources.ts`, gezählt in Punkten, Doppelprovinz = 2):
  - Gesamtkarte grob 40 % Energie (Kohle, Öl, Gas), 30 % Baustoffe (Eisen, Holz), 30 % Nahrung
    (Getreide, Fisch).
  - Je Nation ab 3 Provinzen jede Kategorie mindestens einmal, keine über 60 %; ab 5 Provinzen
    jede Kategorie mindestens 15 %. Ungleichheit ja, aber nicht extrem.
  - Grundlage ist die Lage: Rohstofforte (Kohlereviere, Erzlager, Kornkammern, Gasfelder), Küste,
    Breite, Wüste.
  - Öl ist der knappste Rohstoff, nur an historischen Ölorten (teils erst nach 1914 erschlossen),
    automatisch nie in Doppelprovinzen. Je 2 für Marokko, Libyen, Ägypten, Russland; sonst höchstens 1.
  - Feste Vorgaben danach (`adjust` in `scripts/maps/europe.ts`): Schweden Luleå/Sundsvall Holz,
    Korsika Holz, Öl in Palermo und Ploiești, Doppel-Öl in Sirte (Libyen) und Jerewan (Kaukasus),
    Fisch in Cork, Bari und Vlora. Das Skript prüft, dass jede Spielernation weiter genau 2 Doppelprovinzen hat.
- Rohstoffsymbole stehen in der Mitte der Provinz (Punkt mit größtem Randabstand).
- M3: Beziehungen Krieg < Embargo < Frieden < Durchmarschrecht < geteilte Karte, für beide Seiten
  gleich; verschlechtern einseitig, verbessern per Angebot. Durchmarsch: Betreten erlaubt, Häfen
  befreundet. Geteilte Karte: gemeinsame Sicht. Börse: Angebote je Rohstoff mit Rücklage, 3 Tage
  gültig, Preis 20–500 % des Richtpreises, kein Handel bei Krieg/Embargo; KI kauft bei Engpässen
  und bietet Überschüsse an. Zeitung täglich (Ereignisse, Eroberungsbilanz, Rangliste, Tageskarte,
  14 Ausgaben). Sieg: 45 % aller Siegpunkte oder letzte Großmacht; Spielende hält das Spiel an.
- Geldproduktion ×1,5 (375/1350/2700). Offen fürs Balancing: Nahrung wird bei allen knapp,
  Kohle stapelt sich (Stand 30-Tage-Lauf).
- Kartendaten: Natural Earth (Public Domain), Grenzen von 1914 per Regionszuordnung.
- Spielstart: jede Provinz mit Wehramt und 10 Infanterie an der Stadt, sonst keine Gebäude.
  Vorräte für alle gleich: 6000 je Rohstoff, +1000 beim häufigsten eigenen Rohstoff (Gleichstand
  per Zufall), 10.000 Geld. Wählbares Testszenario mit ausgebauten Provinzen und 50.000 je Wert.
- Infanterie entsteht nur automatisch: Wehramt 16 h je Infanterie bei 100 % Moral, Kaserne 1: 8 h,
  Kaserne 2: 4 h, Kaserne kostet 1000 Getreide je Stufe und Tag; Kaserne braucht Wehramt, ohne Wehramt halbes Tempo;
  ohne beide keine Infanterie. Fertigung nur für Fabrikeinheiten: Artillerie/Panzerwagen Fabrik 1,
  Panzer Fabrik 2, Schlachtschiff Fabrik 3 + Hafen, Eisenbahngeschütz Fabrik 3 + Eisenbahn.
  Bauzeit: Startwert auf der Mindeststufe (Artillerie 96 h, Panzerwagen 16 h, Panzer 36 h,
  Eisenbahngeschütz 62 h, Schlachtschiff 96 h), jede weitere Fabrikstufe −25 % des Startwerts.
  Kosten und Unterhalt: siehe src/game/balance.ts (Stand nach Vorgabe des Auftraggebers).
- Kämpfe in einer Provinz beschädigen Gebäude (4 % je Stunde und Gebäude, eine Stufe; das Wehramt
  kann zerstört werden).
- Unterhalt angepasst: Infanterie 10 Getreide, Nahrungsbedarf je Provinz 100/200.
- See: Schlachtschiffe entstehen im Seegebiet vor der Hafenprovinz und gehen nie an Land.
  Ein-/Ausschiffen 3 h, mit befreundetem (vorerst eigenem) Hafen am Ort 1,5 h. Landtruppen auf See
  kämpfen mit halber Stärke. Auf See dürfen Truppen zu einer Flotte steigen („Schiffe abtrennen“
  zum Anlanden).
- Ausgewählte Armeen zeigen Reichweitenkreise ihrer Fernkampfeinheiten.
- Landung: Flotte mit Truppen und Ziel an Land fährt bis vor die Küste, die Truppen steigen aus
  und marschieren weiter, die Schiffe bleiben ohne weiteren Befehl liegen.
- Fernkampf: alle 10 Spielminuten erfassen Einheiten mit Reichweite Feinde in Reichweite und bleiben
  stehen (stehende Armeen und reine Fernkampfverbände; gemischte Armeen auf dem Marsch ziehen weiter).
  Schaden stündlich. Beschossene dürfen weiterziehen; im Nahkampf Gebundene erst nach Kampfende.
- Geschossanimation von Nadelkopf zu Nadelkopf, solange ein Fernkampf läuft (Artillerie hoher Bogen,
  Eisenbahngeschütz höher, Schlachtschiff flach mit zwei Granaten).
- Moral und Verwundung schwächen nur Infanterie; Maschinen kämpfen bis zur Zerstörung voll.
- Darstellung der Armeen als Pinnadeln: Kopf = Einheitentypen (Kreis Infanterie, Dreieck
  Artillerie, großes Dreieck Eisenbahngeschütz, Quadrat Panzer, Raute Panzerwagen, liegendes
  Rechteck Schlachtschiff überdeckt alles), ein Kopf je Armee mit übereinander gezeichneten Formen,
  Zahl daneben; nahe Armeen (unter 14 px) werden aufgefächert.
- Militär (M2): Bewegungsnetz aus Provinz- und Seegebietsmittelpunkten (45 Seegebiete,
  küstennah feiner). Tempo nach Gebiet (eigen 100 %, fremd 70 %, feindlich 35 %), Bahn ×2,5 im
  eigenen Gebiet, Einschiffen 1 h, Transport 21 km/h. Kampf stündlich: Angreifer nutzt Angriff,
  Verteidiger in eigener Provinz Verteidigung, Festung mindert Schaden, Moral wirkt mit.
  Fernkampfeinheiten feuern selbständig auf Feinde in Reichweite. Eroberung bei Ankunft ohne
  Gegner; Hauptstadtfall: Moral +10 % Sieger / −15 % Verlierer. Aufständische ab Moral < 25 %.
- Nebel: Sicht auf eigene Provinzen, Nachbarn und 120 km um eigene Armeen; Festung ab Stufe 2
  verbirgt die Truppen ihres Besitzers.
- KI (M2): Kriege erst nach 3 Tagen Friedenszeit, Großmächte gegen deutlich schwächere Nachbarn,
  5 Tage Waffenstillstand nach Frieden. Kleinstaaten starten mit Besatzung in jeder Provinz und
  Festung 2 in der Hauptstadt. Flotten bewegt die KI noch nicht (M4).
- KI (M4): Persönlichkeit je Nation (Kriegslust 0,7–1,3, Vorsicht 0,8–1,2, zufällig beim
  Spielstart) und KI-Stärke Leicht/Normal/Schwer (Entscheidung alle 6/3/2 Spielstunden, Kriegslust
  ×0,5/1/1,4, nötige Überlegenheit 1,6/1,3/1,15; Leicht baut keine schweren Einheiten).
  Frontprovinzen (Grenze zum Kriegsgegner) mit Bedrohung aus sichtbaren Feinden; Reserven aus dem
  Hinterland verlegen an die Front, an der die eigenen Kräfte fehlen; bedrohte Frontprovinzen
  werden befestigt (Normal bis Stufe 2, Schwer bis 3). Großmächte greifen auch über See an
  (Landweg bevorzugt), bauen im Krieg Eisenbahngeschütze (bis 2) und Schlachtschiffe (bis 3),
  Flotten stellen schwächere feindliche Flotten oder beziehen vor feindlichen Küsten Stellung,
  Eisenbahngeschütze fahren dorthin, wo die meisten Ziele in Reichweite liegen.
- Steuerung (M4): je Nation Spieler/KI/Extern (Panel „Steuerung"). Extern gesteuerte Nationen
  übernimmt ohne verbundenes Modell die eingebaute KI – auch während der Nachsimulation; die
  Spielernation nur, wenn sie auf KI gestellt ist. Scheidet die Spielernation unter KI- oder
  Modellsteuerung aus, endet das Spiel nicht.
- Externe Modelle (M4): Das Modell ist WebSocket-Server, der Worker verbindet sich nach der
  Nachsimulation (Adresse im Spielstand, Wiederverbindung alle 5 s). Stündlich eine Beobachtung je
  extern gesteuerter Nation; Aktionen des Modells werden sofort ausgeführt. Headless-Runner mit
  `reset`/`step` (Belohnung = Zuwachs des laufenden Punktestands), Batch mit JSONL-Aufzeichnung
  und stdio-Modus für Python. Protokoll: `docs/EXTERNAL_MODELS.md`.
- Wirtschaft (Vorgabe): Geld 3200 je Provinz bei 100 % Moral, Doppelprovinz 6400 (unabhängig von
  Stadt/Hauptstadt, Gebäude erhöhen Geld nicht). Provinzunterhalt 266 je Provinz und Tag in jeder
  Kategorie (Nahrung, Baustoffe, Energie), ersetzt den bisherigen Nahrungsbedarf 100/200.
  Verbrauchsregler je Nation (Wirtschaftsfenster, Aktion `setConsumption`): Anteil jedes Rohstoffs
  am Provinzunterhalt seiner Kategorie; fehlt ein eingestellter Rohstoff, springen die anderen
  eingestellten derselben Kategorie ein, Rohstoffe auf 0 % werden nur durch festen Unterhalt
  (Einheiten, Gebäude) verbraucht. Startwerte anteilig zur eigenen Produktion; die KI verteilt
  nach Vorrat plus fünf Tagen Bilanz und schont Öl. Eisenbahn-Unterhalt 500 Kohle/Tag.
  Infanterie verbraucht ihre 20 Getreide jetzt fest (nicht mehr als frei verteilbare Nahrung).
- Karte: Eisenbahnen als Schienen von der Stadt zum nächstgelegenen Punkt jeder Nachbargrenze,
  Hafen als Anker am Küstenpunkt zum vorgelagerten Seegebiet, Festung als Turm mit Stufe neben der
  Stadt; Gebäude nur in einsehbaren Provinzen.
- Bauschleife je Provinz: Ist ein Bau im Gange, kommen weitere Gebäude in eine Warteschlange
  (höchstens 6), bezahlt wird beim Baubeginn; Stufe, Voraussetzungen und Ausschlüsse zählen
  geplante Gebäude mit. Nicht mehr mögliche Einträge entfallen mit Meldung. Eroberung leert sie.
- Bauamt (Vorgabe): 2 Tage, 30000 Geld + 500 Holz, Unterhalt 2000 Geld/Tag, Gebäudebauzeiten
  in seiner Provinz −25 % (bestätigt: nur Gebäude, nur eigene Provinz; Einheiten unverändert).
- Manufaktur (Vorgabe): 4 Stufen, Rohstoffproduktion +10 % je Stufe (nicht Geld), schließt sich
  mit der Fabrik aus, keine Einheiten.
- Gebäudekosten (Vorgabe, L = Stufe): Fabrik 10000·L Geld, 2500·L Eisen/Holz/Öl, 48 h je Stufe;
  Manufaktur 10000·L Geld, 2000·L Eisen/Holz, 3000·L Gas, 50 h; Wehramt 2000 Geld, 500 Holz, 2 h;
  Festung 4000 Geld, 2000 Eisen je Stufe, 8·L h; Eisenbahn 10000 Geld, 5000 Holz, 3000 Eisen,
  1000 Kohle, 72 h; Hafen 10000 Geld, 10000 Holz, 72 h; Kaserne beide Stufen 4000 Geld,
  1500 Getreide, 1500 Holz, 24 h.
- Bedienung: Linke Maustaste ziehen = Lasso (eigene Armeen, deren Nadel oder Kopf im Lasso liegt;
  Umschalt fügt hinzu), Rechtsklick = Marschbefehl für alle ausgewählten Armeen (auf eine fremde
  Armee: reine Fernkampfverbände beschießen, sonst hinmarschieren). Karte verschieben mit rechter
  oder mittlerer Maustaste ziehen oder Pfeiltasten/WASD; Esc oder Linksklick ins Leere hebt die Auswahl auf.
- Wege: Landwege knicken am nächstgelegenen Punkt der gemeinsamen Grenze (Tempo bis zur Grenze nach
  dem Gebiet von u, danach nach v); sie sind auf der Karte als Linien gezeichnet, Seewege gestrichelt,
  Schienen liegen auf den Wegen. Marschziele dürfen auch Punkte auf einem Weg sein; dort bleibt die
  Armee stehen (keine Eroberung, die Stadt ist nicht erreicht) und kann in beide Richtungen weiter.
- Besatzung: Verlässt die letzte Armee eine eigene Stadt, bleibt eine Einheit zurück (Infanterie,
  sonst die schwächste); eine einzelne letzte Einheit nimmt keine Marschbefehle an.
- Armeenamen: „<Nr>. <Art><Größe>“, Größe nach Kampfstärke (< 10 Brigade, < 30 Division,
  < 70 Heeresgruppe, < 120 Korps (Annahme für die Lücke 70–120), sonst Armee), Art nach der Einheit
  mit dem größten Stärkeanteil; Flotten: Geschwader (< 30) bzw. Flotte. Nummer je Nation eindeutig.
- Truppenmoral (nur Infanterie, je Armee): Stärke 0,8 + 0,4 × Moral (50 % = 1,0, 100 % = 1,2).
  Tageswechsel: Annäherung an das Ziel (eigene Provinz: deren Moral; See, Weg, fremdes Gebiet: 50 %;
  ohne Getreide: 10 %), steigen 30 % der Lücke (2–10 Punkte), sinken 25 % (2–8 Punkte). Je
  Nahkampfrunde −3 Punkte, je Beschuss −1,5, je vernichteter feindlicher Einheit +1 (höchstens +5
  je Runde). Neue Rekruten bringen die Provinzmoral mit (gewichtetes Mittel). Maschinen: keine Moral,
  Zustand ohne Einfluss auf die Kampfkraft; Infanterie zeigt keinen Zustand.
- Überlaufen statt Aufständischer: Provinzen unter 33 % Moral zeigen eine Rebellionsfaust und laufen
  zum Tageswechsel über: Chance linear von 1 % (knapp unter 33 %) bis 33 % (0 % Moral), je angefangene
  5 Kampfstärke eigener Truppen in der Stadt 1 Prozentpunkt weniger (Vorgabe). Übergang bevorzugt zum früheren
  Besitzer, sonst zu einem Nachbarn (Kriegsgegner eher). Je Einheit in der Stadt 25 % Überläufer,
  der Rest fällt, mindestens eine Einheit wechselt. Meldung „Revolution“ in der Zeitung.
- Provinzgrenzen: feines verwackeltes Zellgitter je Nation, Zuordnung zum nächsten Saatpunkt von
  einem durch Rauschen verschobenen Punkt aus; Namen/Städte aus dem geraden Zuschnitt, abgesprengte
  Landstücke gehen an den Landnachbarn, Nachbarschaft erst ab 10 km gemeinsamer Grenze. Rohstoffe und
  Doppelprovinzen werden beim Neubau aus der bisherigen Karte übernommen (`--new-resources` würfelt neu).
- Börse: Handelsprotokoll (letzte 300 Abschlüsse) im Börsenfenster; die KI kauft Engpässe aktiv
  (auch per Kaufgesuch), liefert auf Gesuche und bietet Überschüsse an.
- Flaggen (SVG, vereinfacht um 1914) für alle Nationen; Bildplätze für Einheiten, Gebäude und je drei
  Varianten je Zeitungsmeldung (public/images/README.md).
- Teilen: Regler je Einheitentyp; im Nahkampf nicht möglich. Die abgetrennte Armee wird ausgewählt;
  wird sie ohne Befehl abgewählt (oder steht sie 6 Spielstunden ohne Befehl am selben Ort wie die
  Ursprungsarmee), gliedert sie sich wieder ein. „Schiffe abtrennen“ bleibt dauerhaft getrennt.
- Zeitung: Karte oben, Meldungen darunter. Öffentliche Meldungen sammeln sich bis zur nächsten Ausgabe
  (state.newsFeed); eroberte Städte je Eroberer zusammengefasst („X erobert die Stadt Y (Provinz Y)“,
  Hauptstädte als eigene Meldung), vernichtete Armeen mit Namen und Sieger als Schlachtbericht.
  Eroberte Provinzen erscheinen ganz in der Farbe des Eroberers (keine Schraffur mehr).
