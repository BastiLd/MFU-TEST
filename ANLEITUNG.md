# ⚓ WebHafen — dein eigenes Website-Hosting mit Dashboard

WebHafen ist eine Docker-App, mit der du ganz einfach Websites hostest — statische Seiten (HTML/CSS/JS, z. B. dein MFU-TEST-Projekt) genauso wie PHP-Seiten (z. B. die Montrigor-Website, die beim ersten Start **automatisch importiert** wird).

Jede Website bekommt einen eigenen Port, einen **📊-Dashboard-Button** mit echten Analytics (Besucher, Aufrufe, Live-Ansicht, meistbesuchte Seiten, Referrer, Geräte, Status-Codes, Uhrzeiten, Antwortzeiten, Traffic), einen Dateimanager mit ZIP-Upload, Drag-&-Drop und eingebautem Text-Editor — und alles hinter einem Passwort-Login.

---

## 1. Schnellstart (Windows mit Docker Desktop)

Docker Desktop muss installiert sein und laufen. Dann in PowerShell:

```powershell
cd "C:\Users\basti\OneDrive - CHS Villach\Attachments\Websites\webhafen"
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

## 3. ZimaOS — über Portainer (WICHTIG: nicht über den ZimaOS-App-Dialog!)

Der ZimaOS-Dialog „Eigene App installieren“ kann **keine Images bauen** (er will ein fertiges Docker-Image) und versteht weder `${...}`-Platzhalter noch Port-Bereiche. Deshalb läuft die Installation über **Portainer**, das direkt aus deinem GitHub-Repo baut:

1. **Einmalig:** den Ordner `montrigor-site` auf die Zima kopieren nach `/DATA/AppData/webhafen/seed/montrigor-site` (ZimaOS-Dateien-App oder Netzwerkfreigabe).
2. WebHafen muss auf GitHub liegen (siehe PowerShell-Befehle / Repo `BastiLd/MFU-TEST`).
3. **Portainer → Stacks → Add stack:**
   - Name: `webhafen`
   - Build method: **Repository**
   - Repository URL: `https://github.com/BastiLd/MFU-TEST`
   - Reference: `refs/heads/main`
   - Compose path: `docker-compose.zimaos.yml`
   - Unten bei **Environment variables** zwei Einträge anlegen: `ADMIN_PASSWORD` = dein Passwort, `APP_SECRET` = langer Zufallstext
4. **Deploy the stack** — der erste Build dauert ein paar Minuten. Danach: `http://ZIMA-IP:8010`

Passwort später ändern: Portainer → Stack `webhafen` → Environment variables → Wert ändern → **Update the stack**. (Das Passwort wird bei jedem Start aus der Umgebungsvariable gelesen, es ist nirgendwo sonst gespeichert.)

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

## 5. Von außen erreichbar machen (ohne Tailscale)

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
