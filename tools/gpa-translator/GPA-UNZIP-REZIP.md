# GPA projekti: raspakiravanje, izmjena i ponovno pakiranje

Ovo je postupak koji smo koristili pri radu na GPA prevoditelju. Može se
iskoristiti za novi alat koji radi druge izmjene projekta: čitanje i pakiranje
arhive ne ovise o prijevodima, rječnicima ni grafičkom sučelju.

Ručna izmjena XML-a i ponovno pakiranje potvrđeni su uspješnim uvozom u
**Gira Project Assistant 6.0.0.9058**. To je potvrda za isprobane projekte i tu
verziju GPA-a; novi tip izmjene treba zasebno provjeriti u GPA-u.

## 1. Format koji smo našli

Datoteke `.gpa` na kojima smo radili obične su ZIP arhive. Pythonov `zipfile`
može ih izravno otvoriti; nije potrebno mijenjati nastavak u `.zip`.

Unutarnji raspored izgleda ovako; `GUID` je ovdje zamjena za stvarni identifikator:

```text
projects/
  $GUID.xml
  $GUID/
    channelviews/
      $ID.xml
    projectparts/
      ...
    ...
```

U primjeru `projects/$GUID.xml` i mapa `projects/$GUID/` dijele isti projektni
identifikator. Postoje i druge datoteke, među njima `.assoc` veze i binarni
sadržaj: sačuvati cijeli sadržaj, ne samo XML koji se uređuje.

To je prikaz hijerarhije putanja. Izlazni ZIP **ne smije sadržavati zasebne
zapise mapa** poput `projects/` ili `projects/$GUID/`. Dovoljni su zapisi datoteka
poput `projects/$GUID.xml` i `projects/$GUID/channelviews/$ID.xml`.

## 2. Postupak koji je radio

1. Sačuvati izvorni `.gpa` i raditi na kopiji.
2. Raspakirati arhivu u novu radnu mapu. Neposredno u njoj treba biti `projects`.
3. Izmijeniti samo potrebne datoteke i polja. Ne mijenjati projektne i objektne
   identifikatore, imena datoteka ni veze ako nova funkcionalnost to ne zahtijeva.
4. Pakirati **sadržaj radne mape**, tako da putanje u arhivi počinju s `projects/`.
   Ne uključivati ime radne mape kao dodatnu razinu.
5. Napraviti pravi ZIP, kompresijom **Deflate**, bez šifriranja i bez zasebnih
   zapisa mapa. Može se odmah zapisati s nastavkom `.gpa`.
6. Ponovno otvoriti izlaz i provjeriti putanje, sadržaj i integritet ZIP-a.
7. Uvesti izlazni `.gpa` u GPA i provjeriti rezultat izmjene.

Ispravno: `projects/$GUID.xml`.
Pogrešno: `radni-projekt/projects/$GUID.xml`.
Pogrešno je i izostaviti razinu `projects`, pa u korijen staviti samo `$GUID.xml`.

U našem alatu fizičko raspakiravanje nije potrebno: sadržaj se učita kao
`dict[str, bytes]`, izmijene se odabrane vrijednosti i ponovno zapiše arhiva.
Time se lakše sačuvaju svi neizmijenjeni sadržaji.

## 3. Što je uzrokovalo probleme pri pakiranju

| GPA greška | Što nam govori / što provjeriti |
| --- | --- |
| `End of Central Directory record could not be found` | GPA nije uspio otvoriti valjan ZIP. Provjeriti format, potpunost datoteke i integritet. Samo preimenovanje RAR/7z datoteke u `.gpa` ne pretvara je u ZIP. Iz tadašnjeg loga nismo utvrdili točan uzrok prvog neuspjelog pokušaja. |
| `Patch failed: R1-13 - with passwords/` ili `Patch failed: projects/`, uz `String cannot be of zero length. Parameter name: oldValue` | U našim pokušajima problem su bili zapisi mapa i/ili dodatna vanjska mapa. Radno rješenje bilo je sačuvati ispravnu hijerarhiju i zapisivati samo datoteke, bez zasebnih zapisa mapa. |

Dakle, uklanjanje samo vanjske mape nije bilo dovoljno: i zasebni zapis
`projects/` izazvao je grešku. Mapa mora postojati u putanjama datoteka, ali ne
kao vlastiti ZIP zapis.

WinRAR mora stvarati **ZIP**, ne RAR. Nismo se oslonili na određenu kombinaciju
WinRAR opcija: pouzdano rješenje bilo je eksplicitno pakiranje samo datoteka
Pythonovim `zipfile`. Preskakanje praznih mapa samo po sebi ne jamči da ZIP
neće sadržavati zapise ostalih mapa. Razina kompresije nije bila ključna;
koristili smo standardni `ZIP_DEFLATED`.

## 4. Samostalan Python primjer za raspakiranu mapu

Sljedeći primjer ne koristi prevoditelj. Spremiti ga kao vlastitu `.py`
datoteku i prilagoditi tri putanje na početku. Relativne putanje računaju se
od mape iz koje je Python pokrenut. Potrebna je samo standardna biblioteka.

### Raspakiravanje

`ulaz.gpa` je primjer naziva ulaza; `radni-projekt` mora biti nova mapa.
Provjera putanja obavlja se prije zapisivanja datoteka.

```python
from pathlib import Path, PurePosixPath
import zipfile

source = Path("ulaz.gpa")
work = Path("radni-projekt").resolve()

with zipfile.ZipFile(source) as archive:
    entries = [entry for entry in archive.infolist() if not entry.is_dir()]
    names = [entry.filename for entry in entries]
    if len(names) != len(set(names)):
        raise ValueError("Ponovljene putanje u arhivi.")

    targets = []
    for entry in entries:
        relative = PurePosixPath(entry.filename)
        target = (work / entry.filename).resolve()
        if (relative.is_absolute() or ".." in relative.parts
                or "\\" in entry.filename or ":" in entry.filename
                or not target.is_relative_to(work) or target == work):
            raise ValueError(f"Neispravna putanja: {entry.filename}")
        targets.append((entry, target))

    work.mkdir(exist_ok=False)
    for entry, target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(archive.read(entry))
```

Nakon toga napraviti željene izmjene u `radni-projekt`. Bilješke, izvještaje i
skripte držati izvan te mape jer sljedeći korak pakira sve datoteke iz nje.

### Ponovno pakiranje i provjera

`output/izmijenjeni-projekt.gpa` mora biti nova izlazna datoteka. Ulazni `.gpa`
koristi se za provjeru da nije izgubljena ili dodana datoteka. Ako nova namjena
namjerno dodaje ili briše datoteke, tu provjeru treba prilagoditi uz jasan popis
očekivanih promjena.

```python
from pathlib import Path
import re
import zipfile

source = Path("ulaz.gpa")
work = Path("radni-projekt").resolve()  # Sadrži projects/.
output = Path("output/izmijenjeni-projekt.gpa").resolve()

if output.is_relative_to(work):
    raise ValueError("Izlaz mora biti izvan mape koja se pakira.")

files = {
    path.relative_to(work).as_posix(): path.read_bytes()
    for path in sorted(work.rglob("*")) if path.is_file()
}
roots = [name for name in files if re.fullmatch(r"projects/\$[^/]+\.xml", name)]
if len(roots) != 1:
    raise ValueError("Očekuje se jedan projects/$GUID.xml.")
prefix = roots[0][:-4] + "/"
if any(name != roots[0] and not name.startswith(prefix) for name in files):
    raise ValueError("Datoteke izvan očekivanog projekta ili pogrešna razina mape.")

with zipfile.ZipFile(source) as archive:
    original_names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
    if len(original_names) != len(set(original_names)):
        raise ValueError("Ponovljene izvorne putanje.")
    if set(original_names) != set(files):
        raise ValueError("Izgubljene ili dodane datoteke; provjerite radnu mapu.")

output.parent.mkdir(parents=True, exist_ok=True)
with output.open("xb") as stream:  # Ne prepisuje postojeću datoteku.
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)  # Samo datoteke; nema zapisa mapa.

with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise ValueError("Neispravan ZIP sadržaj.")
    if any(entry.is_dir() for entry in archive.infolist()):
        raise ValueError("ZIP sadrži zasebne zapise mapa.")
    if set(archive.namelist()) != set(files):
        raise ValueError("Izlazne putanje se razlikuju.")
    for name, content in files.items():
        if archive.read(name) != content:
            raise ValueError(f"Izlazni sadržaj se razlikuje: {name}")

print(f"Provjeren GPA: {output}")
```

Uspjeh ovih provjera potvrđuje ZIP i sačuvani sadržaj, ali ne potvrđuje da je
nova izmjena semantički ispravna za GPA. Zato je uvoz u GPA završna provjera.

## 5. Pravila za izmjene XML-a

- Najprije napraviti ciklus raspakiraj → zapakiraj **bez izmjena**, pa provjeriti
  uvoz. Zatim mijenjati jednu stvar kako bi se odvojio problem formata od problema
  nove funkcionalnosti.
- Sačuvati kodiranje i sve bajtove neizmijenjenih datoteka. XML iz isprobanih
  projekata obrađivali smo kao UTF-8; ne spremati ga u Windows ANSI kodiranju.
- Za ciljanu izmjenu prvo parsirati XML radi provjere, zatim zamijeniti samo
  potrebnu vrijednost. Ne serijalizirati nepotrebno cijeli dokument jer se mogu
  promijeniti namespace prefiksi, formatiranje i drugi detalji.
- Ispravno escapirati XML tekst, primjerice `&` kao `&amp;` i `<` kao `&lt;`.
- Sačuvati `EntityId`, nazive `$...` datoteka, reference u `.assoc` i namespace
  `http://service.schema.gira.de/configuration`, osim ako je njihova promjena
  izričito dio nove funkcionalnosti i provedena kroz sve povezane reference.
- Arhiva može sadržavati lozinke i druge privatne podatke. U upute i izvještaje
  ne kopirati sadržaj tih polja.

ZIP bajtovi ne moraju biti isti kao u originalu: kompresija i metapodaci arhive
mogu se razlikovati. Uspoređuju se relativne putanje i raspakirani bajtovi datoteka.
Nakon izmjene samo očekivane datoteke trebaju imati drugačiji sadržaj.

## 6. Postojeći kod koji može poslužiti novom chatu

Putanje su relativne korijenu repozitorija `IoT_Electric`:

| Datoteka / funkcija | Što već radi |
| --- | --- |
| `tools/gpa-translator/gpa_translator/translate.py` → `read_archive()` | Čita `.gpa` u `dict[str, bytes]`, ignorira zapise mapa, odbija ponovljene putanje, očekuje jedan projekt i provjerava pripadnost njegovoj putanji. |
| Ista datoteka → `write_archive()` | Zapisuje Deflate ZIP bez zapisa mapa, isključivo u novu datoteku, pa uspoređuje izlazne putanje i sadržaj. |
| Ista datoteka → `replace_entity_name()` | Primjer provjere XML-a i ciljane zamjene vrijednosti uz očuvanje ostalih bajtova. |
| `tools/gpa-translator/gpa_translator/status_texts.py` → `replace_parameter_text()` | Primjer ciljane izmjene postojećeg parametra bez promjene okolnog XML-a. |
| `tools/gpa-translator/tests/test_translate.py` | Provjere da arhiva čuva ostale datoteke, nema zapisa mapa i ne prepisuje postojeći izlaz. |

Za ponovno pakiranje sadržaja u memoriji bez prevođenja postojeći
`write_archive(output, files, [])` ne mijenja nazive: prazan popis prijedloga
znači samo zapisivanje i provjeru arhive. Za potpuno samostalan novi alat može
se izdvojiti isti princip u poseban modul, bez logike rječnika i naziva.

Izvorni primjeri u ovom checkoutu nalaze se pod `projects/gpa/`, a generirani
izlazi pod `output/`. Postupak se odnosi na **GPA projekt**, ne na ZIP Windows
distribucije programa `GPA Prevoditelj.exe`.
