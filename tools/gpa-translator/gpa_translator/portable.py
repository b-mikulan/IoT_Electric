"""Windows executable entry point, including an unattended package check."""

import json
from pathlib import Path
import sys
import tempfile
import traceback
import tkinter as tk

from .gui import TranslatorApp, main
from .defaults import load_defaults
from .icon_images import IconImages, icon_cache_ready, proposal_uses_icon
from .status_texts import apply_status_edits, load_status_dictionary
from .translate import HERE, load_dictionary, read_archive, write_archive


def check_package(report: Path, project: Path | None = None) -> int:
    root = None
    result = {"ok": False}
    try:
        rooms = load_dictionary(HERE / "rooms.hr.json", "translations")
        icons = load_dictionary(HERE / "icons.hr.json", "icons")
        load_status_dictionary(HERE / "status-texts.hr.json")
        defaults = load_defaults(HERE / "defaults.hr.json")
        if not icon_cache_ready():
            raise RuntimeError("Incomplete icon cache")
        root = tk.Tk()
        root.withdraw()
        images = IconImages(root)
        for uid in icons:
            if images.get(uid) is None:
                raise RuntimeError(f"Missing or unreadable icon {uid}")
        app = TranslatorApp(root)
        root.update_idletasks()
        result.update(rooms=len(rooms), icons=len(icons), priority_rules=len(defaults))
        if project is not None:
            if not app.load_project(project):
                raise RuntimeError("Project could not be loaded")
            initial_selection = {uid: edit.selected for uid, edit in app.session.edits.items()}
            pending_duplicates = {
                uid for uid in app.session.duplicate_candidate_ids()
                if not initial_selection[uid] and app.session.by_id[uid].new is not None
                and app.session.edits[uid].name != app.session.by_id[uid].old
            }
            app.duplicates_toggle.invoke()
            if (not app.session.allow_duplicates
                    or any(not app.session.edits[uid].selected for uid in pending_duplicates)):
                raise RuntimeError("Duplicate option did not select pending proposals")
            app.duplicates_toggle.invoke()
            if app.session.allow_duplicates or any(
                edit.selected != initial_selection[uid] for uid, edit in app.session.edits.items()
            ):
                raise RuntimeError("Duplicate option did not restore initial selection")
            result["auto_selected_duplicates"] = len(pending_duplicates)
            count = 0
            for index in range(len(app.group_ids)):
                app.room_list.selection_clear(0, "end")
                app.room_list.selection_set(index)
                app.show_group()
                root.update_idletasks()
                for uid, label in app.icon_labels.items():
                    if proposal_uses_icon(app.session.by_id[uid], app.session):
                        if not label.cget("image"):
                            raise RuntimeError("Missing image in project review")
                        count += 1
            with tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / "checked.gpa"
                status_files, status_count = apply_status_edits(app.files, app.status_review.reviewed())
                changes = write_archive(output, status_files, app.session.reviewed())
                if set(read_archive(output)) != set(app.files):
                    raise RuntimeError("Archive paths differ after saving")
            result.update(groups=len(app.group_ids), displayed_icons=count, saved_changes=changes,
                          saved_status_texts=status_count)
        result["ok"] = True
    except Exception:
        result["error"] = traceback.format_exc()
    finally:
        if root is not None:
            root.destroy()
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--self-test":
        raise SystemExit(check_package(Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None))
    main()
