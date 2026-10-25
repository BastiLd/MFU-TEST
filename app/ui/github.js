'use strict';

/* Eigenständiges UI-Modul; Zugangsdaten und Dateizugriffe bleiben im Backend. */
window.WebHafenGitHub = (() => {
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = sha => String(sha || '').slice(0, 7);
  const when = value => value ? new Date(value).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nicht';
  const bytes = value => value >= 1048576 ? (value / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.ceil((value || 0) / 1024) + ' KB';
  const help = (name, text) => '<details class="gh-help"><summary aria-label="Info: ' + esc(name) + '">i</summary><div>' + text + '</div></details>';
  let disposeCurrent = () => {};

  function statusLabel(g) {
    if (!g || !g.owner) return 'Noch nicht verknüpft';
    return ({ checking: 'Updates werden geprüft …', current: 'Auf aktuellem Stand', 'update-available': 'Update verfügbar', deploying: 'Update wird übernommen …', rollback: 'Vorherige Version wird wiederhergestellt …', error: 'Prüfung oder Update fehlgeschlagen', configured: 'Quelle gespeichert · noch nicht geprüft', unconfigured: 'Quelle gespeichert · noch nicht geprüft' })[g.status] || 'GitHub verknüpft';
  }
  function isBusy(g) { return !!(g && (g.busy || ['checking', 'deploying', 'rollback'].includes(g.status))); }
  function badge(site) {
    const g = site && site.github;
    if (!g || !g.owner) return '';
    const cls = g.status === 'update-available' ? 'warn' : g.status === 'error' ? 'off' : 'ok';
    const text = g.status === 'update-available' ? '↻ GitHub-Update verfügbar' : isBusy(g) ? '↻ GitHub wird bearbeitet' : g.status === 'error' ? '⚠ GitHub prüfen' : 'GitHub verbunden';
    return '<a class="tag ' + cls + ' gh-badge-link" href="#/site/' + esc(site.slug) + '/settings" title="' + esc(statusLabel(g)) + '">' + text + '</a>';
  }
  function renderPanel(site) {
    const g = site.github || {};
    const configured = !!(g.owner && g.repo), disabled = isBusy(g) ? ' disabled' : '';
    const proxy = site.type === 'proxy';
    return '<section class="panel gh-panel rise d2" id="ghPanel" data-slug="' + esc(site.slug) + '">' +
      '<div class="gh-head"><h3>GitHub · Website-Updates</h3>' + help('Website-Updates', 'Verbinde eine Website mit einem GitHub-Repository. WebHafen prüft den Branch und übernimmt auf Wunsch nur deinen ausgewählten Ordner und die ausgewählten Dateien. Das erste Speichern ändert noch keine Website-Dateien.') + '</div>' +
      '<p class="gh-explain mt">Website-Dateien direkt aus GitHub aktualisieren: Quelle verbinden, den Website-Ordner wählen, Änderungen ansehen und mit „Update“ übernehmen.</p>' +
      (proxy ? '<p class="gh-note warn mt">Diese Website ist eine Weiterleitung auf eine andere Anwendung. WebHafen kann deren laufenden Server nicht durch das Kopieren von Dateien aktualisieren. Verwalte dieses Backend in seiner eigenen Anwendung oder nutze GitHub hier für eine statische bzw. PHP-Website.</p>' : '') +
      '<div class="gh-statusline"><span class="tag ' + (g.status === 'update-available' ? 'warn' : g.status === 'error' ? 'off' : configured ? 'ok' : '') + '">' + esc(statusLabel(g)) + '</span>' +
      (configured ? '<span class="gh-source">' + esc(g.owner + '/' + g.repo + ' · ' + (g.branch || 'Standardbranch')) + '</span>' : '') + '</div>' +
      (g.error ? '<p class="gh-note error mt">' + esc(g.error) + '</p>' : '') +
      '<div class="gh-fields">' +
      '<label class="fld"><span class="gh-fieldhead">GitHub-Konto / Organisation ' + help('GitHub-Konto', 'Der Teil direkt nach github.com, zum Beispiel <b>BastiLd</b> in <code>github.com/BastiLd/MeinProjekt</code>. Das kann ein Benutzerkonto oder eine Organisation sein.') + '</span><input id="ghOwner" value="' + esc(g.owner || '') + '" placeholder="z. B. BastiLd" autocomplete="off"' + disabled + '></label>' +
      '<label class="fld"><span class="gh-fieldhead">Repository ' + help('Repository', 'Der Projektname auf GitHub, zum Beispiel <b>MeinProjekt</b>. Du kannst den Namen eingeben oder die Repositories des Kontos laden. Für private Repositories zuerst den Token zusammen mit der Verbindung speichern.') + '</span><span class="gh-inline"><input id="ghRepo" list="ghRepoList" value="' + esc(g.repo || '') + '" placeholder="MeinProjekt" autocomplete="off"' + disabled + '><button class="btn ghost sm" type="button" id="ghLoadRepos"' + disabled + '>Laden</button></span><datalist id="ghRepoList"></datalist></label>' +
      '<label class="fld"><span class="gh-fieldhead">Branch ' + help('Branch', 'Der Entwicklungszweig, von dem die Website kommen soll, zum Beispiel <b>main</b> oder <b>production</b>. WebHafen führt keine Build-Befehle aus. Wähle bei gebauten Projekten den Branch und Ordner, der die fertigen Website-Dateien enthält.') + '</span><span class="gh-inline"><input id="ghBranch" list="ghBranchList" value="' + esc(g.branch || 'main') + '" placeholder="main" autocomplete="off"' + disabled + '><button class="btn ghost sm" type="button" id="ghLoadBranches"' + disabled + '>Laden</button></span><datalist id="ghBranchList"></datalist></label>' +
      '<label class="fld"><span class="gh-fieldhead">Website-Ordner im Repository ' + help('Website-Ordner', 'Ein relativer Pfad, zum Beispiel <code>website/dist</code> oder <code>server/public</code>. Die <b>Inhalte</b> dieses Ordners landen direkt im Website-Verzeichnis. Leer bedeutet das Repository-Hauptverzeichnis. Lade nur Dateien hoch, die über den Webserver erreichbar sein sollen; keine Schlüssel, .env-Dateien oder privaten Datenbanken.') + '</span><input id="ghFolder" value="' + esc(g.folder || '') + '" placeholder="z. B. website/dist oder server/public" autocomplete="off"' + disabled + '></label>' +
      '<label class="fld gh-wide"><span class="gh-fieldhead">Dateien / Unterordner innerhalb des Website-Ordners ' + help('Dateiauswahl', 'Optional ein relativer Pfad pro Zeile, zum Beispiel <code>index.html</code>, <code>assets</code> oder <code>static</code>. Ein Ordner schließt seine Unterordner ein. Leer bedeutet alle freigegebenen Website-Dateien im gewählten Website-Ordner. Dateien außerhalb der Auswahl werden nicht aus GitHub übernommen.') + '</span><textarea class="gh-paths" id="ghPaths" placeholder="Leer = gesamter Website-Ordner\nindex.html\nassets"' + disabled + '>' + esc((g.paths || []).join('\n')) + '</textarea></label>' +
      '<label class="fld gh-wide"><span class="gh-fieldhead">GitHub-Token für private Repositories (optional) ' + help('GitHub-Token', 'Öffentliche Repositories funktionieren ohne Token. Für private Repositories in GitHub unter <b>Settings → Developer settings → Personal access tokens → Fine-grained tokens</b> einen Token mit Zugriff auf das gewünschte Repository und <b>Contents: Read-only</b> anlegen. WebHafen speichert ihn verschlüsselt mit APP_SECRET. Der Token wird nie wieder angezeigt und nicht in Website-Dateien geschrieben.') + '</span><input type="password" id="ghToken" autocomplete="new-password" placeholder="' + (g.tokenConfigured ? 'Token gespeichert · leer lassen zum Beibehalten' : 'github_pat_… · für öffentliche Repositories leer lassen') + '"' + disabled + '></label>' +
      (g.tokenConfigured ? '<label class="gh-toggle gh-wide"><input type="checkbox" id="ghRemoveToken"' + disabled + '><span>Gespeicherten GitHub-Token entfernen<small>Die Verbindung bleibt gespeichert; ein privates Repository kann danach ohne neuen Token nicht geprüft oder aktualisiert werden.</small></span></label>' : '') +
      '<label class="gh-toggle gh-wide"><input type="checkbox" id="ghAutoCheck"' + (g.autoCheck !== false ? ' checked' : '') + disabled + '><span>Automatisch nach Website-Updates suchen<small>WebHafen prüft den Branch regelmäßig. Ein Hinweis erscheint hier und in der Website-Übersicht.</small></span></label>' +
      '<label class="fld"><span class="gh-fieldhead">Prüfintervall ' + help('Prüfintervall', 'Wie oft WebHafen GitHub auf neue Änderungen prüft. 15 Minuten ist ein guter Standard. Häufige Prüfungen können das GitHub-Anfragelimit erreichen; ein Token erhöht das verfügbare Kontingent.') + '</span><select id="ghInterval"' + disabled + '>' + [5, 15, 30, 60, 360, 1440].map(n => '<option value="' + n + '"' + (+g.intervalMinutes === n || !g.intervalMinutes && n === 15 ? ' selected' : '') + '>' + (n < 60 ? n + ' Minuten' : n === 1440 ? '24 Stunden' : n / 60 + ' Stunden') + '</option>').join('') + '</select></label>' +
      '<label class="gh-toggle gh-wide"><input type="checkbox" id="ghAutoUpdate"' + (g.autoUpdate === true ? ' checked' : '') + disabled + (proxy ? ' disabled' : '') + '><span>Neue Website-Versionen automatisch installieren<small>Standardmäßig ausgeschaltet. Wenn aktiviert, werden Änderungen ohne einen weiteren Klick übernommen. Vor Änderungen sichert WebHafen die betroffenen Website-Dateien; bei lokalen Konflikten wird das Update angehalten.</small></span></label>' +
      '</div>' +
      '<div class="gh-actions"><button class="btn sm" type="button" id="ghSave"' + disabled + '>Verbindung speichern & prüfen</button><button class="btn ghost sm" type="button" id="ghBrowse"' + (!configured || isBusy(g) ? ' disabled' : '') + '>Ordner und Dateien auswählen</button></div>' +
      '<p class="gh-explain mt">Speichere eine neue Quelle oder geänderte Auswahl zuerst. Anschließend kannst du die Dateien im gespeicherten Branch durchsuchen und vor dem ersten Update die Vorschau prüfen.</p>' +
      '<div id="ghTree" hidden></div>' +
      '<div class="gh-statusline"><span>Zuletzt geprüft: ' + esc(when(g.checkedAt)) + '</span>' + (g.deployedSha ? '<span>Installiert: <code>' + esc(short(g.deployedSha)) + '</code></span>' : '<span>Noch keine GitHub-Version installiert</span>') +
      (g.latestSha ? '<span>Branch: <code>' + esc(short(g.latestSha)) + '</code></span>' : '') + '</div>' +
      (g.latestMessage ? '<p class="gh-explain mt">Letzte Änderung: ' + esc(g.latestMessage) + '</p>' : '') +
      '<div class="gh-actions"><button class="btn ghost sm" type="button" id="ghCheck"' + (!configured || isBusy(g) ? ' disabled' : '') + '>Nach Updates suchen</button><button class="btn ghost sm" type="button" id="ghPreviewBtn"' + (!configured || isBusy(g) || proxy ? ' disabled' : '') + '>Änderungen ansehen</button><button class="btn ghost sm" type="button" id="ghRollback"' + (!configured || isBusy(g) || proxy || !(g.canRollback || g.hasBackup || g.previousSha) ? ' disabled' : '') + '>Vorherige Version wiederherstellen</button>' +
      (configured ? '<button class="btn ghost sm gh-danger" type="button" id="ghDisconnect"' + disabled + '>Verbindung trennen</button>' : '') + '</div>' +
      '<div id="ghPreview" hidden></div><p class="gh-status mt" id="ghStatus" role="status" aria-live="polite"></p><p class="gh-error" id="ghError" role="alert"></p>' +
      '<details class="gh-explain mt"><summary>Was passiert mit vorhandenen Dateien und meinem Backend?</summary><p class="mt">WebHafen aktualisiert die ausgewählten Website-Dateien und zeigt dir vorher die Änderungen. Lokale Änderungen dürfen nicht unbemerkt überschrieben werden. Persönliche Daten gehören in ein privates Verzeichnis außerhalb der Website-Dateien. Eine Wiederherstellung betrifft die Website-Dateien, nicht Datenbankänderungen, die deine Anwendung selbst vorgenommen hat.</p><p class="mt">Ein Python-, Node.js- oder Docker-Backend wird dadurch weder gebaut noch neu gestartet. Für solche Anwendungen aktualisiert WebHafen die hier gehostete Website; den externen Server aktualisierst du in dessen eigener Umgebung.</p></details>' +
      '</section>';
  }

  function bindPanel(site, services) {
    disposeCurrent();
    const root = document.getElementById('ghPanel');
    if (!root || root.dataset.slug !== site.slug) return () => {};
    const { api, toast, onChange } = services;
    const $ = id => root.querySelector('#' + id);
    const endpoint = '/api/sites/' + encodeURIComponent(site.slug) + '/github';
    let preview = null, working = false, disposed = false, timer = null;
    const original = JSON.stringify(configValues());
    const otherFields = [...document.querySelectorAll('#app input, #app textarea, #app select')].filter(input => !root.contains(input));
    const fieldValue = input => input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value;
    const originalOtherFields = otherFields.map(fieldValue);
    const status = message => { if (!disposed && $('ghStatus')) $('ghStatus').textContent = message; };
    const error = message => { if (!disposed && $('ghError')) $('ghError').textContent = message; };
    function configValues() {
      return { owner: $('ghOwner').value.trim(), repo: $('ghRepo').value.trim(), branch: $('ghBranch').value.trim(),
        folder: $('ghFolder').value.trim().replace(/^\/+|\/+$/g, ''),
        paths: $('ghPaths').value.split('\n').map(x => x.trim()).filter(Boolean),
        autoCheck: $('ghAutoCheck').checked, autoUpdate: $('ghAutoUpdate').checked,
        intervalMinutes: +$('ghInterval').value };
    }
    function requireSaved() {
      if (JSON.stringify(configValues()) !== original || $('ghToken').value || $('ghRemoveToken') && $('ghRemoveToken').checked)
        throw new Error('Bitte die geänderte Verbindung und Dateiauswahl zuerst speichern. Danach die Vorschau neu laden.');
    }
    function setBusy(value) {
      working = value;
      root.querySelectorAll('button').forEach(button => {
        if (value) { button.dataset.ghWasDisabled = String(button.disabled); button.disabled = true; }
        else if (button.dataset.ghWasDisabled !== undefined) { button.disabled = button.dataset.ghWasDisabled === 'true'; delete button.dataset.ghWasDisabled; }
      });
    }
    async function run(task, message) {
      if (working || disposed) return;
      setBusy(true); error(''); status(message || 'Wird geladen …');
      try { await task(); }
      catch (e) { error(e.message); status(''); }
      finally { if (!disposed && root.isConnected) setBusy(false); }
    }
    async function updateSite(data, message) {
      if (message) toast(message, 'ok');
      if (!disposed && root.isConnected && data.site && onChange) await onChange(data.site);
    }
    function on(id, callback) { if ($(id)) $(id).addEventListener('click', callback); }
    function parseOwnerRepo() {
      const current = configValues();
      const match = /^(?:https:\/\/)?github\.com\/([^/]+)\/([^/#?]+)(?:\/.*)?$/i.exec(current.repo);
      if (match) { $('ghOwner').value = match[1]; $('ghRepo').value = match[2].replace(/\.git$/, ''); }
      else $('ghRepo').value = current.repo.replace(/\.git$/, '');
    }
    $('ghRepo').addEventListener('change', parseOwnerRepo);
    $('ghAutoUpdate').addEventListener('change', () => {
      if ($('ghAutoUpdate').checked) $('ghAutoCheck').checked = true;
    });
    on('ghSave', () => run(async () => {
      parseOwnerRepo(); const config = configValues();
      if (!config.owner || !config.repo || !config.branch) throw new Error('Bitte GitHub-Konto, Repository und Branch angeben.');
      if ($('ghToken').value.trim()) config.token = $('ghToken').value.trim();
      if ($('ghRemoveToken') && $('ghRemoveToken').checked) config.removeToken = true;
      if (config.token && config.removeToken) throw new Error('Bitte entweder einen neuen Token speichern oder den vorhandenen entfernen.');
      const data = await api(endpoint, { method: 'PUT', json: config });
      $('ghToken').value = '';
      try {
        const checked = await api(endpoint + '/check', { method: 'POST', json: {} });
        await updateSite(checked, 'GitHub-Verbindung gespeichert und geprüft. Website-Dateien bleiben bis zum Update erhalten.');
      } catch (checkError) {
        let saved = data;
        try { saved = await api(endpoint); } catch (_) {}
        toast('Verbindung gespeichert, Prüfung fehlgeschlagen: ' + checkError.message, 'err');
        if (!disposed && root.isConnected && saved.site && onChange) await onChange(saved.site);
        else { status('GitHub-Verbindung gespeichert.'); error('Prüfung fehlgeschlagen: ' + checkError.message); }
      }
    }, 'Verbindung wird gespeichert und geprüft …'));
    on('ghLoadRepos', () => run(async () => {
      const owner = $('ghOwner').value.trim();
      if (!owner) throw new Error('Bitte zuerst das GitHub-Konto oder die Organisation angeben.');
      const data = await api(endpoint + '/repos?owner=' + encodeURIComponent(owner));
      const repos = data.repos || data.repositories || [];
      $('ghRepoList').innerHTML = repos.map(item => { const name = typeof item === 'string' ? item : item.name; return '<option value="' + esc(name) + '">' + esc(typeof item === 'string' ? item : item.description || '') + '</option>'; }).join('');
      status(repos.length ? repos.length + ' Repositories geladen. Im Repository-Feld einen Namen auswählen oder selbst eingeben.' : 'Keine Repositories gefunden. Für ein privates Repository Namen und Token eingeben und die Verbindung speichern.');
      $('ghRepo').focus();
    }, 'Repositories werden geladen …'));
    on('ghLoadBranches', () => run(async () => {
      parseOwnerRepo(); const config = configValues();
      if (!config.owner || !config.repo) throw new Error('Bitte zuerst GitHub-Konto und Repository angeben.');
      const data = await api(endpoint + '/branches?owner=' + encodeURIComponent(config.owner) + '&repo=' + encodeURIComponent(config.repo));
      const branches = data.branches || [];
      $('ghBranchList').innerHTML = branches.map(item => '<option value="' + esc(typeof item === 'string' ? item : item.name) + '"></option>').join('');
      status(branches.length + ' Branches geladen. Im Branch-Feld auswählen oder den gewünschten Namen eingeben.'); $('ghBranch').focus();
    }, 'Branches werden geladen …'));
    on('ghCheck', () => run(async () => {
      requireSaved(); const data = await api(endpoint + '/check', { method: 'POST', json: {} });
      await updateSite(data, 'GitHub-Prüfung abgeschlossen');
    }, 'GitHub wird auf Änderungen geprüft …'));

    function fileList(label, items) {
      if (!items || !items.length) return '';
      return '<details><summary>' + esc(label) + ' (' + items.length + ')</summary><ul>' + items.slice(0, 300).map(item => '<li>' + esc(typeof item === 'string' ? item : item.path || item.name || item.reason || JSON.stringify(item)) + '</li>').join('') + (items.length > 300 ? '<li>… weitere Dateien</li>' : '') + '</ul></details>';
    }
    function showPreview(value) {
      preview = value;
      const conflicts = value.conflicts || [];
      const existing = value.existing || [];
      const box = $('ghPreview'); box.hidden = false;
      box.innerHTML = '<div class="gh-preview"><h4>Änderungsvorschau</h4><p class="gh-explain">Commit <code>' + esc(short(value.sha)) + '</code>' + (value.message ? ' · ' + esc(value.message) : '') + '</p>' +
        '<div class="gh-counts"><span>' + (value.fileCount || 0) + ' ausgewählte Dateien</span><span>' + bytes(value.totalBytes) + '</span><span>' + (value.add || []).length + ' neu</span><span>' + (value.change || []).length + ' geändert</span><span>' + (value.remove || []).length + ' entfernt</span></div>' +
        (conflicts.length ? '<p class="gh-note warn">Das Update wurde angehalten: Es gibt lokale Änderungen oder geschützte Dateien. Prüfe die Konflikte, bevor du fortfährst.</p>' : '<p class="gh-explain">Vor Änderungen werden die betroffenen Website-Dateien gesichert. Installiert wird genau der hier geprüfte Commit.</p>') +
        fileList('Neue Dateien', value.add) + fileList('Geänderte Dateien', value.change) + fileList('Zu entfernende GitHub-Dateien', value.remove) + fileList('Konflikte', conflicts) + fileList('Vorhandene Dateien aus dem bisherigen Upload', existing) + fileList('Ausgelassene private Dateien und Laufzeitdaten', value.excluded) +
        (existing.length ? '<label class="gh-toggle mt"><input type="checkbox" id="ghApproveExisting"><span>Diese vorhandenen Dateien durch die angezeigte GitHub-Version ersetzen<small>Die oben aufgelisteten Dateien stammen noch nicht aus der GitHub-Verwaltung. Ich habe die Vorschau geprüft. Vor der Übernahme werden die betroffenen bisherigen Dateien gesichert.</small></span></label>' : '') +
        (value.warnings && value.warnings.length ? '<p class="gh-note warn mt">' + value.warnings.map(esc).join('<br>') + '</p>' : '') +
        '<div class="gh-actions"><button class="btn sm" type="button" id="ghUpdate"' + (conflicts.length || existing.length || !value.sha ? ' disabled' : '') + '>↻ Update übernehmen</button></div></div>';
      if ($('ghApproveExisting')) $('ghApproveExisting').addEventListener('change', () => {
        $('ghUpdate').disabled = !!conflicts.length || !$('ghApproveExisting').checked || !value.sha;
      });
      on('ghUpdate', () => run(async () => {
        requireSaved();
        if (!preview || !preview.sha) throw new Error('Bitte zuerst eine aktuelle Änderungsvorschau laden.');
        const overwriteExisting = !!($('ghApproveExisting') && $('ghApproveExisting').checked);
        if (existing.length && !overwriteExisting) throw new Error('Bitte zuerst die Übernahme der vorhandenen Dateien in der Vorschau bestätigen.');
        const data = await api(endpoint + '/update', { method: 'POST', json: { sha: preview.sha, overwriteExisting } });
        await updateSite(data, 'GitHub-Update wurde gestartet');
      }, 'Die geprüfte Website-Version wird übernommen …'));
      status('Vorschau geladen. Die Website wurde noch nicht verändert.');
    }
    on('ghPreviewBtn', () => run(async () => {
      requireSaved(); const data = await api(endpoint + '/preview', { method: 'POST', json: {} });
      showPreview(data.preview);
    }, 'Website-Dateien und lokale Änderungen werden verglichen …'));
    on('ghRollback', () => run(async () => {
      requireSaved();
      if (!confirm('Die zuletzt gesicherten Website-Dateien wiederherstellen? Nur die beim Update betroffenen Dateien werden ersetzt. Andere Dateien und private Laufzeitdaten bleiben erhalten.')) return;
      const data = await api(endpoint + '/rollback', { method: 'POST', json: {} });
      await updateSite(data, 'Wiederherstellung wurde gestartet');
    }, 'Vorherige Website-Version wird wiederhergestellt …'));
    on('ghDisconnect', () => run(async () => {
      if (!confirm('GitHub-Verbindung trennen? Die Website-Dateien bleiben erhalten. Automatische Prüfungen und Updates werden beendet.')) return;
      const data = await api(endpoint, { method: 'DELETE' }); await updateSite(data, 'GitHub-Verbindung getrennt');
    }, 'Verbindung wird getrennt …'));

    function setPaths(paths) { $('ghPaths').value = [...new Set(paths)].sort().join('\n'); preview = null; $('ghPreview').hidden = true; }
    function relativeSelection(fullPath) {
      const folder = configValues().folder;
      if (!folder) return fullPath;
      if (fullPath === folder) return '';
      if (!fullPath.startsWith(folder + '/')) return null;
      return fullPath.slice(folder.length + 1);
    }
    async function browse(pathValue) {
      const data = await api(endpoint + '/tree?scope=repository&path=' + encodeURIComponent(pathValue));
      if (disposed || !root.isConnected) return;
      const pathValueActual = data.path === undefined ? pathValue : data.path;
      const entries = data.entries || data.items || [];
      const selected = new Set(configValues().paths);
      const tree = $('ghTree'); tree.className = 'gh-tree'; tree.hidden = false;
      const parent = pathValueActual.split('/').slice(0, -1).join('/');
      tree.innerHTML = '<div class="gh-tree-head"><b>Repository-Inhalt</b><code>/' + esc(pathValueActual) + '</code>' +
        (pathValueActual ? '<button class="btn ghost sm" type="button" data-gh-up="' + esc(parent) + '">↑ Zurück</button>' : '') +
        '<button class="btn ghost sm" type="button" id="ghUseFolder">Diesen Website-Ordner wählen</button></div>' +
        '<div class="gh-tree-list">' + (entries.length ? entries.map(item => {
          const fullPath = item.path || (pathValueActual ? pathValueActual + '/' : '') + item.name;
          const dir = item.type === 'dir' || item.type === 'tree' || item.dir === true;
          const relative = relativeSelection(fullPath);
          const selectable = relative !== null && !!relative && item.type !== 'symlink' && item.type !== 'submodule';
          return '<div class="gh-tree-row"><label><input type="checkbox" data-gh-pick="' + esc(fullPath) + '"' + (selectable ? '' : ' disabled') + (relative && selected.has(relative) ? ' checked' : '') + '><span>' + (dir ? '📁 ' : '📄 ') + esc(item.name || fullPath.split('/').pop()) + '</span></label>' +
            (dir ? '<button class="btn ghost sm" type="button" data-gh-open="' + esc(fullPath) + '">Öffnen</button>' : '') + '</div>';
        }).join('') : '<p class="gh-tree-empty">Dieser Ordner enthält keine auswählbaren Dateien.</p>') + '</div>' +
        '<p class="gh-explain" style="padding:12px 14px">Ordner mit „Öffnen“ durchsuchen. Mit „Diesen Website-Ordner wählen“ legst du die Wurzel fest; die Häkchen wählen einzelne Dateien oder Unterordner darin aus. Danach die Verbindung speichern.</p>';
      tree.querySelectorAll('[data-gh-open]').forEach(button => button.addEventListener('click', () => run(() => browse(button.dataset.ghOpen), 'Ordner wird geladen …')));
      tree.querySelectorAll('[data-gh-up]').forEach(button => button.addEventListener('click', () => run(() => browse(button.dataset.ghUp), 'Ordner wird geladen …')));
      $('ghUseFolder').addEventListener('click', () => {
        $('ghFolder').value = pathValueActual; setPaths([]);
        status('Website-Ordner gewählt. Jetzt die Verbindung speichern; anschließend kannst du einzelne Dateien darin auswählen.');
        tree.querySelectorAll('[data-gh-pick]').forEach(input => { input.checked = false; input.disabled = relativeSelection(input.dataset.ghPick) === null; });
      });
      tree.querySelectorAll('[data-gh-pick]').forEach(input => input.addEventListener('change', () => {
        const relative = relativeSelection(input.dataset.ghPick);
        if (relative === null || !relative) return;
        const paths = new Set(configValues().paths);
        if (input.checked) paths.add(relative); else paths.delete(relative);
        setPaths([...paths]); status('Dateiauswahl geändert. Bitte speichern, bevor du eine Vorschau oder ein Update startest.');
      }));
      status('Repository-Inhalt geladen. Es wurden noch keine Website-Dateien verändert.');
    }
    on('ghBrowse', () => run(async () => { requireSaved(); await browse(configValues().folder); }, 'Repository-Inhalt wird geladen …'));
    root.querySelectorAll('input:not([type=password]),textarea,select').forEach(input => input.addEventListener('input', () => {
      if (preview) { preview = null; $('ghPreview').hidden = true; }
    }));
    let dispose = () => {};
    const onHashChange = () => dispose();
    const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); });
    observer.observe(document.getElementById('app') || document.body, { childList: true });
    window.addEventListener('hashchange', onHashChange);
    dispose = () => {
      disposed = true; clearTimeout(timer); observer.disconnect(); window.removeEventListener('hashchange', onHashChange);
    };
    disposeCurrent = dispose;
    if (site.github && site.github.owner) {
      const signature = value => JSON.stringify(value ? [value.status, value.latestSha, value.deployedSha, value.error, value.busy, value.canRollback] : null);
      let observed = signature(site.github), remoteBusy = isBusy(site.github);
      const pristine = () => JSON.stringify(configValues()) === original && !$('ghToken').value && !($('ghRemoveToken') && $('ghRemoveToken').checked) &&
        otherFields.every((input, index) => input.isConnected && fieldValue(input) === originalOtherFields[index]);
      const poll = async () => {
        if (disposed || !root.isConnected) return;
        if (working) { timer = setTimeout(poll, 3000); return; }
        try {
          const data = await api(endpoint);
          if (disposed || !root.isConnected || !data.site) return;
          const next = data.site.github;
          remoteBusy = isBusy(next);
          if (signature(next) !== observed) {
            observed = signature(next);
            if (pristine()) {
              if (next && next.status === 'error') toast(next.error || 'GitHub-Vorgang fehlgeschlagen', 'err');
              if (onChange) { await onChange(data.site); return; }
            } else {
              status(next && next.status === 'update-available'
                ? 'Neue GitHub-Änderungen gefunden. Deine noch nicht gespeicherten Eingaben bleiben erhalten.'
                : 'Der GitHub-Status hat sich geändert. Deine noch nicht gespeicherten Eingaben bleiben erhalten; speichere sie vor dem nächsten Update.');
            }
          }
        } catch (e) { error(e.message); }
        if (!disposed) timer = setTimeout(poll, remoteBusy ? 2000 : 30000);
      };
      timer = setTimeout(poll, remoteBusy ? 1600 : 30000);
    }
    return dispose;
  }
  return { renderPanel, bindPanel, badge, dispose: () => disposeCurrent(), stop: () => disposeCurrent() };
})();
