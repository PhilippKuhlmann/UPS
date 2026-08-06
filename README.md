# ups-nut

[![CI](https://github.com/PhilippKuhlmann/UPS/actions/workflows/ci.yml/badge.svg)](https://github.com/PhilippKuhlmann/UPS/actions/workflows/ci.yml)

Web-Dashboard für USV-Geräte, die an einem **NUT-Server** (Network UPS Tools) hängen.
Die App spricht das NUT-Netzwerkprotokoll direkt über TCP 3493 — es muss kein
`upsc`, kein NUT-Client und kein Zusatzpaket auf dem Host installiert sein.

## Was drin ist

- **Anmeldung** — die Oberfläche und die gesamte API sind hinter einem Login.
  Beim ersten Start entsteht `admin` / `admin`; dieses Passwort muss beim ersten
  Login ersetzt werden, vorher antwortet nichts anderes. Später lässt es sich
  jederzeit unter „Konto" ändern; alle anderen Sitzungen enden dabei.
- **USV-Server über die Oberfläche** — unter „Server" lassen sich NUT-Server
  anlegen, bearbeiten, pausieren und entfernen. „Verbindung testen" zeigt vor dem
  Speichern, welche USV der Server meldet. Änderungen greifen sofort, ohne
  Neustart.
- **Eine einzige Datenbank** — Messwerte, Ereignisse, Serverliste, Konten und
  Sitzungen liegen zusammen in einer SQLite-Datei.

- **Live-Dashboard** — pro Gerät ein Einliniendiagramm (Netz → USV → Last, Batterie
  darunter). Der stromführende Pfad ist animiert: fällt das Netz aus, geht die
  Netzleitung tot und die Batterieleitung speist nach oben. Dazu Ladezustand, Last,
  Restlaufzeit und Eingangsspannung.
- **Verlauf** — jede Abfrage landet in SQLite, Diagramme für Ladezustand,
  Restlaufzeit, Last, Wirkleistung, Ein- und Batteriespannung sowie Temperatur.
  Zeiträume von 1 Stunde bis 30 Tagen, jeweils mit Fadenkreuz, Tooltip und
  Tabellenansicht.
- **Alarme** — zehn Regeln (Batteriebetrieb, Batterie kritisch, Ladezustand,
  Restlaufzeit, Überlast, Batteriewechsel, Bypass, Temperatur, Abschaltung,
  Verbindungsverlust). Jede Regel meldet sich einmal beim Auftreten und einmal beim
  Ende; alles landet im Ereignisprotokoll und optional auf einem Webhook.
- **Alle Variablen & Steuerung** — vollständige NUT-Variablenliste mit Filter,
  `INSTCMD`-Befehle (Signalton, Batterietest, …) und Schreiben beschreibbarer
  Variablen. Befehle, die Strom wegnehmen, brauchen einen zweiten Klick.
- Mehrere NUT-Server gleichzeitig, tastaturbedienbar, mobiltauglich.

## Aussehen

Die Oberfläche übernimmt die visuelle Linie von [dokuvault.de](https://dokuvault.de):
dunkle Blaugrau-Flächen, ein einziges kräftiges Signalblau, 46-px-Blueprint-Raster,
Space Grotesk für Überschriften, Inter für Fließtext, IBM Plex Mono für Messwerte.
Wie dort gibt es nur das dunkle Schema.

Das Raster liegt hinter dem Einliniendiagramm — für einen Schaltplan genau das
richtige Papier. Die Schriften liegen unter `public/fonts/` lokal bei (rund 91 KB,
SIL Open Font License), damit nichts von externen Servern nachgeladen wird.

Die Farben der Verlaufsdiagramme sind gegen die Panelfläche geprüft
(Helligkeitsband, Chroma, Farbfehlsichtigkeit, Kontrast) und bewusst von den
Zustandsfarben getrennt, damit „grün" im Diagramm nie mit „alles in Ordnung"
verwechselt wird.

## Schnellstart

```bash
npm install
cp .env.example .env   # NUT_HOST optional vorbelegen
npm run dev
```

Dann http://localhost:8080 öffnen und mit **admin / admin** anmelden. Die App
verlangt sofort ein eigenes Passwort. Danach unter „Server" den NUT-Server
eintragen — falls er nicht schon per `.env` vorbelegt wurde.

Ohne echte Hardware zum Ausprobieren:

```bash
npm run mock-nut
```

Der Mock-Server simuliert zwei USV-Geräte auf Port 3493 (per `MOCK_PORT`
änderbar) und schaltet gelegentlich auf Batteriebetrieb, damit Alarme, Diagramm
und Verlauf sichtbar werden. Die mitgelieferte `.env` zeigt bereits darauf.

Produktivbetrieb ohne Container:

```bash
npm run build && npm start
```

## Docker

```bash
docker compose up -d
```

Das genügt: der Container startet auch ohne konfigurierten NUT-Server, danach
meldest du dich auf Port 8080 an und legst den Server unter „Server" an.

Wer vorbelegen will, legt eine `.env` neben die Compose-Datei — alle Variablen
aus `.env.example` werden durchgereicht. Für den unbeaufsichtigten Betrieb lohnt
sich `ADMIN_PASSWORD`, dann entfällt der erzwungene Passwortwechsel:

```ini
NUT_HOST=192.168.29.113
ADMIN_PASSWORD=ein-langes-passwort
HOST_PORT=8080
```

Die gesamte Datenbank liegt im Volume `ups-nut-data` unter `/data` und übersteht
Updates. Steht ein Reverse Proxy mit HTTPS davor, `SESSION_COOKIE_SECURE=1`
setzen.

Das Image baut in zwei Stufen: die erste bringt die Toolchain für `better-sqlite3`
mit, die zweite enthält nur Laufzeit, `dist/` und `public/` und läuft als
Benutzer `node`. Ein Healthcheck fragt `/healthz` ab.

Der Build wird bei jedem Push auf `main` von GitHub Actions gebaut, gestartet und
geprüft (`/healthz`, Anmeldesperre, Login, Oberfläche, Serververwaltung) —
siehe [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Konfiguration

Alle Werte kommen aus Umgebungsvariablen; eine `.env` im Projektverzeichnis wird
beim Start eingelesen. Vollständige Liste mit Erklärungen: `.env.example`.

Die NUT-Server selbst stehen **nicht** in der Konfiguration, sondern in der
Datenbank; die folgenden `NUT_*`-Variablen belegen sie nur beim allerersten
Start vor. Danach zählt die Oberfläche.

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `NUT_HOST` | — | Adresse des NUT-Servers, nur zur Vorbelegung |
| `NUT_PORT` | `3493` | Port von `upsd` |
| `NUT_NAME` | = `NUT_HOST` | Anzeigename, wird Teil jeder Geräte-ID |
| `NUT_USERNAME` / `NUT_PASSWORD` | — | nur für Befehle und Schreibzugriffe nötig |
| `NUT_SERVERS` | — | JSON-Array statt der Einzelvariablen, für mehrere Server |
| `ADMIN_PASSWORD` | — | Startpasswort statt `admin`; unterdrückt die erzwungene Änderung |
| `SESSION_TTL_HOURS` | `336` | Gültigkeit einer Sitzung |
| `SESSION_COOKIE_SECURE` | `0` | auf `1` setzen, wenn die App hinter HTTPS läuft |
| `AUTH_ENABLED` | `1` | auf `0` nur, wenn etwas davor bereits authentifiziert |
| `PORT` / `BIND_HOST` | `8080` / `0.0.0.0` | Webserver |
| `POLL_INTERVAL_MS` | `5000` | Abfrageintervall |
| `HISTORY_RETENTION_DAYS` | `30` | Aufbewahrung von Messwerten und Ereignissen |
| `DB_PATH` | `./data/ups.db` | SQLite-Datei |
| `ALERT_CHARGE_BELOW` | `30` | Schwelle Ladezustand in % |
| `ALERT_LOAD_ABOVE` | `85` | Schwelle Last in % |
| `ALERT_RUNTIME_BELOW_SECONDS` | `300` | Schwelle Restlaufzeit |
| `ALERT_TEMPERATURE_ABOVE` | `45` | Schwelle Temperatur in °C |
| `ALERT_WEBHOOK_URL` | — | Ziel für Alarm-Benachrichtigungen |

### UniFi SmartPower UPS 2U

Die UniFi UPS 2U bringt selbst einen NUT-Server mit (`upsd 2.8.0`, Gerät `ups01`)
und lässt sich ohne Zusatzsoftware direkt eintragen:

```ini
NUT_HOST=192.168.29.113
NUT_PORT=3493
NUT_NAME=unifi
```

Sie liefert Ladezustand, Last, Restlaufzeit, Ein- und Ausgangsspannung, Wirk- und
Scheinleistung, Leistungsfaktor, Temperatur sowie Ergebnis und Datum des letzten
Batterietests. Angebotene Befehle: `load.on`, `load.off`, `shutdown.reboot`,
`test.battery.start`. Beschreibbare Variablen bietet sie keine.

### Was in der Datenbank liegt

Eine einzige SQLite-Datei (`DB_PATH`, im Container `/data/ups.db`) mit sechs
Tabellen: `samples` (Messwerte), `events` (Alarmprotokoll), `nut_servers`
(Serverliste), `users`, `sessions` und `sqlite_sequence`.

Zwei Dinge dazu, offen gesagt:

- **Konto-Passwörter** liegen als scrypt-Hash mit eigenem Salt vor, Sitzungen
  nur als SHA-256 des Tokens. Ein Blick in die Datei gibt also weder Passwort
  noch gültige Sitzung her.
- **NUT-Passwörter liegen im Klartext.** Sie müssen im Original an `upsd`
  geschickt werden, ein Hash hilft dort nicht. Das ist dieselbe Lage wie bei
  einer `.env` oder `upsmon.conf` — die Datenbankdatei gehört entsprechend
  geschützt (im Container liegt sie in einem eigenen Volume, nur für den
  Benutzer `node` lesbar).

Wer alles zurücksetzen will, löscht die Datei: beim nächsten Start entstehen
Konto und Serverliste neu.

### Rechte auf dem NUT-Server

Lesen funktioniert bei üblicher `upsd.conf` ohne Anmeldung. Für `INSTCMD` und
`SET VAR` braucht es einen Benutzer in `upsd.users`:

```ini
[monuser]
    password = geheim
    actions = SET
    instcmds = ALL
```

Fehlen die Rechte, antwortet der NUT-Server mit `ACCESS-DENIED`; die App zeigt
das direkt am Befehl an.

### Webhook

Bei jedem Beginn und Ende eines Alarms geht ein `POST` mit JSON an
`ALERT_WEBHOOK_URL`:

```json
{
  "device": "nas/rack",
  "model": "5PX 1500",
  "rule": "on_battery",
  "title": "Batteriebetrieb",
  "state": "raised",
  "severity": "serious",
  "message": "Netzstrom ausgefallen — Gerät läuft auf Batterie",
  "value": 96,
  "status": "OB DISCHRG",
  "timestamp": "2026-08-05T18:30:32.664Z"
}
```

Das passt direkt auf Home-Assistant-Webhooks, ntfy oder Gotify.

## HTTP-API

Die Oberfläche nutzt ausschließlich diese Endpunkte — sie eignen sich genauso für
eigene Automatisierungen. `:server` und `:ups` sind die beiden Teile der
Geräte-ID.

Alles außer `/api/auth/session`, `/api/auth/login` und `/api/auth/logout`
verlangt ein gültiges Sitzungs-Cookie.

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `POST` | `/api/auth/login` · `/api/auth/logout` | Anmelden, abmelden |
| `GET` | `/api/auth/session` | aktueller Anmeldestand |
| `POST` | `/api/auth/password` | Passwort ändern (beendet alle anderen Sitzungen) |
| `GET` | `/api/servers` | NUT-Server, ohne Passwörter |
| `POST` | `/api/servers/test` | Verbindung probeweise aufbauen, gefundene USV zurückgeben |
| `POST` · `PATCH` · `DELETE` | `/api/servers` · `/api/servers/:id` | anlegen, ändern, entfernen |
| `GET` | `/api/state` | Geräte, aktive Alarme und Konfiguration in einem Aufruf |
| `GET` | `/api/devices` | alle Geräte |
| `GET` | `/api/devices/:server/:ups` | ein Gerät samt aller Variablen |
| `GET` | `/api/devices/:server/:ups/history?range=6h` | Verlauf (`1h`…`30d`, oder `from`/`to` in ms) |
| `POST` | `/api/devices/:server/:ups/command` | `{"command":"beeper.disable"}` |
| `POST` | `/api/devices/:server/:ups/variable` | `{"name":"ups.delay.start","value":"30"}` |
| `GET` | `/api/events?limit=100` | Ereignisprotokoll |
| `POST` | `/api/events/:id/ack` · `/api/events/ack-all` | Ereignisse bestätigen |
| `GET` | `/healthz` | Healthcheck |

Zusätzlich schiebt `WS /ws` nach jeder Abfrage einen vollständigen Snapshot und
jedes neue Ereignis an alle offenen Browser.

## Aufbau

```
src/
  nut/protocol.ts   Tokenizer und Antwort-Parser des NUT-Protokolls
  nut/client.ts     TCP-Verbindung, Befehlswarteschlange, LIST/GET/INSTCMD/SET
  poller.ts         Abfrageschleife, wandelt NUT-Variablen in Snapshots
  alerts.ts         Regelwerk, Zustandsübergänge, Webhook
  auth.ts           Passwort-Hashing, Sitzungen, Sperre nach Fehlversuchen
  store.ts          SQLite: Messwerte, Ereignisse, Serverliste, Konten
  api.ts            REST-Endpunkte
  server.ts         HTTP, Websocket, Aufräumen
  tools/mock-nut-server.ts   simulierter upsd für die Entwicklung
public/
  js/diagram.js     Einliniendiagramm
  js/chart.js       Zeitreihendiagramm als reines SVG
  js/gate.js        Anmeldung und Passwortwechsel
  js/servers.js     Serververwaltung
  js/app.js         Ansichten und Routing
```

Keine Frontend-Abhängigkeiten und keine externen Ressourcen: die Oberfläche läuft
vollständig offline im lokalen Netz.
