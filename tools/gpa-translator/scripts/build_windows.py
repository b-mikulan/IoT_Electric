"""Build a self-contained Windows x64 folder and ZIP using PyInstaller."""

import argparse
from datetime import datetime
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

TOOL_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_DIRECTORY))

from gpa_translator.icon_images import ICON_DIRECTORY, icon_cache_ready


SCRIPT_DIRECTORY = TOOL_DIRECTORY / "scripts"
NAME = "GPA Prevoditelj"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=TOOL_DIRECTORY.parents[1] / "output" / "gpa-translator" / "releases")
    parser.add_argument("--archive-name", default="GPA-Translator-Windows-x64.zip")
    args = parser.parse_args()
    if Path(args.archive_name).name != args.archive_name or not args.archive_name.lower().endswith(".zip"):
        raise SystemExit("Archive name must be a ZIP filename without directories.")
    if sys.platform != "win32" or sys.maxsize <= 2**32:
        raise SystemExit("Build using 64-bit Python on Windows.")
    if not icon_cache_ready():
        raise SystemExit("Prepare the icon cache before building.")
    # Each build uses a fresh directory, so no previous release needs deleting.
    build = TOOL_DIRECTORY / ".cache" / "releases" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    build.mkdir(parents=True)
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--windowed", "--onedir",
               "--name", NAME, "--distpath", str(build / "dist"),
               "--workpath", str(build / "work"), "--specpath", str(build)]
    command.extend(["--paths", str(TOOL_DIRECTORY),
                    "--add-data", f"{TOOL_DIRECTORY / 'data'};data",
                    "--add-data", f"{SCRIPT_DIRECTORY / 'export_gpa_icons.ps1'};scripts",
                    "--add-data", f"{ICON_DIRECTORY};.cache/icons",
                    str(SCRIPT_DIRECTORY / "portable_entry.py")])
    subprocess.run(command, check=True, cwd=TOOL_DIRECTORY)
    package = build / "dist" / NAME
    shutil.copy2(TOOL_DIRECTORY / "docs" / "PORTABLE-README.txt", package / "START HERE.txt")
    source = package / "source"
    source.mkdir()
    for filename in ("gui.py", "translate.py", "README.md"):
        shutil.copy2(TOOL_DIRECTORY / filename, source / filename)
    for directory in ("gpa_translator", "data", "tests", "scripts", "docs"):
        shutil.copytree(TOOL_DIRECTORY / directory, source / directory,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
    shutil.copytree(ICON_DIRECTORY, source / ".cache" / "icons")
    license_path = Path(sys.base_prefix) / "LICENSE.txt"
    tk_path = Path(sys.base_prefix) / "tcl" / "tk8.6" / "license.terms"
    notices = license_path.read_bytes()
    tk_notice = tk_path.read_bytes()
    # The official Windows Python notice already includes Tcl/Tk. Keep one file,
    # appending the original Tk notice only if a future runtime omits it.
    if tk_notice.decode("utf-8").replace("\r\n", "\n").strip() not in notices.decode("utf-8").replace("\r\n", "\n"):
        notices += b"\r\n\r\nTk license\r\n\r\n" + tk_notice
    (package / "LICENCE.txt").write_bytes(notices)
    # Verify the finished executable with its bundled runtime before shipping it.
    check = build / "self-test.json"
    subprocess.run([str(package / f"{NAME}.exe"), "--self-test", str(check)], check=True, timeout=60)
    print(check.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    archive_path = args.output / args.archive_name
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(package.rglob("*")):
            if file.is_file():
                archive.write(file, f"{NAME}/{file.relative_to(package).as_posix()}")
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("ZIP integrity check failed")
    print(f"ZIP: {archive_path}\nFolder: {package}")


if __name__ == "__main__":
    main()
