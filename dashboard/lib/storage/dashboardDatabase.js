const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

class DashboardDatabase {
  #db;
  #transactionActive = false;

  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    try { fs.closeSync(fs.openSync(filename, "wx", 0o600)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    this.#db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
      this.transaction(() => {
        const { application_id: application } = this.#db.prepare("PRAGMA application_id").get();
        const { user_version: version } = this.#db.prepare("PRAGMA user_version").get();
        if (application === 0 && version === 0 && !this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) {
          this.#db.exec(fs.readFileSync(path.join(__dirname, "dashboardSchema.sql"), "utf8"));
        } else if (application !== 1229935684 || version !== 1) {
          throw new Error("DASHBOARD_DB_FILE nije podržana baza dashboarda.");
        }
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() { this.#db.close(); }

  transaction(operation) {
    if (this.#transactionActive) return operation();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#transactionActive = true;
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back the transaction. */ }
      throw error;
    } finally {
      this.#transactionActive = false;
    }
  }

  readDocument(name) {
    const row = this.#db.prepare("SELECT document FROM dashboard_documents WHERE name = ?").get(name);
    return row && JSON.parse(row.document);
  }

  saveDocument(name, document) {
    this.#db.prepare(`
      INSERT INTO dashboard_documents (name, document) VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET document = excluded.document
    `).run(name, JSON.stringify(document));
  }

  readWidgets() {
    return this.#db.prepare("SELECT definition FROM dashboard_widgets ORDER BY position").all().map(row => JSON.parse(row.definition));
  }

  saveWidgets(widgets) {
    this.transaction(() => {
      this.#db.exec("DELETE FROM dashboard_widgets");
      const insert = this.#db.prepare("INSERT INTO dashboard_widgets (id, position, definition) VALUES (?, ?, ?)");
      widgets.forEach((widget, position) => insert.run(String(widget.id).trim(), position, JSON.stringify(widget)));
    });
  }

  readConfiguration() {
    return {
      widgets: this.readWidgets(),
      deviceWidgets: this.readDocument("devices"),
      metadata: this.readDocument("metadata"),
      dashboardSettings: this.readDocument("settings"),
    };
  }

  saveConfiguration({ widgets, deviceWidgets, metadata, dashboardSettings }) {
    this.transaction(() => {
      this.saveWidgets(widgets);
      this.saveDocument("devices", deviceWidgets);
      this.saveDocument("metadata", metadata);
      this.saveDocument("settings", dashboardSettings);
    });
  }

  replaceConfiguration(configuration, previousSettings) {
    return this.transaction(() => {
      const id = randomUUID();
      const previous = { ...this.readConfiguration(), dashboardSettings: previousSettings };
      this.#db.prepare("INSERT INTO dashboard_backups VALUES (?, ?, ?)").run(id, new Date().toISOString(), JSON.stringify(previous));
      this.saveConfiguration(configuration);
      return id;
    });
  }

  readBackup(id) {
    const row = this.#db.prepare("SELECT created_at, configuration FROM dashboard_backups WHERE id = ?").get(id);
    return row && { exportedAt: row.created_at, ...JSON.parse(row.configuration) };
  }

  readUsers() {
    if (!this.readDocument("usersInitialized")) return undefined;
    const users = new Map(this.#db.prepare("SELECT * FROM dashboard_users ORDER BY username").all().map(row => [
      row.username, { username: row.username, passwordHash: row.password_hash, roomIds: row.all_rooms ? null : [] },
    ]));
    for (const { username, room_id } of this.#db.prepare("SELECT * FROM dashboard_room_grants ORDER BY room_id").all()) {
      users.get(username).roomIds.push(room_id);
    }
    return [...users.values()];
  }

  saveUsers(users) {
    this.transaction(() => {
      this.#db.exec("DELETE FROM dashboard_users");
      const insertUser = this.#db.prepare("INSERT INTO dashboard_users VALUES (?, ?, ?)");
      const insertGrant = this.#db.prepare("INSERT INTO dashboard_room_grants VALUES (?, ?)");
      for (const { username, passwordHash, roomIds } of users) {
        insertUser.run(username, passwordHash, Number(roomIds === null));
        for (const id of new Set(roomIds)) insertGrant.run(username, id);
      }
      this.saveDocument("usersInitialized", true);
    });
  }
}

module.exports = { DashboardDatabase };
