GPA PREVODITELJ - WINDOWS PORTABLE
================================

Windows 10/11, 64-bit (x64).
Python, Gira GPA and an internet connection are not needed to run this tool.

1. Right-click the ZIP and choose Extract All / Izdvoji sve.
2. Open the extracted GPA Prevoditelj folder.
3. Double-click GPA Prevoditelj.exe.
4. Choose Otvori projekt and select your own .gpa file.
5. Review rooms, icons and proposed names; edit the Croatian text as needed.
   AC1/AC2..., FH/FH1..., T1/T2... and S1/S2... use naming rules for air
   conditioning, floor heating, temperature and sensors plus the actual room.
   Other names first use exact matches in the priority dictionary; otherwise
   the tool suggests a name from the icon and room. For dictionary matches,
   choose Poznati prijevod or Automatika in Način prijevoda. You can also enter
   your own name. The dictionary now includes findings from 14 apartments.
   Read the explanation beneath each name. Yellow text flags an unavailable
   translation (unknown room/icon or an unclear room assignment), a different
   room from the one expected by the dictionary, or a duplicate to review.
   A name missing from the priority dictionary can still have an automatic
   suggestion; that alone does not produce a yellow warning.
   Dopusti duplikatne nazive is off initially. Turn it on to automatically
   select repeated suggestions throughout the project for saving. You can still
   uncheck individual items. Turning it off undoes only selections made by this
   toggle and preserves your manual choices.
6. Open Prioritetni rječnik to search, add, edit or delete exact-name rules.
   Spremi JSON saves the dictionary and refreshes the open project's proposals.
   This is separate from saving a translated GPA project.
7. In each room, open Tekstovi i opisi to review status, operation and display
   texts, plus descriptions, grouped by function type and icon. Edit the Croatian text or choose a suggested
   translation. Each edit affects the listed functions in that room's group.
   Use the checkbox to select changes; Vrati restores the initial suggestion.
   Descriptions have separate groups for Button -> Tipkalo and Sensor -> Senzor,
   keeping Sensor (VOC) and Sensor (CO2) separate. A description containing
   srednja or equal to Average (case-insensitive) becomes Srednja plus the room
   name that will be saved, for example Srednja boravak or Srednja dječja 2.
   Room numbers and WC capitalization are kept; an unresolved room gives plain
   Srednja. This rule reads the existing Description, not the object name or
   the number of temperature functions. Mixed Average/Srednja values can be
   normalized automatically; other mixed groups remain unchecked for review.
   Automatic average descriptions follow room-name changes; your manual texts
   and unchecked changes are preserved. Trigger Display text Unlock becomes
   Otključaj.
   Only existing text fields are edited; units and addresses remain unchanged.
8. Choose Spremi novi GPA and save to a new filename.
   Only checked changes are saved. Import the result into Gira GPA and check
   names, room assignments, texts and descriptions before using the project.

Keep the whole extracted folder together, including _internal. Do not run the
program directly inside the ZIP. No installer or administrator rights are needed.
Gira GPA is still needed to import/use the translated project afterwards.

The application includes Python/Tk, four dictionaries (rooms, icons, priority
names and status/display texts and descriptions), and 455 original Gira icons. No customer projects or
project passwords are included.

Advanced: the executable reads dictionaries from _internal/data/rooms.hr.json,
_internal/data/icons.hr.json, _internal/data/defaults.hr.json and
_internal/data/status-texts.hr.json. The Prioritetni rječnik tab saves changes to
the executable's defaults.hr.json. Restart after editing dictionaries outside
the application. The source/ folder is a separate Python edition with its own
data/ dictionaries and README.md; editing source files does not change the
compiled executable. Run source/gui.py with Python to use that edition.

Croatian quick start:
Raspakiraj cijeli ZIP i pokreni GPA Prevoditelj.exe. Otvori projekt, provjeri
nazive po sobama i procitaj objasnjenja ispod njih. Zuti tekst upozorava na
nepoznatu sobu/ikonu ili nedostupan prijedlog, razliku izmedu sobe u projektu
i sobe koju ocekuje rjecnik, ili duplikat koji treba pregledati. Ako naziv nije
u prioritetnom rjecniku, a automatika ga prepoznaje po ikoni i sobi, zbog toga
samog nema zutog upozorenja.
Pravila AC/FH/T/S koriste stvarnu sobu, a prioritetni rjecnik prosiren je iz
projekata 14 stanova. Opcija Dopusti duplikatne nazive automatski oznacava
ponovljene prijedloge za spremanje; pojedine promjene mozes i dalje odznaciti.
Na kartici Tekstovi i opisi provjeri i tekstove statusa, Display text gumba i
opise po sobama i tipovima funkcija. Tipkalo, Srednja, Senzor, Senzor (VOC) i
Senzor (CO2) imaju odvojene grupe. Ako postojeci Description sadrzi srednja ili
je jednak Average, neovisno o velikim/malim slovima, dobiva Srednja + naziv sobe
koji ce se spremiti. Brojevi sobe i WC ostaju sacuvani; bez razrijesene sobe
dobiva samo Srednja. Automatski opis prati izmjene sobe, a rucni opisi i
odznacene promjene ostaju sacuvani. Pravilo moze ujednaciti Average i razlicite
opise sa srednja; ostale mijesane grupe treba pregledati. Spremi novu GPA
datoteku, u kojoj su primijenjene samo oznacene promjene, pa je uvezi i provjeri
u Gira GPA. Izvorni projekt ostaje sacuvan.

Python and Tk runtime notices are in LICENCE.txt. Keep this file with the runtime
when sharing this package. Gira icons are sourced from the local GPA 6.0
installation used to prepare this package.
