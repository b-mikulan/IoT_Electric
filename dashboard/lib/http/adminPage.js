function sendAdminPage(response) {
  return response.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'").send(`<!doctype html>
<html lang="hr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Administracija · IoT Electric</title>
    <link rel="icon" href="/favicon.svg">
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/dashboardSettings.css">
    <link rel="stylesheet" href="/admin.css">
    <script defer src="/dashboardSettings.js"></script>
    <script defer src="/adminApi.js"></script>
    <script defer src="/adminUsers.js"></script>
    <script defer src="/adminSystem.js"></script>
    <script defer src="/adminOrganization.js"></script>
    <script defer src="/adminCatalog.js"></script>
  </head>
  <body class="admin-page">
    <a class="admin-skip" href="#users">Preskoči na upravljanje korisnicima</a>
    <header class="app-header page-header admin-header">
      <div class="admin-container page-header-inner">
        <div class="page-header-copy">
          <a class="brand" href="/" aria-label="IoT Electric"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span><span class="brand-name">IoT Electric</span></a>
          <h1>Administracija</h1>
          <p class="page-header-description">Korisnici, pristup prostorijama i postavke sustava.</p>
        </div>
        <div class="page-header-side">
          <p class="page-header-status admin-account">Administrator <strong id="admin-current-user">—</strong></p>
          <div class="admin-actions page-header-actions">
            <a class="admin-button secondary" href="/">Natrag na dashboard</a>
            <form action="/logout" method="post"><button class="admin-button secondary" type="submit">Odjava</button></form>
          </div>
        </div>
      </div>
    </header>
    <main class="admin-container admin-main">
      <dl class="admin-overview" aria-label="Pregled sustava">
        <div><dt>Korisnici</dt><dd id="admin-user-count">—</dd><dd class="admin-stat-hint">Računi za pregled dashboarda</dd></div>
        <div><dt>Prostorije</dt><dd id="admin-room-count">—</dd><dd class="admin-stat-hint">Dostupne za dodjelu pristupa</dd></div>
        <div><dt>Aktivne sesije</dt><dd id="admin-session-count">—</dd><dd class="admin-stat-hint">Uključuju prijavljene administratore</dd></div>
        <div><dt>Izvor podataka</dt><dd id="admin-source">—</dd><dd id="admin-health-status" class="admin-stat-hint">Učitavam stanje…</dd></div>
      </dl>
      <nav class="admin-section-nav" aria-label="Administracija">
        <a href="#users">Korisnici i prava</a>
        <a href="#system">Sustav i konfiguracija</a>
        <a href="#organization">Organizacija zgrade</a>
        <a href="#catalog">Skeniranje zgrade</a>
      </nav>
      <noscript><p class="admin-warning">Za upravljanje korisnicima i postavkama potrebno je omogućiti JavaScript u pregledniku.</p></noscript>

      <section id="users" class="admin-section" aria-labelledby="admin-users-title">
        <div class="admin-section-heading">
          <div><h2 id="admin-users-title">Korisnici i prava pristupa</h2><p>Korisnici mogu pregledavati samo prostorije koje im dodijeliš.</p></div>
          <button id="admin-new" class="admin-button" type="button" disabled>+ Novi korisnik</button>
        </div>
        <div class="admin-users-layout">
          <aside class="admin-card admin-user-browser" aria-label="Popis korisnika">
            <label class="admin-label" for="admin-user-search">Pretraži korisnike</label>
            <input id="admin-user-search" type="search" placeholder="Korisničko ime" autocomplete="off">
            <p id="admin-users-loading" class="admin-hint" role="status">Učitavam korisnike…</p>
            <div id="admin-users" class="admin-users-list"></div>
            <p id="admin-users-empty" class="admin-empty" hidden>Nema korisnika.</p>
            <button id="admin-users-retry" class="admin-button secondary" type="button" hidden>Pokušaj ponovno</button>
            <p class="admin-account-note">Administratorski račun postavlja se na serveru i ne prikazuje se na ovom popisu.</p>
          </aside>
          <div class="admin-card admin-user-editor">
            <h3 id="admin-editor-title">Novi korisnik</h3>
            <form id="admin-user-form" hidden>
              <div class="admin-account-fields">
                <div class="admin-field">
                  <label class="admin-label" for="admin-username">Korisničko ime</label>
                  <input id="admin-username" autocomplete="off" maxlength="128" required>
                </div>
                <div class="admin-field">
                  <label class="admin-label" for="admin-password">Privremena lozinka</label>
                  <input id="admin-password" type="password" autocomplete="new-password" minlength="8" maxlength="1024" aria-describedby="admin-password-hint">
                  <p id="admin-password-hint" class="admin-hint">Najmanje 8 znakova.</p>
                </div>
              </div>
              <div class="admin-access-heading"><h4>Dozvoljene prostorije</h4><p class="admin-hint">Označi prostoriju za pregled i osvježavanje. Zatim odaberi može li korisnik i upravljati njezinim uređajima.</p></div>
              <label class="admin-checkbox"><input id="admin-edit-device-settings" type="checkbox"><span>Dopusti uređivanje postavki kartica</span></label>
              <p class="admin-hint">Za dodijeljene uređaje dopušta promjenu naziva, očitanja i prikazane jedinice.</p>
              <div class="admin-full-access">
                <label class="admin-checkbox"><input id="admin-all-rooms" type="checkbox"><span>Pregled svih prostorija i uređaja bez prostorije</span></label>
                <p class="admin-hint">Pregled uključuje i buduće prostorije. Upravljanje dodijeli zasebno za svaku prostoriju.</p>
              </div>
              <fieldset id="admin-room-field">
                <legend>Odabir prostorija</legend>
                <div class="admin-room-filters">
                  <div class="admin-field"><label class="admin-label" for="admin-room-search">Pretraži prostorije</label><input id="admin-room-search" type="search" placeholder="Naziv prostorije ili kat" autocomplete="off"></div>
                  <div class="admin-field"><label class="admin-label" for="admin-room-floor">Kat</label><select id="admin-room-floor"><option value="">Svi katovi</option></select></div>
                </div>
                <div class="admin-room-tools">
                  <label class="admin-checkbox"><input id="admin-selected-only" type="checkbox"><span>Samo odabrane</span></label>
                  <div class="admin-actions"><button id="admin-select-visible" class="admin-text-button" type="button">Označi prikazane</button><button id="admin-clear-visible" class="admin-text-button" type="button">Ukloni prikazane</button></div>
                </div>
                <div id="admin-rooms" class="admin-rooms"></div>
                <p id="admin-rooms-empty" class="admin-empty" role="status" hidden></p>
              </fieldset>
              <p id="admin-room-summary" class="admin-permission-summary" aria-live="polite"></p>
              <p id="admin-no-access" class="admin-warning" hidden>Korisnik neće vidjeti nijednu prostoriju.</p>
              <div class="admin-form-footer">
                <div class="admin-actions"><button id="admin-save" class="admin-button" type="submit">Spremi korisnika</button><button id="admin-reset" class="admin-button secondary" type="button">Poništi izmjene</button></div>
                <p class="admin-hint">Spremanje promjena odjavljuje postojeće sesije ovog korisnika.</p>
              </div>
              <section id="admin-user-session" class="admin-user-session" aria-label="Aktivne sesije korisnika" hidden>
                <div><h4>Prijave korisnika</h4><p id="admin-user-session-count" class="admin-hint"></p></div>
                <button id="admin-revoke" class="admin-button secondary" type="button">Odjavi sve sesije</button>
              </section>
              <button id="admin-delete" class="admin-text-button danger" type="button" aria-controls="admin-delete-confirmation" aria-expanded="false" hidden>Izbriši korisnika</button>
              <div id="admin-delete-confirmation" class="admin-delete-confirmation" hidden>
                <p id="admin-delete-question"></p>
                <div class="admin-actions"><button id="admin-delete-cancel" class="admin-button secondary" type="button">Odustani</button><button id="admin-delete-confirm" class="admin-button danger" type="button">Izbriši korisnika</button></div>
              </div>
            </form>
            <p id="admin-status" class="admin-status" role="status" aria-live="polite"></p>
          </div>
        </div>
      </section>

      <section id="system" class="admin-section" aria-labelledby="admin-system-title">
        <div class="admin-section-heading"><div><h2 id="admin-system-title">Sustav i konfiguracija</h2><p>Osvježavanje podataka, organizacija zgrade i prijenos postavki.</p></div></div>
        <div class="admin-card admin-system-card">
          <div class="admin-system-heading"><div><h3>Osvježavanje podataka</h3><p id="admin-polling-status" class="admin-hint">Učitavam stanje…</p></div><div class="admin-actions"><button id="refresh-pause" class="refresh-pause" type="button" disabled><span>Pauziraj</span></button><button id="general-settings-open" class="admin-button" type="button">Postavke osvježavanja</button></div></div>
          <dl class="admin-system-details"><div><dt>Zadnje očitanje</dt><dd id="admin-last-sync">—</dd></div><div><dt>Učestalost provjere</dt><dd id="poll-interval">—</dd></div></dl>
          <p class="admin-hint">Postavke osvježavanja vrijede za sve korisnike dashboarda.</p>
          <p id="admin-system-status" class="admin-status" role="status" aria-live="polite"></p>
          <button id="admin-system-retry" class="admin-button secondary" type="button" hidden>Pokušaj ponovno</button>
        </div>
        <div class="admin-shortcuts">
          <a id="admin-rooms-link" class="admin-card admin-shortcut" href="/#rooms" hidden><span class="admin-shortcut-heading">Prostorije i katovi <span aria-hidden="true">↗</span></span><span>Uredi organizaciju zgrade i raspored uređaja po prostorijama.</span></a>
          <a id="admin-visibility-link" class="admin-card admin-shortcut" href="/#visibility" hidden><span class="admin-shortcut-heading">Vidljivost podataka <span aria-hidden="true">↗</span></span><span>Odaberi koje se mjerne točke prikazuju na dashboardu.</span></a>
          <a id="admin-discovery-link" class="admin-card admin-shortcut" href="/#discovery" hidden><span class="admin-shortcut-heading">Dodavanje mjernih točaka <span aria-hidden="true">↗</span></span><span>Pronađi dostupne točke i dodaj ih u prikaz.</span></a>
          <a id="admin-transfer-link" class="admin-card admin-shortcut" href="/transfer.html" hidden><span class="admin-shortcut-heading">Prijenos konfiguracije <span aria-hidden="true">↗</span></span><span>Izvoz, uvoz i sigurnosna kopija konfiguracije.</span><small>Korisnički računi nisu dio izvoza konfiguracije.</small></a>
          <a class="admin-card admin-shortcut" href="/trends.html"><span class="admin-shortcut-heading">Trendovi i alarmi <span aria-hidden="true">↗</span></span><span>Pregledaj povijest mjerenja, promjene i alarme.</span></a>
          <a class="admin-card admin-shortcut" href="/technical.html"><span class="admin-shortcut-heading">Tehnički prikaz <span aria-hidden="true">↗</span></span><span>Provjeri pojedinačne mjerne točke i njihove vrijednosti.</span></a>
        </div>
      </section>
      <section id="organization" class="admin-section" aria-labelledby="admin-organization-title">
        <div class="admin-section-heading"><div><h2 id="admin-organization-title">Organizacija zgrade</h2><p>Pregledaj prijedloge iz spremljenog kataloga i postavki.</p></div></div>
        <div class="admin-card admin-system-card">
          <p class="admin-hint">Obuhvaća konfigurirane, vidljive uređaje. Postojeće ručne dodjele i popisi članova imaju prednost. Katovi se preuzimaju iz odabrane prostorije.</p>
          <button id="organization-preview" class="admin-button" type="button">Predloži organizaciju</button>
          <fieldset id="organization-scope" hidden>
            <legend>Dodjela grane u prostoriju (opcionalno)</legend>
            <div class="admin-room-filters">
              <div class="admin-field"><label for="organization-root">Grana / puna putanja uređaja</label><input id="organization-root" list="organization-branches" placeholder="Odaberi granu iz popisa" maxlength="4096"><datalist id="organization-branches"></datalist></div>
              <div class="admin-field"><label for="organization-room">Ciljna prostorija</label><select id="organization-room"><option value="">Bez dodjele grane</option></select></div>
            </div>
            <p class="admin-hint">Odaberi granu i prostoriju pa ponovno pripremi prijedlog. Ručno dodijeljeni uređaji ostaju u svojim prostorijama. Nove prostorije možeš dodati u <a href="/#rooms">Prostorije i katovi</a>.</p>
          </fieldset>
          <p id="organization-status" class="admin-status" role="status" aria-live="polite"></p>
          <div id="organization-result" hidden>
            <p id="organization-summary" class="admin-hint"></p>
            <p class="admin-warning">Premještanje može promijeniti tko vidi uređaj i tko njime upravlja. Moguća podgrupiranja zahtijevaju tvoju potvrdu; ista prostorija ne dokazuje stvarno članstvo u grupi.</p>
            <div class="admin-actions"><button id="organization-select" class="admin-text-button" type="button">Odaberi pouzdane prijedloge bez promjene pristupa</button><button id="organization-clear" class="admin-text-button" type="button">Poništi odabir</button></div>
            <label class="admin-label" for="organization-search">Pretraži prijedloge</label><input id="organization-search" type="search" placeholder="Uređaj, prostorija ili putanja">
            <div id="organization-items" class="organization-items"></div>
            <button id="organization-more" class="admin-button secondary" type="button" hidden>Prikaži još prijedloga</button>
            <details id="organization-unresolved"><summary id="organization-unresolved-title">Potrebna provjera</summary><ul id="organization-unresolved-items"></ul></details>
            <p id="organization-selected" class="admin-permission-summary"></p>
            <label class="admin-checkbox"><input id="organization-confirm" type="checkbox"><span>Pregledao/la sam odabrane promjene i njihov utjecaj na pristup.</span></label>
            <button id="organization-apply" class="admin-button" type="button" disabled>Primijeni odabrano</button>
          </div>
          <p id="organization-backup" class="admin-hint" hidden><a id="organization-backup-link">Preuzmi prethodnu konfiguraciju</a>. Za povrat je uvezi kroz <a href="/transfer.html">Prijenos konfiguracije</a>.</p>
        </div>
      </section>
      <section id="catalog" class="admin-section" aria-labelledby="catalog-title">
        <div class="admin-section-heading"><div><h2 id="catalog-title">Skeniranje zgrade</h2><p>Izradi katalog dostupnih uređaja i točaka iz kontrolera.</p></div></div>
        <div class="admin-card admin-system-card">
          <p class="admin-warning">Skeniranje privremeno pauzira očitanja i upravljanje za sve korisnike ovog dashboarda. Nakon pauze ili završetka skena vraća se prethodno stanje osvježavanja. Zatvaranje stranice ne prekida skeniranje.</p>
          <p class="admin-hint">Nakon skena možeš odabrati uređaje iz snimke i dodati njihove mjerne točke u dashboard.</p>
          <div class="admin-account-fields">
            <div class="admin-field"><label class="admin-label" for="catalog-profile">Obuhvat novog skena</label><select id="catalog-profile"><option value="catalog">Uređaji i točke (preporučeno)</option><option value="full">Sve dostupne grane</option></select><p class="admin-hint">Preporučeni obuhvat preskače programe, grafike i druge tehničke grane.</p></div>
            <div class="admin-field"><label class="admin-label" for="catalog-limit">Zahtjevi po pokretanju / nastavku</label><select id="catalog-limit"><option value="500">Do 500 zahtjeva</option><option value="2000">Do 2000 zahtjeva</option><option value="0">Bez ograničenja</option></select><p class="admin-hint">Jedan zahtjev u trenutku, uz najmanje 3 sekunde razmaka. Na limitu se napredak sprema za nastavak.</p></div>
            <div class="admin-field"><label class="admin-label" for="catalog-root">Početna grana (opcionalno)</label><input id="catalog-root" maxlength="4096" placeholder="Prazno za cijelu dostupnu zgradu" autocomplete="off"><p class="admin-hint">Za uži obuhvat unesi točan EWS ID grane.</p></div>
          </div>
          <div class="admin-form-footer">
            <label class="admin-checkbox"><input id="catalog-confirm" type="checkbox"><span>Potvrđujem privremenu pauzu očitanja i upravljanja.</span></label>
            <div class="admin-actions catalog-actions"><button id="catalog-start" class="admin-button" type="button" disabled>Pokreni novi sken</button><button id="catalog-pause" class="admin-button secondary" type="button" disabled>Pauziraj aktivni sken</button><button id="catalog-refresh" class="admin-text-button" type="button">Osvježi stanje</button></div>
          </div>
          <p id="catalog-status" class="admin-status" role="status" aria-live="polite">Učitavam stanje skeniranja…</p>
          <div id="catalog-history" class="admin-form-footer" hidden>
            <label class="admin-label" for="catalog-job">Spremljene snimke (posljednjih 30)</label><select id="catalog-job"></select>
            <p id="catalog-message" class="admin-status" role="status" aria-live="polite"></p>
            <p id="catalog-scope" class="admin-hint"></p>
            <dl id="catalog-counts" class="admin-system-details" aria-label="Napredak skeniranja"></dl>
            <p id="catalog-coverage" class="admin-hint"></p>
            <div class="admin-actions catalog-actions"><button id="catalog-resume" class="admin-button secondary" type="button" disabled>Nastavi odabrani sken</button><label class="admin-checkbox"><input id="catalog-retry" type="checkbox"><span>Ponovi i neuspjele grane</span></label></div>
            <div class="admin-actions catalog-actions">
              <div id="catalog-downloads" class="admin-actions" role="group" aria-label="Preuzimanje snimke"></div>
              <button id="catalog-import" class="admin-button" type="button" aria-describedby="catalog-selected" hidden disabled>Dodaj odabrane u dashboard</button>
            </div>
            <p id="catalog-selected" class="admin-hint" role="status" hidden></p>
            <p id="catalog-import-status" class="admin-status catalog-import-notice" role="status"></p>
            <div id="catalog-browser" class="admin-form-footer" hidden>
              <h3>Uređaji u snimci</h3>
              <form id="catalog-search-form" class="catalog-search"><div class="admin-field"><label class="admin-label" for="catalog-search">Naziv, prostorija ili putanja</label><input id="catalog-search" type="search" maxlength="200" autocomplete="off"></div><button class="admin-button secondary" type="submit">Pretraži</button></form>
              <div class="admin-actions catalog-actions" role="group" aria-label="Odabir uređaja na trenutačnoj stranici">
                <button id="catalog-select-visible" class="admin-button secondary" type="button" disabled>Označi prikazane</button>
                <button id="catalog-clear-visible" class="admin-text-button" type="button" disabled>Poništi odabir prikazanih</button>
              </div>
              <p id="catalog-devices-status" class="admin-status" role="status"></p>
              <div id="catalog-devices" class="organization-items"></div>
              <div class="admin-actions"><button id="catalog-prev" class="admin-button secondary" type="button" disabled>Prethodnih 50</button><button id="catalog-next" class="admin-button secondary" type="button" disabled>Sljedećih 50</button></div>
            </div>
          </div>
        </div>
      </section>
      <footer class="admin-footer">IoT Electric · Administracija</footer>
    </main>
  </body>
</html>`);
}

module.exports = { sendAdminPage };
