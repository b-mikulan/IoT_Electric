"""Update the balcony lighting and user configuration in offline R1 GPA projects."""

import argparse
import getpass
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import xml.etree.ElementTree as ET
import zipfile

if __name__ == "__main__" and not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from r1_updater.logic import update_logic
from r1_updater.project import Project, field, one, require, set_user_password, update_users, update_widgets
from gpa_translator.translate import read_archive, write_archive


def update(files):
    project = Project(files)
    pages = [p[:-4] for p in files if p.endswith(".xml") and p.split("/")[-2] == "logicpages"]
    page = one((p for p in pages if field(project.xml(p), "LogicPageName") == "Facade Lights"),
               "Stranica logike Facade Lights")
    points = [p[:-4] for p in files if p.endswith(".xml") and p.split("/")[-2] == "knxdatapoints"]
    mode = one((p for p in points if field(project.xml(p), "LogicalName") == "FLLMode"),
               "KNX točka FLLMode")
    rewired, outputs = update_logic(project, page, mode)
    widgets = update_widgets(project, mode)
    require(rewired == bool(widgets), "Widgeti i logika nisu u istom početnom ili završnom stanju.")
    promoted, deleted = update_users(project)
    project.check_removed()
    return widgets, rewired, outputs, promoted, deleted


def save(output, files):
    # Publish only a completely written, verified archive, without replacing
    # an original or an output created concurrently.
    with TemporaryDirectory(dir=output.parent) as tmp:
        staged = Path(tmp) / "project.gpa"
        write_archive(staged, files, [])
        if os.name == "nt":
            staged.rename(output)
        else:
            os.link(staged, output)


def process_project(source, output, passwords):
    if output:
        require(not output.exists(), f"Izlaz već postoji: {output}")
    files = read_archive(source)
    widgets, rewired, outputs, promoted, deleted = update(files)
    if any((widgets, rewired, promoted, deleted)):
        require(update(files) == ([], False, outputs, False, []),
                "Završna provjera ažuriranog projekta nije uspjela.")
    if passwords:
        project = Project(files)
        for account, password in passwords.items():
            changed = set_user_password(project, password, account)
            require(not set_user_password(project, password, account), f"Provjera lozinke za {account} nije uspjela.")
            print(f"Lozinka računa {account}:", "predviđena promjena" if changed else "već odgovara unosu")
    print("Widgeti za uklanjanje:", ", ".join(widgets) or "nema")
    print("Facade Lights:", "prespajanje" if rewired else "već ažurirano", f"(broj izlaza: {outputs})")
    print("Račun User:", "prijelaz u Administrator" if promoted else "već je administrator")
    print("Računi za uklanjanje:", ", ".join(deleted) or "nema")
    if output:
        save(output, files)
        print("Spremljeno:", output)


def main():
    parser = argparse.ArgumentParser(description="Provjera i ažuriranje rasvjete i korisnika za R1.")
    parser.add_argument("project", type=Path, help="Izvorna .gpa datoteka ili mapa s projektima")
    parser.add_argument("--output", type=Path,
                        help="Izlazna .gpa datoteka ili izlazna mapa za skupnu obradu. Bez opcije slijedi pregled.")
    parser.add_argument("--set-user-password", action="store_true",
                        help="Upitaj za novu lozinku računa User. Enter zadržava postojeću lozinku.")
    parser.add_argument("--set-installer-password", action="store_true",
                        help="Upitaj za novu lozinku računa Installer. Enter zadržava postojeću lozinku.")
    args = parser.parse_args()
    try:
        batch = args.project.is_dir()
        if batch:
            sources = sorted((p for p in args.project.iterdir() if p.suffix.lower() == ".gpa" and p.is_file()),
                             key=lambda p: (p.name.casefold(), p.name))
            require(sources, "Mapa ne sadrži .gpa datoteke.")
            if args.output:
                require(args.output.resolve() != args.project.resolve(), "Odaberite izlaznu mapu različitu od ulazne.")
                args.output.mkdir(parents=True, exist_ok=True)
        else:
            require(args.project.is_file(), f"Ulazna putanja ne postoji ili nije datoteka: {args.project}")
            sources = [args.project]
            if args.output:
                require(args.output.suffix.lower() == ".gpa", "Izlaz mora imati nastavak .gpa.")
        passwords = {}
        for account, requested in (("User", args.set_user_password), ("Installer", args.set_installer_password)):
            if not requested:
                continue
            if sys.stdin.isatty():
                password = getpass.getpass(f"Nova lozinka za {account} (Enter zadržava postojeću): ")
            else:
                line = sys.stdin.readline()
                require(line, f"Nedostaje redak za lozinku računa {account}.")
                password = line.rstrip("\r\n")
            if password:
                passwords[account] = password
    except (ValueError, OSError, EOFError) as exc:
        print(f"Greška ({args.project.name}): {exc}", file=sys.stderr)
        return 1

    failed = 0
    for index, source in enumerate(sources, 1):
        output = args.output
        if batch:
            print(f"[{index}/{len(sources)}] {source.name}", flush=True)
            if output:
                output = output / source.name
        try:
            process_project(source, output, passwords)
        except (ValueError, OSError, KeyError, IndexError, TypeError, AttributeError, RuntimeError,
                ET.ParseError, zipfile.BadZipFile) as exc:
            failed += 1
            print(f"Greška ({source.name}): {exc}", file=sys.stderr)
    if batch:
        print(f"Ukupno: {len(sources)}, uspješno: {len(sources) - failed}, greške: {failed}.")
    if not args.output and failed < len(sources):
        print("Pregled dovršen. Za spremanje dodajte --output i novu putanju.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
