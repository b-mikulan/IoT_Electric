# Stil sučelja dashboarda

Ovaj dokument opisuje vizualni jezik dashboarda: login, glavnu stranicu, tehnički prikaz, trendove i alarme, prijenos postavki i administraciju. Držite ga se pri svakoj promjeni sučelja. Ako se pravilo više ne slaže s kodom, ispravite ili kod ili ovaj dokument; nemojte ih ostaviti da se razilaze.

Izvor istine za vrijednosti je blok `:root` na vrhu `dashboard/public/shared/styles.css`. Tablice ispod su pregled; pri izmjeni tokena prvo mijenjajte CSS.

## Karakter: razvodni ormar

Sučelje izgleda kao prednja ploča električnog razvodnog ormara, a ne kao generički SaaS:

- **Kućište:** svijetlosiva podloga, bijeli paneli, tamni antracit za zaglavlje i tekst.
- **Boja znači stanje:** pojavljuje se samo kad nešto govori, po konvenciji signalnih lampica (IEC 60073):
  - plava je radnja koju korisnik može napraviti;
  - zelena je normalno;
  - žuta (jantarna) je odstupanje;
  - crvena je alarm.
- **Očitanja su glavni element:** velike DIN brojke s poravnatim znamenkama. Sve ostalo je mirno i podređeno njima.

Ako nova komponenta privlači pažnju više od očitanja ili alarma, smanjite je.

Ista ploča postoji i u **tamnoj temi** (ormar noću): podloga i paneli su tamni, tekst svijetao, a značenje boja ostaje isto. Tamna tema nije zasebni dizajn, nego drugi skup vrijednosti istih tokena (vidi "Tamna tema").

## Osnovna pravila

1. **Samo tokeni.** U CSS-u pišite `var(--ink)`, `var(--sp-4)`, `var(--r-md)` i slično, a ne hex vrijednosti ni proizvoljne piksele. Ako token nedostaje, dodajte ga u `:root` umjesto da ga zaobiđete.
2. **Plava je samo za radnju.** Gumbi, poveznice, odabir i fokus. Nikad za ukras, naslove ili stanje.
3. **Signalne boje su samo za stanje.** Zelena, jantarna i crvena nikad ne znače "gumb" ni "brend". Status uvijek ima i tekst ili ikonu, ne samo boju.
4. **Jedna veličina kontrole.** Gumbi i polja visoki su 40 px (`--control-h`); mali gumb 34 px (`--control-h-sm`).
5. **Malo dubine.** Kartice imaju rub i kontaktnu sjenu od 1 px. Stvarnu sjenu ima samo dijalog.
6. **Isto zaglavlje na svakoj stranici.** Vidi odjeljak "Zaglavlje stranice".
7. **Hrvatski, rečenični stil.** Bez velikih slova za cijele riječi i bez razmaknutih slova.

## Boje

### Površine i tekst

| Token | Vrijednost | Upotreba |
| --- | --- | --- |
| `--anthracite` | `#2A3136` | Zaglavlje stranice |
| `--canvas` | `#E9ECEB` | Podloga stranice (kućište) |
| `--surface` | `#FFFFFF` | Kartice, paneli, dijalozi, polja |
| `--surface-sunken` | `#F4F6F5` | Uvučene površine, polja samo za čitanje, oblačići poruka |
| `--surface-sunken-2` | `#E4E8E7` | Drugi stupanj uvlačenja |
| `--ink` | `#23292D` | Glavni tekst i naslovi |
| `--ink-2` | `#3E474C` | Sekundarni tekst koji mora ostati čitljiv |
| `--muted` | `#5A646A` | Opisi, oznake, metapodaci (oko 5,3:1 na podlozi) |
| `--muted-2` | `#7A8489` | Samo za veliki ili nebitan tekst i placeholder (u svijetloj temi oko 3,8:1 na bijeloj, ispod AA za mali tekst; tamna vrijednost prolazi 4,5:1) |
| `--line-soft` | `#E1E5E4` | Razdjelnici unutar panela, mreža grafa |
| `--line` | `#CBD1CF` | Rub kartice i panela |
| `--line-strong` | `#858F92` | Rub polja i sekundarnog gumba (najmanje 3:1 na bijeloj) |

### Radnja

| Token | Vrijednost | Upotreba |
| --- | --- | --- |
| `--action` | `#1C5D99` | Primarni gumb, poveznica, odabrana stavka, fokus |
| `--action-strong` | `#154A7B` | Hover primarnog gumba i poveznice |
| `--action-tint` | `#E3EDF7` | Pozadina odabira, hover sekundarnog gumba, naredba na čekanju |
| `--action-line` | `#9DBBD8` | Rub odabrane ili aktivne površine |
| `--focus` / `--focus-ring` | `#1C5D99` / 25 % | Prsten fokusa i označene kartice |

### Signalna stanja

Svako stanje ima četiri nijanse:

- osnovnu boju za lampicu ili rub;
- `-ink` za tekst;
- `-tint` za pozadinu;
- `-line` za rub obojene površine.

| Stanje | Osnovna | `-ink` | `-tint` | `-line` | Značenje |
| --- | --- | --- | --- | --- | --- |
| `--ok` | `#2E7D46` | `#1E6B3A` | `#E3F1E7` | `#9CCBA9` | Veza uživo, uređaj radi normalno |
| `--warn` | `#B7790A` | `#7A4E00` | `#FCF0D6` | `#E9C26A` | Demo podaci, pauzirano osvježavanje, simulacija, upozorenje |
| `--alarm` | `#C2362B` | `#9E2A22` | `#FBE5E3` | `#E7A39C` | Alarm, prekid veze, greška naredbe, brisanje |
| `--idle` | `#8A9498` | | | | Povezivanje, nepoznato, isključeno |

`--on-alarm` (`#FFFFFF`) je tekst na crvenoj ispuni (gumb za potvrdu brisanja), kao što je `--on-action` tekst na plavoj.

Za tekst na svijetloj podlozi koristite `-ink` nijansu, ne osnovnu boju; osnovna nema dovoljan kontrast za mala slova.

### Kontrole i kategorije

| Token | Vrijednost | Upotreba |
| --- | --- | --- |
| `--control-thumb` | `#FFFFFF` | Ručica prekidača i rub ručice slidera, uvijek na boji staze |
| `--select-arrow` | SVG strelica u boji `--muted` | Strelica padajućeg izbornika (`background-image: var(--select-arrow)`) |
| `--backdrop` | `rgba(20,26,30,.55)` | Zatamnjenje iza dijaloga |
| `--tone-rust`, `--tone-teal`, `--tone-ochre`, `--tone-violet`, `--tone-olive`, `--tone-neutral` | Prigušeni tonovi | Ikone jedinica (`visualForUnit`) i vrsta uređaja na karticama, svaki s `-tint` pozadinom |

Tonovi kategorija nisu signalne boje: ne znače stanje i ne koriste se za gumbe.

### Tamna tema

Tamne vrijednosti nalaze se u `styles.css` dvaput, s istim sadržajem:

- pod `:root[data-theme="dark"]`, koji postavlja `theme.js` prema izboru korisnika;
- pod `@media (prefers-color-scheme: dark)` za `:root:not([data-theme="light"])`, za stranicu bez JavaScripta.

Test `dashboard/test/theme.test.js` provjerava da su blokovi jednaki, da svaki token boje ima tamnu vrijednost i da glavni parovi tokena imaju dovoljan kontrast u obje teme.

| Token | Tamna vrijednost | Token | Tamna vrijednost |
| --- | --- | --- | --- |
| `--anthracite` | `#0C1012` | `--action` | `#78B0E6` |
| `--canvas` | `#151A1D` | `--action-strong` | `#A3C9EF` |
| `--surface` | `#1E2428` | `--action-tint` | `#1C3045` |
| `--surface-sunken` | `#191F22` | `--action-line` | `#3E6890` |
| `--surface-sunken-2` | `#2A3136` | `--on-action` | `#0B1724` |
| `--ink` | `#E4E9EB` | `--focus` | `#8DBEEE` |
| `--ink-2` | `#C6CED2` | `--control-thumb` | `#11161A` |
| `--muted` | `#9DA8AE` | `--idle` | `#7F8A90` |
| `--muted-2` | `#8A959B` | `--on-alarm` | `#1A0B0A` |
| `--line-soft` | `#2C3438` | `--backdrop` | `rgba(0,0,0,.65)` |
| `--line` | `#3A4449` | `--line-strong` | `#77838A` |

| Stanje | Osnovna | `-ink` | `-tint` | `-line` |
| --- | --- | --- | --- | --- |
| `--ok` | `#4FAF68` | `#80CF95` | `#173023` | `#2F6B43` |
| `--warn` | `#D6A13A` | `#EBC06A` | `#33290F` | `#7A5C1C` |
| `--alarm` | `#E8695E` | `#F59A90` | `#3A1D1B` | `#8C3D36` |

Pravila:

- **Isto značenje.** Plava je i dalje samo radnja, a zelena, jantarna i crvena samo stanje. Ne dodajte boju koja postoji samo u jednoj temi.
- **Svijetla plava, tamni tekst.** U tamnoj temi `--action` je svijetloplava, pa je tekst na plavoj ispuni taman. Tekst na ispuni zato uvijek piše `var(--on-action)` ili `var(--on-alarm)`, nikad `#fff`.
- **Uvučeno je tamnije.** U tamnoj temi `--surface-sunken` je tamniji od `--surface`. Hover i uvučene površine i dalje se razlikuju od kartice.
- **Zaglavlje ostaje tamno** u obje teme, pa iznimke za tekst i lampice u zaglavlju i dalje vrijede.
- **Kontrast.** Minimum je isti kao u svijetloj temi: 4,5:1 za tekst te 3:1 za fokus, rub polja i lampice. Novi par tokena dodajte u test.
- **Bez tvrdih boja u komponentama.** Komponenta koja piše hex ili `white` ne mijenja se s temom. Ako boja nedostaje, dodajte token u svijetli i u oba tamna bloka.

### Iznimke

- **Tamno zaglavlje.** Na antracitu tekst je `#fff` ili `rgba(255,255,255,.75)` za sporedni tekst. Lampice su svjetlije (`#5FBF7A`, `#F06A5E`), a pauza je `#F2B33D`.
- **Boje mjernih jedinica.** `visualForUnit` u `dashboard/public/dashboard/app.js` daje ikonama widgeta tokene `--tone-*` prema jedinici (temperatura, vlaga, snaga, napon). One nisu signalne boje i ne smiju biti zasićene.
- **Grafovi.** `dashboard/public/trends/trends.js` čita boje iz CSS tokena (`--ink`, `--muted`, `--line-soft`) i ponovno crta graf na događaj `iot-themechange`. Novi graf treba raditi isto.
- **DataTables.** Tablice na stranici trendova dobivaju boje kroz `--dt-*` varijable u `trends.css`, mapirane na tokene. Tako tablica izgleda jednako bez obzira na to dolazi li tamna tema iz izbora ili iz sustava.
- **Stara imena.** `--brand`, `--brand-dark`, `--brand-soft`, `--error` i `--border` su aliasi. U novom kodu koristite nova imena.

## Tipografija

| Token | Font | Upotreba |
| --- | --- | --- |
| `--font-din` | Bahnschrift, DIN Alternate, … | Naslovi `h1`–`h4`, naziv branda, naslovi kartica, očitanja, brojke |
| `--font-ui` | Segoe UI, Roboto, … | Tekst, oznake, gumbi, polja |

Bahnschrift je DIN font koji dolazi s Windowsima, pa ne treba webfont. CSP (`default-src 'self'`) ionako blokira vanjske fontove. Ne dodajte Google Fonts ni drugi CDN.

| Token | Veličina | Upotreba |
| --- | --- | --- |
| `--fs-xs` | 12 px | Najmanji dopušteni tekst: metapodaci, ID točke, oznake polja |
| `--fs-sm` | 13 px | Sporedni tekst, status u zaglavlju, opisi |
| `--fs-base` | 14 px | Osnovni tekst sučelja i gumba |
| `--fs-md` | 16 px | Tekst za čitanje, veći odlomci |
| `--fs-lg` | 20 px | Naslov odjeljka na mobitelu |
| `--fs-xl` | 26 px | Naslov odjeljka (`h2`), naslov na login stranici |
| `--fs-title` | 28–38 px | `h1` u zaglavlju stranice |
| `--fs-reading` | 40 px | Glavno očitanje na kartici |

Pravila:

- **Ne manje od 12 px.** Tokeni su u `rem`, a `:root { font-size: 100% }` u `styles.css` vraća osnovu na 16 px, jer je Materialize smanjuje na 14–15 px. Ne uklanjajte to pravilo.
- **Naslovi** imaju težinu 600 i visinu retka 1.2.
- **Brojke** (očitanja, vremena, tablice) koriste `font-variant-numeric: tabular-nums`, da ne skaču pri osvježavanju.
- **Bez `text-transform: uppercase`** i bez razmaknutih velikih slova. `.eyebrow` je kratka kontekstualna linija u rečeničnom stilu i koristi se samo kad stvarno daje kontekst.
- **Duljina retka** u odlomcima do oko 75 znakova.

## Razmak, oblik i dubina

**Razmak.** Koristi se ljestvica `--sp-1` do `--sp-7`: 4, 8, 12, 16, 24, 32 i 48 px.

- Unutar kontrole: 8–12 px.
- Između srodnih elemenata: 12–16 px.
- Između odjeljaka: 24–32 px.

**Radijusi:**

| Token | Radijus | Za što |
| --- | --- | --- |
| `--r-sm` | 4 px | Gumbi, polja, chipovi, oznake |
| `--r-md` | 8 px | Kartice i paneli |
| `--r-lg` | 12 px | Dijalozi |

Potpuno okrugli su samo lampice, prekidači i točke statusa. Radijus prati hijerarhiju; ne stavljajte isti radijus na sve.

**Sjene:**

| Token | Za što |
| --- | --- |
| `--shadow-card` | Kartice |
| `--shadow-raised` | Login panel |
| `--shadow-dialog` | Samo dijalozi |

Ne dodajte gradijente, staklo ni podizanje kartice na hover. Hover mijenja boju ruba, ne položaj.

**Širina.** Sadržaj je najviše `--page-max` (1200 px) širok, s 24 px ruba sa svake strane na desktopu i 16 px na mobitelu. Zaglavlje, sadržaj i podnožje dijele istu širinu preko pravila `:is(.page-header-inner, .dashboard-shell, .app-footer).container` u `styles.css`; stranice ga ne ponavljaju.

## Zaglavlje stranice

Sve stranice osim logina koriste isto zaglavlje; uzor je administracija. Tamna antracitna traka sadrži:

- lijevo: brand, naslov i kratki opis;
- desno: statusni redak i radnje stranice.

```html
<header class="app-header page-header">
  <div class="container page-header-inner">
    <div class="page-header-copy">
      <a class="brand" href="/" aria-label="IoT Electric">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="brand-name">IoT Electric</span>
      </a>
      <h1>Naslov stranice</h1>
      <p class="page-header-description">Jedna rečenica o tome čemu stranica služi.</p>
    </div>
    <div class="page-header-side">
      <div class="page-header-status"><!-- veza, demo oznaka, prijavljeni korisnik --></div>
      <div class="page-header-actions"><!-- gumbi stranice --></div>
    </div>
  </div>
</header>
```

Pravila:

- **Prekidač teme** (svijetla, tamna, sustav) zadnji je element u `.page-header-actions` svake stranice. Na prijavi i postavljanju lozinke stoji ispod panela. Dodaje ga `theme.js`, pa ga ne pišite u HTML. Odabrana opcija je ispunjena i ima `aria-pressed="true"`.
- **Naslov i radnje stranice su u traci**, a ne ispod nje. Nema zasebnog bloka `.intro` u sadržaju.
- **Statusni redak** se sam skriva kad su mu sva djeca skrivena.
- **Rub veze.** Donji rub trake (3 px) pokazuje stanje veze preko klasa `.connection-dot.is-*`:
  - sivo: povezivanje, ili stranica bez indikatora veze;
  - zeleno: uživo;
  - jantarno: pauzirano. Pauza vrijedi za cijeli dashboard, pa je rub jantaran na svakoj stranici čiji gumb `#refresh-pause` ima `.is-paused`;
  - crveno: prekid (ima prednost pred pauzom).

  Ne dodajte drugi indikator veze.
- **Gumbi na traci.** Sekundarni gumbi imaju bijeli obrub na prozirnoj pozadini; primarni ostaju plavi. Najviše jedan primarni gumb po zaglavlju.
- **Mobitel.** Ispod 760 px traka se slaže okomito i poravnava lijevo. Gumbi s ikonom smiju sakriti tekst (`span`), ali tada moraju imati `aria-label`.

## Komponente

### Gumbi

| Vrsta | Klase | Izgled | Kada |
| --- | --- | --- | --- |
| Primarni | `.btn`, `.btn.filled`, `.admin-button`, `.general-button`, `.trends-open` | Plava ispuna, bijeli tekst | Glavna radnja u kontekstu, najviše jedna po grupi |
| Sekundarni | `.btn.outlined`, `.admin-button.secondary`, `.general-button.secondary`, `.general-settings-open`, `.refresh-pause` | Bijelo, jaki rub, plavi hover | Ostale radnje, povratak, postavke |
| Tihi | `.btn-flat`, `.btn.text`, `.admin-text-button`, `.dc-reset` | Samo tekst | Odustani, poništi filter, sporedne poveznice |
| Opasni | `.danger-action`, `.settings-delete`, `.admin-text-button.danger` | Crveni tekst ili ispuna u potvrdi | Brisanje i nepovratne radnje |

Pravila:

- **Tekst gumba** je glagol koji kaže što će se dogoditi ("Spremi", "Dodaj korisnika", "Natrag na dashboard"). Ne pišite "U redu" ni "Pošalji" ako postoji precizniji glagol.
- **Ikone** su linijske SVG ikone od 18–20 px s `stroke="currentColor"`. Ne koristite emoji u gumbima ni strelice u tekstu.
- **Onemogućen gumb** ima `opacity: .5`. Ako razlog nije očit, napišite ga uz gumb.
- **Specifičnost.** Pravilo za "goli" `.btn` ima specifičnost jedne klase (`:where()`), pa ga crvena i onemogućena stanja nadjačavaju. Ne podižite mu specifičnost.
- **Opasne radnje** uvijek traže potvrdu unutar aplikacije prije izvršenja: u dijalogu (`.settings-delete-confirmation`) ili uz sam gumb (`.admin-delete-confirmation`). Ne koristite `window.confirm`.

### Polja i obrasci

- **Polje:** visina 40 px, radijus 4 px, pozadina `--surface` i rub `--line-strong`. U fokusu rub je `--action` uz globalni prsten.
- **Padajući izbornik** s vlastitom strelicom koristi `background-image: var(--select-arrow)`, ne SVG s upisanom bojom.
- **Polje samo za čitanje:** pozadina `--surface-sunken`, tekst `--muted`.
- **Oznaka** stoji iznad polja: `--fs-xs`, težina 600, boja `--muted`. Ne koristite placeholder umjesto oznake.
- **Polja u dijalozima** dijele jedno pravilo (`.discovery-dialog :is(input, select)` u `styles.css`). Novi dijalog ga dobiva automatski, pa ne pišite vlastiti stil polja.
- **Prekidači i potvrdni okviri** koriste plavu radnje kao `accent-color` (`--action` ili njegov alias `--brand`). Ručica prekidača i rub ručice slidera su `--control-thumb`.

### Dijalozi

- **Element:** nativni `<dialog>` s `showModal()`, radijusom `--r-lg` i sjenom `--shadow-dialog`.
- **Gumb za zatvaranje:** `.dialog-close` gore desno.
- **Radnje** su dolje desno: tihi gumb lijevo, primarni desno, opasni gumb odvojen na lijevi rub. Na mobitelu se radnje slažu okomito, s primarnom na vrhu.
- **Zajednički dijalozi** glavne stranice i tehničkog prikaza nalaze se u `dashboard/public/partials/`. Mijenjajte ih tamo, ne u pojedinačnim stranicama.

### Kartice uređaja

- **Kartica:** bijela, rub `--line`, radijus `--r-md`, unutarnji razmak 22 px (20 px na mobitelu).
- **Naslov** je DIN; **očitanje** je DIN 40 px s `tabular-nums`. Jedinica je u zasebnom `span.dc-metric-unit`, manja i `--muted`; tekst elementa ostaje „24,1 °C”.
- **Oznaka izvora:** "Simulacija" je jantarna oznaka s lampicom, a "Uživo" zelena. Demo i simulirani podaci uvijek moraju biti vidljivo označeni.
- **Naredba na čekanju** koristi `--action-tint`.
- **Poruke naredbe** (`.dc-command-status`) su oblačić s lijevim rubom od 3 px:
  - plavi rub za informaciju;
  - crveni rub i `--alarm-tint` za grešku (`.dc-command-error`).

  Prihvaćena naredba i potvrđeno očitanje su dvije različite poruke; ne spajajte ih.
- **Odabrana kartica** ima rub `--action` i prsten `--focus-ring`.
- **Fallback vrijednosti.** `deviceCards.css` piše svaki token s rezervnom vrijednošću, npr. `var(--ink, #23292D)`, jer korisnički vodič (`tools/user-guide/buildDemo.cjs`) ugrađuje tu datoteku bez `styles.css`. Kad mijenjate token, promijenite i fallback. Fallback je uvijek svijetla vrijednost. Tamne vrijednosti ne pišite u `deviceCards.css`; tema ih daje kroz tokene.

### Statusni elementi

| Element | Izgled | Kada |
| --- | --- | --- |
| Status zaglavlja (`.connection`) | Lampica (`.connection-dot`, krug od 10 px), stanje podataka i način upravljanja (`.connection-mode`), npr. "Podaci uživo · Stvarno upravljanje" ili "· Samo pregled" | Stvarni podaci. Način upravljanja je samo ovdje, ne i iznad kartica |
| Demo oznaka (`.demo-badge`) | Jantarna, lampica i tekst "Demo podaci · simulacija upravljanja" | Uvijek kad podaci nisu s kontrolera; tada zamjenjuje status zaglavlja |
| Chip izvora (`.telemetry-source.chip`) | Jantarni za demo ili nepoznat izvor, zeleni (`.is-live`) za kontroler | Izvor podataka na stranici trendova; postavlja ga svaki odgovor trendova (`demoMode`) |
| Obavijest | Uvučena površina s lijevim rubom u boji stanja | Rezultat radnje, upozorenje, greška |

### Paneli i odjeljci

- **Naslov odjeljka** je `h2` u DIN fontu, `--fs-xl`, s linijskom ikonom u `--muted`.
- **Na stranici trendova** ispod naslova je crta od 2 px u boji `--ink`. To je uzor za nove podatkovne panele.
- **Koraci** (npr. na stranici prijenosa) dobivaju brojeve samo kad je redoslijed stvaran. Ne numerirajte odjeljke radi ukrasa.

## Tekst

- **Jezik.** Sve sučelje je na hrvatskom, uključujući `aria-label`, `title` i poruke grešaka.
- **Pisanje velikih slova.** Rečenični stil: "Dodaj korisnika", ne "Dodaj Korisnika" ni "DODAJ KORISNIKA".
- **Nazivi radnji** su jednaki kroz cijeli tok. Ako gumb kaže "Spremi", poruka kaže "Spremljeno".
- **Poruke grešaka** kažu što se dogodilo i što napraviti, bez isprika i bez nejasnih fraza. Primjer: "Kontroler nije odgovorio. Provjeri vezu pa pokušaj ponovno."
- **Prazna stanja** kažu što korisnik može napraviti ("Nema prostorija. Dodaj prvu prostoriju.").
- **Tekst o kojem ovise JavaScript i testovi.** Prije promjene natpisa pretražite `dashboard/public/` i `dashboard/test/` za taj tekst.

## Pristupačnost i responzivnost

Ovo je minimum za svaku promjenu, ne dodatak:

- **Fokus.** Fokus mora biti vidljiv svugdje. Globalni `:focus-visible` crta plavi prsten od 2 px s odmakom od 2 px; na tamnom zaglavlju prsten je bijel. Ne pišite `outline: none` bez zamjene.
- **Kontrast.** Tekst najmanje 4,5:1, veliki tekst i rubovi kontrola najmanje 3:1. `--muted` je najsvjetlija boja za mali tekst.
- **Smanjeno kretanje.** `prefers-reduced-motion` gasi prijelaze i animacije (pravilo na dnu `styles.css`). Nova animacija mora poštovati to pravilo.
- **Kretanje.** Kretanje odgovara na korisnikovu radnju; nema animacija pri učitavanju stranice.
  - Gumbi i polja: prijelaz boje 120–160 ms.
  - Prekidači i kontrole na kartici: smiju koristiti `--dc-spring`, do oko 400 ms.
  - Stalna animacija: samo indikator rada (vrtnja pri osvježavanju).
- **Mobitel.** Na 375 px nema horizontalnog pomicanja stranice. Široke tablice pomiču se unutar vlastitog spremnika.
- **Veličina kontrola.** Glavne kontrole visoke su najmanje 40 px. Mali gumb (34 px) i male poveznice koristite samo u gustim popisima i alatnim trakama.
- **Ikone.** Gumb sa samo ikonom ima `aria-label`; ukrasne ikone imaju `aria-hidden="true"`.
- **Stanje.** Stanje nikad nije označeno samo bojom; uvijek ide i tekst.

## Tehnička pravila

- **Bez novih alata.** Nema build koraka, frameworka ni preprocesora. CSS je običan CSS, a JS je postojeći modulski stil u `dashboard/public/`.
- **Gdje stilovi žive:**

  | Datoteka | Sadržaj |
  | --- | --- |
  | `shared/styles.css` | Tokeni (svijetli i tamni), zaglavlje, gumbi, dijalozi, login, globalni fokus i kretanje |
  | `shared/theme.js` | Izbor teme, prekidač teme i događaj `iot-themechange` |
  | `shared/dashboardTheme.css` | Mapiranje Materialize varijabli za stranice s temom (`.app-theme`) |
  | Stranični CSS (`dashboard/`, `admin/`, `trends/`, `transfer/`, `devices/`) | Samo raspored i komponente te stranice |

- **Pravila za stranični CSS.** Ne ponavljajte zajednička pravila u straničnom CSS-u. Ako dvije stranice trebaju isto, premjestite to u `styles.css`.
- **Materialize.** Materialize čita `--md-sys-color-*-light` i `--btn-*` varijable, koje su u `:root` mapirane na naše tokene. Stilizirajte preko tokena, a ne nadjačavanjem pojedinih Materialize klasa, osim kad nema druge mogućnosti.
- **Što ne smijete mijenjati.** ID-jevi, `data-*` atributi, ARIA atributi i klase koje koristi JavaScript ne mijenjaju se radi stila. Dodajte novu klasu umjesto da preimenujete postojeću.
- **Specifičnost.** Držite je niskom. Za iznimke koristite `:where()`; `!important` samo uz komentar zašto.
- **Tema prije iscrtavanja.** Svaka nova stranica učitava `<script src="/theme.js"></script>` u `<head>`, bez `defer`, prije prvog stylesheeta. CSP ne dopušta inline skripte. Izbor se pamti u `localStorage` (`iotElectric.dashboard.theme`), a kod mora raditi i kad pohrana nije dostupna.

## Što izbjegavati

- Hex boje i proizvoljne piksele umjesto tokena.
- Plavu za stanje ili zelenu za gumb.
- Gradijente, staklene efekte, podizanje kartica na hover i dekorativne sjene.
- Velika slova i razmaknuta slova u oznakama.
- Emoji i strelice (`→`, `←`) u tekstu gumba.
- Drugi naslov stranice ispod zaglavlja ili gumbe stranice izvan trake.
- Brojeve ili `eyebrow` iznad svakog naslova kad ne nose informaciju.
- Vanjske fontove i CDN resurse (CSP ih blokira).
- Slanje stvarnih naredbi uređajima radi provjere izgleda.

## Provjera prije commita

1. Pokrenite dashboard s `DEMO_MODE=true` i privremenom bazom (`DASHBOARD_DB_FILE`), nikad na produkcijskoj bazi.
2. Pregledajte svaku izmijenjenu stranicu na desktopu (1440 px) i na mobitelu (375 px), u svijetloj i tamnoj temi: nema horizontalnog pomicanja, zaglavlje se ispravno slaže.
3. Prođite tipkovnicom (Tab) kroz izmijenjeni dio i provjerite vidljiv fokus.
4. Provjerite stanja: povezano, pauzirano, prekid veze, demo, onemogućeno, greška i otvoreni dijalozi.
5. Pokrenite `npm run test:dashboard`.
6. Ako ste mijenjali `deviceCards.css`, ponovno izgradite vodič s `node tools/user-guide/buildDemo.cjs`.
7. Ako ste dodali ili promijenili token ili pravilo, ažurirajte ovaj dokument.
