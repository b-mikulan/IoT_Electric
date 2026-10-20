# Pravila kartica uređaja i stvarnog upravljanja

Kartice koriste eksplicitna pravila prilagođena pregledanoj EBO instalaciji. Ne koriste Ontology Graph niti pretpostavljaju da EWS sam opisuje kompletan uređaj. Ista logika `dashboard/public/deviceModel.js` izvršava se u pregledniku i na backendu.

Kartice uređaja glavni su prikaz dashboarda. Sirovi widgeti i obrazac ručnog upisa skriveni su u početno zatvorenom odjeljku **Tehnički prikaz vrijednosti** ispod kartica. Točke ostaju konfigurirane i nastavljaju se dohvaćati; ne mijenjamo njihovo polje `visible`, jer ono utječe i na kartice uređaja.

Zupčanik na kartici otvara postavke njezinih funkcija. Odabir **Funkcija uređaja** nudi najprije naredbe, zatim očitanja. Postavke se spremaju za odabranu točku; na naredbi se može uključiti **Dozvoli upis vrijednosti**, dok je ta opcija zaključana za očitanja. Naziv kartice i pronađena prostorija i dalje proizlaze iz modela uređaja. Zupčanik je dostupan kad instalacija podržava spremanje postavki u `WIDGETS_FILE`; samo otvaranje ili spremanje dijaloga ne šalje naredbu kontroleru.

## 1. Kojoj kartici pripada točka

`widgetGrouping.js` izvodi vlasnika iz pune EWS putanje. Za `01/.../L3307/Values/LtPct` vlasnik je cijela putanja do `L3307`. Organizacijske mape `Values`, `Points`, `External Bindings`, `Logs`, `Alarms` i `Graphics` pripadaju tom vlasniku. Tako AC309 okuplja Input/Holding Registers, a B301 okuplja svoje Values i Points. Za direktna svojstva Modbus uređaja postoji prepoznavanje putanje do konkretnog Modbus uređaja.

Ključ kartice zadržava server, kontroler i cijelu putanju vlasnika. Dva `S3201` na RP31 i RP32 ostaju zasebna. Točke neposredno pod `Zones/Z312/Values` čine pregled zone, ne dokaz novog fizičkog uređaja. Ručno polje `group` starih widgeta ne mijenja ove kartice.

## 2. Što funkcija znači

U prepoznatim granama Values, Points i External Bindings točan završni naziv određuje ulogu. To su konvencije pregledanog projekta, a ne univerzalna imena propisana EWS standardom. Opis pomaže prikazu i određivanju opcija, ali sam tekst opisa ne provjerava ispravnost naziva funkcije.

| Funkcije | Uloga | Postupak |
| --- | --- | --- |
| `LtPct`, `GrpPct` | Zadana svjetlina pojedinačnog svjetla ili grupe | Naredba |
| `LtVal` | Povratno očitanje rasvjete | Prikaz |
| `BlndPos`, `BlndSlt` | Zadani položaj rolete i lamela | Naredbe s korisnički potvrđenim rasponom 0–1 i korakom 0,01 |
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
- Položaj rolete (`BlndPos`) i lamela (`BlndSlt`): korisnik je potvrdio raspon 0–1 za obje naredbe. Klizači koriste korak 0,01 i šalju izvornu vrijednost, npr. 0,36; ne pretvaraju je u 36 ili postotak. Backend odbija vrijednosti izvan raspona. Značenje krajnjih položaja nije pretpostavljeno. Očitani kut lamela (`BlndAng`) zadržava izvornu skalu.

Provjera se primjenjuje i na poznate naredbe poslane kroz stari `/api/write`, kako stari obrazac ne bi zaobišao pravila. Demo ostaje lokalna simulacija.

Slider šalje nakon završene promjene, ne za svaki pomak. Dok zahtjev traje, ista kartica ne šalje drugi. Potvrda znači da je kontroler prihvatio naredbu; stvarni prikaz mijenja tek novo očitanje. Greška ili timeout ne izazivaju automatsko ponavljanje. Ponovno provjeri očitanje prije novog pokušaja.

Dvije sekunde nakon svake potvrde uspješnog upisa backend ponovno čita sve konfigurirane vrijednosti, uključujući povezane povratne vrijednosti i skrivene točke, te šalje rezultate otvorenim dashboardima. Ako je ranije čitanje još u tijeku, prvo završava ono, a zatim počinje novo čitanje. Redovno periodično osvježavanje nastavlja raditi neovisno o tome. Odbijeni i neuspjeli upisi ne zakazuju dodatno osvježavanje. Rok od dvije sekunde počinje potvrdom prihvata naredbe; to nije zasebna potvrda da je fizički uređaj završio radnju.

State 2 (Forced), nedostupnost i greške blokiraju naredbu. Ne šaljemo Force/Unforce. Svježa provjera i upis dva su zasebna EWS zahtjeva: EWS ovdje ne daje atomsku provjeru i upis, pa promjena stanja između njih ostaje moguća.

U lokalnoj konfiguraciji za prvi test ciljano su uključene izvorne naredbe pet svjetala/grupe i četiri funkcije klime. Forsirana funkcija ostaje zaključana dok ne postane Good. Novi widgeti i dalje se uvoze bez dozvole za pisanje. Konfiguracija se učitava pri pokretanju servisa; ručne promjene datoteke zahtijevaju ponovno pokretanje dashboarda.
