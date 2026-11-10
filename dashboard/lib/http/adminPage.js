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
  </head>
  <body class="admin-page">
    <a class="admin-skip" href="#users">Preskoči na upravljanje korisnicima</a>
    <header class="admin-header">
      <div class="admin-container admin-header-inner">
        <div>
          <p class="eyebrow">IoT Electric</p>
          <h1>Administracija</h1>
          <p class="admin-header-description">Korisnici, pristup prostorijama i postavke sustava.</p>
        </div>
        <div class="admin-header-actions">
          <p class="admin-account">Administrator <strong id="admin-current-user">—</strong></p>
          <div class="admin-actions">
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
              <div class="admin-access-heading"><h4>Dozvoljene prostorije</h4><p class="admin-hint">Pravo pristupa vrijedi za pregled podataka, bez upravljanja uređajima.</p></div>
              <div class="admin-full-access">
                <label class="admin-checkbox"><input id="admin-all-rooms" type="checkbox"><span>Sve prostorije i uređaji bez prostorije</span></label>
                <p class="admin-hint">Uključuje i prostorije koje se naknadno dodaju.</p>
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
              <button id="admin-delete" class="admin-text-button danger" type="button" hidden>Izbriši korisnika</button>
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
      <footer class="admin-footer">IoT Electric · Administracija</footer>
    </main>
  </body>
</html>`);
}

module.exports = { sendAdminPage };
