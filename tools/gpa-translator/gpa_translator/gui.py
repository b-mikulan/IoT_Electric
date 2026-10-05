"""Local desktop editor for GPA naming proposals (Python + Tkinter)."""

from __future__ import annotations

import argparse
from pathlib import Path
from queue import Empty, Queue
import sys
from threading import Thread
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .defaults import load_defaults
from .defaults_editor import DefaultsEditor
from .icon_images import IconImages, icon_cache_ready, prepare_icon_cache, proposal_uses_icon
from .name_rules import name_rule_for
from .review import ReviewSession
from .status_review import StatusReview
from .status_texts import apply_status_edits, build_status_groups, load_status_dictionary
from .translate import HERE, load_dictionary, propose_names, read_archive, write_archive


class TranslatorApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("GPA prevoditelj")
        self.root.geometry("1180x780")
        self.root.minsize(900, 600)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Title.TLabel", font=("Segoe UI", 17, "bold"))
        style.configure("Heading.TLabel", font=("Segoe UI", 10, "bold"))
        style.configure("Muted.TLabel", foreground="#526171")
        style.configure("Warning.TLabel", foreground="#9c5800")
        self.session: ReviewSession | None = None
        self.status_review: StatusReview | None = None
        self.status_dictionary: dict | None = None
        self.status_function_rooms: dict[str, str | None] = {}
        self.status_room_names: dict[str, str] = {}
        self.files: dict[str, bytes] = {}
        self.source: Path | None = None
        self.dirty = False
        self._syncing = False
        self.rows = {}
        self.strategy_controls = {}
        self.icon_labels = {}
        self.status_rows = {}
        self.status_icon_labels = []
        self.icon_images = IconImages(root)
        self.group_ids: list[str | None] = []
        self.file_label = tk.StringVar(value="Odaberite GPA projekt za pregled naziva.")
        self.summary = tk.StringVar(value="Sve se obrađuje lokalno na ovom računalu.")
        self.icon_status = tk.StringVar()
        self.allow_duplicates = tk.BooleanVar(master=root, value=False)
        self._build()
        if not icon_cache_ready():
            self.icon_status.set("Pripremam slike ikona iz lokalne instalacije GPA-a…")
            self._icon_result = Queue()
            Thread(target=lambda: self._icon_result.put(prepare_icon_cache()), daemon=True).start()
            self.root.after(150, self._icons_prepared)

    def _icons_prepared(self):
        try:
            ready = self._icon_result.get_nowait()
        except Empty:
            self.root.after(150, self._icons_prepared)
            return
        self.icon_status.set("" if ready else "Slike ikona nisu pripremljene. Pregled možete nastaviti uz tekstualna objašnjenja.")
        self.icon_images.images.clear()
        if self.session is not None:
            self._sync_rows()
            self._sync_status_rows()

    def _build(self):
        header = ttk.Frame(self.root, padding=(22, 18))
        header.pack(fill="x")
        ttk.Label(header, text="GPA prevoditelj", style="Title.TLabel").pack(side="left")
        self.save_button = ttk.Button(header, text="Spremi novi GPA…", command=self.save, state="disabled")
        self.save_button.pack(side="right")
        ttk.Button(header, text="Otvori projekt…", command=self.open).pack(side="right", padx=10)
        ttk.Label(self.root, textvariable=self.file_label, padding=(22, 0, 22, 12),
                  style="Muted.TLabel").pack(fill="x")
        panes = ttk.Panedwindow(self.root, orient="horizontal")
        panes.pack(fill="both", expand=True, padx=22)
        sidebar = ttk.Frame(panes, padding=(0, 8, 12, 0))
        panes.add(sidebar, weight=1)
        ttk.Label(sidebar, text="Sobe i grupe", style="Heading.TLabel").pack(anchor="w", pady=(0, 10))
        self.room_list = tk.Listbox(sidebar, width=28, activestyle="none", exportselection=False,
                                   font=("Segoe UI", 10), borderwidth=0, highlightthickness=1,
                                   selectbackground="#176b84", selectforeground="white")
        self.room_list.pack(fill="both", expand=True)
        self.room_list.bind("<<ListboxSelect>>", self.show_group)
        right = ttk.Frame(panes, padding=(12, 8, 0, 0))
        panes.add(right, weight=4)
        ttk.Label(right, text="Označite promjene koje želite spremiti. Hrvatski naziv možete slobodno urediti.",
                  wraplength=700, style="Muted.TLabel").pack(anchor="w", pady=(0, 10))
        self.tabs = ttk.Notebook(right)
        self.tabs.pack(fill="both", expand=True)
        names_page = ttk.Frame(self.tabs)
        statuses_page = ttk.Frame(self.tabs)
        self.defaults_editor = DefaultsEditor(self.tabs, HERE / "defaults.hr.json", self._defaults_saved)
        self.tabs.add(names_page, text="Nazivi")
        self.tabs.add(statuses_page, text="Tekstovi i opisi")
        self.tabs.add(self.defaults_editor, text="Prioritetni rječnik")
        self.duplicates_toggle = ttk.Checkbutton(
            names_page, text="Dopusti duplikatne nazive", variable=self.allow_duplicates,
            command=self._toggle_duplicates)
        self.duplicates_toggle.pack(anchor="w", padx=12, pady=(10, 6))
        self.canvas, self.content = self._scroll_page(names_page)
        self.status_canvas, self.status_content = self._scroll_page(statuses_page)
        self.root.bind_all("<MouseWheel>", self._wheel)
        self.empty_label = ttk.Label(self.content, text="Otvorite .gpa datoteku kako biste vidjeli prijedloge.",
                                    padding=(20, 30), style="Muted.TLabel")
        self.empty_label.pack(anchor="w")
        ttk.Label(self.status_content, text="Otvorite projekt za pregled statusnih tekstova, teksta gumba i opisa po sobi.",
                  padding=(20, 30), style="Muted.TLabel").pack(anchor="w")
        ttk.Separator(self.root).pack(fill="x", padx=22, pady=(12, 0))
        ttk.Label(self.root, textvariable=self.summary, padding=(22, 12)).pack(fill="x")
        ttk.Label(self.root, textvariable=self.icon_status, padding=(22, 0, 22, 4),
                  style="Muted.TLabel").pack(fill="x")

    def _scroll_page(self, parent):
        area = ttk.Frame(parent)
        area.pack(fill="both", expand=True)
        canvas = tk.Canvas(area, highlightthickness=0, background=ttk.Style().lookup("TFrame", "background"))
        scrollbar = ttk.Scrollbar(area, orient="vertical", command=canvas.yview)
        scrollbar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        canvas.configure(yscrollcommand=scrollbar.set)
        content = ttk.Frame(canvas)
        window = canvas.create_window((0, 0), window=content, anchor="nw")
        content.bind("<Configure>", lambda _: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window, width=e.width))
        return canvas, content

    def _wheel(self, event):
        widget = self.root.winfo_containing(event.x_root, event.y_root)
        while widget is not None:
            if widget in (self.canvas, self.status_canvas):
                widget.yview_scroll(-int(event.delta / 120), "units")
                return "break"
            widget = getattr(widget, "master", None)

    def _discard_ok(self):
        return not self.dirty or messagebox.askyesno(
            "Nespremljen pregled", "Odbaciti nespremljene izmjene ovog pregleda?", parent=self.root)

    def open(self):
        if not self._discard_ok():
            return
        filename = filedialog.askopenfilename(parent=self.root, title="Odaberi GPA projekt",
                                              filetypes=[("Gira projekt", "*.gpa")])
        if filename:
            self.load_project(Path(filename))

    def load_project(self, path: Path):
        self.root.configure(cursor="watch")
        self.root.update_idletasks()
        try:
            files = read_archive(path)
            rooms = load_dictionary(HERE / "rooms.hr.json", "translations")
            icons = load_dictionary(HERE / "icons.hr.json", "icons")
            proposals = propose_names(files, rooms, icons, load_defaults(HERE / "defaults.hr.json"))
            session = ReviewSession(proposals, icons, allow_duplicates=self.allow_duplicates.get())
            status_dictionary = load_status_dictionary(HERE / "status-texts.hr.json")
            function_rooms = {p.entity_id: (p.room_id if p.room_id in session.by_id else None)
                              for p in proposals if p.kind == "function"}
            room_names = self._applied_room_names(session)
            statuses = StatusReview(build_status_groups(files, function_rooms, status_dictionary, room_names))
        except Exception as error:
            messagebox.showerror("Projekt nije učitan", str(error), parent=self.root)
            return False
        finally:
            self.root.configure(cursor="")
        self.source, self.files, self.session = path, files, session
        self.status_review = statuses
        self.status_dictionary = status_dictionary
        self.status_function_rooms = function_rooms
        self.status_room_names = room_names
        self.dirty = False
        self.file_label.set(path.name)
        self.group_ids = [p.entity_id for p in session.rooms]
        if session.children[None]:
            self.group_ids.append(None)
        self._refresh_room_list()
        self.save_button.configure(state="normal")
        if self.group_ids:
            self.room_list.selection_set(0)
            self.show_group()
        else:
            self.rows = {}
            self.strategy_controls = {}
            self.icon_labels = {}
            self.status_rows = {}
            for child in self.content.winfo_children():
                child.destroy()
            ttk.Label(self.content, text="Ovaj projekt nema prostorija ni funkcija za preimenovanje.",
                      padding=20, style="Muted.TLabel").pack(anchor="w")
            self._show_status_groups(None)
        self._summary()
        return True

    @staticmethod
    def _applied_room_names(session):
        return {room.entity_id: (session.edits[room.entity_id].name
                                if session.edits[room.entity_id].selected else room.old)
                for room in session.rooms}

    def _refresh_status_proposals(self):
        if self.session is None or self.status_review is None or self.status_dictionary is None:
            return
        room_names = self._applied_room_names(self.session)
        if room_names == self.status_room_names:
            return
        self.status_review.refresh(build_status_groups(
            self.files, self.status_function_rooms, self.status_dictionary, room_names))
        self.status_room_names = room_names
        self._sync_status_rows()

    def _refresh_room_list(self):
        if self.session is None:
            return
        selected = self.room_list.curselection()
        self.room_list.delete(0, "end")
        for uid in self.group_ids:
            p = self.session.by_id.get(uid)
            label = p.old if p else "Bez jednoznačne sobe"
            self.room_list.insert("end", f"{label}  ({len(self.session.children[uid])})")
        if selected:
            self.room_list.selection_set(selected[0])

    def show_group(self, _event=None):
        if self.session is None or not self.room_list.curselection():
            return
        uid = self.group_ids[self.room_list.curselection()[0]]
        self.rows = {}
        self.strategy_controls = {}
        self.icon_labels = {}
        for child in self.content.winfo_children():
            child.destroy()
        p = self.session.by_id.get(uid)
        if p:
            ttk.Label(self.content, text="PROSTORIJA / GRUPA", style="Heading.TLabel").pack(anchor="w", pady=(8, 4))
            self._row(p, self.content)
        else:
            ttk.Label(self.content, text="Bez jednoznačne sobe", style="Title.TLabel").pack(anchor="w", pady=12)
        ttk.Separator(self.content).pack(fill="x", pady=14)
        ttk.Label(self.content, text="FUNKCIJE U PROSTORIJI", style="Heading.TLabel").pack(anchor="w", padx=22, pady=(0, 8))
        functions = ttk.Frame(self.content, padding=(22, 0, 8, 0))
        functions.pack(fill="x")
        for child in self.session.children[uid]:
            self._row(child, functions)
        if not self.session.children[uid]:
            ttk.Label(functions, text="Ova grupa nema izravno povezanih funkcija.", style="Muted.TLabel").pack(anchor="w", pady=10)
        self.canvas.yview_moveto(0)
        self._show_status_groups(uid)
        self._sync_rows()

    def _show_status_groups(self, room_id):
        self.status_rows = {}
        self.status_icon_labels = []
        for child in self.status_content.winfo_children():
            child.destroy()
        ttk.Label(self.status_content,
                  text="Zajednički tekstovi vrijede samo za navedene funkcije u ovoj sobi. "
                       "Svako polje možete urediti i zasebno označiti za spremanje.",
                  wraplength=650, padding=(12, 14), style="Muted.TLabel").pack(fill="x")
        groups = self.status_review.by_room[room_id] if self.status_review else []
        if not groups:
            ttk.Label(self.status_content, text="U ovoj sobi nema podržanih statusnih tekstova, teksta gumba ni opisa.",
                      padding=12, style="Muted.TLabel").pack(anchor="w")
        for group in groups:
            icon = self.session.icons.get(group.icon_id, {})
            label = group.type_label + " · " + icon.get("hr", f"Ikona {group.icon_id}")
            if group.variant is not None:
                label += " · Opis: " + (group.variant or "(prazno)")
            card = ttk.LabelFrame(self.status_content, text=label, padding=12)
            card.pack(fill="x", padx=10, pady=(0, 16))
            members = [self.session.by_id[uid].old for uid in group.entity_ids if uid in self.session.by_id]
            heading = ttk.Frame(card)
            heading.pack(fill="x", pady=(0, 10))
            picture = ttk.Label(heading)
            picture.pack(side="left", padx=(0, 10))
            self.status_icon_labels.append((picture, group.icon_id))
            ttk.Label(heading, text=f"Primjenjuje se na {len(group.entity_ids)} funkcija: " + ", ".join(members),
                      wraplength=580, style="Muted.TLabel").pack(side="left", fill="x", expand=True)
            for field in group.fields:
                key = group.key + (field.key,)
                edit = self.status_review.edits[key]
                row = ttk.Frame(card)
                row.pack(fill="x", pady=(4, 10))
                row.columnconfigure(1, weight=1)
                row.columnconfigure(3, weight=1)
                selected = tk.BooleanVar(value=edit.selected)
                value = tk.StringVar(value=edit.text)
                ttk.Checkbutton(row, variable=selected,
                                command=lambda k=key, v=selected: self._status_toggle(k, v.get())).grid(row=0, column=0, rowspan=3, sticky="n")
                ttk.Label(row, text=field.label, style="Heading.TLabel").grid(row=0, column=1, columnspan=4, sticky="w")
                originals = " · ".join(f"{old if old else '(prazno)'} ({count}×)" for old, count in field.old_values.items())
                ttk.Label(row, text=originals, wraplength=210).grid(row=1, column=1, sticky="nw", pady=6)
                ttk.Label(row, text="→").grid(row=1, column=2, padx=10)
                entry = ttk.Combobox(row, textvariable=value, values=field.candidates, width=24)
                entry.grid(row=1, column=3, sticky="ew", pady=6)
                ttk.Button(row, text="Vrati", width=6, command=lambda k=key: self._status_reset(k)).grid(row=1, column=4, padx=(8, 0))
                reason = ttk.Label(row, wraplength=600, style="Muted.TLabel")
                reason.grid(row=2, column=1, columnspan=4, sticky="w")
                self.status_rows[key] = (value, selected, reason, entry)
                value.trace_add("write", lambda *_, k=key, v=value: self._status_edit(k, v.get()))
        self.status_canvas.yview_moveto(0)
        self._sync_status_rows()

    def _sync_status_rows(self):
        if self.status_review is None:
            return
        was_syncing = self._syncing
        self._syncing = True
        try:
            for label, icon_id in self.status_icon_labels:
                image = self.icon_images.get(icon_id)
                label.configure(image=image if image is not None else "")
            for key, (value, selected, reason, entry) in self.status_rows.items():
                edit = self.status_review.edits[key]
                entry.configure(values=edit.field.candidates)
                if value.get() != edit.text:
                    value.set(edit.text)
                selected.set(edit.selected)
                detail = "Ručno postavljen zajednički tekst." if key in self.status_review.manual else edit.field.reason
                if self.status_review.unresolved(key):
                    detail += " Različiti izvorni tekstovi: odaberite ili unesite zajednički tekst."
                changes = sum(t.old != edit.text for t in edit.field.targets) if edit.selected and not self.status_review.unresolved(key) else 0
                detail += f" Odabrano promjena: {changes}." if edit.selected else " Nije označeno za spremanje."
                reason.configure(text=detail, style="Warning.TLabel" if self.status_review.unresolved(key) else "Muted.TLabel")
        finally:
            self._syncing = was_syncing

    def _status_edit(self, key, value):
        if self._syncing:
            return
        self.status_review.set_text(key, value)
        self.dirty = True
        self._sync_status_rows()
        self._summary()

    def _status_toggle(self, key, selected):
        self.status_review.set_selected(key, selected)
        self.dirty = True
        self._sync_status_rows()
        self._summary()

    def _status_reset(self, key):
        self.status_review.reset(key)
        self.dirty = True
        self._sync_status_rows()
        self._summary()

    def _row(self, p, parent):
        edit = self.session.edits[p.entity_id]
        frame = ttk.Frame(parent, padding=(0, 8, 8, 10))
        frame.pack(fill="x")
        frame.columnconfigure(3, weight=1)
        checked = tk.BooleanVar(value=edit.selected)
        name = tk.StringVar(value=edit.name)
        ttk.Checkbutton(frame, variable=checked, command=lambda: self._toggle(p.entity_id, checked.get())).grid(row=0, column=0, rowspan=2, sticky="n", padx=(0, 5))
        ttk.Label(frame, text="Izvorni naziv", style="Muted.TLabel").grid(row=0, column=1, sticky="w")
        ttk.Label(frame, text=p.old, width=25, wraplength=190).grid(row=1, column=1, sticky="nw", pady=5)
        ttk.Label(frame, text="→").grid(row=1, column=2, padx=10)
        ttk.Label(frame, text="Novi naziv (HR)", style="Muted.TLabel").grid(row=0, column=3, sticky="w")
        entry = ttk.Entry(frame, textvariable=name, font=("Segoe UI", 10))
        entry.grid(row=1, column=3, sticky="ew", pady=5)
        ttk.Button(frame, text="Vrati", width=6, command=lambda: self._reset(p.entity_id)).grid(row=1, column=4, padx=(8, 0))
        explanation = ttk.Frame(frame)
        explanation.grid(row=2, column=1, columnspan=4, sticky="ew", pady=(2, 0))
        icon_label = ttk.Label(explanation, style="Muted.TLabel", anchor="center")
        reason = ttk.Label(explanation, wraplength=595, style="Muted.TLabel")
        reason.pack(side="left", fill="x", expand=True)
        self.icon_labels[p.entity_id] = icon_label
        self.rows[p.entity_id] = (name, checked, reason, entry)
        if p.default_new is not None:
            controls = ttk.Frame(frame)
            controls.grid(row=3, column=1, columnspan=4, sticky="w", pady=(7, 0))
            ttk.Label(controls, text="Način prijevoda:", style="Muted.TLabel").pack(side="left", padx=(0, 8))
            strategy = tk.StringVar(value="Poznati prijevod" if edit.strategy == "default" else "Automatika")
            choice = ttk.Combobox(controls, textvariable=strategy,
                                  values=("Poznati prijevod", "Automatika"), state="readonly", width=23)
            choice.pack(side="left")
            choice.bind("<<ComboboxSelected>>", lambda _, uid=p.entity_id, var=strategy:
                        self._strategy(uid, "default" if var.get() == "Poznati prijevod" else "automatic"))
            self.strategy_controls[p.entity_id] = strategy
        name.trace_add("write", lambda *_: self._edit(p.entity_id, name.get()))

    def _reason(self, p, duplicates):
        edit = self.session.edits[p.entity_id]
        if edit.manual:
            detail = "Ručno uređen naziv."
            if proposal_uses_icon(p, self.session):
                icon = self.session.icons.get(p.icon_id, {})
                detail += f" Početni prijedlog prema ikoni {icon.get('en', p.icon_id)} → {icon.get('hr', '?')}."
        elif edit.strategy == "default":
            detail = "Poznati prijevod iz prioritetnog rječnika."
        elif p.kind == "room":
            detail = "Prijevod naziva iz rječnika soba; broj se zadržava." if p.new is not None else "Naziv nije u rječniku. Unesite prijevod ručno."
        else:
            suggested = self.session.suggested_name(p)
            naming_rule = name_rule_for(p.old, p.room)
            if naming_rule is not None:
                detail = (f"{naming_rule.label} → {naming_rule.prefix} + soba: {self.session.room_name(p)}."
                          if suggested is not None else
                          f"{naming_rule.label} → {naming_rule.prefix}; nema jednoznačne sobe. Unesite naziv ručno.")
            elif suggested is None or (p.status == "unknown" and edit.name == p.old):
                detail = "Nema poznate ikone ili jednoznačne sobe. Unesite naziv ručno."
            else:
                icon = self.session.icons.get(p.icon_id, {})
                detail = f"Ikona {icon.get('en', p.icon_id)} → {icon.get('hr', '?')} + soba {self.session.room_name(p)}."
        if p.default_new is not None:
            automatic = self.session.automatic_name(p)
            detail += f" Poznati: {p.default_new}. Automatika: {automatic or 'nije dostupna'}."
            actual_room = self.session.room_name(p) if p.kind == "function" else None
            if p.default_room and actual_room and p.default_room.strip().casefold() != actual_room.strip().casefold():
                detail += f" Različita soba: rječnik očekuje {p.default_room}, projekt je u sobi {actual_room}."
        if not edit.selected and edit.name != p.old:
            detail += " Prijedlog nije označen za spremanje."
        if p.entity_id in duplicates:
            detail += (" Duplikatni naziv dopušten je za spremanje." if self.session.allow_duplicates else
                       " Više funkcija u ovoj sobi spremilo bi se pod istim nazivom.")
        elif p.status == "review" and not edit.manual and not self.session.allow_duplicates:
            detail += " Početni prijedlog ponavlja se; pregledajte i označite željene promjene."
        return detail

    def _sync_rows(self):
        self._refresh_status_proposals()
        self._syncing = True
        try:
            duplicates = self.session.duplicate_ids()
            for uid, (name, checked, reason, _entry) in self.rows.items():
                edit = self.session.edits[uid]
                if name.get() != edit.name:
                    name.set(edit.name)
                checked.set(edit.selected)
                if uid in self.strategy_controls:
                    self.strategy_controls[uid].set("Poznati prijevod" if edit.strategy == "default" else "Automatika")
                p = self.session.by_id[uid]
                icon_label = self.icon_labels[uid]
                if proposal_uses_icon(p, self.session):
                    image = self.icon_images.get(p.icon_id)
                    icon_label.configure(image=image if image is not None else "",
                                         text="" if image is not None else f"Ikona {p.icon_id}\nSlika nije dostupna")
                    icon_label.pack(side="left", before=reason, padx=(0, 10))
                else:
                    icon_label.pack_forget()
                room = self.session.room_name(p) if p.kind == "function" else None
                mismatch = bool(p.default_room and room and p.default_room.strip().casefold() != room.strip().casefold())
                warning = (p.status == "unknown" or mismatch or
                           (not self.session.allow_duplicates and (uid in duplicates or p.status == "review")))
                reason.configure(text=self._reason(p, duplicates), style="Warning.TLabel" if warning else "Muted.TLabel")
        finally:
            self._syncing = False
        self._summary()

    def _edit(self, uid, name):
        if self._syncing:
            return
        self.session.set_name(uid, name)
        self.dirty = True
        self._sync_rows()

    def _toggle_duplicates(self):
        if self.session is not None:
            self.session.set_allow_duplicates(self.allow_duplicates.get())
            self.dirty = True
            self._sync_rows()

    def _strategy(self, uid, strategy):
        self.session.set_strategy(uid, strategy)
        self.dirty = True
        self._sync_rows()

    def _defaults_saved(self, rules):
        if self.session is not None:
            self.session.refresh_defaults(rules)
            self.dirty = True
            self.show_group()

    def _toggle(self, uid, checked):
        self.session.set_selected(uid, checked)
        self.dirty = True
        self._sync_rows()

    def _reset(self, uid):
        self.session.reset(uid)
        self.dirty = True
        self._sync_rows()

    def _summary(self):
        if self.session:
            self.summary.set(f"{len(self.session.rooms)} soba/grupa · {sum(len(v) for v in self.session.children.values())} funkcija · "
                             f"{self.session.changed_count()} naziva + "
                             f"{self.status_review.changed_count() if self.status_review else 0} statusnih tekstova · "
                             f"{len(self.session.duplicate_ids())} funkcija s ponovljenim konačnim nazivom")

    def save(self):
        if self.session is None:
            return
        self._refresh_status_proposals()
        try:
            reviewed = self.session.reviewed()
            status_files, status_count = apply_status_edits(self.files, self.status_review.reviewed())
        except ValueError as error:
            messagebox.showerror("Provjerite nazive", str(error), parent=self.root)
            return
        if not status_count and not any(p.status == "ready" for p in reviewed):
            messagebox.showinfo("Nema promjena", "Označite ili uredite naziv ili statusni tekst koji želite promijeniti.", parent=self.root)
            return
        filename = filedialog.asksaveasfilename(parent=self.root, title="Spremi novi GPA projekt",
            initialdir=self.source.parent, initialfile=self.source.stem + " - prevedeno.gpa",
            defaultextension=".gpa", filetypes=[("Gira projekt", "*.gpa")], confirmoverwrite=False)
        if not filename:
            return
        self.root.configure(cursor="watch")
        self.root.update_idletasks()
        try:
            count = write_archive(Path(filename), status_files, reviewed)
        except Exception as error:
            messagebox.showerror("Projekt nije spremljen", f"{error}\n\nOdaberite novo ime izlazne datoteke.", parent=self.root)
            return
        finally:
            self.root.configure(cursor="")
        self.dirty = False
        messagebox.showinfo("Projekt spremljen", f"Spremljeno {count} naziva i {status_count} statusnih tekstova u:\n{filename}", parent=self.root)

    def close(self):
        if self._discard_ok() and self.defaults_editor.confirm_discard():
            self.root.destroy()


def main():
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Pregled i uređivanje GPA naziva po sobama.")
    parser.add_argument("project", nargs="?", type=Path)
    args = parser.parse_args()
    root = tk.Tk()
    app = TranslatorApp(root)
    if args.project:
        root.after(100, lambda: app.load_project(args.project))
    root.mainloop()


if __name__ == "__main__":
    main()
