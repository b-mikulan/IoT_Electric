"""Local editor for the priority dictionary, available without an open project."""

from __future__ import annotations

from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable

from .defaults import DefaultRule, load_defaults, save_defaults, validate_rules


class DefaultsEditor(ttk.Frame):
    """Edit exact-name rules and notify the project only after a successful save."""

    _fields = ("source_name", "target_hr", "kind", "icon_id", "urn", "expected_room")

    def __init__(self, parent, path: Path,
                 on_saved: Callable[[list[DefaultRule]], None]):
        super().__init__(parent, padding=12)
        self.path = Path(path)
        self.on_saved = on_saved
        self.rules: list[DefaultRule] = []
        self._saved_rules: list[DefaultRule] = []
        self._snapshot: bytes | None = None
        self._load_valid = True
        self._selected_index: int | None = None
        self._filling = False
        self._selecting = False
        self._form_baseline: tuple[str, ...] = ()
        self.search = tk.StringVar(master=self)
        self.status = tk.StringVar(master=self)
        self.dirty_label = tk.StringVar(master=self)
        self.values = {field: tk.StringVar(master=self) for field in self._fields}
        self._build()
        self.search.trace_add("write", lambda *_: self._refresh_table())
        for variable in self.values.values():
            variable.trace_add("write", self._form_changed)
        self._load()

    @property
    def dirty(self) -> bool:
        return self.rules != self._saved_rules or self._draft_changed()

    def confirm_discard(self) -> bool:
        return not self.dirty or messagebox.askyesno(
            "Nespremljen prioritetni rječnik",
            "Odbaciti nespremljene izmjene prioritetnog rječnika?",
            parent=self.winfo_toplevel(),
        )

    def _build(self):
        ttk.Label(self, text="Prioritetni prijevodi poznatih naziva",
                  style="Heading.TLabel").pack(anchor="w")
        ttk.Label(self, text=("Oznake AC…, FH…, T… i S… prevode se zasebnim pravilima prema sobi. "
                              "Za ostale nazive traži se cijeli izvorni naziv, uz razlikovanje velikih i malih slova. "
                              "ID ikone i tip funkcije mogu suziti pravilo. Soba iz primjera služi kao napomena."),
                  wraplength=700, style="Muted.TLabel").pack(anchor="w", pady=(4, 10))
        search_bar = ttk.Frame(self)
        search_bar.pack(fill="x", pady=(0, 8))
        ttk.Label(search_bar, text="Pretraži:").pack(side="left", padx=(0, 8))
        ttk.Entry(search_bar, textvariable=self.search).pack(side="left", fill="x", expand=True)
        ttk.Label(search_bar, textvariable=self.dirty_label,
                  style="Warning.TLabel").pack(side="right", padx=(12, 0))

        table_area = ttk.Frame(self)
        table_area.pack(fill="both", expand=True)
        columns = ("source_name", "target_hr", "kind", "icon_id", "urn", "expected_room")
        self.table = ttk.Treeview(table_area, columns=columns, show="headings",
                                  selectmode="browse", height=9)
        headings = (("Izvorni naziv", 100), ("Hrvatski naziv", 170), ("Vrsta", 65),
                    ("Ikona", 50), ("Tip funkcije", 170), ("Soba iz primjera", 120))
        for column, (label, width) in zip(columns, headings):
            self.table.heading(column, text=label)
            self.table.column(column, width=width, minwidth=45, stretch=True)
        vertical = ttk.Scrollbar(table_area, orient="vertical", command=self.table.yview)
        horizontal = ttk.Scrollbar(table_area, orient="horizontal", command=self.table.xview)
        self.table.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        table_area.columnconfigure(0, weight=1)
        table_area.rowconfigure(0, weight=1)
        self.table.grid(row=0, column=0, sticky="nsew")
        vertical.grid(row=0, column=1, sticky="ns")
        horizontal.grid(row=1, column=0, sticky="ew")
        self.table.bind("<<TreeviewSelect>>", self._on_select)

        details = ttk.LabelFrame(self, text="Odabrano ili novo pravilo", padding=10)
        details.pack(fill="x", pady=(10, 0))
        details.columnconfigure(1, weight=1)
        details.columnconfigure(3, weight=1)
        labels = ("Izvorni naziv", "Hrvatski naziv", "Vrsta objekta", "ID ikone (opcionalno)",
                  "Tip funkcije / URN (opcionalno)", "Soba iz primjera (opcionalno)")
        self.entries = {}
        for index, (field, label) in enumerate(zip(self._fields, labels)):
            row, column = divmod(index, 2)
            column *= 2
            ttk.Label(details, text=label).grid(row=row * 2, column=column, columnspan=2,
                                               sticky="w", padx=(0, 10), pady=(2, 3))
            if field == "kind":
                entry = ttk.Combobox(details, textvariable=self.values[field],
                                     values=("function", "room"), state="readonly", width=20)
            else:
                entry = ttk.Entry(details, textvariable=self.values[field])
            entry.grid(row=row * 2 + 1, column=column, columnspan=2,
                       sticky="ew", padx=(0, 10), pady=(0, 5))
            self.entries[field] = entry

        edit_bar = ttk.Frame(self)
        edit_bar.pack(fill="x", pady=10)
        ttk.Button(edit_bar, text="Dodaj", command=self.add_rule).pack(side="left")
        self.update_button = ttk.Button(edit_bar, text="Izmijeni odabrano", command=self.update_rule)
        self.update_button.pack(side="left", padx=6)
        self.delete_button = ttk.Button(edit_bar, text="Obriši odabrano", command=self.delete_rule)
        self.delete_button.pack(side="left")
        ttk.Button(edit_bar, text="Očisti obrazac", command=self.clear_form).pack(side="right")
        save_bar = ttk.Frame(self)
        save_bar.pack(fill="x")
        self.save_button = ttk.Button(save_bar, text="Spremi JSON", command=self.save)
        self.save_button.pack(side="left")
        ttk.Button(save_bar, text="Učitaj ponovno", command=self.reload).pack(side="left", padx=6)
        ttk.Label(self, textvariable=self.status, wraplength=700,
                  style="Muted.TLabel").pack(anchor="w", fill="x", pady=(8, 0))

    def _draft_values(self) -> tuple[str, ...]:
        return tuple(self.values[field].get() for field in self._fields)

    def _draft_changed(self) -> bool:
        return bool(self._form_baseline) and self._draft_values() != self._form_baseline

    def _update_dirty_label(self):
        self.dirty_label.set("Nespremljene izmjene" if self.dirty else "")

    def _form_changed(self, *_):
        if not self._filling:
            self._update_dirty_label()

    def _fill_form(self, index: int | None):
        self._filling = True
        self._selected_index = index
        rule = self.rules[index] if index is not None else DefaultRule("", "")
        for field in self._fields:
            self.values[field].set(getattr(rule, field) or "")
        self._form_baseline = self._draft_values()
        self._filling = False
        state = "normal" if index is not None else "disabled"
        self.update_button.configure(state=state)
        self.delete_button.configure(state=state)
        self._update_dirty_label()

    def clear_form(self):
        """An explicit form reset leaves the table's pending edits intact."""
        self._selecting = True
        self.table.selection_remove(*self.table.selection())
        self._fill_form(None)
        self._selecting = False
        self.status.set("Unesite izvorni i hrvatski naziv pa pritisnite Dodaj.")

    def _refresh_table(self):
        self._selecting = True
        self.table.delete(*self.table.get_children())
        query = self.search.get().strip().casefold()
        for index, rule in enumerate(self.rules):
            values = tuple(getattr(rule, field) or "" for field in self._fields)
            if not query or any(query in str(value).casefold() for value in (*values, rule.provenance)):
                self.table.insert("", "end", iid=str(index), values=values)
        if self._selected_index is not None and self.table.exists(str(self._selected_index)):
            self.table.selection_set(str(self._selected_index))
        self._selecting = False

    def _on_select(self, _event=None):
        if self._selecting:
            return
        selection = self.table.selection()
        if not selection:
            return
        index = int(selection[0])
        if index == self._selected_index:
            return
        if self._draft_changed():
            self._selecting = True
            if self._selected_index is not None and self.table.exists(str(self._selected_index)):
                self.table.selection_set(str(self._selected_index))
            else:
                self.table.selection_remove(*selection)
            self._selecting = False
            self.status.set("Obrazac sadrži izmjene. Primijenite ih gumbom Dodaj, Izmijeni odabrano "
                            "ili Spremi JSON; za novi odabir možete i očistiti obrazac.")
            return
        self._fill_form(index)

    def _rule_from_form(self, *, creating=False) -> DefaultRule:
        previous = (self.rules[self._selected_index]
                    if self._selected_index is not None and not creating else None)
        return DefaultRule(
            source_name=self.values["source_name"].get(),
            target_hr=self.values["target_hr"].get(),
            kind=self.values["kind"].get(),
            icon_id=self.values["icon_id"].get().strip() or None,
            urn=self.values["urn"].get().strip() or None,
            expected_room=self.values["expected_room"].get().strip() or None,
            provenance=previous.provenance if previous else "manual",
        )

    def _error(self, message: str):
        self.status.set(message)
        messagebox.showerror("Prioritetni rječnik", message, parent=self.winfo_toplevel())

    def add_rule(self) -> bool:
        try:
            rules = [*self.rules, self._rule_from_form(creating=True)]
            validate_rules(rules)
        except ValueError as error:
            self._error(str(error))
            return False
        self.rules = rules
        self._fill_form(len(rules) - 1)
        self._refresh_table()
        self.status.set("Pravilo je dodano. Spremi JSON primjenjuje izmjene na otvoreni projekt.")
        return True

    def update_rule(self) -> bool:
        if self._selected_index is None:
            self.status.set("Odaberite pravilo koje želite izmijeniti.")
            return False
        try:
            rules = list(self.rules)
            rules[self._selected_index] = self._rule_from_form()
            validate_rules(rules)
        except ValueError as error:
            self._error(str(error))
            return False
        self.rules = rules
        self._fill_form(self._selected_index)
        self._refresh_table()
        self.status.set("Pravilo je izmijenjeno. Spremi JSON primjenjuje izmjene na otvoreni projekt.")
        return True

    def delete_rule(self) -> bool:
        if self._selected_index is None:
            self.status.set("Odaberite pravilo koje želite obrisati.")
            return False
        del self.rules[self._selected_index]
        self._fill_form(None)
        self._refresh_table()
        self.status.set("Pravilo je obrisano iz pregleda. Spremite JSON kako biste zadržali izmjenu.")
        return True

    def _load(self):
        try:
            rules = load_defaults(self.path)
            snapshot = self.path.read_bytes()
        except FileNotFoundError:
            rules, snapshot = [], None
            self._load_valid = True
            self.status.set("Rječnik još ne postoji. Dodajte pravila i spremite JSON za njegovu izradu.")
        except (OSError, ValueError) as error:
            self._load_valid = False
            self.status.set(f"Rječnik nije učitan: {error}. Ispravite datoteku pa odaberite Učitaj ponovno.")
            self.save_button.configure(state="disabled")
            self._fill_form(None)
            self._refresh_table()
            return
        else:
            self._load_valid = True
            self.status.set(f"Učitano {len(rules)} pravila. Datoteka: {self.path.name}")
        self.rules = rules
        self._saved_rules = list(rules)
        self._snapshot = snapshot
        self.save_button.configure(state="normal")
        self._fill_form(None)
        self._refresh_table()

    def reload(self) -> bool:
        if not self.confirm_discard():
            return False
        self._load()
        return self._load_valid

    def save(self) -> bool:
        if not self._load_valid:
            self._error("Neispravan rječnik nije moguće prepisati. Ispravite datoteku pa je ponovno učitajte.")
            return False
        if self._draft_changed():
            applied = self.update_rule() if self._selected_index is not None else self.add_rule()
            if not applied:
                return False
        try:
            current = self.path.read_bytes() if self.path.exists() else None
            if current != self._snapshot:
                raise ValueError("Datoteka je izmijenjena izvan ovog pregleda. Učitajte je ponovno prije spremanja.")
            save_defaults(self.path, self.rules)
            self._snapshot = self.path.read_bytes()
        except (OSError, ValueError) as error:
            self._error(str(error))
            return False
        self._saved_rules = list(self.rules)
        self._update_dirty_label()
        self.status.set(f"Spremljeno {len(self.rules)} pravila u {self.path.name}.")
        try:
            self.on_saved(list(self.rules))
        except Exception as error:
            self._error(f"JSON je spremljen, ali pregled projekta nije osvježen: {error}")
        return True
