# Ažuriranje balkonske rasvjete i korisnika u R1

R1 updater koristi Python 3.10+ i zajedničke funkcije za čitanje i zapis GPA arhiva iz susjednog paketa `gpa_translator`. Iz korijena repozitorija pokrenite pregled jednog projekta, a za spremanje navedite novu datoteku u postojećoj mapi.

```powershell
python tools/gpa-translator/r1_updater/update_r1.py "stan.gpa"
python tools/gpa-translator/r1_updater/update_r1.py "stan.gpa" --output "stan-azuriran.gpa"
```

Lozinke postavljate odvojeno. Dodajte `--set-user-password` za račun `User` i/ili `--set-installer-password` za `Installer`. Za zadržavanje postojeće lozinke izostavite opciju tog računa ili na njegovu upitu pritisnite Enter. Pri ažuriranju `User` dobiva administratorska prava i kad zadrži svoju lozinku. Kod obje opcije prvi skriveni unos pripada računu `User`, a drugi računu `Installer`. Za automatiziranu obradu vrijedi isti redoslijed, po jedan redak za svaki odabrani račun. Prazan redak čuva lozinku tog računa.

```powershell
python tools/gpa-translator/r1_updater/update_r1.py "stan.gpa" --set-user-password --set-installer-password --output "stan-azuriran.gpa"
```

### Obrada cijele mape

Prvi argument može biti mapa. Skripta obrađuje jednu po jednu `.gpa` datoteku neposredno u toj mapi, abecednim redom po nazivu. Lozinku za svaki odabrani račun unosite jednom za cijelu mapu.

```powershell
python tools/gpa-translator/r1_updater/update_r1.py "projects/gpa/blocks/R1/Translating" --set-user-password --set-installer-password --output "output/gpa-r1/azurirani"
```

Skripta po potrebi stvara izlaznu mapu i sprema projekte pod izvornim imenima. Za pregled izostavite `--output` i izlaznu putanju. Ako pojedini projekt ima neočekivanu strukturu ili istoimeni izlaz već postoji, skripta ispisuje ime i razlog greške te nastavlja sa sljedećim projektom. Na kraju prikazuje broj uspješnih i neuspješnih obrada te vraća izlazni kod 1 ako je bilo grešaka.

### Izmjene projekta

Skripta čita GPA u memoriju. Prepoznaje `Sensor Loggia` i `Senzor loggia`, uključujući brojeve i razlike u velikim i malim slovima. Provjerava vezu `OnOff` s KNX točkom `FLLMode`, uklanja pripadajuće widgete i njihove veze te isključuje namjenski timer widgeta. KNX točka ostaje u projektu.

Na aktivnoj stranici `Facade Lights` provjerava iste čvorove i veze u XML-u i izvršnom JSON grafu. Uklanja upravljačku granu `FLLMode → Inverter → Block`, povezuje `Send-by-change` sa svakim od jednog ili dvaju postojećih izlaza i ažurira manifest grafa. Račun `User` premješta u grupu `Administrator`, a račune `Dado` i `Damjan` uklanja s njihovim pripadajućim profilima, pravima i vezama ako postoje.

Kod neočekivane strukture (primjerice nedostaje stranica ili se XML i JSON veze razlikuju) naredba završava greškom za cijeli projekt. Izlaz se objavljuje tek nakon provjere svih izmjena i zapisanog ZIP-a. Ponovni pregled ažuriranog projekta prikazuje da su izmjene već primijenjene.

Skripta uređuje aktivnu konfiguraciju. Povijesne snimke puštanja u pogon i spremljenu GPA procjenu potrošnje memorije ostavlja kakve su bile. Za provjeru u GPA-u uvezite novu arhivu, otvorite `Facade Lights` i provjerite spoj do svake predviđene svjetiljke.

## Testovi

```powershell
python -B -m unittest discover -s tools/gpa-translator/r1_updater/tests -t tools/gpa-translator
```
