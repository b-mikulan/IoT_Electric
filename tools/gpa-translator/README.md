# GPA prevoditelj

Lokalni pregled i uređivanje naziva te tekstova statusa u Gira GPA projektima.
Python 3.10 ili noviji;
standardna biblioteka i Tkinter (uključen u uobičajenu Windows instalaciju Pythona).
Nisu potrebni dodatni paketi ni internetska veza.

## Prijenos na drugo računalo

Postojeći ZIP nije ponovno izrađen. Novosti opisane ovdje dostupne su u Python
kodu; stari izvršni paket zadržava prethodnu verziju bez uređivanja tekstova statusa.

Samostalni Windows x64 paket: raspakirajte cijeli `GPA-Translator-Windows-x64.zip`
i pokrenite `GPA Prevoditelj.exe`. Python i GPA ne moraju biti instalirani za
pregled i prevođenje; ikone su uključene. Zadržite mapu `_internal` uz program.
Paket sadrži i zasebnu Python verziju u mapi `source`.

Za ponovnu izradu paketa na Windows računalu, uz pripremljenu lokalnu zbirku ikona:

```powershell
python -m venv tools/gpa-translator/.cache/build-venv
tools/gpa-translator/.cache/build-venv/Scripts/python.exe -m pip install pyinstaller==6.22.3
tools/gpa-translator/.cache/build-venv/Scripts/python.exe tools/gpa-translator/scripts/build_windows.py
```

ZIP se sprema u `output`. Uključuju se samo programske datoteke, rječnici, ikone
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
    status-texts.hr.json    prijevodi tekstova statusa i upravljanja
  tests/                    provjere prevođenja i spremanja
  scripts/                  priprema ikona i budućeg Windows paketa
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
python tools/gpa-translator/gui.py "R1-13 - with passwords - eng.gpa"
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
5. Na kartici **Statusni tekstovi** pregledajte i uredite tekstove upravljanja i
   statusa po tipovima funkcija i ikonama, kako je opisano niže.
6. Kliknite **Spremi novi GPA…** i odaberite novo ime datoteke.

Prijedlozi s ponovljenim nazivima inicijalno nisu označeni. Možete ih doraditi ili
izričito označiti; upozorenje na ponavljanje ne blokira takav odabir. Nepoznate
stavke također se mogu ručno preimenovati. Funkcije bez jednoznačne veze s
prostorijom prikazane su u grupi **Bez jednoznačne sobe**.

Uz prijedlog nastao prema ikoni prikazuje se izvorni Gira simbol i objašnjenje
prijevoda. Slika se odabire prema istom `IconId` kao naziv. Nakon ručnog uređivanja
ostaje kao kontekst početnog prijedloga. Pravilo `S1/S2 → Senzor` ne prikazuje ikonu
jer se temelji na oznaci senzora.

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

## Tekstovi statusa i upravljanja

U svakoj sobi kartica **Statusni tekstovi** prikazuje postojeća polja, grupirana
prema tipu funkcije i ikoni, primjerice **Prekidač · Rasvjeta**:

| GPA polje | Što se uređuje |
| --- | --- |
| `OnAction` | Tekst radnje za uključivanje |
| `OffAction` | Tekst radnje za isključivanje |
| `OnText` | Tekst statusa kada je uključeno |
| `OffText` | Tekst statusa kada je isključeno |

Svaka grupa navodi funkcije na koje se odnosi. Uz svako polje vide se izvorni
tekstovi i broj funkcija koje ih koriste. U polje s hrvatskim tekstom možete
upisati vlastiti tekst ili odabrati ponuđeni prijevod. Ta se izmjena primjenjuje
na funkcije iz iste grupe, unutar odabrane sobe. Brisanje sadržaja dopušteno je
ako namjerno želite prazan tekst.

Kvačica uz polje određuje hoće li se promjena spremiti. Jednoznačni prijedlozi s
ujednačenim izvornim tekstom unaprijed su označeni; grupe s različitim izvornim
tekstovima ili više mogućih prijevoda ostaju neoznačene za pregled. Ručni unos
označava polje za spremanje. **Vrati** vraća početni prijedlog. **Spremi novi GPA…**
zajedno sprema označene nazive i statusne tekstove.

Prijedlozi se čitaju iz `data/status-texts.hr.json`, izdvojenog usporedbom istih
funkcija u engleskom i hrvatskom primjeru R1-13. Rječnik uzima u obzir tip funkcije,
ikonu, polje i izvorni tekst. Primjerice, `On` za svjetlo i `On` za drugi tip
funkcije ne moraju imati isti prijevod.

Prikazuju se samo polja koja već postoje u projektu. Ne dodaju se nedostajući
parametri niti se mijenjaju XML oznake i zadane vrijednosti u atributima. Nepoznat
tekst ostaje sačuvan dok ga ručno ne uredite. Ako primjeri sadrže više različitih
prijevoda za isto pravilo, potreban je odabir u pregledu. U primjeru postoje i
nedosljednosti, uključujući `OnText` napajanja s prijevodima „Uključeno” i
„Isključeno”; takvo pravilo nije automatski potvrđeno.

## Pravila prijedloga

- `data/rooms.hr.json` prevodi osnovni naziv sobe uz očuvanje završnog broja:
  `Bathroom 12` → `Kupaonica 12`.
- Svaka funkcija s poznatom ikonom i jednoznačnom prevedenom sobom dobiva
  prijedlog `{hrvatski naziv ikone} {naziv sobe}`, bez provjere izvornog naziva.
  Tako i `E1` dobiva `Vrata ulaz` kada je ikona Door i soba Entrance.
- Postojeće posebno pravilo `S1`, `S2` itd. daje `Senzor {soba}`.
- Prvo slovo naziva sobe spušta se u malo slovo. Skraćivanje naziva soba,
  položaji stropna/zidna i druga posebna pravila još nisu implementirani.
- Veze se čitaju iz `.assoc`, a ikone iz `IconId` u XML-u. Brojčana oznaka kruga
  ne služi za zaključivanje kojoj sobi ili fizičkom uređaju funkcija pripada.
- Tekstovi statusa i upravljanja imaju odvojen pregled i rječnik
  `data/status-texts.hr.json`; prijevod naziva funkcije ih sam po sebi ne mijenja.

Ikona je početni prijedlog: isti simbol može pokrivati različite funkcije, a
postojeći opisni nazivi također dobivaju novi prijedlog. Prije spremanja pregledajte
odabrane promjene u sučelju.

## Naredbeni redak

Pregled bez izmjene projekta:

```powershell
python tools/gpa-translator/translate.py "R1-13 - with passwords - eng.gpa" --report "$env:TEMP/gpa-proposals.json"
```

Bez `--report` prijedlozi se ispisuju u terminal. Primjena samo automatskih
prijedloga sa statusom `ready`:

```powershell
python tools/gpa-translator/translate.py "R1-13 - with passwords - eng.gpa" --output "$env:TEMP/gpa-translated.gpa"
```

CLI preskače `review` (ponovljen naziv), `unknown` (nedostaje ikona ili soba) i
`unchanged`. `ready` označava primjenjivost pravila, ne ručnu potvrdu korisnika.
Za ručni pregled i odabir koristite GUI.

## Spremanje i provjere

Izlazna datoteka mora biti nova. Izvorni arhiv ostaje sačuvan. Mijenjaju se samo
odabrani nazivi i postojeći tekstovi statusa/upravljanja; drugi bajtovi datoteka
ostaju isti. ZIP koristi Deflate
bez zasebnih zapisa mapa. Provjeravaju se sve izlazne putanje i raspakirani sadržaj.
Ulaz mora sadržavati točno jedan projekt u `projects/`.

Ručna izmjena i ponovno pakiranje ranije su potvrđeni u GPA 6.0. Rezultat ove
verzije alata još treba provjeriti u GPA-u. Izvještaje i projekte držite lokalno,
izvan verzioniranih datoteka.

```powershell
python -B -m unittest discover -s tools/gpa-translator/tests -t tools/gpa-translator
```
