# WebHafen auf ZimaOS aktualisieren

Dieses Update ergänzt eigene HTTPS-Adressen je Website über Tailscale. Das vorhandene Design bleibt bestehen. Die Tailscale-Anmeldung und die Geräte jeder Website werden innerhalb des vorhandenen Daten-Mounts `/data` gespeichert.

Der GitHub-Workflow veröffentlicht das Image unter `ghcr.io/bastild/webhafen:latest` und zusätzlich mit dem jeweiligen Commit als Tag. Den erfolgreichen Lauf unter [GitHub Actions](https://github.com/BastiLd/MFU-TEST/actions/workflows/webhafen-image.yml) prüfen. Das lokale Docker-Archiv ist eine alternative Installationsmöglichkeit.

## Vorhandenes Image aus der Registry aktualisieren

Nach einem erfolgreichen Build unter GitHub Actions:

In der bestehenden ZimaOS-App **Bearbeiten → Bildname** auf `ghcr.io/bastild/webhafen` und **Tag** auf `latest` setzen. **Updates ignorieren** ausgeschaltet lassen. Danach speichern und die neue Version prüfen. Der bisherige Name `bastild/webhafen:latest` verweist auf Docker Hub und ist eine andere Image-Quelle.

Beim Einsatz von Portainer:

1. In Portainer den bestehenden WebHafen-Stack öffnen und **Update the stack → Re-pull image** wählen. Bei einem einzelnen Container **Recreate → Pull latest image** verwenden.
2. Den bisherigen Datenpfad auf `/data`, die veröffentlichten Ports, `ADMIN_PASSWORD` und `APP_SECRET` übernehmen.
3. WebHafen öffnen und unter **System → Tailscale** den Auth-Key hinterlegen.

Für eine neue Installation oder einen Wechsel zu einem Image-basierten Stack steht `docker-compose.zimaos.yml` bereit. Die darin verwendeten Standardports und `/DATA/AppData/webhafen/data` müssen deiner bestehenden Installation entsprechen. Nicht versehentlich einen zweiten Container auf denselben Ports starten.

## Lokal gebautes Image importieren

Das lokale Release heißt `webhafen:2026.10.25-tailscale` und ist für Linux auf x86-64 (AMD64) gebaut. Das Docker-Archiv ist `release/webhafen-2026.10.25-tailscale-amd64.tar.gz`. Es enthält das Image und keine Website-Daten oder Zugangsschlüssel.

1. Das Archiv auf die Zima kopieren, zum Beispiel nach `/DATA/AppData/webhafen/`.
2. Per SSH auf ZimaOS importieren:

   ```sh
   docker load -i /DATA/AppData/webhafen/webhafen-2026.10.25-tailscale-amd64.tar.gz
   ```

3. Im bestehenden Portainer-Stack die `image:`-Zeile auf `webhafen:2026.10.25-tailscale` ändern. **Re-pull image deaktiviert lassen**, da das Image bereits lokal importiert wurde. Den bestehenden Daten-Mount und alle Umgebungsvariablen beibehalten; dann den Stack aktualisieren.

Bei Verwendung der beiliegenden Compose-Datei alternativ `WEBHAFEN_IMAGE=webhafen:2026.10.25-tailscale` sowie das vorhandene Passwort und `APP_SECRET` setzen und `docker compose -f docker-compose.zimaos.yml up -d --pull never` ausführen. Auf dem Zielserver ist kein Build notwendig.

Nach einem erfolgreichen Wechsel lässt sich bei Bedarf mit dem bisherigen Image und demselben Daten-Mount zurückwechseln. Tailscale-Adressdaten im Store werden von älteren WebHafen-Versionen ignoriert; ältere Versionen verwalten diese Verbindungen nicht.

## Tailscale verbinden

- In der [Tailscale-Schlüsselverwaltung](https://login.tailscale.com/admin/settings/keys) einen **Reusable Auth-Key** erstellen, **Ephemeral** ausschalten und bei erforderlicher Gerätefreigabe **Pre-approved** aktivieren. Den Schlüssel direkt unter **WebHafen → System → Tailscale** eingeben. Für neu angelegte Website-Geräte muss der Schlüssel noch gültig sein.
- Unter [Tailscale → DNS](https://login.tailscale.com/admin/dns) **MagicDNS** und **HTTPS** aktivieren.
- Bei **Neue Website** oder **Website → Einstellungen → Eigene Adresse** auf **Create Domain using Tailscale** klicken, z. B. `bot-studio` eingeben und den Zugriff wählen.
- **Privat / Serve:** Zugriff über Tailscale, auch unterwegs. Das neue Website-Gerät bei Bedarf separat unter **Machines → Share** an Freunde freigeben.
- **Öffentlich / Funnel:** Zugriff aus dem Internet ohne Tailscale. Dafür muss Funnel in der Tailnet-Policy erlaubt sein. Öffentliche Websites mit privaten Inhalten brauchen einen eigenen Login.

Die tatsächliche Adresse wird nach dem erfolgreichen Tailscale-Login übernommen: `https://<name>.<dein-tailnet>.ts.net`. Weicht der von Tailscale vergebene Name wegen einer Belegung vom gewünschten Namen ab, lehnt WebHafen die Einrichtung ab. Dann einen freien Namen wählen. Die bestehende Tailscale-Installation auf ZimaOS und ihre Gerätefreigaben werden nicht verändert.

Nach einem Einrichtungsfehler ausdrücklich **Erneut versuchen** wählen. Kann eine alte öffentliche Route nicht sicher zurückgesetzt werden, wird der betroffene Gerätezustand stillgelegt. In diesem Fall die Adresse in WebHafen entfernen, das alte Gerät in Tailscale löschen und die Adresse neu erstellen. Freunde anschließend am neuen Gerät wieder freigeben.

Der gespeicherte Auth-Key wird mit `APP_SECRET` verschlüsselt. Mitgelieferte Beispielwerte werden für das Speichern eines Keys abgewiesen: falls noch ein solcher Wert gesetzt ist, vor dem ersten Verknüpfen einmalig einen eigenen langen Zufallstext setzen. Danach diesen Wert bei Updates erhalten und den vorhandenen `/data`-Mount weiterverwenden. Bestehende Tailscale-Sitzungen überleben den Austausch des Images. Ein Docker-Socket, privilegierter Modus, Host-Netzwerk oder `/dev/net/tun` werden nicht benötigt.

## Image selbst bauen

```sh
docker build --build-arg WEBHAFEN_VERSION=2026.10.25-tailscale -t webhafen:2026.10.25-tailscale .
```

Der GitHub-Workflow prüft JavaScript und Regressionstests, baut das Image und veröffentlicht nach einem Push auf `main` die Tags `ghcr.io/bastild/webhafen:latest` und `ghcr.io/bastild/webhafen:<commit-sha>`. Den neuen Registry-Stand erst nach einem erfolgreich abgeschlossenen Build abrufen.

Tailscale wird aus dem offiziellen Image `tailscale/tailscale:v1.104.2` mit festgelegtem Manifest-Digest übernommen. Die [Tailscale-Dokumentation zu Funnel](https://tailscale.com/docs/features/tailscale-funnel) und die [Serve-Dokumentation](https://tailscale.com/docs/features/tailscale-serve) beschreiben Voraussetzungen und Zugriffsarten.
