PRAGMA application_id = 1229935683;
PRAGMA user_version = 1;

CREATE TABLE buildings (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  root_id TEXT NOT NULL
) STRICT;

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  building_key TEXT NOT NULL REFERENCES buildings(key),
  fingerprint TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  captured_at TEXT,
  started_at TEXT,
  discovery_profile TEXT NOT NULL,
  metadata_requested INTEGER NOT NULL CHECK(metadata_requested IN (0, 1)),
  recognizer_hash TEXT NOT NULL,
  source_summary_json TEXT NOT NULL CHECK(json_valid(source_summary_json)),
  UNIQUE(building_key, fingerprint)
) STRICT;
CREATE INDEX snapshots_building ON snapshots(building_key, id DESC);

CREATE TABLE objects (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  kind TEXT NOT NULL CHECK(kind IN ('container', 'value', 'history', 'alarm')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  PRIMARY KEY(snapshot_id, kind, id)
) STRICT;

CREATE TABLE containers (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'container' CHECK(kind = 'container'),
  parent_id TEXT,
  state TEXT NOT NULL,
  issue TEXT NOT NULL,
  last_error TEXT NOT NULL,
  prune_reason TEXT NOT NULL,
  resume_state TEXT NOT NULL,
  paging_unknown INTEGER NOT NULL CHECK(paging_unknown IN (0, 1)),
  pages INTEGER NOT NULL,
  last_fetched_at TEXT,
  PRIMARY KEY(snapshot_id, id),
  FOREIGN KEY(snapshot_id, kind, id) REFERENCES objects(snapshot_id, kind, id),
  FOREIGN KEY(snapshot_id, parent_id) REFERENCES containers(snapshot_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX containers_state ON containers(snapshot_id, state);

CREATE TABLE points (
  snapshot_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'value' CHECK(kind = 'value'),
  native INTEGER NOT NULL CHECK(native IN (0, 1)),
  unit TEXT NOT NULL,
  writeable INTEGER CHECK(writeable IN (0, 1)),
  forceable INTEGER CHECK(forceable IN (0, 1)),
  enum_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, id),
  FOREIGN KEY(snapshot_id, kind, id) REFERENCES objects(snapshot_id, kind, id)
) STRICT;
CREATE INDEX points_native ON points(snapshot_id, native);

-- An object may have several real parents. Do not turn the EWS graph into a tree.
CREATE TABLE relations (
  snapshot_id INTEGER NOT NULL,
  parent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, parent_id, kind, item_id),
  FOREIGN KEY(snapshot_id, parent_id) REFERENCES containers(snapshot_id, id),
  FOREIGN KEY(snapshot_id, kind, item_id) REFERENCES objects(snapshot_id, kind, id)
) STRICT;
CREATE INDEX relations_target ON relations(snapshot_id, kind, item_id);

CREATE TABLE devices (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  grouping_kind TEXT NOT NULL,
  context TEXT NOT NULL,
  room_label TEXT,
  room_source TEXT,
  container_id TEXT,
  reason TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  PRIMARY KEY(snapshot_id, key),
  FOREIGN KEY(snapshot_id, container_id) REFERENCES containers(snapshot_id, id)
) STRICT;
CREATE INDEX devices_type ON devices(snapshot_id, type);

CREATE TABLE device_points (
  snapshot_id INTEGER NOT NULL,
  device_key TEXT NOT NULL,
  point_id TEXT NOT NULL,
  role TEXT NOT NULL,
  importance TEXT NOT NULL,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  command INTEGER NOT NULL CHECK(command IN (0, 1)),
  role_ambiguous INTEGER NOT NULL CHECK(role_ambiguous IN (0, 1)),
  options_json TEXT NOT NULL CHECK(json_valid(options_json)),
  PRIMARY KEY(snapshot_id, device_key, point_id),
  FOREIGN KEY(snapshot_id, device_key) REFERENCES devices(snapshot_id, key),
  FOREIGN KEY(snapshot_id, point_id) REFERENCES points(snapshot_id, id)
) STRICT;
CREATE INDEX device_points_role ON device_points(snapshot_id, role);
CREATE INDEX device_points_point ON device_points(snapshot_id, point_id);

-- Keep unresolved reference strings; only resolved_point_id claims a saved target.
CREATE TABLE point_references (
  snapshot_id INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('value-property', 'value-item')),
  target_id TEXT NOT NULL,
  resolved_point_id TEXT,
  PRIMARY KEY(snapshot_id, source_kind, source_id, relation),
  FOREIGN KEY(snapshot_id, source_kind, source_id) REFERENCES objects(snapshot_id, kind, id),
  FOREIGN KEY(snapshot_id, resolved_point_id) REFERENCES points(snapshot_id, id)
) STRICT;
CREATE INDEX point_references_target ON point_references(snapshot_id, resolved_point_id);

CREATE TABLE item_errors (
  snapshot_id INTEGER NOT NULL,
  container_id TEXT NOT NULL,
  page_seq INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  item_id TEXT,
  message TEXT NOT NULL,
  fetched_at TEXT,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  PRIMARY KEY(snapshot_id, page_seq, ordinal),
  FOREIGN KEY(snapshot_id, container_id) REFERENCES containers(snapshot_id, id)
) STRICT;
