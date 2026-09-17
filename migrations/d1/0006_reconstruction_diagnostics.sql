-- Only newly captured diagnostics are stored here; old browser archives remain untouched.
CREATE TABLE d1_reconstruction_diagnostics (
  run_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 26214400),
  started_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','failed','cancelled')),
  created_at TEXT NOT NULL
);
CREATE INDEX d1_diagnostics_owner_started_idx ON d1_reconstruction_diagnostics(owner_id,started_at DESC,run_id);
-- Staged uploads and retired JSON objects are cleaned independently of project/assets ownership.
CREATE TABLE d1_diagnostic_cleanup (
  object_key TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  eligible_at TEXT NOT NULL
);
CREATE INDEX d1_diagnostic_cleanup_owner_due_idx ON d1_diagnostic_cleanup(owner_id,eligible_at);
CREATE TABLE d1_diagnostic_checks (
  id TEXT PRIMARY KEY NOT NULL,
  active_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT diagnostic_active CHECK(active_ok=1),
  conflict_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT diagnostic_conflict CHECK(conflict_ok=1)
);
