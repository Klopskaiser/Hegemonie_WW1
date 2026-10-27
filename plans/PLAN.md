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
   Durchmarschrecht, geteilte Karte; Börse mit Angeboten; tägliche Zeitung; Sieg bei 70 % der Provinzen.
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
- Europakarte: 14 Spielernationen + 15 neutrale Kleinstaaten, 189 Provinzen (Wunsch: 160–180, erweitert um
  12 Provinzen neuer Kleinstaaten).
  Spielernationen: Deutsches Reich, Österreich-Ungarn, Frankreich, Großbritannien, Italien,
  Russland, Osmanisches Reich, Spanien, Schweden, Norwegen, Rumänien sowie in Afrika Marokko (Marokko +
  Algerien, Hauptstadt Rabat), Libyen (Libyen + Tunesien) und Ägypten. Frankreich, Italien und GB haben keine
  Kolonien mehr auf der Karte; Malta → Italien, Zypern → Osmanisches Reich, Island → Dänemark.
  Nicht streng historisch, wo es dem Spiel dient. Persien gibt es nicht.
- Neue Kleinstaaten zum Ausbreiten (Vorgabe): Finnland (3 Provinzen), Baltikum (2) und Nordrussland (3: Karelien,
  Archangelsk, Komi) aus Russland, Dschabal Schammar (2: Ostjordanien, Nordarabien, Syrische Wüste) aus dem
  Osmanischen Reich, Sahara-Emirat (2: Süd-Algerien) aus Marokko. Großmächte behalten 10 Startprovinzen auf
  kleinerer Fläche. Doppelt sind nur Oulu (Holz) und Ouargla (Gas). Kiew ist Getreide ×2, Russland hat Eisen in
  Kriwoi Rog (Jekaterinoslaw); Holz im Süden: Fès (Mittlerer Atlas) und Tunis (Kroumirie).
- Maßstab 0,85 (Vorgabe, zuerst 0,9): die fertige Karte ist um 15 % verkleinert (`scale` in der
  Kartenkonfiguration), Spielwerte in km (Tempo, Sicht, Reichweiten) bleiben – Wege sind damit 15 % kürzer.
- Der Kartenbau prüft je Nation die Rohstoffregeln und die Entfernung von der Hauptstadt zum nächsten Feld
  jedes Rohstoffs (Warnung ab 1000 km, `src/game/mapcheck.ts`).
- Kartenrand: gerades Rechteck, Ostrand knapp westlich des Kaspischen Meeres. Jedes Land im
  Ausschnitt gehört einer Nation (das Kartenskript bricht sonst ab) – keine grauen Reste.
- Inseln: mittelgroße Inseln (5.000–15.000 km², z. B. Korsika, Zypern, Kreta) sind genau eine
  eigene Provinz; kleinere Inseln gehören zur nächstgelegenen Provinz.
- Städte: Hauptstadt plus die größten Städte ab 300.000 Einwohnern, höchstens 30 % der Provinzen.
- **Jede Spielernation (Mensch oder KI) hat 10 Provinzen mit genau 2 Doppelprovinzen.**
  Neutrale Kleinstaaten haben weniger (1–9 nach Fläche oder fest vorgegeben, ab 3 Provinzen eine Doppelprovinz).
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
  - Ausgleich (Symbole, Doppel = 2): Getreide 45, Fisch 22, Eisen 33, Holz 33, Kohle 34, Gas 27, Öl 16.
    Norwegen: Doppel-Fisch Bergen, Doppel-Eisen Tromsø. Serbien verliert Doppel-Holz Niš, bekommt
    Doppel-Kohle in Kragujevac.
- Rohstoffsymbole stehen in der Mitte der Provinz (Punkt mit größtem Randabstand).
- Symbole (Rohstoffe, Nadelköpfe, Hauptstadt, Stadt, Festung, Hafen, Aufstand) wachsen beim
  Hineinzoomen bis +40 % bei größter Zoomstufe; kleiner als die Grundgröße werden sie nie.
- M3: Beziehungen Krieg < Embargo < Frieden < Durchmarschrecht < geteilte Karte, für beide Seiten
  gleich; verschlechtern einseitig, verbessern per Angebot. Durchmarsch: Betreten erlaubt, Häfen
  befreundet. Geteilte Karte: gemeinsame Sicht. Börse: Angebote je Rohstoff mit Rücklage, gültig bis
  erfüllt, zurückgezogen oder die Nation untergeht (die KI zieht eigene nach 3 Tagen zurück und stellt
  neu ein), Preis ab 20 % des Richtpreises bis höchstens 1000 je Einheit, kein Handel bei Krieg/Embargo; KI kauft bei Engpässen
  und bietet Überschüsse an. Zeitung täglich (Ereignisse, Eroberungsbilanz, Rangliste, Tageskarte,
  14 Ausgaben). Sieg (Vorgabe): wer 70 % aller Provinzen hält; Rangfolge (Rangliste, Zeitung,
  Spielende) nach Zahl der Provinzen; Spielende hält das Spiel an. Siegpunkte werden weiter berechnet (externe Modelle).
- Geldproduktion ×1,5 (375/1350/2700). Offen fürs Balancing: Nahrung wird bei allen knapp,
  Kohle stapelt sich (Stand 30-Tage-Lauf).
- Kartendaten: Natural Earth (Public Domain), Grenzen von 1914 per Regionszuordnung.
- Spielstart: jede Provinz mit Wehramt und 10 Infanterie an der Stadt, sonst keine Gebäude.
  Vorräte für alle gleich: 6000 je Rohstoff, +1000 beim häufigsten eigenen Rohstoff (Gleichstand
  per Zufall), 100.000 Geld. Wählbares Testszenario mit ausgebauten Provinzen und 50.000 je Wert,
  ohne Nebel des Krieges für den Spieler (`revealed`, die KI sieht weiter nur ihr Gebiet).
- Infanterie entsteht nur automatisch: Wehramt 16 h je Infanterie bei 100 % Moral, Kaserne 1: 8 h,
  Kaserne 2: 4 h, Kaserne kostet 1000 Getreide je Stufe und Tag; Kaserne braucht Wehramt, ohne Wehramt halbes Tempo;
  ohne beide keine Infanterie. Fertigung nur für Fabrikeinheiten: Artillerie/Panzerwagen Fabrik 1,
  Panzer Fabrik 2, Schlachtschiff Fabrik 3 + Hafen, Eisenbahngeschütz Fabrik 3 + Eisenbahn.
  Bauzeit: Startwert auf der Mindeststufe (Artillerie 96 h, Panzerwagen 16 h, Panzer 40 h,
  Eisenbahngeschütz 62 h, Schlachtschiff 96 h), jede weitere Fabrikstufe −25 % des Startwerts.
  Kosten und Unterhalt: siehe src/game/balance.ts (Stand nach Vorgabe des Auftraggebers).
- Kämpfe in einer Provinz beschädigen Gebäude (5 % je Stunde und Gebäude, eine Stufe; das Wehramt
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
- Geschossanimation vom Nadelkopf des Schützen auf die Nadelspitze des Ziels (seine echte Position), solange ein
  Fernkampf läuft: Artillerie hoher Bogen, Eisenbahngeschütz höher, Schlachtschiff flach – je Schiff zwei Granaten
  nebeneinander gleichzeitig (Doppelkanone, nur optisch). Einschlag als kleine Explosion, deren Ring etwa den
  Umkreis des Flächenschadens (1 km) zeigt.
- Moral und Verwundung schwächen nur Infanterie; Maschinen kämpfen bis zur Zerstörung voll.
- Darstellung der Armeen als Pinnadeln: Kopf = Einheitentypen (Kreis Infanterie, Dreieck
  Artillerie, großes Dreieck Eisenbahngeschütz, Quadrat Panzer, Raute Panzerwagen, liegendes
  Rechteck Schlachtschiff überdeckt alles), ein Kopf je Armee mit übereinander gezeichneten Formen,
  Zahl daneben; nahe Armeen (unter 14 px) werden aufgefächert.
- Militär (M2): Bewegungsnetz aus Provinz- und Seegebietsmittelpunkten (45 Seegebiete,
  küstennah feiner). Tempo nach Gebiet (eigen 100 %, mit Durchmarschrecht/Bündnis 70 %, sonst – feindlich
  oder ohne Wegerecht – 50 %; der Marsch wird ab der Grenze sichtbar langsamer), Bahn ×2,5 im
  eigenen Gebiet, Ein-/Ausschiffen 2 h an der Wassergrenze (eigener oder befreundeter Hafen: 1 h), Transport 21 km/h. Kampf stündlich: Angreifer nutzt Angriff,
  Verteidiger in eigener Provinz Verteidigung, Festung mindert Schaden, Moral wirkt mit.
  Fernkampfeinheiten feuern selbständig auf Feinde in Reichweite. Eroberung bei Ankunft ohne
  Gegner; Hauptstadtfall: Moral +10 % Sieger / −15 % Verlierer. Aufständische ab Moral < 25 %.
- Nebel: eigene Provinzen (und die von Partnern mit geteilter Karte) sind ganz einsehbar, sonst nur
  ein Kreis von 100 km um jede eigene Armee (Eisenbahngeschütz und Schlachtschiff 200 km). Festung ab
  Stufe 2 verbirgt die Truppen ihres Besitzers in dessen Stadt – nicht vor Nationen, die selbst mit
  Truppen in dieser Provinz stehen.
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
  Stadt/Hauptstadt, Gebäude erhöhen Geld nicht). Provinzunterhalt 800 je Provinz und Tag in jeder
  Kategorie (Nahrung, Baustoffe, Energie), ersetzt den bisherigen Nahrungsbedarf 100/200.
  Verbrauchsregler je Nation (Wirtschaftsfenster, Aktion `setConsumption`): Anteil jedes Rohstoffs
  am Provinzunterhalt seiner Kategorie, stur (Vorgabe): fehlt ein eingestellter Rohstoff, springen die anderen
  nicht ein – Engpass, Moral sinkt; so lässt sich ein Rohstoff gezielt aufstapeln. Rohstoffe auf 0 % werden nur durch festen Unterhalt
  (Einheiten, Gebäude) verbraucht. Startwerte anteilig zur eigenen Produktion; die KI verteilt
  nach Vorrat plus fünf Tagen Bilanz und schont Öl. Eisenbahn-Unterhalt 500 Kohle/Tag.
  Infanterie verbraucht ihre Getreideration (jetzt 18 je Tag) fest (nicht mehr als frei verteilbare Nahrung).
- Karte: Eisenbahnen als Schienen von der Stadt zum nächstgelegenen Punkt jeder Nachbargrenze,
  Hafen als Anker am Küstenpunkt zum vorgelagerten Seegebiet, Festung als Turm mit Stufe neben der
  Stadt; Gebäude nur in einsehbaren Provinzen.
- Bauschleife je Provinz: Ist ein Bau im Gange, kommen weitere Gebäude in eine Warteschlange
  (höchstens 6), bezahlt wird beim Baubeginn; Stufe, Voraussetzungen und Ausschlüsse zählen
  geplante Gebäude mit. Nicht mehr mögliche Einträge entfallen mit Meldung. Eroberung leert sie.
- Bauamt (Vorgabe): 2 Tage, 30000 Geld + 500 Holz, Unterhalt 2000 Geld/Tag, Gebäudebauzeiten
  in seiner Provinz −25 % (bestätigt: nur Gebäude, nur eigene Provinz; Einheiten unverändert).
  Abschaltbar wie Kaserne, Wehramt und Eisenbahn (aus: kein Unterhalt, keine Wirkung).
- Handelsposten (Vorgabe): 1 Stufe, nur in Provinzen ohne Küste (kein Hafen möglich), 12000 Geld, 500 Eisen,
  2500 Holz, Bauzeit 48 h, Rohstoffproduktion +7 % (nicht Geld), Moral +3 %, Unterhalt 20 Fisch/Tag.
- Werkstatt (Vorgabe): 1 Stufe, 1 Tag, 5000 Geld, 1500 Eisen, 500 Holz, Moral +1 %, mechanische
  Einheiten (alles außer Infanterie) in der Provinz +10 % Bautempo (Fertigungszeit ÷ 1,1),
  Voraussetzung für die Fabrik (geplante Werkstatt zählt mit). Alte Spielstände: Werkstatt 0,
  bestehende Fabriken bleiben.
- Manufaktur (Vorgabe): 4 Stufen, Rohstoffproduktion +11 % je Stufe (nicht Geld), Moral +2,5 % je Stufe wie die Fabrik, schließt sich
  mit der Fabrik aus, keine Einheiten.
- Gebäudekosten (Vorgabe, je Stufe gleich; nur die Festung dauert je Stufe länger): Fabrik 10000 Geld,
  2500 Eisen/Holz/Öl, 48 h; Manufaktur 10000 Geld, 2000 Eisen/Holz, 3000 Gas, 50 h; Wehramt 2000 Geld, 125 Holz, 125 Eisen, 2 h;
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
  sonst die schwächste); eine einzelne letzte Einheit nimmt keine Marschbefehle an. „In der Stadt“ heißt im
  Umkreis von 1 km – auch eine Armee, die die Stadt von dort erobert hat oder gerade hineinzieht, lässt die
  Besatzung in der Stadt zurück.
- Armeenamen: „<Nr>. <Art><Größe>“, Größe nach Kampfstärke (< 10 Brigade, < 30 Division,
  < 70 Heeresgruppe, < 120 Korps (Annahme für die Lücke 70–120), sonst Armee), Art nach der Einheit
  mit dem größten Stärkeanteil; Flotten: Geschwader (< 30) bzw. Flotte. Nummer je Nation eindeutig.
- Truppenmoral (nur Infanterie, je Armee): Stärke 0,8 + 0,4 × Moral (50 % = 1,0, 100 % = 1,2).
  Tageswechsel: Annäherung an das Ziel (eigene Provinz: deren Moral; See, Weg, fremdes Gebiet: 50 %;
  ohne Getreide: 10 %), steigen 30 % der Lücke (2–10 Punkte), sinken 25 % (2–8 Punkte). Je
  Nahkampfrunde −2 Punkte, gegen mehrere Armeen −3, beschossen −2 (egal wie viele Schützen), zusammen
  höchstens −4 je Runde; je vernichteter feindlicher Einheit +1 (höchstens +4 je Runde, gegen den Verlust gerechnet). Neue Rekruten bringen die Provinzmoral mit (gewichtetes Mittel). Maschinen: keine Moral,
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
- Teilen: Regler je Einheitentyp; im Nahkampf nicht möglich. Die abgetrennte Armee wird ausgewählt.
  Sie verschmilzt nicht von selbst wieder mit ihrer Ursprungsarmee (`apartFrom`, auch nicht über eine dritte
  Armee im Verband), bis eine der beiden losmarschiert: Am Zielort geht sie in den dortigen Truppen auf, und
  rückt die Ursprungsarmee nach, verschmelzen beide wieder. Im Kampf gilt die Trennung nicht (Verband wie
  sonst). Wieder eingliedern nur von Hand („Zusammenlegen“ bzw. Aktion `rejoin`); früher geschah das beim
  Abwählen und nach 6 Stunden von selbst (auf Vorgabe entfernt). Marschierende Armeen verschmelzen nie.
- Zeitung: Karte oben, Meldungen darunter. Öffentliche Meldungen sammeln sich bis zur nächsten Ausgabe
  (state.newsFeed); eroberte Städte je Eroberer zusammengefasst („X erobert die Stadt Y (Provinz Y)“,
  Hauptstädte als eigene Meldung), vernichtete Armeen mit Namen und Sieger als Schlachtbericht.
  Eroberte Provinzen erscheinen ganz in der Farbe des Eroberers (keine Schraffur mehr).
- Wegenetz (Vorgabe): Landwege nur zu einem Teil der Nachbarn – 2 bis 5 je Provinz, 5 selten (≤ 8 %),
  rund 17 % der Nachbarschaften ohne Weg (bevorzugt bei vielen Wegen, großem Umweg oder kurzer Grenze);
  zwischen Nachbarländern bleiben mindestens 2 Übergänge, das Netz bleibt zusammenhängend.
  Wasserwege: je Küstenprovinz 1–2 (Inseln ohne Landnachbarn bis 4), die nächstgelegenen Seegebiete;
  sie knicken am Hafenpunkt der Küste, Seewege untereinander an einem Punkt der gemeinsamen Grenze.
  Nachbarschaft (Sicht, Front, Überlaufen) bleibt geografisch.
- Marsch in Gebiet einer Nation im Frieden/Embargo: Rückfrage; bestätigt, wird der Krieg erklärt, sobald
  die Truppen ihr Gebiet betreten (danach Kampf). Mit Durchmarschrecht/geteilter Karte darf man in die fremde Stadt.
- Rohstoffe (Vorgabe): Danzig, Barcelona, Valencia, Alexandria, Montpellier, Jaffa Getreide → Fisch;
  Mailand, Agadir Gas → Eisen.
- Landwege übers Wasser: Wo der Weg Stadt → Grenzpunkt → Stadt Wasser quert, führt der Kartenbau ihn per
  Rasterwegsuche an Land herum (zuerst durch die beiden Provinzen, notfalls über anderes Land) und glättet
  ihn zu einem eckigen Pfad (map.roads, mit Anteil je Provinz). Ohne Landverbindung (z. B. Kopenhagen–Aarhus)
  bleibt der gerade Weg übers Wasser (gewollte Ausnahme).
- Sizilien ist eine Provinz (Palermo, Konfiguration ownIslands); die frühere Provinz Messina liegt in
  Kalabrien und heißt Catanzaro (Rohstoff Getreide ×2 übernommen). Umbenannte Provinzen erben beim Neubau
  die Rohstoffe ihrer Vorgängerin; die Reihenfolge der Provinzen bleibt stabil.
- Wegauswahl (Vorgabe): beim Ausdünnen fallen bevorzugt lange Wege (relativ zu den anderen Wegen der beiden
  Provinzen) und Wege durch eine dritte Provinz weg; bei Gleichstand bleiben Wege im eigenen Land. Verbleibende
  Wege durch dritte Provinzen werden innerhalb der beiden Provinzen geführt.
- Seewege, die über Land liefen, verlaufen jetzt durchs Wasser (Rasterwegsuche, eckig; scripts/routes.ts).
  Seegebietsmitten liegen immer im Wasser.
- Wegbündel und Kreuzungen: Wege, die von einem Knoten aus lange dicht nebeneinander laufen (Land: ≤ 10 km
  über ≥ 90 km und ≥ 30 % – selten; See: ≤ 35 km über ≥ 50 km), teilen sich den Abschnitt bis zu einer
  Wegkreuzung (Punkt auf der Karte). Zwischen Zielen ohne eigene Verbindung entsteht eine Abkürzung über die
  Kreuzung (map.shortcuts); die Wegsuche nutzt sie, wenn sie schneller ist, und verlangt Zutritt zum Gebiet
  dazwischen (Landabkürzungen: Tempo je Abschnitt nach Gebiet).
- Wegbündel überarbeitet: an Land laufen gebündelte Wege auf einem Stamm bis kurz vor die Grenzen; die
  Kreuzung liegt dort, wo die Abzweige mindestens 30° auseinandergehen, von ihr führen gerade Abzweige zur
  Grenze (z. B. Archangelsk → Kiruna/Luleå/Tromsø/Vadsø). Seewege werden global zusammengelegt: längere Wege
  sind Rückgrat, kürzere übernehmen deren Verlauf, wo sie ihm über ≥ 40 km auf ≤ 25 km nahekommen
  (Kreuzungspunkte unter 20 km Abstand zusammengefasst).
- Seewege verlassen ein gemeinsames Rückgrat nicht mehr, um später ohne Zwischenziel wieder einzumünden
  (Läufe auf demselben Rückgrat werden verbunden). Hafenwege, die vom üblichen Einschiffpunkt nicht durchs
  Wasser führen, bekommen einen anderen Küstenpunkt zu diesem Seegebiet (der stadtnächste, der passt);
  das Hafensymbol sitzt am tatsächlichen Einschiffpunkt.
- Landwege durch eine dritte Provinz werden gestrichen, sofern beide Provinzen mindestens 2 Wege behalten
  (Provinzen mit 2 Wegen bekommen vorher einen sauberen Ersatz); als Ausgleich entstehen kurze, saubere
  Wege anderswo (Gesamtzahl gleich). Gebündelte Wege und Abkürzungen durch dritte Provinzen entfallen.
  Patras liegt auf dem Festland (`cityAt`, Vorgabe; vor dem Zuschnitt angewendet): die Provinz hat kein
  Splitterstück auf der Peloponnes, die ganz zu Kalamata gehört.
- Kartenbau (Vorgabe): Nebenteile einer Provinz, die an Land an eine andere Provinz derselben Nation stoßen,
  gehören zu der Nachbarprovinz mit der längsten gemeinsamen Grenze (echte Inseln bleiben). Provinzstädte haben
  einen Mindestabstand zur nächsten Landgrenze ihrer Provinz: die 5 heute dichtesten 5 km, alle anderen einen
  festen Zufallswert von 8–25 km (Spiel-km); liegt eine Stadt näher, rückt nur ihr Standort ins Innere.
- Samsun hat genau einen Hafen nahe der Stadt zum Schwarzen Meer II (`seaLinks`).
- Begegnungen auf Wegen: Armeen, die auf demselben Weg aneinander vorbeiziehen, sich überholen oder auf
  eine dort stehende Armee treffen (bis auf 1 km), bleiben am Treffpunkt stehen und kämpfen – im Krieg überall, an Land
  auch im Frieden/Embargo (dann beginnt der Krieg); Durchmarschrecht und geteilte Karte lassen passieren.
  Auf See kämpfen nur Nationen im Krieg. Wer in einen laufenden Kampf nachrückt, verschmilzt mit der
  größten eigenen Armee dort; alle Kämpfe laufen im selben Stundentakt.
- Kaserne, Wehramt und Eisenbahn lassen sich je Provinz abschalten: kein Unterhalt, aber auch keine Wirkung
  (Rekrutierung, Produktion, Moral, Bahntempo, Eisenbahngeschütze).
- Wirtschaft: Verbrauch je Rohstoff nach Verursachern (Provinzunterhalt laut Regler, Gebäude je Art,
  Einheiten je Typ). Provinz: Moralziel mit allen Gründen (Gebäude einzeln, Kämpfe in der Provinz −10 %
  bis zum nächsten Tageswechsel).
- Armeen zählen Abschüsse. Schlachtschiffe und Eisenbahngeschütze bekommen beim Bau einen Namen (Orte der
  eigenen Nation, z. B. „SMS …“); jede eigene Armee lässt sich umbenennen.
- Karteneditor (nur `npm run dev`, Knopf im Hauptmenü oder `#editor`): Land-, Hafen- und Seewege
  hinzufügen/löschen, Verläufe und Einschiffpunkte per Knick verschieben, Kreuzungen setzen; Modus „Rohstoffe“:
  Rohstoff und Doppelprovinz je Provinz setzen, mit Regelprüfung der Nation und Entfernung zum nächsten Feld. Gespeichert
  werden Vorgaben in `scripts/maps/europe.edits.json`; der Kartenbau schreibt die Grundkarte nach
  `data/maps/europe.base.json` und wendet die Vorgaben an (`src/game/mapedits.ts`).
- Inseln werden nicht zerteilt: Stücke einer Insel gehören der Provinz, deren Stadt dort liegt (sonst dem
  größten Anteil). Norwegen ist ocker.
- Küstenorte ohne echte Stadt: Lag der Provinzmittelpunkt unter 10 km am Wasser, bleiben nur etwa 20 %
  dort (feste Auswahl nach Namen); die übrigen rücken an eine zufällige Stelle im Inneren der Provinz
  (mindestens halb so weit vom Rand wie der innerste Punkt, nicht direkt am Rohstoffsymbol). Echte Städte
  und Vorgaben (`cityAt`) bleiben. Ergebnis: 33 verlegt, 8 bleiben; Mittelpunkte unter 10 km am Meer
  62 → 29 (davon 19 echte Städte). Je Ortspaar gibt es nur noch eine Abkürzung (die kürzere).
- Provinzmoral (Vorgabe): Ziel = 85 % − Entfernung zur Hauptstadt (1 % je 100 km ab 300 km, höchstens
  30 %; ohne Hauptstadt die vollen 30 %; Werte wie in balance.ts MORALE) + Gebäude − 5 % je Krieg (höchstens 25 %) − Mangel (Nahrung 15 %,
  Baustoffe 5 %, Energie 10 %) − Kämpfe in der Provinz (Vorgabe: fest −15 % am Ziel, solange seit dem letzten Tageswechsel gekämpft wurde,
  unabhängig von der Dauer; zusätzlich je Kampfrunde in der Provinz – Nahkampf oder Beschuss, zusammen höchstens einmal je Stunde – sofort −0,75 %) − 2 % je angrenzender eigener Provinz
  unter 33 % Moral. Kein Hauptstadtbonus, kein Abzug für besetztes Gebiet. Annäherung je Tag 35 % der
  Lücke, mindestens 3 Prozentpunkte (Vorgabe; liegt das Ziel näher, die Restlücke), höchstens ±10 Prozentpunkte. Eroberte Provinzen beginnen bei 25 %, Rückeroberung durch den
  Vorbesitzer am selben Spieltag bei 40 % (wie Überlaufen). Hauptstadtfall: Sieger +10 %, Verlierer −15 %.
- Hauptstadt verlegen: 20000 Geld, je 5000 Holz/Eisen/Getreide/Kohle, 48 h; je Nation eine Verlegung
  gleichzeitig, Abbruch mit voller Erstattung; fällt die Zielprovinz, scheitert sie. Die KI verlegt eine
  verlorene Hauptstadt in ihre wertvollste sichere Provinz. Der Stern auf der Karte zeigt die aktive Hauptstadt.
- Truppenmoral (nur Infanterie): 10–100 %. Ziel = Provinzmoral (stehend in eigener Provinz) bzw. 50 %
  (sonst), bei Getreidemangel −20 %. Zum Tageswechsel geht sie auf das Ziel zu, nie darüber hinaus:
  höchstens +10 %/−8 %, bei Getreidemangel +5 %/−13 %. Kampfeffekte wirken je Kampfstunde und unabhängig davon.
- Kampfmoral je Stunde (Vorgabe, Nah- und Fernkampf zusammen): Nahkampf −2 %, gegen zwei und mehr Armeen −3 %,
  beschossen −2 % (egal wie viele Schützen), Nahkampf und Beschuss zusammen höchstens −4 % – egal wie viele
  Armeen angreifen. Abschüsse +1 % je Einheit, höchstens +4 %, gegen den Verlust gerechnet (im Nahkampf netto
  höchstens +2 %, Schütze ohne Gegenwehr bis +4 %).
- Nahkampfreichweite 1 km (Vorgabe, `MILITARY.meleeKm`): stehende Armeen im Krieg, die höchstens 1 km
  auseinander stehen, kämpfen – an Land wie auf See, Artillerie in diesem Umkreis wird in den Nahkampf
  verwickelt. Marschierende Armeen bleiben genau am Rand dieses Umkreises stehen, sobald sie einer Armee im
  Krieg so nahe kommen (auch auf anderen Wegen und vor Städten); Nachrücker verschmelzen mit der größten
  eigenen Armee im Umkreis. Städte werden aus 1 km Entfernung erobert.
- Flächenschaden (Vorgabe): jeder Treffer im Nah- und Fernkampf trifft alle gegnerischen Armeen im selben
  Umkreis von 1 km mit vollem Schaden; Aufteilen schützt nicht.
- Verbände (Vorgabe): stehende Armeen derselben Nation (Landtruppen bzw. Flotten) im Umkreis von 1 km werden
  alle 10 Spielminuten (und beim Nachrücken in einen Kampf) zur größten zusammengefasst – im Kampf wie im Stand.
  Im Kampf gehören auch Armeen dazu, die mit demselben Gegner im Nahkampf stehen (von zwei Seiten herangerückt,
  je 1 km vor dem Gegner, also bis zu 2 km auseinander). Wer dabei einen unterbrochenen
  Marschbefehl hat, bleibt als Teil vorgemerkt und zieht nach dem Kampf mit seinem Anteil (Verluste anteilig)
  unter alter Nummer weiter. Nie zusammengefasst: Armeen mit Angriffsziel; frisch abgeteilte nicht mit ihrer
  Ursprungsarmee (siehe Teilen).
- Marschart im Armeefenster (Vorgabe): „Normal“ (Standard) hält im Marsch nicht für Gegner in Reichweite,
  „Angriff“ hält mit Fernkampfeinheiten, sobald ein Gegner in Reichweite ist, und zieht danach weiter. Im
  Stand feuern Fernkampfeinheiten immer selbständig. „Gewaltmarsch“ (umschaltbar): 50 % schneller, im Marsch
  je Stunde −4 % Moral (Infanterie) bzw. 4 % der Lebenspunkte (Maschinen, können ausfallen), keine Reparatur.
- Angriff (Vorgabe, Rechtsklick auf eine feindliche Armee oder Knopf im Armeefenster): die Armee verfolgt das
  Ziel und plant neu, wenn es weiterzieht. Mit Fernkampfeinheiten (auch gemischt) rückt sie nur bis in
  Reichweite heran und beschießt es, sonst bis in den Nahkampf.
- Beschuss räumt keine Stadt (Vorgabe): steht eine Armee in einer Stadt ihrer Seite und hat die Seite dort sonst
  keine Einheiten, fällt ihre letzte Einheit nicht durch Fernkampf – die Moral sinkt weiter (bis 10 %), die
  Provinz gilt als umkämpft. Städte fallen nur im Nahkampf; unterwegs oder im gleichzeitigen Nahkampf wird
  die letzte Einheit normal vernichtet.
- Reichweiten (Vorgabe): Artillerie 65 km, Eisenbahngeschütz 200 km, Schlachtschiff 100 km. Kampfkraft je Moral linear:
  1,2 × Moral: 10 % → 0,12 bis 100 % → 1,2 (1,0 bei 83,3 %). Das Armeefenster zeigt Ziel und Gründe.
- Spielbeginn: alle Provinzen und Truppen haben 70 % Moral (Startgeld 100.000).
- Kämpfe und Eroberungen gelten im Umkreis von 1 km (siehe Nahkampfreichweite): eine Armee weiter draußen auf
  dem Weg kämpft nicht mit der Besatzung der nächsten Stadt und erobert sie nicht. Läuft eine
  Provinz ohne Besatzung über, stellt der neue Herr eine Infanterie hinein – eine Stadt ist nie leer.
- Unterbrochene Befehle: Wird ein Marsch durch Nahkampf, eine Begegnung auf dem Weg oder ein Fernkampfziel
  angehalten, merkt sich die Armee ihr Ziel und zieht weiter, sobald sie wieder frei ist (Prüfung alle
  10 Spielminuten). Ein neuer Befehl oder „Halt“ verwirft das gemerkte Ziel. Bei einer Verfolgung bestimmt
  das Ziel den Weg, ein gemerktes Ziel entfällt.
- Eisenbahn deckt auch die Wege bis zu den Hafenpunkten ab (Schienen auf der Karte, Bahntempo bis zum
  Hafenpunkt, danach Transporttempo).
- Abbruch eines Baus, einer laufenden Fertigung oder einer Hauptstadtverlegung erstattet die vollen Kosten.
- See (Vorgabe): Landeinheiten brauchen beim Ein- und Ausschiffen 2 h am Hafenpunkt (Wassergrenze); ein
  eigener Hafen oder einer mit Durchmarschrecht/Bündnis halbiert das, feindliche Häfen nicht. Bis zum
  Hafenpunkt geht es im Landtempo (mit eigener Bahn auf der Schiene), auf dem Wasser im Transporttempo.
  Auf See kämpfen Landeinheiten mit halber Stärke (Schlachtschiffe voll); Artillerie und
  Eisenbahngeschütze haben dort keine Reichweite und kämpfen als Nahkämpfer. Eisenbahngeschütze dürfen
  aufs Wasser, an Land aber nur in Provinzen mit eigener, eingeschalteter Eisenbahn.
- Beim Ein- und Ausschiffen sind Landtruppen am Hafenpunkt vom Land aus im Nahkampf angreifbar (Rechtsklick
  auf die Armee führt genau dorthin). Werden sie dort gestellt, kämpfen sie mit halber Stärke und ohne
  Fernkampf; danach setzen sie das Ein- bzw. Ausschiffen fort (die Wartezeit beginnt neu).
- Stadteinnahme: Erobert wird erst, wenn in der Stadt keine Verfeindeten mehr gegeneinander stehen. Stehen
  dann mehrere Angreifer (untereinander nicht im Krieg) dort, erobert die stärkste verbliebene
  Landstreitmacht; die anderen bleiben stehen und können ohne Krieg abziehen.
- Krieg beim Marsch: Die Kriegserklärung (mit Rückfrage) ist nur nötig, wenn das Ziel eine Stadt einer
  Nation im Frieden ist oder der Weg zwingend durch eine ihrer Städte führt. Wege und Wegpunkte in ihrem
  Gebiet und der Abzug von dort sind frei; Begegnungen mit ihren Armeen an Land lösen weiterhin Kampf aus.
  Ein Marsch zu einem Wegpunkt hinter der letzten eigenen Stadt läuft bis dorthin durch (früher blieb die Armee
  in dieser Stadt stehen). Eisenbahngeschütze fahren nur auf intakten Schienen, sonst nach denselben Regeln wie alle
  Truppen (Vorgabe): eigene und mit Durchmarschrecht mit vollem Tempo, beim Kriegsgegner und im Frieden (dort mit
  Kriegserklärung beim Eintreffen) halb so schnell (`enemyRailFactor`); ein Wegpunkt jenseits des befahrbaren
  Bahnnetzes wird bis knapp vor die Grenze angefahren (`roadLimit`).
  Beschädigte Schienen (Reparatur nötig) sind nicht befahrbar und werden nicht gezeichnet; ein Eisenbahngeschütz
  in einer Provinz mit beschädigter Eisenbahn (auch mitten auf der Strecke) steht fest, bis sie repariert ist.
- Fernkampf auf verborgene Ziele (Festung ab Stufe 2): Geschosse und Einschläge sind trotzdem zu sehen, sie
  schlagen am Ort des Ziels ein, ohne dessen Nadel zu zeigen.
- Kampfwerte (Vorgabe): Infanterie 1 (× 1,2 × Moral, also höchstens 1,2), in eigenen Provinzen +10 %;
  Maschinen haben in Angriff und Verteidigung denselben Wert: Panzerwagen 2, Artillerie 1,5, Panzer 4,
  Eisenbahngeschütz 3, Schlachtschiff 6 (auch Fernkampfschaden je Einheit). Artillerie und
  Eisenbahngeschütze kämpfen im Nahkampf mit halbem Wert, Schlachtschiffe voll.
- Nahkampf (Vorgabe): je Armee kämpfen die stärksten Einheiten vorne (Panzer, Panzerwagen, dann Infanterie,
  Artillerie und Eisenbahngeschütze mit halbem Wert zuletzt). Platz 1–20 zählt voll, Platz 21–50 linear weniger
  ((51 − Platz)/31), ab Platz 51 nichts – höchstens 35 „volle“ Einheiten. Fernkampf hat keine Grenze.
  Treffer (Nah- und Fernkampf) werden je Einheit ausgewürfelt (jede Einheit gleich wahrscheinlich), ein
  Treffer trifft die Einheit, bis sie fällt; Infanterie schützt so teure Technik. Kämpfe auf Wegen
  beschädigen Gebäude der Provinz, in deren Gebiet gekämpft wird.
- Auf See und beim Ein-/Ausschiffen (Vorgabe): Landtruppen haben halbe Kampfkraft im Nahkampf und halbe
  Lebenspunkte (`seaFactor`, `seaHpFactor`); Schlachtschiffe sind nicht betroffen. Bestehende Wunden zählen
  dabei voll weiter (eine an Land halb verwundete Einheit fällt auf See beim nächsten Treffer).
- Nadeln: liegen Spitzen dicht beieinander, werden sie aufgefächert; Köpfe, die sich danach noch überdecken,
  werden auseinandergeschoben (die Nadel zeigt dann schräg zum Kopf).
- Lebenspunkte der Infanterie hängen wie ihre Kampfkraft von der Moral ab: 20 × 1,2 × Moral,
  also 2,4 bis 24 (20 bei 83,3 %). Angeschlagene Einheiten, deren Wunde nach einem Moralverlust über den
  Lebenspunkten liegt, fallen beim nächsten Treffer.
- Maschinen (alle Einheiten außer Infanterie) reparieren sich zum Tageswechsel um 1/7 ihrer fehlenden
  Lebenspunkte, mindestens aber 5 % der vollen, sofern sie nicht im Nahkampf stehen – so werden sie ganz heil.
- Ein-/Ausschiffen: Das Armeefenster zeigt die Restzeit. Ein Befehl in die Gegenrichtung wickelt den Vorgang
  zurück und dauert so lange, wie schon vergangen ist; ein neues Ziel in derselben Richtung braucht nur
  noch die Restzeit.
- Eisenbahn, Fabrik und Hafen sind erst ab Tag 3 baubar (`fromDay` je Gebäude in `balance.ts`), für alle Nationen.
- Zielmoral der Infanterie richtet sich nach dem Gebiet, in dem die Armee gerade ist – auch unterwegs und auf
  Wegen: im eigenen Gebiet die Moral dieser Provinz, erst nach dem Grenzübertritt in fremdes Gebiet (oder auf
  See) 50 %.
- Gebäudeschäden: Jede Stufe hat Leben (Eisenbahn, Hafen 3; Festung, Wehramt, Bauamt, Handelsposten,
  Werkstatt 1; sonst 2). Ein Treffer im Kampf (5 % je Gebäude und Stunde, auch bei Kämpfen auf Wegen) kostet
  ein Leben der obersten Stufe; ohne Leben fällt die
  Stufe weg, die darunter ist heil. Beschädigte Gebäude wirken nicht (Unterhalt läuft weiter), bis sie
  repariert sind: sofort, Kosten anteilig zu den fehlenden Leben an den Kosten der obersten Stufe (Eisenbahn
  mit 1/3 Leben: 2/3 des Preises), nicht solange Feinde in der Stadt stehen. Die KI repariert selbst.
- Grundmoral der Provinzen 80 %. Börse: Höchstpreis 1000 je Einheit.
- Kampfanzeige (Karte, Armeefenster) nach dem tatsächlichen Ort, nicht dem nächsten Knoten.
- KI-Angriffe: Feindliche Provinzen greift die KI erst ab einer Stärke von etwa 10 Infanteristen an
  (`MIN_STRIKE` in `ai.ts`). Ist die Zielprovinz nicht einsehbar oder verbirgt eine Festung die Truppen,
  rechnet sie mit der üblichen Besatzung (10 Infanterie); die Schadensminderung der Festung erhöht die
  nötige Überlegenheit. Zu kleine Überschüsse sammeln sich bei der stärksten eigenen Armee an der Front.
  Messung (3 KI-Partien à 30 Tage): vernichtete Armeen 686 → 231, Kleinsttrupps (≤ 3) im Feindesland 487 → 98.
- Diplomatie: Angebote (Frieden, Durchmarschrecht, geteilte Karte) können einen Tribut (Geld, Rohstoffe) tragen,
  gezahlt erst bei Annahme; kann der Anbieter dann nicht mehr zahlen, ist das Angebot hinfällig. Die KI wertet
  Tribut zu Börsenpreisen, nimmt Frieden gegen ordentlichen Tribut auch als Stärkere an, legt eigenen
  Friedensangeboten Tribut bei, wenn sie unterlegen ist, und bietet in festgefahrenen Kriegen (ab 8 Tagen) öfter
  Frieden an. Wer den Krieg erklärt (auch beim Einmarsch), bekommt 2 Tage lang −5 % Moralziel (höchstens 5 %, auch bei
  mehreren Erklärungen; jede neue Erklärung verlängert die 2 Tage).
- KI-Nahrung: Kasernen werden bei Getreidemangel abgeschaltet (bei Überschuss wieder eingeschaltet) und nur
  bei Getreideüberschuss gebaut; der Provinzunterhalt läuft bevorzugt über Fisch (Getreide bleibt für die
  Infanterie); bei knapper Nahrung baut sie Wirtschaftsgebäude bevorzugt in Getreide- und Fischprovinzen.
  Wehrämter schaltet sie ebenso ab (jede neue Infanterie isst 18 Getreide). Messung (3 Partien, 14 Großmächte):
  Nationen ohne Getreide an Tag 10/20/30: 39/41/42 → 0/4/11 von 42; Nahrungsmangel-Tage 286/409/414 → 0/8/77;
  Infanterie an Tag 30: 17.600 → 7.000.
- KI offensiver (Vorgabe, nur Großmächte; Kleinstaaten bleiben passiv): Großmächte schalten Wehrämter nie ab
  (Kasernen weiter bei Mangel) und erobern lieber Land; knappe Besatzungen (Hinterland 1, Grenze 3, Front 4,
  Hauptstadt 6, mal Vorsicht); gegen Kleinstaaten 20 % weniger Überlegenheit nötig; neben einem laufenden
  Krieg ein zweiter gegen einen Kleinstaat; bei Nahrungsmangel doppelte Kriegslust. Messung (3 Partien,
  30 Tage): Zugewinn der Großmächte 53 → 146 Provinzen, verlorene Kleinstaaten-Provinzen 40 → 97,
  abgeschaltete Wehrämter der Großmächte 364 → 1.
- Eroberung (Vorgabe): Die Eroberer im Umkreis von 1 km rücken in die Stadt ein. Ziehen sie danach weiter
  (neuer Befehl, fortgesetzter Marsch, Verfolgung), gilt die Besatzungsregel: eine Einheit bleibt; eine
  einzelne letzte Einheit bleibt ganz, ihr Befehl verfällt.
- Ein-/Ausschiffen: Die Restzeit steht auch auf der Karte als Schild unter dem Nadelkopf, für eigene und sichtbare
  fremde Armeen.
- Provinzübersicht im Vollbild (Knopf „Provinzen“): je eigene Provinz Ertrag, Moral, Gebäude als Bilder (Stufe,
  abgeschaltet grau, beschädigt rot), Schalter für Wehramt/Kaserne/Eisenbahn, Bauen und Technik in Auftrag geben;
  unten „Überall Wehrämter bauen“ sowie alle Kasernen aktivieren/deaktivieren (`ProvinceOverview.tsx`).
- Wirtschaft (Vorgabe, neu): Rohstoffertrag je Provinz 3150 pro Tag bei 100 % Moral (Doppelprovinz 6300),
  Grundbedarf je Provinz 800 pro Kategorie (Nahrung, Baustoffe, Energie) und Tag. Geld je Provinz 1600
  (Doppelprovinz 3200).
- Moral (Vorgabe, neu): Grundwert 85 %, Entfernung zur Hauptstadt −1 % je 100 km ab 300 km (höchstens −30 %),
  +1 % je angrenzender eigener Provinz mit mindestens 91 % Moral, Bauamt +2 %, +3 % bei eigenen Truppen mit
  mehr als 20 Stärke in der Stadt.
- Gebäude: Kaserne Unterhalt 1000 Getreide und 1000 Geld je Stufe; Wehramt Bauzeit 10 min, Unterhalt 500 Geld.
- Infanterie-Rekrutierung bei 100 % Moral: nur Wehramt 32 h, mit Kaserne 21 h, Kaserne Stufe 2 16 h; Kaserne
  ohne Wehramt halb so schnell; die Moral wirkt anteilig, Doppelprovinzen stellen doppelt so schnell auf.
- Leistung (Vorgabe: flüssiger bei hohem Tempo): Die Simulation rechnet die Wirtschaftsraten nur noch neu,
  wenn sich Wirtschaftliches ändert (Gebäude, Einheitenzahl, Besitz, Regler, Tageswechsel) und sonst einmal je
  Spielstunde – nicht mehr bei jeder Bewegung; die KI-Befehle einer Stunde werden gesammelt, danach einmal
  neu gerechnet. Die Wegsuche der KI endet bei ihrer Reichweite (72 h). Ankunft an einer umkämpften Stadt:
  angehalten wird am Rand des 1-km-Umkreises nur, wenn von dort ein Gegner in Reichweite ist (sonst hing die
  Armee in einer Schleife aus Anhalten und Weiterziehen fest). Die Karte speichert Grund (Meer, Flächen,
  Papier, Vignette), Nebel und Linien (Grenzen, Rahmen, Wege) als Ebenen und zeichnet sie nur bei geänderter
  Ansicht, Besitz oder Sicht neu; je Bild bleiben Armeen, Symbole und Geschosse (gemessen im Spiel Tag 44:
  etwa 10 ms je Bild statt rund 70–80 ms für ein komplettes Neuzeichnen).
- Verbrauchsregler (Vorgabe): 2-%-Schritte; bei Kategorien mit drei Rohstoffen (Energie) lässt sich ein Regler
  sperren – Änderungen gleichen dann nur die beiden anderen aus (Bedienhilfe, nicht gespeichert). Fokus je
  Kategorie (`consumptionFocus`, Aktion `setConsumptionFocus`): die anderen Rohstoffe tragen so viel
  Provinzunterhalt, wie ihr laufender Überschuss (Produktion minus fester Verbrauch) hergibt, nie ins Minus; der
  Fokus-Rohstoff zahlt nur den Rest (reicht die Kategorie insgesamt nicht, trägt er den Fehlbetrag). Die
  Simulation stellt den Regler stündlich und sofort nach dem Setzen ein; ohne Fokus gilt der Regler von Hand.
- Kampfmoral-Varianten: im Spielstand wählbar (`combatMorale`). Vorgabe ist Mechanik 2 mit Übermacht
  (`DEFAULT_COMBAT_MORALE`, gilt auch für Spielstände ohne das Feld); Mechanik 1 (`TROOP_MORALE`) nur noch mit
  `combatMorale: 1`. Mechanik 2 (`COMBAT_MORALE_V2`):
  im Kampf je Runde −2,5 % (Nahkampf, beschossen, Fernkampf gegen Fernkampf), Beschuss zusätzlich zum Nahkampf
  oder eine zweite gegnerische Armee −1,5 %, höchstens −4 %; Zuwachs 1/2/3 Punkte je Abschuss, Punkt 4 und 5 je
  zwei Abschüsse (abgerundet), höchstens +5 %; jede vernichtete Einheit zählt als ein Abschuss (Maschinen zählten
  zuerst doppelt, auf Vorgabe zurückgenommen).
  Vergleich ohne Browser: `npm run morale:compare -- <Läufe> <Partien> <Tage>`.
- Übermacht im Nahkampf (Vorgabe, `SUPERIORITY`, im Spielstand abschaltbar über `superiority: false`, Standard an):
  Je Schlacht (zusammenhängende Gruppe im Nahkampf) zählt jede Armee die Einheiten ihrer Seite (sie und alle, mit
  denen sie nicht im Krieg ist) gegen alle Gegner der Schlacht – nach Anzahl, nicht nach Stärke. Mindestens doppelt
  so viele und mindestens 8 Einheiten mehr: +0,5 Prozentpunkte Moral je Runde; umgekehrt (höchstens halb so
  viele, mindestens 8 weniger): −0,3 Punkte – zusätzlich zu und außerhalb der Rundengrenzen der Kampfmoral (die Moral bleibt in 10–100 %). Vergleich der Varianten in
  `plans/kampfmoral-vergleich.md` (`npm run morale:compare`).
