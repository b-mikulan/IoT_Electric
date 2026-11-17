# Grupiranje kartica po prostorijama — dizajn

Datum: 2026-11-17 · Veličina: mala promjena (kratki dizajn)

## Namjera

Kad se prikaže cijeli kat (ili cijela zgrada), kartice uređaja trenutno dolaze
redom kojim su točke dodane, pa su prostorije i vrste uređaja izmiješane.
Korisnik želi kartice grupirane po prostorijama, a unutar prostorije uvijek
istim redom vrsta: pregled zone, svjetla, rolete, klima itd.

## Ciljevi

- Sortiranje vrijedi **uvijek**: svi uređaji, odabrani kat, odabrana prostorija,
  filtar vrste i tekstualna pretraga.
- Redoslijed: kat → prostorija → vrsta uređaja.
- Vidljivi naslovi prostorija (i kata u prikazu cijele zgrade) u gridu.

## Ne-ciljevi

- Sklopive sekcije po prostoriji, gumb za osvježavanje po sekciji (moguće kasnije).
- Korisnički podesiv redoslijed vrsta ili ručno slaganje kartica.
- Promjene na backendu, pohrani ili formatu prijenosa konfiguracije.

## Anti-ciljevi

- Ne smije se pokvariti učitavanje u serijama („Učitaj još”), odabir više
  uređaja, premještanje, nacrti komandi ni fokus kontrola tijekom ažuriranja vrijednosti.
- Ažuriranja živih vrijednosti ne smiju premještati kartice.

## Pristupi koji su razmatrani

- **A) Samo sortiranje bez naslova**: najmanja promjena, ali nema vidljive granice
  između prostorija; problem se rješava tek napola.
- **B) Sortiranje i naslovi prostorija/kata kao redovi preko cijele širine grida**:
  **odabrano**. Jasno grupiranje, a postojeći grid, serije, odabir i komande ostaju isti.
- **C) Sklopive sekcije po prostoriji**: najurednije, ali preradu serija, odabira
  i strukture DOM-a čini najvećim zahvatom. Može se kasnije dograditi na B.

## Dogovoreno ponašanje

**Redoslijed** (samo kartice na vrhu; svjetla unutar grupe i senzori unutar zone
ostaju ugniježđeni kao danas):

1. Kat: redoslijedom spremljenih katova (`floors`), kat koji nije određen ide na kraj.
2. Prostorija: po nazivu, `localeCompare(…, "hr", { numeric: true })`, isto kao
   postojeći filtar prostorija; „Bez prostorije” ide na kraj.
3. Vrsta: `zone` → `lightGroup` → `light` → `blind` → `climate` → `sensor` → `generic`.
4. Unutar iste vrste: po nazivu uređaja (`hr`, numeric), pa po ključu radi stabilnosti.

**Naslovi:**

- Naslov prostorije ide ispred prve kartice svake prostorije u prikazanom isječku.
- U prikazu „svi uređaji” ispred svakog kata ide i naslov kata.
- Kad je odabrana jedna prostorija, naslovi se ne prikazuju jer su suvišni.
- „Učitaj još” nastavlja ispod iste prostorije bez ponovljenog naslova. Serija
  od 24 i dalje broji samo kartice, ne naslove.
- Kod tekstualne pretrage članovi grupe prikazani samostalno sortiraju se po
  vlastitoj vrsti i prostoriji, uz postojeću oznaku „U grupi: …”.

## Ograničenja

- Logika je u `dashboard/public/devices/deviceCards.js` (`applyFilter`).
  Sortiranje se računa nad `filteredDevices` prije rezanja na `displayLimit`.
- Naslovi su elementi koji nisu kartice. Postojeća petlja koja postavlja kartice
  po indeksu u `grid.children` mora ih uzeti u obzir.
- Redoslijed se računa samo kod punog osvježavanja ili promjene filtra, ne u `updateValues`.
- Isto vrijedi za glavnu (`index.html`) i tehničku stranicu jer obje koriste `deviceCards.js`.

## Prepušteno izvođaču

- Točan izgled naslova (CSS u `deviceCards.css`), uz `grid-column: 1 / -1` i
  usklađenost s postojećim stilom.
- Hoće li funkcija za sortiranje živjeti u `deviceModel.js` (radi testiranja)
  ili u `deviceCards.js`.
- Testovi u `dashboard/test/` za redoslijed i za naslove (uključujući „Učitaj
  još” i odabranu prostoriju). Ažurirati `docs/device-cards.md` i README dashboarda.
