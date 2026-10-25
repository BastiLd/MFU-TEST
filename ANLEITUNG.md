# ⚓ WebHafen — dein eigenes Website-Hosting mit Dashboard

WebHafen ist eine Docker-App, mit der du ganz einfach Websites hostest — statische Seiten (HTML/CSS/JS, z. B. dein MFU-TEST-Projekt) genauso wie PHP-Seiten (z. B. die Montrigor-Website, die beim ersten Start **automatisch importiert** wird).

Jede Website bekommt einen eigenen Port, einen **📊-Dashboard-Button** mit echten Analytics (Besucher, Aufrufe, Live-Ansicht, meistbesuchte Seiten, Referrer, Geräte, Status-Codes, Uhrzeiten, Antwortzeiten, Traffic), einen Dateimanager mit ZIP-Upload, Drag-&-Drop und eingebautem Text-Editor — und alles hinter einem Passwort-Login.

---

## 1. Schnellstart (Windows mit Docker Desktop)

Docker Desktop muss installiert sein und laufen. Dann in PowerShell:

```powershell
cd "C:\Users\basti\Nextcloud\Documents\Github\Webhafen"
docker compose up -d --build
```

Danach im Browser: **http://localhost:8010**
Passwort: steht in der `.env`-Datei (`ADMIN_PASSWORD`) — **bitte gleich ändern!**

Die Montrigor-Website wird beim ersten Start automatisch importiert und läuft dann auf **http://localhost:8011** (Erster Aufruf: `http://localhost:8011/install.php`, falls die Datenbank noch leer ist).

## 2. Ports ändern (weil bei dir viele belegt sind)

Alles zentral in der Datei `.env`:

```
PORT_UI=8010            ← Verwaltungs-Oberfläche
PORT_SITES_START=8011   ← Website-Bereich Anfang
PORT_SITES_END=8043     ← Website-Bereich Ende
```

Nach jeder Änderung: `docker compose up -d --build`

## 3. ZimaOS — fertiges Image installieren oder aktualisieren

WebHafen wird vom GitHub-Workflow als fertiges Image unter `ghcr.io/bastild/webhafen:latest` veröffentlicht. Die Datei `docker-compose.zimaos.yml` benutzt dieses Image und baut auf ZimaOS nichts selbst. Nach einem erfolgreichen Build unter [GitHub Actions](https://github.com/BastiLd/MFU-TEST/actions/workflows/webhafen-image.yml) ist das neue Image abrufbar. Den Registry-Wechsel in ZimaOS und den alternativen Import eines lokalen Docker-Archivs beschreibt [UPDATE-ZIMAOS.md](UPDATE-ZIMAOS.md).

**Bestehende Installation aktualisieren:** In Portainer den WebHafen-Container mit **Pull latest image / Re-pull image** neu erstellen oder den Stack aktualisieren. Den bisherigen Daten-Mount auf `/data`, alle Ports, `ADMIN_PASSWORD` und `APP_SECRET` beibehalten. Deine Websites, Statistiken und Tailscale-Verbindungen liegen unter `/data` und bleiben erhalten. Der Schlüssel `APP_SECRET` wird auch zum Verschlüsseln des gespeicherten Tailscale-Auth-Keys verwendet. Ist noch ein mitgelieferter Beispielwert gesetzt, vor dem ersten Verknüpfen einmalig einen eigenen langen Zufallstext setzen; danach beibehalten.

**Neue Installation:** Portainer → Stacks → Add stack → Web editor; Inhalt von `docker-compose.zimaos.yml` einfügen. Unter Environment variables `ADMIN_PASSWORD` und `APP_SECRET` setzen; Datenpfad und Ports an die Zima anpassen. Danach **Deploy the stack** und `http://ZIMA-IP:8010` öffnen. Der optionale Seed-Mount wird nur für einen ersten Montrigor-Import benötigt.

Mit SSH und Docker Compose lautet das Update:

```sh
docker compose -f docker-compose.zimaos.yml pull
docker compose -f docker-compose.zimaos.yml up -d
```

Ein lokales, noch nicht veröffentlichtes Image lässt sich als Docker-Archiv importieren. Den konkreten Export und die Schritte dafür beschreibt [UPDATE-ZIMAOS.md](UPDATE-ZIMAOS.md).

Passwort ändern: Portainer → Stack `webhafen` → Environment variables → `ADMIN_PASSWORD` ändern → **Update the stack**. `APP_SECRET` dabei beibehalten.

## 4. So benutzt du WebHafen

- **＋ Neue Website** → Name eingeben, Typ wählen (Statisch oder PHP), Port automatisch oder selbst wählen → fertig. Die Seite läuft sofort mit einer Platzhalter-Seite.
- **🗂 Dateien** → ZIP hochladen (wird auf Wunsch entpackt, optional „Ordner vorher leeren“), Dateien per Drag-&-Drop reinziehen, Dateien direkt im Browser bearbeiten, umbenennen, löschen, als ZIP sichern.
- **📊 Dashboard** → pro Website: Live-Besucher, Verlauf (7/30/90 Tage), Top-Seiten, Referrer, Geräte, Status-Codes, Uhrzeiten-Verteilung, Ø Antwortzeit, Traffic. Die Daten kommen aus den Webserver-Logs — **es muss nichts in die Websites eingebaut werden.**
- **⚙ Einstellungen** → Name, Port, Typ, aktiv/pausiert, geschützte Ordner (z. B. `/data`), Backup, Löschen.
- **System** → Portübersicht (belegt/frei), erzeugte Caddy-Konfiguration, Speicherplatz.

Statische Sites sind zusätzlich (abschaltbar) unter `http://SERVER:8010/s/name/` erreichbar — praktisch, wenn du mal nur einen Port freigeben willst.

### Websites mit eigenem Backend (API-Ziel)

Manche Websites bestehen nicht nur aus Dateien, sondern brauchen ein Programm im Hintergrund — zum Beispiel, weil sie eine Datenbank lesen oder mit einem anderen Dienst sprechen müssen. WebHafen selbst führt kein Python oder Node aus, aber es kann Anfragen **weiterreichen**:

- **Feld „API-Ziel"** (bei jeder Website unter ⚙ Einstellungen): Trägst du hier z. B. `192.168.68.10:8090` ein, gehen alle Aufrufe, die mit `/api/` beginnen, an diese Adresse. Alles andere bleibt normale Datei-Auslieferung.
- **Typ „Weiterleitung"**: Der komplette Port geht an die andere Anwendung, es werden gar keine Dateien mehr ausgeliefert.

Der große Vorteil des API-Ziels: Oberfläche und Backend laufen unter **derselben Adresse**. Dadurch entfallen die typischen Browser-Probleme (CORS, gemischte Inhalte), und du musst nur **einen** Port freigeben statt zwei.

Erlaubt sind nur Adressen der Form `name:port` oder `http(s)://name` — alles andere wird abgewiesen, damit nichts Fremdes in die Webserver-Konfiguration gelangt.

## 5. Website-Dateien direkt aus GitHub aktualisieren

Unter **Website → Einstellungen → GitHub · Website-Updates** kannst du den ZIP-Upload durch eine GitHub-Verbindung ersetzen. Die kleinen **i**-Schaltflächen erklären die einzelnen Felder.

1. **GitHub-Konto / Organisation**, **Repository** und **Branch** eintragen. Die Schaltflächen **Laden** zeigen verfügbare Repositories und Branches an; Namen lassen sich auch direkt eingeben.
2. Den **Website-Ordner** wählen, beispielsweise `server/public` oder `website/dist`. WebHafen übernimmt dessen **Inhalt** direkt in das bestehende Website-Verzeichnis. Optional einzelne Dateien oder Unterordner auswählen. Ein leerer Ordnerpfad bedeutet das Repository-Hauptverzeichnis, eine leere Dateiauswahl den gesamten gewählten Website-Ordner.
3. **Verbindung speichern & prüfen** drücken. Das speichert die Quelle und prüft den Branch, ändert aber noch keine Website-Dateien. Unter **Ordner und Dateien auswählen** kannst du den gespeicherten Branch durchsuchen und deine Auswahl anschließend speichern.
4. **Änderungen ansehen** zeigt neue, geänderte und entfernte Dateien sowie Konflikte. Bei der ersten Übernahme müssen vorhandene Dateien aus einem bisherigen Upload ausdrücklich zur Ersetzung bestätigt werden.
5. **Update übernehmen** installiert genau den Commit aus dieser Vorschau. Neuere Änderungen auf dem Branch werden erst bei einer weiteren Prüfung übernommen.

Beispiel: Liegen `index.html` und `assets/` im Repository unter `apps/meine-seite/public/`, trägst du diesen Pfad als Website-Ordner ein. Die Website erhält dann direkt `index.html` und `assets/`; andere Anwendungen und Dateien daneben werden nicht veröffentlicht.

**Automatische Prüfungen** sind standardmäßig aktiviert, mit einem Intervall von 15 Minuten. WebHafen zeigt verfügbare Updates in den Einstellungen und auf der Website-Karte an. Änderungen außerhalb deiner Dateiauswahl lösen kein Website-Update aus. **Automatische Installation** ist eine separate, standardmäßig ausgeschaltete Option. Die erste Übernahme und vorhandene Dateikonflikte werden nicht ohne deine Prüfung überschrieben.

**Private Repositories:** Einen Fine-grained Personal Access Token für das gewünschte Repository mit **Contents: Read-only** eintragen. Öffentliche Repositories funktionieren ohne Token. Der Token wird verschlüsselt außerhalb der veröffentlichten Website gespeichert und nie zurückgegeben. Den vorhandenen `APP_SECRET` und den kompletten `/data`-Mount bei Container-Updates beibehalten. [GitHub beschreibt die benötigte Leseberechtigung hier.](https://docs.github.com/en/rest/repos/contents#get-repository-content)

Vor einer Übernahme sichert WebHafen die betroffenen Website-Dateien. **Vorherige Version wiederherstellen** stellt diesen Stand wieder her. Eigene unverwaltete Dateien und Laufzeitdaten werden nicht pauschal gelöscht. Lokale Änderungen an bereits verwalteten Dateien werden als Konflikt gemeldet. Änderungen dann zuerst im Repository nachziehen oder bewusst in der lokalen Website auflösen. Geschützte Ordner, Zugangsdaten und Datenbanken gehören nicht in den veröffentlichten GitHub-Inhalt.

Die Verbindung aktualisiert Website-Dateien für statische und PHP-Websites. Sie führt keine Build-Befehle, Paketinstallationen oder Repository-Skripte aus und startet keinen externen Python-, Node- oder Docker-Server neu. Bei Projekten mit einem Build-Schritt muss der ausgewählte Branch/Ordner bereits die fertigen Website-Dateien enthalten. Eine reine Weiterleitung auf einen anderen Server kann über diese Funktion keine Dateien dieses Servers ändern.

**Verbindung trennen** beendet Prüfungen und Updates und entfernt den gespeicherten Token; die bisherige Website bleibt erhalten. GitHub-Cache und Sicherungen liegen privat unter `/data/github` und werden nicht als Website ausgeliefert.

## 6. Eigene HTTPS-Adresse mit Tailscale

1. In WebHafen **System → Tailscale** öffnen. In der [Tailscale-Verwaltung](https://login.tailscale.com/admin/settings/keys) einen Auth-Key mit **Reusable** erstellen, **Ephemeral** deaktivieren und bei erforderlicher Gerätefreigabe **Pre-approved** wählen. Den Key in WebHafen eingeben und **Auth-Key speichern** drücken. Der Key wird verschlüsselt gespeichert und nicht wieder angezeigt.
2. In [Tailscale → DNS](https://login.tailscale.com/admin/dns) **MagicDNS** und **HTTPS** aktivieren. Für öffentliche Adressen muss **Funnel** für die jeweiligen Geräte erlaubt sein.
3. Bei **＋ Neue Website** oder einer bestehenden Website unter **⚙ Einstellungen → Eigene Adresse** auf **Create Domain using Tailscale** klicken und z. B. `bot-studio` eingeben.
4. Den Zugriff wählen: **Privat — Tailscale Serve** ist auch unterwegs über Tailscale erreichbar; **Öffentlich im Internet — Tailscale Funnel** ist ohne Tailscale für jeden mit der Adresse erreichbar. Bei bestehenden Websites **Create**, bei einer neuen Website **Erstellen** drücken.

WebHafen legt für jede Website ein eigenes Tailscale-Gerät an und übernimmt die tatsächlich von Tailscale zugeteilte Adresse, z. B. `https://bot-studio.tailc4f723.ts.net`. Die Endung stammt aus deinem Tailnet. Verteilt Tailscale wegen eines belegten Namens einen abweichenden Namen, lehnt WebHafen die Einrichtung ab; wähle dann einen freien Namen. Eigene gekaufte Domains werden dadurch nicht registriert.

Jedes neue Gerät hat seine eigenen Zugriffsrechte. Eine bestehende Freigabe der Zima an Freunde gilt nicht automatisch für die neue Website. Für privaten Zugriff das jeweilige neue Gerät unter **Tailscale → Machines → Share** freigeben. Für öffentliche Websites mit privaten Inhalten muss die Website selbst einen Login anbieten.

Der bisherige manuell eingetragene Link bei **Eigene Adresse** bleibt verfügbar. Bei einer verwalteten Tailscale-Adresse lässt sich deren Zugriff ändern, der Status aktualisieren oder die Adresse entfernen. Zum Ändern des Namens erst die bestehende Adresse entfernen und dann neu erstellen. Nach einem Einrichtungsfehler ist ein ausdrücklicher Wiederholungsversuch erforderlich. Kann eine alte öffentliche Route nicht sicher zurückgesetzt werden, wird ihr Gerätezustand stillgelegt: die Adresse entfernen, das alte Gerät in Tailscale löschen und die Adresse neu anlegen; private Gerätefreigaben dann neu erteilen.

Tailscale läuft vollständig im WebHafen-Container. Es werden weder Docker-Socket noch Host-Netzwerk, privilegierter Modus oder `/dev/net/tun` benötigt. Bestehendes Tailscale auf der Zima bleibt unabhängig davon bestehen. Die Verbindung wird beim Erstellen der ersten Adresse geprüft; das Speichern eines Auth-Keys allein bestätigt noch keinen erfolgreichen Tailscale-Login.

Alternativ kann der Auth-Key als Container-Umgebungsvariable `TAILSCALE_AUTHKEY` gesetzt werden. Dieser Wert hat Vorrang vor dem UI und lässt sich nur in der Container-Konfiguration ändern. Tailscale-Sitzungen und Verbindungen liegen persistent unter `/data/tailscale`; diesen Ordner beim Update mit erhalten.

### Ohne Tailscale

Damit z. B. Freunde die Montrigor-Seite von überall öffnen können:

1. **Portweiterleitung im Router:** Leite z. B. externen Port `8011` auf die IP deines Servers, Port `8011` weiter. Nur die Ports der Websites freigeben — **den Verwaltungs-Port 8010 möglichst NICHT ins Internet freigeben** (oder nur mit sehr starkem Passwort).
2. **Feste Adresse:** Deine Heim-IP ändert sich — mit einem kostenlosen DynDNS-Dienst (z. B. DuckDNS) bekommst du einen festen Namen wie `montrigor.duckdns.org`. Viele Router (FritzBox!) haben DynDNS eingebaut.
3. Aufruf dann: `http://montrigor.duckdns.org:8011`

Alternative ohne offene Ports: ein **Cloudflare Tunnel** (kostenlos, gibt dir HTTPS + Domain, keine Portfreigabe nötig). Sag Bescheid, wenn ich dir das einrichten soll.

## 6. Sicherheit

- `ADMIN_PASSWORD` und `APP_SECRET` in der `.env` ändern (Login ist zusätzlich ratenlimitiert).
- Geschützte Ordner: bei Montrigor sind `/data`, `/includes`, `/sql` automatisch gesperrt (403), versteckte Dateien (`.htaccess`, `.user.ini`, …) ebenfalls — auch ohne Apache.
- Alle Website-Daten liegen persistent unter `webhafen/data/` und überleben Container-Updates.

## 7. Häufige Fragen

- **Port schon belegt?** In der `.env` den Bereich verschieben, `docker compose up -d --build`.
- **Montrigor nicht importiert?** Der Ordner `montrigor-site` muss direkt neben dem `webhafen`-Ordner liegen (siehe Volume in der compose-Datei).
- **„Caddy: …“-Fehlermeldung in der UI?** System → „Webserver neu laden“ drücken; wenn es bleibt, Container-Logs anschauen: `docker logs webhafen`.
- **Backup?** Ordner `webhafen/data/` sichern — das ist alles (Websites + Statistiken + Konfiguration).
