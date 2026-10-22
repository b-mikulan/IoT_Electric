# Pravila kartica uređaja i stvarnog upravljanja

Kartice koriste eksplicitna pravila prilagođena pregledanoj EBO instalaciji. Ne koriste Ontology Graph niti pretpostavljaju da EWS sam opisuje kompletan uređaj. Ista logika `dashboard/public/deviceModel.js` izvršava se u pregledniku i na backendu.

Kartice uređaja glavni su prikaz dashboarda. Sirovi widgeti i obrazac ručnog upisa skriveni su u početno zatvorenom odjeljku **Tehnički prikaz vrijednosti** ispod kartica. Točke ostaju konfigurirane i nastavljaju se dohvaćati; ne mijenjamo njihovo polje `visible`, jer ono utječe i na kartice uređaja.

Zupčanik otvara **Postavke kartice**: naziv cijele kartice, prostoriju, glavno očitanje i do 12 sekundarnih očitanja. Moguće je odabrati postojeću ili novu sobu, premjestiti uređaj u drugu sobu, ukloniti dodjelu ili vratiti automatski odabir. Glavno očitanje može dolaziti s bilo koje vidljive konfigurirane točke, uključujući drugi uređaj. Sekundarna očitanja pripadaju isključivo istom uređaju prema punoj putanji vlasnika, uključujući njegove konfigurirane reference; to provjerava i API pri spremanju. Ranije spremljena sekundarna očitanja drugih uređaja izostavljaju se iz prikaza i izbora te se uklanjaju iz postavke pri sljedećem spremanju kartice. Odabir izvora prikaza ne mijenja naredbene točke, tip kartice, dozvole ni vezu s kontrolerom. Nedostupna spremljena vlastita točka prikazuje se kao nedostupna; glavno očitanje ne ponavlja se među sekundarnima.

Postavke funkcionalnih kartica trajno se spremaju u zaseban **device-widgets.json** uz `WIDGETS_FILE`. Datoteka se automatski stvara i dopunjava za pronađene pune ključeve vlasnika uređaja. Koristi objekt `{version:1,devices:[...]}`; svaki zapis ima `key`, `label`, `room`, `primaryPointId`, `primaryUnit` i `secondaryPointIds`. Vrijednost `null` koristi automatsku postavku, `room:""` znači izričito bez sobe, a `secondaryPointIds:[]` znači bez sekundarnih očitanja. Prethodne postavke uklonjenog vlasnika ostaju sačuvane za njegovo ponovno dodavanje. Trenutačna očitanja i kontrolerske dozvole ne spremaju se ovdje.

Mjernu jedinicu **glavnog očitanja** moguće je odabrati uz njegov izvor: automatski, bez jedinice ili vlastiti tekst do 40 znakova. `primaryUnit:null` (ili izostavljeno polje u starijoj datoteci/zahtjevu) zadržava postojeći automatski prikaz, `primaryUnit:""` uklanja jedinicu, a neprazan tekst prikazuje se doslovno uz broj. To je samo oznaka prikaza: vrijednosti se ne preračunavaju, sekundarna očitanja i kontrolne jedinice ne mijenjaju se, a izvorni metapodaci ostaju sačuvani. Primjerice, upis `°F` ne pretvara izmjerene °C u °F. Automatski `%` za položaj rolete potječe iz pravila u `normalizePoint` kad EWS nije dao jedinicu; za `GrpPct` dolazi iz pravila prikaza potvrđenog raspona 0–100. Sam znak `%` nije dokaz da ga je poslao kontroler.

Put se može odrediti kroz `DEVICE_WIDGETS_FILE`, odnosno `DASHBOARD_DEVICE_WIDGETS_FILE` u Composeu. Zadani `/app/config/device-widgets.json` nalazi se u već montiranom trajnom config direktoriju. Za inline `WIDGETS_JSON` treba izričit put datoteke kartica. Spremanje je serijalizirano i koristi privremenu datoteku pa zamjenu; neuspjeh čuva posljednje spremljeno stanje. Neispravna JSON datoteka prijavljuje se bez prepisivanja. API `GET/POST /api/devices/settings` čita i sprema kartice; SSE `device-settings` osvježava ostale otvorene dashboarde.

Gumb **Postavke funkcija uređaja** otvara raniji dijalog pojedinih raw točaka. **Funkcija uređaja** nudi najprije naredbe pa očitanja. Ti nazivi, jedinice i dozvole ostaju u postojećem `widgets.json`; na potvrđenoj naredbi može se uključiti **Dozvoli upis vrijednosti**, dok je opcija zaključana za očitanja. Samo otvaranje i spremanje postavki ne šalje naredbu kontroleru. Ako trajne postavke kartica nisu dostupne, zupčanik i dalje može otvoriti ranije postavke funkcija kada je raw uređivanje omogućeno.

Kontrola lamela prikazuje naziv **Kut lamela**, ali i dalje šalje provjerenu naredbu `BlndSlt` u rasponu 0–100 %. `BlndAng` ostaje povratno očitanje; naziv kontrole ne uvodi pretpostavku da su vrijednosti u stupnjevima. Tipke i prekidači imaju blage elastične prijelaze, koji se isključuju uz korisničku postavku smanjenog kretanja.

## 1. Kojoj kartici pripada točka

`widgetGrouping.js` izvodi vlasnika iz pune EWS putanje. Za `01/.../L3307/Values/LtPct` vlasnik je cijela putanja do `L3307`. Organizacijske mape `Values`, `Points`, `External Bindings`, `Logs`, `Alarms` i `Graphics` pripadaju tom vlasniku. Tako AC309 okuplja Input/Holding Registers, a B301 okuplja svoje Values i Points. Za direktna svojstva Modbus uređaja postoji prepoznavanje putanje do konkretnog Modbus uređaja.

Ključ kartice zadržava server, kontroler i cijelu putanju vlasnika. Dva `S3201` na RP31 i RP32 ostaju zasebna. Točke neposredno pod `Zones/Z312/Values` čine pregled zone, ne dokaz novog fizičkog uređaja. Ručno polje `group` starih widgeta ne mijenja ove kartice.

## 2. Što funkcija znači

U prepoznatim granama Values, Points i External Bindings točan završni naziv određuje ulogu. To su konvencije pregledanog projekta, a ne univerzalna imena propisana EWS standardom. Opis pomaže prikazu i određivanju opcija, ali sam tekst opisa ne provjerava ispravnost naziva funkcije.

| Funkcije | Uloga | Postupak |
| --- | --- | --- |
| `LtPct`, `GrpPct` | Zadana svjetlina pojedinačnog svjetla ili grupe | Naredba |
| `LtVal` | Povratno očitanje rasvjete | Prikaz |
| `BlndPos`, `BlndSlt` | Zadani položaj rolete i lamela | Naredbe s korisnički potvrđenim rasponom 0–100 % i korakom 1 % |
| `BlndVal`, `BlndAng`, `BlndSts` | Očitani položaj, kut i stanje | Prikaz / detalji |
| `BlndBtnUp`, `BlndBtnDn` | Signali fizičkih tipki | Detalji; ne šaljemo ih kao naredbe |
| `RmTmp`, `RmRh`, `RmCO2` | Temperatura, vlaga, CO₂ | Prikaz |
| `EffSpt` | Zadana temperatura | Naredba uz poznatu temperaturnu jedinicu |
| `FanSpd`, `OnOffMd`, `SysMdCtrl` | Ventilator, napajanje, zadani način rada klime | Naredbe uz potvrđene opcije |
| `SysMdSts` | Stvarni način rada klime | Prikaz; ne služi za zadavanje načina |
| `LtLvl`, `OccSts` | Osvijetljenost, prisutnost | Prikaz |
| `DevSta`, `IduSts`, `DevErr`, `EcgFlt`, `LtFlt`, `FilAlm`, `IduAlm` | Statusi i kvarovi | Dijagnostika u detaljima |
| `LtCol`, `DevCol`, `ScrnCol` | Boje grafičkog prikaza | Detalji; nisu potvrđeno RGB upravljanje |

Nepoznato ime može preko jedinice postati samo očitanje: °C/°F/K → temperatura, %RH → vlaga, lx/lux → osvijetljenost, ppm → opća koncentracija. Sam ppm ne dokazuje CO₂. Ostale točke ostaju u detaljima s nepoznatom namjenom.

Opcije naredbi prvenstveno dolaze iz EWS enuma. Ako ih nema, parser prepoznaje izričit popis poput `0=Heat,1=Cool` u opisu. Nepotvrđene opcije se ne nude. Sama oznaka `Writeable=1` nikad ne pretvara očitanje ili kvar u naredbu.

## 3. Duplikati i pomoćna svojstva

`11/.../LtPct/Value` spaja se samo ako postoji točno odgovarajući `01/.../LtPct` u konfiguraciji. Naziv `Plan-`, jednaka trenutna vrijednost ili jednako kratko ime nisu dokaz duplikata. Nepovezana Value referenca ostaje nepoznata. Ako je izvor skriven, vidljiva referenca može predstavljati očitanje, ali nije dopušten izvor za stvarni upis.

`Reliability`, `OutOfService`, `ActiveCommandPriority`, `TotalRecordCount`, `EventState` i tehnička svojstva uređaja ostaju u dijagnostici te se povezuju s izvornom točkom punom putanjom. Ništa se ne briše s kontrolera.

Ako više različitih naredbi dobije istu ulogu unutar jednog vlasnika, model zadržava informacije za prikaz, ali blokira stvarni upis zbog dvosmislenog izvora. To treba riješiti eksplicitnim mapiranjem, ne redoslijedom u konfiguraciji.

## 4. Tip i sadržaj kartice

Prioritet tipova je: zona → roleta → klima → rasvjeta → senzor → generički uređaj. Položaj/lamela određuje roletu; setpoint, ventilator ili način rada određuju klimu; svjetlina određuje rasvjetu. `GrpPct` razlikuje grupu rasvjete.

Prednja strana koristi predloške: svjetlo prikazuje povratnu razinu i kontrolu zadane razine; klima temperaturu, vlagu, CO₂, stvarni način rada i dostupne naredbe; roleta očitani položaj te naredbe položaja/lamela; senzor i zona mjerne podatke. Korisna klasifikacija ne jamči prikaz svakog podatka na prednjoj strani: primjerice stanje/kut rolete i prisutnost u grupi rasvjete dostupni su u detaljima. Predloške možemo proširivati bez promjene vezanja izvora.

## 5. Prostorija

Učitava se Description točne zonske putanje. Za uređaj se bira najduži odgovarajući predak iz poznatih zona. Prazni i placeholder opisi se odbacuju. Rasvjeta pod potvrđenim RP32/Z312 dobiva Kitchen. AC309 i B301 nemaju potvrđenu sobu. Isti kod Z312 na drugom kontroleru ne prenosi naziv sobe automatski.

## 6. Stvarni upis

Klik šalje `POST /api/devices/write` s punim `widgetId` i vrijednošću. Backend provjerava da točka postoji, da je vidljiva, da ima `writable:true`, da je izvorna `01` naredba i da vezanje nije dvosmisleno. Zatim radi novi `GetItems` s `metadata:true`, izvan cachea za prikaz: mora dobiti upravo traženi ID, izričit Writeable, valjano očitanje i State 0 (Good). Po potrebi učitava enum. Neuspjeh svježe provjere blokira upis.

Vrijednost se provjerava prije slanja postojećem middleware `POST /api/values/write`, odnosno EWS SetValues:

- Rasvjeta: broj u rasponu 0–100, prema pregledanoj funkciji LtPct/GrpPct.
- Klima: samo potvrđene enum opcije.
- Temperatura: **politika ovog testnog dashboarda** je 5–35 °C, odnosno 41–95 °F ili 278,15–308,15 K. To nisu granice dobivene iz EWS-a niti jamstvo da ih konkretna klima podržava. UI mijenja vrijednost u koracima 0,5; kontroler može odbiti vrijednost i unutar tog raspona.
- Položaj rolete (`BlndPos`) i lamela (`BlndSlt`): korisnik je ispravio raspon na 0–100 % za obje naredbe. Klizači koriste korak 1 % i šalju izravnu postotnu vrijednost, npr. 36; ne dijele je sa 100. Backend odbija vrijednosti izvan raspona. Numerička očitanja se ne preračunavaju; položaj se označava znakom % ako server nije dao jedinicu. Izvorna jedinica ostaje u detaljima metapodataka, a očitani kut lamela (`BlndAng`) zadržava izvornu skalu. Značenje krajnjih položaja nije pretpostavljeno.

Provjera se primjenjuje i na poznate naredbe poslane kroz stari `/api/write`, kako stari obrazac ne bi zaobišao pravila. Demo ostaje lokalna simulacija.

Slider šalje nakon završene promjene, ne za svaki pomak. Dok zahtjev traje, ista kartica ne šalje drugi. Potvrda znači da je kontroler prihvatio naredbu; stvarni prikaz mijenja tek novo očitanje. Greška ili timeout ne izazivaju automatsko ponavljanje. Ponovno provjeri očitanje prije novog pokušaja.

Dvije sekunde nakon svake potvrde uspješnog upisa backend ponovno čita sve konfigurirane vrijednosti, uključujući povezane povratne vrijednosti i skrivene točke, te šalje rezultate otvorenim dashboardima. Ako je ranije čitanje još u tijeku, prvo završava ono, a zatim počinje novo čitanje. Redovno periodično osvježavanje nastavlja raditi neovisno o tome. Odbijeni i neuspjeli upisi ne zakazuju dodatno osvježavanje. Rok od dvije sekunde počinje potvrdom prihvata naredbe; to nije zasebna potvrda da je fizički uređaj završio radnju.

State 2 (Forced), nedostupnost i greške blokiraju naredbu. Ne šaljemo Force/Unforce. Svježa provjera i upis dva su zasebna EWS zahtjeva: EWS ovdje ne daje atomsku provjeru i upis, pa promjena stanja između njih ostaje moguća.

U lokalnoj konfiguraciji za prvi test ciljano su uključene izvorne naredbe pet svjetala/grupe i četiri funkcije klime. Forsirana funkcija ostaje zaključana dok ne postane Good. Novi widgeti i dalje se uvoze bez dozvole za pisanje. Konfiguracija se učitava pri pokretanju servisa; ručne promjene datoteke zahtijevaju ponovno pokretanje dashboarda.
