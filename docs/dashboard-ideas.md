# Ideje za dashboard

Popis mogućih funkcija i poboljšanja za korisnike, ugodnost korištenja i
održavanje. Ništa od ovoga nije obećanje ni plan. Stavke su ideje za odabir
sljedećeg posla. Kad se neka napravi, označi je ovdje ili je ukloni.

Stanje u trenutku pisanja (studeni 2026.): dashboard nema tamni način (u izradi),
favorite, instalaciju na mobitel (PWA), CSV izvoz trendova ni povijest naredbi.

## Za svakodnevne korisnike

1. **Favoriti i početni prikaz.** Korisnik prikvači svoje prostorije ili uređaje
   i dashboard se otvara na njima. Sprema se po računu u bazu, ne u preglednik,
   pa vrijedi i na mobitelu.
2. **„Treba pažnju”.** Na jednom mjestu uređaji s greškom, zastarjelim očitanjem
   ili vrijednošću izvan raspona (npr. CO2 iznad 1000 ppm jantarno, iznad
   1500 ppm crveno). Admin podešava pragove po vrsti uređaja. Sve se računa iz
   podataka koje dashboard već ima.
3. **Mini-graf na kartici.** Zadnja 24 sata temperature ili CO2 kao mala linija.
   Dashboard ionako čita vrijednosti svakih 15 s, pa ih može sam pamtiti
   sažeto (npr. svakih 5 minuta), bez dodatnih upita kontroleru.
4. **Trend iz kartice.** „Prikaži trend” na kartici umjesto traženja po mapama
   kontrolera. Trend u EWS-u ima drugi ID od žive vrijednosti, pa treba veza
   između njih, npr. iz skeniranja zgrade.
5. **Brze radnje po prostoriji ili katu**, npr. „Ugasi sva svjetla” ili
   „Rolete gore”. Uz pristanak prije slanja, naredbe idu jedna po jedna i svaka
   prolazi postojeće provjere prava i potvrde očitanja.
6. **Scene.** Spremljene kombinacije, npr. „Sastanak”: svjetla 70 %, rolete do
   pola, klima 22 °C. Nadogradnja na brze radnje.
7. **Alarmi u zaglavlju.** Broj aktivnih alarma vidljiv na svakoj stranici, a
   kasnije i obavijesti (preglednik, e-mail ili webhook). Sada se alarmi čitaju
   samo na zahtjev.

## Ugodnost korištenja

8. **Tamni način.** Boje su već tokeni u `dashboard/public/shared/styles.css`.
   U izradi.
9. **Instalacija na mobitel (PWA).** Ikona na početnom zaslonu i otvaranje preko
   cijelog zaslona. Preduvjet za push obavijesti, koje traže HTTPS.
10. **Tablični prikaz.** Sve prostorije u jednoj tablici s temperaturom, CO2 i
    prisutnošću, uz sortiranje. Brže od kartica za održavanje.
11. **Brza pretraga (Ctrl+K).** Skok na bilo koju prostoriju ili uređaj s bilo
    koje stranice.
12. **Trendovi:** brzi rasponi uz „Od”/„Do” (24 h, 7 dana), više trendova na
    istom grafu, izvoz u CSV i spremljeni trendovi.
13. **Zidni prikaz za tablet ili recepciju.** Prostorija ili kat preko cijelog
    zaslona, veliki elementi, samo za čitanje. Treba trajna prijava samo za
    čitanje, jer obične sesije istječu nakon 12 sati i pri restartu.

## Za admina i održavanje

14. **Povijest naredbi.** Tko je što promijenio, kada, i je li očitanje to
    potvrdilo. Na kartici npr. „Zadnja promjena: Ana, 10:32”.
15. **Automatski backup.** Svakodnevna kopija baze u volumen, uz čuvanje zadnjih
    nekoliko. Sada postoji samo ručno preuzimanje na Admin stranici.
16. **Obavijest kad veza padne.** E-mail ili webhook kad middleware ili kontroler
    ne odgovaraju dulje od zadanog vremena.
17. **Tlocrt.** Slika kata s označenim prostorijama, a klik otvara uređaje.
    Najviše posla, ali najpregledniji prikaz.

## Na što paziti

- **Rasporedi** (npr. rolete dolje u 18 h): kontroler ih najvjerojatnije već
  ima. Drugi raspored u dashboardu mogao bi se s njim sukobljavati, pa je bolje
  prikazati rasporede kontrolera nego raditi vlastite.
- **Sve što šalje naredbe** (brze radnje, scene) mora ići kroz postojeći put
  naredbi i zajedničko planiranje čitanja. Inače se gube provjere prava, stanja
  i raspona te se kontroler dodatno opterećuje.
- **Obavijesti i alarmi za obične korisnike:** trendovi i alarmi namjerno nisu
  ograničeni po prostorijama (`docs/known-issues.md`, stavka 1). Ako se alarmi
  pokazuju u zaglavlju, ta odluka vrijedi i tamo.

## Predloženi redoslijed

1. Favoriti i početni prikaz: malo posla, a korist svaki dan.
2. „Treba pažnju” s pragovima: dashboard sam upozorava.
3. Mini-graf na kartici: puno informacija bez dodatnog opterećenja kontrolera.
4. Povijest naredbi: sigurnost i odgovornost, a kasnije i temelj za obavijesti.
