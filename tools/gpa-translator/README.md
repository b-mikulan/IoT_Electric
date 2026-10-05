# GPA prevoditelj

Lokalni pregled i uređivanje naziva, tekstova upravljanja, statusa i opisa u Gira GPA projektima.
Python 3.10 ili noviji;
standardna biblioteka i Tkinter (uključen u uobičajenu Windows instalaciju Pythona).
Nisu potrebni dodatni paketi ni internetska veza.

## Prijenos na drugo računalo

Samostalni Windows x64 paket: raspakirajte cijeli `GPA-Translator-Windows-x64-v3.zip`
i pokrenite `GPA Prevoditelj.exe`. Python i GPA ne moraju biti instalirani za
pregled i prevođenje; ikone su uključene. Zadržite mapu `_internal` uz program.
Paket uključuje pregled naziva, prioritetni rječnik i uređivanje statusnih tekstova
te zasebnu Python verziju u mapi `source`.

Četiri rječnika izvršnog programa nalaze se u `_internal/data`: `rooms.hr.json`,
`icons.hr.json`, `defaults.hr.json` i `status-texts.hr.json`. Kartica **Prioritetni
rječnik** sprema izmjene u taj `defaults.hr.json`. Python verzija u `source` ima
vlastite rječnike; njezino uređivanje ne mijenja izvršni program.

Datoteka `LICENCE.txt` sadrži obavijesti za uključeni Python i Tk.
Zadržite je uz izvršno okruženje pri daljnjem dijeljenju paketa.

Za ponovnu izradu paketa na Windows računalu, uz pripremljenu lokalnu zbirku ikona:

```powershell
python -m venv tools/gpa-translator/.cache/build-venv
tools/gpa-translator/.cache/build-venv/Scripts/python.exe -m pip install pyinstaller==6.22.3
tools/gpa-translator/.cache/build-venv/Scripts/python.exe tools/gpa-translator/scripts/build_windows.py --archive-name GPA-Translator-Windows-x64-v3.zip
```

ZIP se sprema u `output/gpa-translator/releases`. Uključuju se samo programske datoteke, rječnici, ikone
i izvršno okruženje; korisnički GPA projekti nisu dio paketa.

## Raspored datoteka

```text
gpa-translator/
  gui.py                    pokretanje grafičkog sučelja
  translate.py              pokretanje naredbenog retka
  gpa_translator/            logika prevođenja, pregled i sučelje
  data/
    rooms.hr.json           prijevodi osnovnih naziva soba
    icons.hr.json           prijevodi naziva Gira ikona
    defaults.hr.json        prioritetni prijevodi poznatih naziva
    status-texts.hr.json    prijevodi tekstova statusa, upravljanja i opisa
  tests/                    provjere prevođenja i spremanja
  scripts/                  priprema ikona i izrada Windows paketa
  docs/                     upute za samostalni Windows paket
  .cache/                   lokalne ikone i privremene datoteke izrade
```

Ulazni projekti i izlazne `.gpa` datoteke ne pripadaju izvornom kodu alata.

## Grafičko sučelje

Iz korijena repozitorija:

```powershell
python tools/gpa-translator/gui.py
```

Može se odmah otvoriti projekt:

```powershell
python tools/gpa-translator/gui.py "projects/gpa/reference/R1-13 - with passwords - eng.gpa"
```

1. Kliknite **Otvori projekt…** i odaberite `.gpa` datoteku.
2. Odaberite sobu ili grupu na lijevoj strani. Desno na kartici **Nazivi** su naziv
   sobe i uvučene funkcije koje joj pripadaju. Svaki red sadrži izvorni naziv, uređivo polje
   **Novi naziv (HR)**, objašnjenje i kvačicu za primjenu.
3. Uredite željene nazive. Ručna izmjena automatski označava red za spremanje.
   Uklanjanjem kvačice zadržavate original. **Vrati** vraća automatski prijedlog.
4. Promjena naziva sobe osvježava automatske nazive funkcija. Ručno uređeni nazivi
   funkcija ostaju sačuvani. Ako isključite prijevod sobe, automatski prijedlozi
   koriste njezin originalni naziv.
5. Na kartici **Tekstovi i opisi** pregledajte i uredite tekstove upravljanja,
   statusa i opise po tipovima funkcija i ikonama, kako je opisano niže.
6. Kliknite **Spremi novi GPA…** i odaberite novo ime datoteke.

Prijedlozi s ponovljenim nazivima inicijalno nisu označeni. Na kartici **Nazivi**
uključite **Dopusti duplikatne nazive** da se automatski označe ponovljeni
prijedlozi za spremanje u cijelom projektu. Opcija vrijedi za funkcije u istoj
sobi. Pojedinu stavku i dalje možete odznačiti; isključivanje opcije poništava
samo kvačice koje je ona automatski dodala, uz zadržavanje ručnih odabira i naziva.
Možete ih i pojedinačno doraditi ili izričito označiti; upozorenje na ponavljanje
ne blokira takav odabir. Nepoznate
stavke također se mogu ručno preimenovati. Funkcije bez jednoznačne veze s
prostorijom prikazane su u grupi **Bez jednoznačne sobe**.

Uz prijedlog nastao prema ikoni prikazuje se izvorni Gira simbol i objašnjenje
prijevoda. Slika se odabire prema istom `IconId` kao naziv. Nakon ručnog uređivanja
ostaje kao kontekst početnog prijedloga. Pravila za oznake `AC`, `FH`, `T` i `S`
ne prikazuju ikonu jer se temelje na izvornom nazivu funkcije.

Pri prvom pokretanju slike se pripremaju u pozadini iz lokalne instalacije GPA 6.0
i spremaju u zanemarenu mapu `.cache/icons`. Koristi se Windows PowerShell;
instalacija GPA-a ostaje nepromijenjena. Ako slike nisu dostupne, pregled i
spremanje rade uz tekstualno objašnjenje. Za drugu lokaciju instalacije slike se
mogu pripremiti ručno:

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File tools/gpa-translator/scripts/export_gpa_icons.ps1 -GpaDirectory "D:\Gira\Gira Project Assistant\6.0"
```

Pregled postoji u memoriji do zatvaranja prozora. Nema zasebnog spremanja radne
sesije ni povratnog uvoza izvještaja; **Spremi novi GPA…** sprema odabrane promjene u
novi projekt. Nakon spremanja možete nastaviti uređivati i spremiti novu kopiju.

## Prioritetni prijevodi poznatih naziva

Prvo se primjenjuju pravila za oznake `AC1`, `FH1`, `T1`, `S1` i njihove brojevne
varijante, uključujući `FH` bez broja. Naziv dobivaju prema pripadajućoj sobi,
kako je opisano niže. Za ostale nazive traži se cijeli izvorni naziv u
`data/defaults.hr.json`. Ako postoji poznati prijevod, on ima prednost pred
prijedlogom prema ikoni i sobi.
Početni rječnik sadrži poznate prijevode iz para R1-13 te 18 oznaka iz Marinove
poruke od 30. rujna 2026. Primjer: `1.3` → `Stropna blagovaonica`.
Pregledom 14 projekata iz bloka R1 dodani su `2.9` → `Stropna spavaća`
(samo tip Switch) i KNX alias `32.36` → `Otvori vrata` (samo tip Trigger).
Za oznaku `5.19-20`, koja u 11 projekata ima istu ikonu sjenila i sobu boravka,
dodan je opći naziv `Sjenilo boravak`, ograničen na ikonu 7 i tip Covering.
Postojeći unosi ostaju sačuvani. Oznake koje imaju različite namjene u stanovima,
poput `2.8`, ostaju bez općeg unosa. Dokazi i preostale oznake za ručni pregled
nalaze se u lokalnom `output/gpa-translator/reports/block-dictionary-discovery.md`.

U retku s poznatim prijevodom izbornik **Način prijevoda** nudi **Poznati prijevod**
i **Automatika**. Izbor vrijedi za taj objekt. Prikazuju se obje ponuđene vrijednosti;
ako očekivana soba iz rječnika odstupa od sobe u projektu, prikazuje se upozorenje.
Automatika koristi trenutni naziv pripadajuće sobe. Ručni naziv ostaje uređiv.

Kartica **Prioritetni rječnik** dostupna je i bez otvorenog projekta. U njoj možete
pretraživati pravila, dodati ili urediti par izvornog i hrvatskog naziva te obrisati
pravilo. Opcionalna ikona i tip funkcije su ograničenja podudaranja; očekivana soba
služi za upozorenje. Uspoređuje se cijeli naziv, tako da `1.1` ne odgovara `11.1`.
Jednako određena, preklapajuća pravila odbijaju se kao nejednoznačna.

**Spremi JSON** trajno sprema rječnik i osvježava prijedloge otvorenog projekta.
Ručni nazivi i pojedinačni odabiri automatike ostaju sačuvani. Spremanje rječnika
odvojeno je od **Spremi novi GPA…**, koje sprema odabrane nazive, tekstove i opise.
Za izravno uređivanje JSON-a koristite UTF-8 i ponovno otvorite projekt nakon izmjene.

## Tekstovi statusa, upravljanja i opisi

U svakoj sobi kartica **Tekstovi i opisi** prikazuje postojeća polja, grupirana
prema tipu funkcije i ikoni, primjerice **Prekidač · Rasvjeta**:

| GPA polje | Što se uređuje |
| --- | --- |
| `OnAction` | Tekst radnje za uključivanje |
| `OffAction` | Tekst radnje za isključivanje |
| `OnText` | Tekst statusa kada je uključeno |
| `OffText` | Tekst statusa kada je isključeno |
| `Text` | Tekst gumba (GPA Display text), primjerice Unlock → Otključaj |
| `Description` | Opis brojčanog prikaza, primjerice Button → Tipkalo |

Svaka grupa navodi funkcije na koje se odnosi. Uz svako polje vide se izvorni
tekstovi i broj funkcija koje ih koriste. U polje s hrvatskim tekstom možete
upisati vlastiti tekst ili odabrati ponuđeni prijevod. Ta se izmjena primjenjuje
na funkcije iz iste grupe, unutar odabrane sobe. Brisanje sadržaja dopušteno je
ako namjerno želite prazan tekst.

Opisi se dodatno odvajaju prema značenju izvornog teksta. U istoj sobi i s istom
ikonom zasebno se uređuju **Tipkalo**, **Srednja** i **Senzor**; za senzore se
čuvaju odvojeni opisi **Senzor (VOC)** i **Senzor (CO2)**. Engleski i već prevedeni
opisi koji imaju isto značenje pripadaju istoj grupi. Nepoznati opisi ostaju
odvojeni za ručni pregled.

Prijevodi opisa ovise o postojećem GPA polju: `Button` → `Tipkalo`,
`Sensor` → `Senzor`, `Sensor (VOC)` → `Senzor (VOC)` i `Sensor (CO2)` →
`Senzor (CO2)`. Za srednju vrijednost postoji jedno pravilo: ako `Description`
sadrži `srednja` ili je jednak `Average`, neovisno o velikim i malim slovima,
prijedlog je `Srednja` + naziv sobe koji će se spremiti, primjerice
`Srednja boravak` ili `Srednja dječja 2`. Brojevi sobe i zapis `WC` ostaju
sačuvani; bez razriješene sobe prijedlog je samo `Srednja`. Pravilo ima prednost
pred prijevodom po ikoni i ne zahtijeva poseban unos za svaku sobu. Provjerava se
postojeći opis, a ne naziv objekta ili broj temperatura u sobi. `Sensor` se ne
mijenja u VOC bez oznake `(VOC)` u izvornom opisu.

Ako promijenite naziv sobe, automatski opisi srednje vrijednosti prate novi
naziv. Vaš ručno upisani opis i odluka da se promjena ne spremi ostaju sačuvani.

Kvačica uz polje određuje hoće li se promjena spremiti. Jednoznačni prijedlozi s
ujednačenim izvornim tekstom unaprijed su označeni; grupe s različitim izvornim
tekstovima ili više mogućih prijevoda ostaju neoznačene za pregled. Pravilo za
srednju vrijednost može automatski ujednačiti `Average` i različite opise sa
`srednja` unutar iste grupe. Ručni unos označava polje za spremanje.
**Vrati** vraća početni prijedlog. **Spremi novi GPA…**
zajedno sprema označene nazive, tekstove i opise.

Prijedlozi se čitaju iz `data/status-texts.hr.json`, izdvojenog usporedbom istih
funkcija u engleskom i hrvatskom primjeru R1-13. Rječnik uzima u obzir tip funkcije,
ikonu, polje i izvorni tekst. Primjerice, `On` za svjetlo i `On` za drugi tip
funkcije ne moraju imati isti prijevod.

Prikazuju se samo polja koja već postoje u projektu. Ne dodaju se nedostajući
parametri niti se mijenjaju XML oznake i zadane vrijednosti u atributima. Jedinice
mjerenja i adrese također ostaju sačuvane. Nepoznat
tekst ostaje sačuvan dok ga ručno ne uredite. Ako primjeri sadrže više različitih
prijevoda za isto pravilo, potreban je odabir u pregledu. Izvorni primjer sadržavao
je sedam prijevoda `OnText` napajanja kao „Uključeno” i jedan proturječan
„Isključeno”. U sadašnjem rječniku to je pravilo ispravljeno na „Uključeno”.

## Pravila prijedloga

- `data/rooms.hr.json` prevodi osnovni naziv sobe uz očuvanje završnog broja:
  `Bathroom 12` → `Kupaonica 12`.
- Svaka funkcija s poznatom ikonom i jednoznačnom prevedenom sobom dobiva
  prijedlog `{hrvatski naziv ikone} {naziv sobe}`, bez provjere izvornog naziva.
  Tako i `E1` dobiva `Vrata ulaz` kada je ikona Door i soba Entrance.
- Oznake `AC1`, `AC2` itd. daju `Klima {soba}`; `FH`, `FH1`, `FH2` itd.
  daju `Podno grijanje {soba}`; `T1`, `T2` itd. daju `Temperatura {soba}`;
  `S1`, `S2` itd. daju `Senzor {soba}`. Velika i mala slova oznake vrijede jednako.
  Ova pravila imaju prednost pred prioritetnim rječnikom i ikonama, a soba se
  određuje iz stvarne veze u projektu. Broj oznake ne određuje sobu. Zato zasebni
  prijevodi za ove oznake nisu potrebni u `defaults.hr.json`. Nazivi poput
  `Auto Sensor` ili `Sensor Mode` i dalje se prevode prema prioritetnom rječniku.
- Prvo slovo naziva sobe spušta se u malo slovo. Skraćivanje naziva soba,
  položaji stropna/zidna i druga posebna pravila još nisu implementirani.
- Veze se čitaju iz `.assoc`, a ikone iz `IconId` u XML-u. Brojčana oznaka kruga
  ne služi za zaključivanje kojoj sobi ili fizičkom uređaju funkcija pripada.
- Tekstovi statusa, upravljanja i opisi imaju odvojen pregled i rječnik
  `data/status-texts.hr.json`; prijevod naziva funkcije ih sam po sebi ne mijenja.

Ikona je početni prijedlog: isti simbol može pokrivati različite funkcije, a
postojeći opisni nazivi također dobivaju novi prijedlog. Prije spremanja pregledajte
odabrane promjene u sučelju.

## Naredbeni redak

Pregled bez izmjene projekta:

```powershell
python tools/gpa-translator/translate.py "projects/gpa/reference/R1-13 - with passwords - eng.gpa" --report "$env:TEMP/gpa-proposals.json"
```

Bez `--report` prijedlozi se ispisuju u terminal. Primjena samo automatskih
prijedloga sa statusom `ready`:

```powershell
python tools/gpa-translator/translate.py "projects/gpa/reference/R1-13 - with passwords - eng.gpa" --output "$env:TEMP/gpa-translated.gpa"
```

CLI preskače `review` (ponovljen naziv), `unknown` (nedostaje ikona ili soba) i
`unchanged`. `ready` označava primjenjivost pravila, ne ručnu potvrdu korisnika.
Za ručni pregled i odabir koristite GUI.

CLI koristi isti redoslijed: pravila oznaka, prioritetni rječnik, pa ikonu i sobu.
Drugi prioritetni rječnik možete odabrati argumentom
`--defaults putanja/do/defaults.hr.json`; za isključivanje pripremite JSON s
`schema_version: 1` i praznim popisom `rules`.

## Spremanje i provjere

Izlazna datoteka mora biti nova. Izvorni arhiv ostaje sačuvan. Mijenjaju se samo
odabrani nazivi i postojeći tekstovi statusa/upravljanja/opisa; drugi bajtovi datoteka
ostaju isti. ZIP koristi Deflate
bez zasebnih zapisa mapa. Provjeravaju se sve izlazne putanje i raspakirani sadržaj.
Ulaz mora sadržavati točno jedan projekt u `projects/`.

Ručna izmjena i ponovno pakiranje ranije su potvrđeni u GPA 6.0. Rezultat ove
verzije alata još treba provjeriti u GPA-u. Izvještaje i projekte držite lokalno,
izvan verzioniranih datoteka.

```powershell
python -B -m unittest discover -s tools/gpa-translator/tests -t tools/gpa-translator
```
