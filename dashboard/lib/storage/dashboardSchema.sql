PRAGMA application_id = 1229935684;
PRAGMA user_version = 4;

CREATE TABLE dashboard_widgets (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE,
  definition TEXT NOT NULL CHECK (json_valid(definition))
) STRICT;

CREATE TABLE dashboard_documents (
  name TEXT PRIMARY KEY,
  document TEXT NOT NULL CHECK (json_valid(document))
) STRICT;

CREATE TABLE dashboard_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  all_rooms INTEGER NOT NULL CHECK (all_rooms IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  can_edit_device_settings INTEGER NOT NULL DEFAULT 0 CHECK (can_edit_device_settings IN (0, 1))
) STRICT;

CREATE TABLE dashboard_room_grants (
  username TEXT NOT NULL REFERENCES dashboard_users(username) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1)),
  PRIMARY KEY (username, room_id)
) STRICT;

CREATE TABLE dashboard_backups (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  configuration TEXT NOT NULL CHECK (json_valid(configuration))
) STRICT;
