GPA PREVODITELJ - WINDOWS PORTABLE
================================

Windows 10/11, 64-bit (x64).
Python, Gira GPA and an internet connection are not needed to run this tool.

1. Right-click the ZIP and choose Extract All / Izdvoji sve.
2. Open the extracted GPA Prevoditelj folder.
3. Double-click GPA Prevoditelj.exe.
4. Choose Otvori projekt and select your own .gpa file.
5. Review rooms, icons and proposed names; edit the Croatian text as needed.
6. In each room, open Statusni tekstovi to review status and operation texts,
   grouped by function type and icon. Edit the Croatian text or choose a suggested
   translation. Each edit affects the listed functions in that room's group.
   Use the checkbox to select changes; Vrati restores the initial suggestion.
7. Choose Spremi novi GPA and save to a new filename.

Keep the whole extracted folder together, including _internal. Do not run the
program directly inside the ZIP. No installer or administrator rights are needed.
Gira GPA is still needed to import/use the translated project afterwards.

The application includes Python/Tk, the room, icon and status-text dictionaries,
and 455 original Gira icons. No customer projects or project passwords are included.

Advanced: the executable reads dictionaries from _internal/data/rooms.hr.json,
_internal/data/icons.hr.json and _internal/data/status-texts.hr.json. Restart the
application after editing them. The source/ folder is a separate Python edition
with its own data/ dictionaries and README.md; editing source files does not
change the compiled executable. Run source/gui.py with Python to use that edition.

Croatian quick start:
Raspakiraj cijeli ZIP, pokreni GPA Prevoditelj.exe, otvori projekt, provjeri i
uredi nazive i tekstove statusa po sobama i tipovima funkcija pa spremi novu GPA
datoteku. Izvorni projekt ostaje sacuvan.

Runtime notices are in licenses/. Gira icons are sourced from the local GPA 6.0
installation used to prepare this package.
