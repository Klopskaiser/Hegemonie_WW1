# Externe Entscheidungsmodelle

Jede Nation wird von genau einem Entscheider gesteuert: **Spieler**, **eingebaute KI** oder
**extern**. Externe Modelle sehen dieselbe Beobachtung wie die KI (Nebel des Krieges inklusive)
und schicken dieselben Aktionen, die auch die Oberfläche verwendet. Es gibt zwei Wege:

| Weg | Wofür | Start |
|---|---|---|
| **WebSocket** | laufendes Browserspiel, Echtzeit | Modell als Server starten, im Spiel *Steuerung → Verbinden* |
| **Headless (stdio)** | Training, Auswertung, beliebig schnell | `npx tsx scripts/headless.ts stdio --agents DE` |

Typdefinitionen (maßgeblich): `src/game/bridgeProtocol.ts` (Nachrichten, Kartenübersicht),
`src/game/controller.ts` (`Observation`), `src/game/actions.ts` (`Action`).

## Grundbegriffe

- **Knoten**: `0..P-1` sind Provinzen, `P..P+S-1` Seegebiete (`P = map.provinceCount`).
  Armeen stehen auf Knoten; `move` hat einen Knoten als Ziel.
- **Zeit**: Millisekunden Spielzeit seit Spielbeginn (1 Spieltag = 86 400 000).
- **Zufall** kommt ausschließlich aus dem Spielstand; gleicher Seed + gleiche Aktionen = gleicher Verlauf.

## Beobachtung (`Observation`)

| Feld | Inhalt |
|---|---|
| `time`, `nation` | Spielzeit, beobachtende Nation |
| `stock`, `ratesPerDay` | Vorräte und Tagesbilanz je Rohstoff (Produktion − fester Unterhalt − Anteil am Provinzunterhalt) |
| `consumption`, `provinceUpkeep` | Verbrauchsregler (Prozent je Rohstoff, je Kategorie Summe 100); Provinzunterhalt je Kategorie und Tag |
| `enemies`, `relations` | Kriegsgegner; Beziehung zu jeder Nation (`war`, `embargo`, `peace`, `rightOfWay`, `sharedMap`) |
| `proposals`, `peaceOffers` | eingegangene Angebote (`{from, kind}`), Friedensangebote |
| `points`, `alive` | Siegpunkte (Stand letzter Tageswechsel), lebende Nationen |
| `offers` | Börsenangebote, mit denen gehandelt werden darf, und die eigenen |
| `provinces[]` | Besitzer, Sichtbarkeit, Rohstoff, Nachbarn, Seegebiete; nur eigene: Moral, Gebäude, Bau, Bauschleife, Fertigung |
| `armies[]` | sichtbare Armeen mit Einheiten; eigene zusätzlich `to` (Marschziel) und `target` (Fernkampfziel) |

## Aktionen (`Action`)

```jsonc
{"type":"build","province":12,"building":"factory"}      // railroad, harbor, fortress, factory, manufactory, barracks, recruitment, office
                                                         // läuft schon ein Bau: kommt in die Bauschleife (bezahlt beim Start)
{"type":"cancelBuild","province":12}                     // laufenden Bau abbrechen (Kosten kommen ganz zurück)
{"type":"dequeueBuild","province":12,"index":0}          // geplantes Gebäude aus der Bauschleife nehmen
{"type":"enqueue","province":12,"unit":"tank"}           // artillery, armoredCar, tank, railgun, battleship (Infanterie entsteht automatisch)
{"type":"dequeue","province":12,"index":0}
{"type":"setRepeat","province":12,"repeat":true}
{"type":"switchBuilding","province":12,"building":"barracks","on":false}   // Kaserne/Wehramt/Eisenbahn abschalten: kein Unterhalt, keine Wirkung
{"type":"moveCapital","province":12}                     // Hauptstadt verlegen (20000 Geld, je 5000 Holz/Eisen/Getreide/Kohle, 48 h)
{"type":"cancelCapitalMove"}                             // Verlegung abbrechen (Kosten kommen ganz zurück)
{"type":"move","army":57,"to":180}                       // Provinz oder Seegebiet; Landungen werden automatisch geplant
{"type":"stop","army":57}
{"type":"attack","army":57,"target":91}                  // Angriff mit Verfolgung (Fernkampf bis in Reichweite), null hebt auf
{"type":"setMarch","army":57,"forced":true,"aggressive":true} // Gewaltmarsch, Angriffsmarsch
{"type":"split","army":57,"units":{"infantry":3}}        // diese Einheiten bleiben als neue Armee stehen
{"type":"merge","army":58,"into":57}
{"type":"rename","army":57,"name":"SMS Kiel"}            // eigener Name, leer = automatisch
{"type":"declareWar","nation":"FR"}
{"type":"downgrade","nation":"FR","to":"embargo"}
{"type":"propose","nation":"FR","kind":"peace"}          // peace, rightOfWay, sharedMap
{"type":"propose","nation":"FR","kind":"peace","tribute":{"money":20000,"coal":5000}}   // mit Tribut, gezahlt bei Annahme
{"type":"answer","nation":"FR","accept":true}
{"type":"postOffer","side":"sell","res":"coal","amount":1000,"price":2}
{"type":"cancelOffer","id":4}
{"type":"acceptOffer","id":4,"amount":500}
{"type":"setConsumption","category":"energy","shares":{"coal":30,"oil":0,"gas":70}}   // food: grain/fish, materials: iron/lumber
```

Jede Aktion liefert `{"ok":true}` oder `{"ok":false,"error":"…"}`.

## WebSocket

Das **Modell ist der Server**, das Spiel verbindet sich (Standard `ws://127.0.0.1:8765`).
Ablauf:

1. Im Spiel *Steuerung* (⚙) öffnen, Nationen auf **Extern** stellen, Adresse eintragen, *Verbinden*.
2. Das Spiel sendet `hello` mit Spieldaten, extern gesteuerten Nationen und der Kartenübersicht.
3. Jede **Spielstunde** kommt je extern gesteuerter Nation ein `observe`.
4. Das Modell antwortet jederzeit mit `actions`; sie werden **sofort** ausgeführt, je Aktion kommt ein `result`.

| Richtung | Nachricht |
|---|---|
| Spiel → Modell | `{"type":"hello","protocol":1,"game":{…},"nations":["FR"],"map":{…}}` |
| Spiel → Modell | `{"type":"controllers","nations":["FR","IT"]}` (Zuordnung geändert) |
| Spiel → Modell | `{"type":"observe","nation":"FR","obs":{…}}` |
| Spiel → Modell | `{"type":"result","nation":"FR","ref":…,"action":{…},"result":{"ok":true}}` |
| Spiel → Modell | `{"type":"error","message":"…"}` |
| Modell → Spiel | `{"type":"actions","nation":"FR","actions":[…],"ref":"beliebig"}` |
| Modell → Spiel | `{"type":"observe","nation":"FR"}` (Beobachtung sofort anfordern) |

Ohne Verbindung (auch während der Nachsimulation beim Öffnen eines Spielstands) entscheidet die
eingebaute KI für extern gesteuerte Nationen. Bricht die Verbindung ab, versucht das Spiel alle
5 Sekunden, sie wiederherzustellen. Die Adresse wird im Spielstand gespeichert.

Beispiel: `npm run model:example` startet ein einfaches Regelmodell (`scripts/example-model.ts`).

## Headless (stdin/stdout)

`npx tsx scripts/headless.ts stdio --agents DE,FR [--seed 1] [--step-hours 6] [--max-days 120] [--difficulty normal]`

Eine JSON-Zeile je Nachricht. Agenten-Nationen handeln **nur** über `step`; alle anderen führt die
eingebaute KI.

```text
-> {"type":"ready","agents":["DE"],"stepHours":6,"maxDays":120,"map":{…}}
<- {"cmd":"reset","seed":7}
-> {"type":"reset","obs":{"DE":{…}}}
<- {"cmd":"step","actions":{"DE":[{"type":"build","province":3,"building":"railroad"}]}}
-> {"type":"step","obs":{…},"reward":{"DE":0.4,…},"done":false,"info":{"day":1,"results":{"DE":[{"ok":true}]},"score":{…},"provinces":{…},"winner":null}}
<- {"cmd":"close"}
```

`reward` ist der Zuwachs des laufenden Punktestands (Provinzwerte wie beim Tageswechsel) seit
dem letzten Schritt. `done` wird wahr bei Sieg, Untergang aller Agenten oder nach `maxDays`.

Python-Beispiel:

```python
import json, subprocess

p = subprocess.Popen(["npx", "tsx", "scripts/headless.ts", "stdio", "--agents", "DE"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, shell=True)
send = lambda m: (p.stdin.write(json.dumps(m) + "\n"), p.stdin.flush())
recv = lambda: json.loads(p.stdout.readline())

ready = recv()
send({"cmd": "reset", "seed": 1}); obs = recv()["obs"]
done = False
while not done:
    send({"cmd": "step", "actions": {"DE": []}})   # hier das Modell entscheiden lassen
    r = recv(); obs, done = r["obs"], r["done"]
send({"cmd": "close"})
```

## Batch und Aufzeichnung

`npx tsx scripts/headless.ts batch --games 4 --days 60 --seed 1 --record runs.jsonl [--obs]`

Reine KI-Partien hintereinander mit Zusammenfassung. `--record` schreibt jede KI-Entscheidung als
JSON-Zeile (`{game, seed, time, nation, actions}`), mit `--obs` zusätzlich die Beobachtung
(groß: rund 20 KB je Eintrag), am Partieende eine Zeile `final`. Geeignet als Datengrundlage für
Imitationslernen.
