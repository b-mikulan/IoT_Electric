# Cudy SNMP MAC probe

Jednokratno, read-only ocitanje MAC tablica. Ne mijenja switch, ne salje alarme i ne cita Excel datoteke.

Iz korijena repozitorija:

```powershell
python -m pip install -r tools/cudy-snmp/requirements.txt
python tools/cudy-snmp/mac_table.py
```

Unesi **read community** kada skripta zatrazi unos (unos je skriven).
Alternativno se cita varijabla okoline `CUDY_SNMP_COMMUNITY`.
Community se ne zapisuje u datoteke niti ispisuje.

Default je R1, `10.110.3.241:161`, SNMP v2c. Za drugi switch:

```powershell
python tools/cudy-snmp/mac_table.py --host 10.110.3.242
```

Odabrana SNMP verzija mora biti ukljucena, a UDP 161 dostupan preko VPN-a.
Ovo nije ICMP ping: skripta cita sysDescr pa GETNEXT zahtjevima prolazi
BRIDGE-MIB i Q-BRIDGE-MIB forwarding tablice te mapiranje bridge port ->
ifIndex -> opis sucelja. Ispisuje sirove OID-ove i dekodirane MAC adrese,
a na kraju spaja MAC, bridge port, ifIndex, opis sucelja i status u sazetak.
Podrska ovim tablicama na konkretnom firmwareu tek se treba potvrditi.

Citaju se sljedeci stupci:

| Objekt | OID | Sadrzaj |
| --- | --- | --- |
| dot1dTpFdbAddress | `1.3.6.1.2.1.17.4.3.1.1` | MAC adresa |
| dot1dTpFdbPort | `1.3.6.1.2.1.17.4.3.1.2` | MAC -> bridge port |
| dot1dTpFdbStatus | `1.3.6.1.2.1.17.4.3.1.3` | Status MAC retka |
| dot1qTpFdbPort | `1.3.6.1.2.1.17.7.1.2.2.1.2` | FDB ID + MAC -> bridge port |
| dot1qTpFdbStatus | `1.3.6.1.2.1.17.7.1.2.2.1.3` | Status Q-BRIDGE retka |
| dot1dBasePortIfIndex | `1.3.6.1.2.1.17.1.4.1.2` | Bridge port -> ifIndex |
| ifDescr | `1.3.6.1.2.1.2.2.1.2` | ifIndex -> opis sucelja |

Statusi su `other(1)`, `invalid(2)`, `learned(3)`, `self(4)` i `mgmt(5)`.
Samo status `learned(3)` broji se kao potvrdjeno nauceni redak.
Nevaljani, vlastiti i staticki retci ostaju vidljivi s odgovarajucim statusom.
Nedostajuci podaci prikazuju se kao `unknown`; bridge port `0` znaci da port
nije naucen i ne mapira se na fizicko sucelje. Svaki se MAC broji jednom po
izvornoj tablici i FDB ID-u, ne ponovno za svaki procitani stupac.
Stupci se citaju odvojeno, pa promjene MAC tablice tijekom upita mogu
dati nepotpuno spajanje; ovo nije atomarna snimka.

Za izravni upit jednog poznatog MAC-a, bez obilaska tablica:

```powershell
python tools/cudy-snmp/mac_table.py --mac AA:BB:CC:DD:EE:FF --timeout 3 --retries 0
```

Zamijeni primjer stvarnim MAC-om iz Dynamic MAC Address Table na web sucelju.
Prihvacaju se zapisi s dvotockama, crticama ili 12 heksadekadskih znakova.
Ovaj nacin izvodi zasebne GET upite za BRIDGE adresu, port i status, pa
po potrebi dohvaca tocni bridge port -> ifIndex -> ifDescr. Ne koristi
GETNEXT. Ako je poznat FDB ID, dodaj `--fdb-id 1` za dodatne tocne Q-BRIDGE
upite za taj FDB; FDB ID nije automatski VLAN ID i ne pretpostavlja se.
Uz `--mac --diagnose` citaju se dijagnosticki skalari, ali nema obilaska
dijagnostickih grana. Postojece ponasanje bez `--mac` ostaje obilazak tablica.

Standardna forwarding tablica indeksirana je MAC-om (i FDB ID-om za
Q-BRIDGE), a ne portom. Nema standardnog izravnog GET upita za sve naucene
MAC-ove jednog porta; za to treba procitati tablicu pa filtrirati portove.
Opcija `--port` oznacava SNMP UDP port, ne fizicki port switcha.
Tocni GET moze pomoci ako agent ima neispravan GETNEXT; ne moze dodati
podrsku objektima koje firmware ne izlaže. `NoSuchObject` znaci da objekt
nije dostupan, a `NoSuchInstance` da tocna instanca nije dostupna; za MAC
koji je u medjuvremenu ostario ili krivi FDB ID potonji rezultat je ocekivan.

Kad GETNEXT izadje iz trazene tablice, skripta uvijek ispisuje poslani OID,
error-status i error-index odgovora te vraceni OID, tip i stvarnu vrijednost.
`error-status=0` znaci da odgovor nema protokolarnu gresku. Taj se odgovor
ne broji kao redak MAC tablice, a obilazak te tablice tu zavrsava.
Isto se ispisuju SNMP iznimke poput `EndOfMibView` i odgovori bez varbindova.
Ovo su dekodirana polja odgovora, ne heksadekadski zapis cijelog UDP paketa.
Za ovaj ispis nije potreban `--diagnose`.

Za usporedbu s v1, na webu otvori Protocol Management > SNMP, ukljuci
SNMP v1 i klikni Apply u odjeljku Version. V2c moze ostati ukljucen.
Koristi isti read community, bez dodatka `@1`:

```powershell
python tools/cudy-snmp/mac_table.py --version 1 --diagnose --max-rows 20 --timeout 3 --retries 0
python tools/cudy-snmp/mac_table.py --version 2c --diagnose --max-rows 20 --timeout 3 --retries 0
```

Bez `--version` i dalje se koristi v2c. Verzija se ispisuje uz ciljnu adresu.
V1 GETNEXT moze zavrsiti odgovorom `noSuchName` (error-status 2); skripta
ispisuje odgovor i zavrsava tu granu bez brojanja odgovora kao MAC retka.
Prikazani tipovi i vrijednosti su PySNMP-ov dekodirani prikaz; biblioteka
moze v1 `noSuchName` prikazati i kao `EndOfMibView` ili `NoSuchObject`.
Za izravni GET nedostupnog objekta `noSuchName` se i dalje prijavljuje kao
greska upita. Promjena verzije sama po sebi ne dodaje podrsku za MAC tablice.

Neovisna provjera iz WSL-a s instaliranim Net-SNMP paketom `snmp`:

```bash
snmpgetnext -v 1 -c 'YOUR_READ_COMMUNITY' -On -t 3 -r 0 10.110.3.241 1.3.6.1.2.1.17.4.3.1.1
snmpgetnext -v 1 -c 'YOUR_READ_COMMUNITY' -On -t 3 -r 0 10.110.3.241 1.3.6.1.2.1.17.4.3.1.2
```

Bridge port nije automatski fizicki broj porta. Q-BRIDGE FDB ID nije
nuzno VLAN ID. Ista MAC adresa moze se pojaviti u obje tablice.
Prazna tablica moze znaciti da nije podrzana, da nema naucenih adresa
ili da pristup nije dopusten. Uplink portovi mogu sadrzavati vise MAC adresa.

Opcije: `--timeout 3 --retries 1 --max-rows 2048`. Limit vrijedi po stupcu.
Jedan dodatni GETNEXT provjerava postoje li retci iznad limita.
Za dijagnostiku praznih tablica:

```powershell
python tools/cudy-snmp/mac_table.py --diagnose --max-rows 100
```

Ispisuje sysObjectID, broj sucelja i bridge portova ako su dostupni,
tocan razlog zavrsetka GETNEXT obilaska te najvise 100 OID-ova iz svake
od MIB-2 i enterprise grana. Vrijednosti redaka unutar tih dodatnih grana
su skrivene; prvi odgovor izvan trazene grane ispisuje se s vrijednoscu
kao sto je opisano iznad. To je ogranicen pregled, ne potpuni
popis svih podrzanih OID-ova. I dalje se izvode samo GET/GETNEXT zahtjevi.

Exit code 0: MAC podaci vraceni bez gresaka citanja i bez skracivanja redovnih
stupaca; 1: greska ili nema MAC podataka; 2: podaci ili mapiranje skraceni su
zbog limita; 130: prekid tipkama Ctrl+C. Limit dodatnih dijagnostickih grana
sam po sebi ne mijenja exit code.

Offline regresijski testovi (bez mreze i communityja):

```powershell
python -m unittest discover -s tools/cudy-snmp -p test_mac_table.py -v
```
