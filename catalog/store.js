const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const APPLICATION_ID = 1229935683;
const SCHEMA_VERSION = 1;

function fold(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("hr");
}

function pagination({ limit = 50, offset = 0 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer from 1 to 1000.");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer.");
  return { limit, offset };
}

function pointRow(row) {
  if (!row) return null;
  const { raw_json, ...point } = row;
  return {
    ...point,
    native: Boolean(row.native),
    writeable: row.writeable === null ? null : Boolean(row.writeable),
    forceable: row.forceable === null ? null : Boolean(row.forceable),
    metadata: JSON.parse(raw_json),
  };
}

class BuildingCatalog {
  constructor(filename, { readOnly = true } = {}) {
    this.db = new DatabaseSync(filename, { readOnly, timeout: 5000 });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
      const application = this.db.prepare("PRAGMA application_id").get().application_id;
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all();
      if (!readOnly && application === 0 && version === 0 && !tables.length) {
        this.transaction(() => this.db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8")));
      } else if (application !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error("This file is not a supported building catalog. Do not use the mapper checkpoint as the catalog database.");
      }
      if (!readOnly) this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.function("catalog_contains", { deterministic: true }, (haystack, needle) => Number(fold(haystack).includes(fold(needle))));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot({ building = "default", snapshotId } = {}) {
    if (snapshotId !== undefined && (!Number.isSafeInteger(snapshotId) || snapshotId < 1)) throw new Error("Invalid snapshot ID.");
    const row = snapshotId === undefined
      ? this.db.prepare("SELECT * FROM snapshots WHERE building_key = ? ORDER BY id DESC LIMIT 1").get(building)
      : this.db.prepare("SELECT * FROM snapshots WHERE building_key = ? AND id = ?").get(building, snapshotId);
    if (!row) throw new Error(`No imported snapshot for building ${building}${snapshotId === undefined ? "" : ` and snapshot ${snapshotId}`}.`);
    const { source_summary_json, ...snapshot } = row;
    return { ...snapshot, metadata_requested: Boolean(row.metadata_requested), sourceSummary: JSON.parse(source_summary_json) };
  }

  listSnapshots({ building = "default", ...options } = {}) {
    const { limit, offset } = pagination(options);
    return this.page("snapshots s", "s.building_key = ?", [building], "s.id, s.imported_at, s.captured_at, s.discovery_profile, s.fingerprint", "s.id DESC", limit, offset);
  }

  summary(options = {}) {
    const snapshot = this.snapshot(options);
    const id = snapshot.id;
    const counts = (sql) => Object.fromEntries(this.db.prepare(sql).all(id).map((row) => [row.key, row.count]));
    return {
      schemaVersion: SCHEMA_VERSION,
      building: { ...this.db.prepare("SELECT * FROM buildings WHERE key = ?").get(snapshot.building_key) },
      snapshot,
      objects: counts("SELECT kind AS key, count(*) AS count FROM objects WHERE snapshot_id = ? GROUP BY kind"),
      points: { ...this.db.prepare("SELECT count(*) AS total, coalesce(sum(native), 0) AS native, coalesce(sum(writeable = 1), 0) AS advertisedWriteable, coalesce(sum(native = 1 AND writeable = 1), 0) AS nativeAdvertisedWriteable FROM points WHERE snapshot_id = ?").get(id) },
      containerStates: counts("SELECT state AS key, count(*) AS count FROM containers WHERE snapshot_id = ? GROUP BY state"),
      deviceGroups: counts("SELECT type AS key, count(*) AS count FROM devices WHERE snapshot_id = ? GROUP BY type"),
      groupingKinds: counts("SELECT grouping_kind AS key, count(*) AS count FROM devices WHERE snapshot_id = ? GROUP BY grouping_kind"),
      functions: counts("SELECT role AS key, count(*) AS count FROM device_points WHERE snapshot_id = ? GROUP BY role"),
      commands: { ...this.db.prepare(`SELECT count(*) AS recognized, coalesce(sum(p.writeable = 1), 0) AS advertisedWriteable,
        coalesce(sum(dp.role_ambiguous), 0) AS ambiguous FROM device_points dp
        JOIN points p ON p.snapshot_id = dp.snapshot_id AND p.id = dp.point_id
        WHERE dp.snapshot_id = ? AND dp.command = 1`).get(id) },
      relations: this.db.prepare("SELECT count(*) AS count FROM relations WHERE snapshot_id = ?").get(id).count,
      references: { ...this.db.prepare("SELECT count(*) AS total, coalesce(sum(resolved_point_id IS NOT NULL), 0) AS resolved FROM point_references WHERE snapshot_id = ?").get(id) },
      itemErrors: this.db.prepare("SELECT count(*) AS count FROM item_errors WHERE snapshot_id = ?").get(id).count,
      requiresLiveValidation: true,
    };
  }

  page(from, where, params, columns, order, limit, offset) {
    const total = this.db.prepare(`SELECT count(*) AS count FROM ${from} WHERE ${where}`).get(...params).count;
    const items = this.db.prepare(`SELECT ${columns} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset).map((row) => ({ ...row }));
    return { total, limit, offset, items };
  }

  listContainers({ parentId, state, search = "", ...options } = {}) {
    const snapshot = this.snapshot(options);
    const { limit, offset } = pagination(options);
    const conditions = ["c.snapshot_id = ?"];
    const params = [snapshot.id];
    if (parentId !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM relations r WHERE r.snapshot_id = c.snapshot_id AND r.kind = 'container' AND r.item_id = c.id AND r.parent_id = ?)");
      params.push(parentId);
    }
    if (state !== undefined) { conditions.push("c.state = ?"); params.push(state); }
    if (search) { conditions.push("catalog_contains(o.name || ' ' || o.description || ' ' || c.id, ?)"); params.push(search); }
    return this.page("containers c JOIN objects o ON o.snapshot_id = c.snapshot_id AND o.kind = c.kind AND o.id = c.id", conditions.join(" AND "), params,
      "c.id, c.parent_id, o.name, o.description, o.type, c.state, c.issue, c.last_error, c.prune_reason, c.pages, c.last_fetched_at", "c.id", limit, offset);
  }

  getContainer(id, options = {}) {
    const snapshot = this.snapshot(options);
    const row = this.db.prepare("SELECT c.*, o.name, o.description, o.type, o.raw_json FROM containers c JOIN objects o ON o.snapshot_id = c.snapshot_id AND o.kind = c.kind AND o.id = c.id WHERE c.snapshot_id = ? AND c.id = ?").get(snapshot.id, id);
    if (!row) return null;
    const { raw_json, ...container } = row;
    return {
      ...container, metadata: JSON.parse(raw_json),
      parents: this.db.prepare("SELECT parent_id FROM relations WHERE snapshot_id = ? AND kind = 'container' AND item_id = ? ORDER BY parent_id").all(snapshot.id, id).map((r) => r.parent_id),
      childCounts: Object.fromEntries(this.db.prepare("SELECT kind, count(*) AS count FROM relations WHERE snapshot_id = ? AND parent_id = ? GROUP BY kind").all(snapshot.id, id).map((r) => [r.kind, r.count])),
      itemErrors: this.db.prepare("SELECT item_id, message, fetched_at FROM item_errors WHERE snapshot_id = ? AND container_id = ? ORDER BY page_seq, ordinal").all(snapshot.id, id).map((r) => ({ ...r })),
    };
  }

  listPoints({ parentId, nativeOnly = false, search = "", ...options } = {}) {
    const snapshot = this.snapshot(options);
    const { limit, offset } = pagination(options);
    const conditions = ["p.snapshot_id = ?"];
    const params = [snapshot.id];
    if (nativeOnly) conditions.push("p.native = 1");
    if (parentId !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM relations r WHERE r.snapshot_id = p.snapshot_id AND r.kind = 'value' AND r.item_id = p.id AND r.parent_id = ?)");
      params.push(parentId);
    }
    if (search) { conditions.push("catalog_contains(o.name || ' ' || o.description || ' ' || p.id, ?)"); params.push(search); }
    const page = this.page("points p JOIN objects o ON o.snapshot_id = p.snapshot_id AND o.kind = p.kind AND o.id = p.id", conditions.join(" AND "), params,
      "p.*, o.name, o.description, o.type, o.raw_json", "p.id", limit, offset);
    page.items = page.items.map(pointRow);
    return page;
  }

  getPoint(id, options = {}) {
    const snapshot = this.snapshot(options);
    const point = pointRow(this.db.prepare("SELECT p.*, o.name, o.description, o.type, o.raw_json FROM points p JOIN objects o ON o.snapshot_id = p.snapshot_id AND o.kind = p.kind AND o.id = p.id WHERE p.snapshot_id = ? AND p.id = ?").get(snapshot.id, id));
    if (!point) return null;
    return {
      ...point,
      parents: this.db.prepare("SELECT parent_id FROM relations WHERE snapshot_id = ? AND kind = 'value' AND item_id = ? ORDER BY parent_id").all(snapshot.id, id).map((r) => r.parent_id),
      devices: this.db.prepare("SELECT device_key, role, command, role_ambiguous FROM device_points WHERE snapshot_id = ? AND point_id = ?").all(snapshot.id, id).map((r) => ({ ...r, command: Boolean(r.command), role_ambiguous: Boolean(r.role_ambiguous) })),
      references: this.db.prepare("SELECT source_kind, source_id, relation, target_id, resolved_point_id FROM point_references WHERE snapshot_id = ? AND ((source_kind = 'value' AND source_id = ?) OR target_id = ?) ORDER BY source_kind, source_id").all(snapshot.id, id, id).map((r) => ({ ...r })),
      requiresLiveValidation: true,
    };
  }

  listHistories({ search = "", parentId, ...options } = {}) {
    const snapshot = this.snapshot(options);
    const { limit, offset } = pagination(options);
    const conditions = ["o.snapshot_id = ?", "o.kind = 'history'"];
    const params = [snapshot.id];
    if (search) { conditions.push("catalog_contains(o.id || ' ' || o.name || ' ' || o.description, ?)"); params.push(search); }
    if (parentId !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM relations r WHERE r.snapshot_id = o.snapshot_id AND r.kind = 'history' AND r.item_id = o.id AND r.parent_id = ?)");
      params.push(parentId);
    }
    const page = this.page("objects o", conditions.join(" AND "), params, "o.id, o.name, o.description, o.raw_json", "o.id", limit, offset);
    const parents = this.db.prepare("SELECT parent_id FROM relations WHERE snapshot_id = ? AND kind = 'history' AND item_id = ? ORDER BY parent_id");
    page.items = page.items.map(row => {
      const metadata = JSON.parse(row.raw_json);
      return { id: row.id, name: row.name, description: row.description, unit: String(metadata.Unit || ""), valueItemId: String(metadata.ValueItemId || ""),
        parentIds: parents.all(snapshot.id, row.id).map(row => row.parent_id) };
    });
    return page;
  }

  listDevices({ type, search = "", ...options } = {}) {
    const snapshot = this.snapshot(options);
    const { limit, offset } = pagination(options);
    const conditions = ["d.snapshot_id = ?"];
    const params = [snapshot.id];
    if (type !== undefined) { conditions.push("d.type = ?"); params.push(type); }
    if (search) { conditions.push("catalog_contains(d.key || ' ' || d.label || ' ' || coalesce(d.room_label, '') || ' ' || d.context, ?)"); params.push(search); }
    return this.page("devices d", conditions.join(" AND "), params, "d.*", "d.key", limit, offset);
  }

  getDevice(key, options = {}) {
    const snapshot = this.snapshot(options);
    const device = this.db.prepare("SELECT * FROM devices WHERE snapshot_id = ? AND key = ?").get(snapshot.id, key);
    if (!device) return null;
    const points = this.db.prepare(`SELECT dp.*, p.native, p.unit, p.writeable, p.forceable, p.enum_id,
      o.name, o.description, o.type, o.raw_json FROM device_points dp
      JOIN points p ON p.snapshot_id = dp.snapshot_id AND p.id = dp.point_id
      JOIN objects o ON o.snapshot_id = p.snapshot_id AND o.kind = p.kind AND o.id = p.id
      WHERE dp.snapshot_id = ? AND dp.device_key = ? ORDER BY dp.point_id`).all(snapshot.id, key).map((row) => {
      const { options_json, ...point } = pointRow(row);
      return { ...point, command: Boolean(row.command), role_ambiguous: Boolean(row.role_ambiguous), options: JSON.parse(options_json) };
    });
    const roles = Object.create(null);
    for (const point of points) (roles[point.role] ||= []).push(point.point_id);
    return { ...device, points, roles, requiresLiveValidation: true };
  }
}

module.exports = { BuildingCatalog, APPLICATION_ID, SCHEMA_VERSION };
