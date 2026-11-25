# Pravila kartica uređaja i stvarnog upravljanja

Kartice koriste eksplicitna pravila prilagođena pregledanoj EBO instalaciji. Ne koriste Ontology Graph niti pretpostavljaju da EWS sam opisuje kompletan uređaj. Ista logika `dashboard/public/devices/deviceModel.js` izvršava se u pregledniku i na backendu.

Kartice uređaja glavni su prikaz dashboarda. Sirovi widgeti i obrazac ručnog upisa nalaze se na zasebnoj stranici **Tehnički prikaz vrijednosti** (`/technical.html`); glavna stranica za njih ne gradi DOM. Točke ostaju konfigurirane i nastavljaju se dohvaćati; ne mijenjamo njihovo polje `visible`, jer ono utječe i na kartice uređaja.

Zupčanik otvara **Postavke kartice**: naziv cijele kartice, prostoriju, glavno očitanje i do 12 sekundarnih očitanja. Moguće je odabrati postojeću ili novu sobu, premjestiti uređaj u drugu sobu, ukloniti dodjelu ili vratiti automatski odabir. Glavno i sekundarna očitanja pripadaju isključivo istom uređaju prema punoj putanji vlasnika, uključujući njegove konfigurirane reference; to provjerava i API pri spremanju. Ranije spremljeno glavno očitanje drugog uređaja vraća se na automatsko očitanje i jedinicu, a ranije spremljena sekundarna očitanja drugih uređaja izostavljaju se iz prikaza i izbora te se uklanjaju iz postavke pri sljedećem spremanju kartice. Prostoriju mijenja administrator; korisnik s dozvolom **Dopusti uređivanje postavki kartica** mijenja naziv, očitanja i jedinicu. Odabir izvora prikaza ne mijenja naredbene točke, tip kartice, dozvole ni vezu s kontrolerom. Nedostupna spremljena vlastita točka prikazuje se kao nedostupna; glavno očitanje ne ponavlja se među sekundarnima.

Postavke funkcionalnih kartica trajno se spremaju u SQLite bazi dashboarda (`dashboard.sqlite`, odnosno `DASHBOARD_DB_FILE`), kao JSON dokument `devices` u tablici `dashboard_documents`, odvojeno od definicija točaka. Dokument se automatski dopunjava za pronađene pune ključeve vlasnika uređaja. Koristi objekt `{version:1,devices:[...]}`; svaki zapis ima `key`, `label`, `room`, `primaryPointId`, `primaryUnit` i `secondaryPointIds`, a grupe rasvjete i zone mogu imati `lightMembers` odnosno `sensorMembers`. Isti dokument nosi i registar prostorija, katova i pravila prostorija (`rooms`, `roomDetails`, `floors`, `roomRules`, `organizationVersion`; vidi `dashboard/ORGANIZATION.md`). Vrijednost `null` koristi automatsku postavku, `room:""` znači izričito bez sobe, a `secondaryPointIds:[]` znači bez sekundarnih očitanja. Prethodne postavke uklonjenog vlasnika ostaju sačuvane za njegovo ponovno dodavanje. Trenutačna očitanja i kontrolerske dozvole ne spremaju se ovdje.

Mjernu jedinicu **glavnog očitanja** moguće je odabrati uz njegov izvor: automatski, bez jedinice ili vlastiti tekst do 40 znakova. `primaryUnit:null` (ili izostavljeno polje u starijoj datoteci/zahtjevu) zadržava postojeći automatski prikaz, `primaryUnit:""` uklanja jedinicu, a neprazan tekst prikazuje se doslovno uz broj. To je samo oznaka prikaza: vrijednosti se ne preračunavaju, sekundarna očitanja i kontrolne jedinice ne mijenjaju se, a izvorni metapodaci ostaju sačuvani. Primjerice, upis `°F` ne pretvara izmjerene °C u °F. Automatski `%` za položaj rolete potječe iz pravila u `normalizePoint` kad EWS nije dao jedinicu; za `GrpPct` dolazi iz pravila prikaza potvrđenog raspona 0–100. Sam znak `%` nije dokaz da ga je poslao kontroler.

Datoteka `device-widgets.json` (uz `WIDGETS_FILE`, ili put iz `DEVICE_WIDGETS_FILE`, odnosno `DASHBOARD_DEVICE_WIDGETS_FILE` u Composeu) danas je samo izvor za jednokratnu migraciju pri prvom pokretanju s novom bazom. Nakon toga dashboard tu datoteku više ne čita ni ne piše, pa ručne izmjene nemaju učinka; za promjene koristi dashboard ili **Prijenos postavki**. Spremanje je serijalizirano; neuspjeh čuva posljednje spremljeno stanje. API `GET/POST /api/devices/settings` čita i sprema kartice; SSE `device-settings` osvježava ostale otvorene dashboarde.

Gumb **Postavke funkcija uređaja** otvara raniji dijalog pojedinih raw točaka. **Funkcija uređaja** nudi najprije naredbe pa očitanja. Ti nazivi, jedinice i dozvole spremaju se uz definiciju točke (tablica `dashboard_widgets` u SQLite bazi); na potvrđenoj naredbi može se uključiti **Dozvoli upis vrijednosti**, dok je opcija zaključana za očitanja. Samo otvaranje i spremanje postavki ne šalje naredbu kontroleru. Ako trajne postavke kartica nisu dostupne, zupčanik i dalje može otvoriti ranije postavke funkcija kada je raw uređivanje omogućeno.

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

### Svjetla u grupi rasvjete

Administrator u **Postavke kartice** grupe rasvjete označava pojedinačna svjetla koja se prikazuju unutar te kartice, u početno zatvorenom dijelu **Svjetla u grupi (N)**. Popis je samo organizacija dashboarda: ne mijenja DALI konfiguraciju ni EBO bindinge, a grupna naredba i dalje upravlja stvarnom grupom preko `GrpPct`. Svjetla u grupi zadržavaju vlastitu prostoriju, kontrole, naredbene ID-jeve i dozvole.

Unutar grupe svjetlo je sažeti red: naziv, očitana svjetlina, prekidač i klizač ispod njih. To je ista kartica kao na glavnom popisu, samo drukčije složena, pa naredbe i njihova potvrda rade jednako. Upozorenja, odabrana vrijednost i status naredbe ostaju vidljivi u redu. Strelica uz naziv otvara prostoriju, dodatna očitanja, osvježavanje, postavke i detalje funkcija; otvoreni red ostaje otvoren i kad stignu nova očitanja.

Svjetlo može biti na popisu više grupa i prikazuje se kao puni redak (naziv, očitanje, prekidač, klizač, strelica) u svakoj prikazanoj grupi koja ga navodi. Retci istog svjetla dijele status naredbe, a otvoreni detalji (strelica) vrijede samo za taj redak. Kad filtar vrste, prostorije ili kata ili ovlasti korisnika izostave sve grupe svjetla, ono se prikazuje samostalno jednom, s oznakom `U grupi: A` ili `U grupama: A, B`; u postavkama kartice uz svjetlo koje je već u drugoj grupi piše `također u grupi …`. Senzor i dalje može biti u samo jednoj zoni (`SENSOR_ALREADY_IN_ZONE`). Članstvo je samo prikaz i ne mijenja DALI grupu, ovlasti ni očitavanje; tekstualna pretraga uvijek prikazuje pronađena svjetla izravno. Korisnik vidi samo svjetla iz svojih prostorija, a popis mijenja samo administrator. Spremljeni, trenutačno nedostupni članovi ostaju zapisani dok ih administrator ne ukloni. Popis je dio backupa i prijenosa konfiguracije.

### Senzori u zoni

Kartica zone prikazuje svoje senzore u početno zatvorenom dijelu **Senzori u zoni (N)**, kao sažete redove s nazivom i očitanjima; ti senzori tada nisu na glavnom popisu. Dok administrator ne uredi popis, kartica sama prikazuje senzore za koje uparivanje nije upitno: senzor u putanji ima kod zone koji na istom serveru nosi točno jedna kartica zone, a prostorije senzora i zone se ne razlikuju. Ako senzori s istim kodom dolaze s više kontrolera, kod sam nije dovoljan pa se mora poklapati i prostorija. Ostali senzori ostaju na glavnom popisu.

Administrator u **Postavke kartice** zone može dodati ili maknuti senzore. Spremljeni popis, i kad je prazan, zamjenjuje automatski odabir za tu zonu; **Vrati automatski odabir senzora** uklanja spremljeni popis. Senzor može biti na spremljenom popisu samo jedne zone, a senzor koji je administrator dodao nekoj zoni ne uparuje se automatski s drugom. Kao i kod svjetala, popis je samo organizacija prikaza, korisnik vidi samo senzore iz svojih prostorija, a popis je dio backupa i prijenosa konfiguracije.

## 5. Prostorija

Učitava se Description točne zonske putanje. Za uređaj se bira najduži odgovarajući predak iz poznatih zona. Prazni i placeholder opisi se odbacuju. Rasvjeta pod potvrđenim RP32/Z312 dobiva Kitchen. AC309 i B301 nemaju potvrđenu sobu. Isti kod Z312 na drugom kontroleru ne prenosi naziv sobe automatski.

Kartice se uvijek slažu po katu (redom spremljenih katova; kat koji nije određen ide iza njih), zatim po prostoriji (abecedno, „2” prije „10”) i unutar prostorije po vrsti: pregled zone, grupa rasvjete, svjetlo, roleta, klima, senzor, ostalo. Uređaji bez prostorije idu na kraj. Kad prikaz obuhvaća više prostorija, ispred prve kartice svake prostorije stoji njezin naslov, a kad obuhvaća više katova i naslov kata; uređaji bez prostorije tada dobivaju vlastiti naslov „Bez prostorije” na razini kata. Kod jedne prostorije naslova nema. Naslov prostorije je gumb (`aria-expanded`) koji sklapa i rasklapa njezine kartice; sklopljena prostorija pokazuje naziv i broj uređaja (uključujući svjetla i senzore unutar grupa i zona). Stanje se pamti u `localStorage` preglednika po stabilnom ključu prostorije, a dok su pretraga ili vrsta uređaja aktivne, sklapanje se zanemaruje. Očitanja ne pomiču kartice; redoslijed se mijenja tek kad se uređaju promijeni naziv, vrsta ili prostorija.

Prekidač **Kartice / Pločice** prikazuje uređaje kao kompaktne pločice (prvi korak prema prikazu za mobitel). Pločica je ista kartica s drugim izgledom: ikona, naziv i jedan redak stanja, a za svjetla kojima račun smije upravljati i okrugli brzi gumb koji šalje istu naredbu kao prekidač kartice (`toggleLight`). Dodir na pločicu otvara cijelu karticu kao donji panel. Uključeno svjetlo ističe se tonom svjetla (`--tone-ochre`), ne signalnim bojama. Rolete zasad nemaju brze gumbe gore i dolje jer smjer naredbe položaja (0 ili 100 %) nije potvrđen. Odabir prikaza pamti se u `localStorage` (`iotElectric.dashboard.cardView`).

## 6. Stvarni upis

Klik šalje `POST /api/devices/write` s punim `widgetId` i vrijednošću. Za običnog korisnika backend najprije provjerava dozvolu **Čitanje i upravljanje** za prostoriju uređaja (`writeRoomIds`), i ponovno neposredno prije slanja jer se dodjela prostorije u međuvremenu može promijeniti; administratora te dodjele ne ograničavaju. Zatim provjerava da točka postoji, da je vidljiva, da ima `writable:true`, da je izvorna `01` naredba i da vezanje nije dvosmisleno. Zatim radi novi `GetItems` s `metadata:true`, izvan cachea za prikaz: mora dobiti upravo traženi ID, izričit Writeable, valjano očitanje i State 0 (Good). Po potrebi učitava enum. Neuspjeh svježe provjere blokira upis.

Vrijednost se provjerava prije slanja postojećem middleware `POST /api/values/write`, odnosno EWS SetValues:

- Rasvjeta: broj u rasponu 0–100, prema pregledanoj funkciji LtPct/GrpPct.
- Klima: samo potvrđene enum opcije.
- Temperatura: **politika ovog testnog dashboarda** je 5–35 °C, odnosno 41–95 °F ili 278,15–308,15 K. To nisu granice dobivene iz EWS-a niti jamstvo da ih konkretna klima podržava. UI mijenja vrijednost u koracima 0,5; kontroler može odbiti vrijednost i unutar tog raspona.
- Položaj rolete (`BlndPos`) i lamela (`BlndSlt`): korisnik je ispravio raspon na 0–100 % za obje naredbe. Klizači koriste korak 1 % i šalju izravnu postotnu vrijednost, npr. 36; ne dijele je sa 100. Backend odbija vrijednosti izvan raspona. Numerička očitanja se ne preračunavaju; položaj se označava znakom % ako server nije dao jedinicu. Izvorna jedinica ostaje u detaljima metapodataka, a očitani kut lamela (`BlndAng`) zadržava izvornu skalu. Značenje krajnjih položaja nije pretpostavljeno.

Provjera se primjenjuje i na poznate naredbe poslane kroz stari `/api/write`, kako stari obrazac ne bi zaobišao pravila. Demo ostaje lokalna simulacija.

Slider šalje nakon završene promjene, ne za svaki pomak. Dok zahtjev traje, ista kartica ne šalje drugi. Potvrda znači da je kontroler prihvatio naredbu; stvarni prikaz mijenja tek novo očitanje. Greška ili timeout ne izazivaju automatsko ponavljanje. Ponovno provjeri očitanje prije novog pokušaja.

Dvije sekunde nakon posljednje potvrde uspješnog upisa (uzastopne naredbe se spajaju) backend ponovno čita konfigurirane točke uređaja u istoj prostoriji, uključujući povezane povratne vrijednosti i skrivene točke, te šalje rezultate otvorenim dashboardima. Uređaj bez prostorije čita samo sebe, a postavka **Samo uređaj** ograničava čitanje na uređaj koji je poslao naredbu. Ako je redovno čitanje u tijeku, ono završava trenutačni zahtjev i propušta ciljano čitanje. Naredba ne zakazuje dodatno čitanje cijele zgrade; redovno periodično osvježavanje nastavlja raditi neovisno o tome. Odbijeni i neuspjeli upisi ne zakazuju dodatno osvježavanje. Detalji su u `dashboard/SETTINGS.md`. Rok od dvije sekunde počinje potvrdom prihvata naredbe; to nije zasebna potvrda da je fizički uređaj završio radnju.

State 2 (Forced), nedostupnost i greške blokiraju naredbu. Ne šaljemo Force/Unforce. Svježa provjera i upis dva su zasebna EWS zahtjeva: EWS ovdje ne daje atomsku provjeru i upis, pa promjena stanja između njih ostaje moguća.

U lokalnoj konfiguraciji za prvi test ciljano su uključene izvorne naredbe pet svjetala/grupe i četiri funkcije klime. Forsirana funkcija ostaje zaključana dok ne postane Good. Novi widgeti i dalje se uvoze bez dozvole za pisanje. Konfiguracija se nalazi u SQLite bazi i mijenja kroz dashboard ili **Prijenos postavki**; ručne izmjene JSON datoteka nakon prve migracije nemaju učinka.
