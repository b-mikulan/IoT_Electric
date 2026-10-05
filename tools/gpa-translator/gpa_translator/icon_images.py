"""Small Tk image cache for original GPA icons, addressed by numeric IconId."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tkinter as tk


from .paths import ICON_DIRECTORY, SCRIPT_DIRECTORY
from .name_rules import name_rule_for


def icon_cache_ready(directory: Path = ICON_DIRECTORY) -> bool:
    try:
        catalog = json.loads((directory / "catalog.json").read_text(encoding="utf-8"))
        ids = catalog["icons"]
        return isinstance(ids, dict) and bool(ids) and all(
            re.fullmatch(r"\d+", uid) and (directory / f"{uid}.png").is_file()
            for uid in ids
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def prepare_icon_cache(directory: Path = ICON_DIRECTORY) -> bool:
    """Read installed GPA 6.0 resources once; call from a worker, not the Tk loop."""
    if icon_cache_ready(directory):
        return True
    if sys.platform != "win32":
        return False
    gpa = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Gira" / "Gira Project Assistant" / "6.0"
    if not (gpa / "Kingfisher.Core.Ui.dll").is_file():
        return False
    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    try:
        # RemoteSigned applies only to this helper process, without changing system settings.
        result = subprocess.run(
            [str(powershell), "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "RemoteSigned", "-File",
             str(SCRIPT_DIRECTORY / "export_gpa_icons.ps1"),
             "-GpaDirectory", str(gpa), "-OutputDirectory", str(directory)],
            capture_output=True, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return result.returncode == 0 and icon_cache_ready(directory)
    except (OSError, subprocess.SubprocessError):
        return False


class IconImages:
    def __init__(self, master, directory: Path = ICON_DIRECTORY):
        self.master = master
        self.directory = directory
        # Keep references alive while switching rooms (Tk does not own PhotoImage).
        self.images: dict[str, tk.PhotoImage | None] = {}

    def get(self, icon_id: str | None) -> tk.PhotoImage | None:
        if not icon_id or re.fullmatch(r"\d+", icon_id) is None:
            return None
        if icon_id not in self.images:
            try:
                image = tk.PhotoImage(master=self.master,
                                     data=(self.directory / f"{icon_id}.png").read_bytes(), format="png")
                # Source renders use 80 px; show 40 px in the review rows.
                factor = max(1, (max(image.width(), image.height()) + 39) // 40)
                self.images[icon_id] = image.subsample(factor, factor) if factor > 1 else image
            except (OSError, tk.TclError):
                self.images[icon_id] = None
        return self.images[icon_id]


def proposal_uses_icon(proposal, session) -> bool:
    """Show an icon only when it supplies the proposed function name."""
    if proposal.kind != "function" or name_rule_for(proposal.old, proposal.room) is not None:
        return False
    if session.edits[proposal.entity_id].strategy == "default":
        return False
    if proposal.icon_id not in session.icons or session.suggested_name(proposal) is None:
        return False
    edit = session.edits[proposal.entity_id]
    return proposal.new is not None or (not edit.manual and edit.name != proposal.old)
