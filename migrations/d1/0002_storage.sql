-- Apply after 0001_auth.sql. Documents and binary files live in private R2 objects.
CREATE TABLE d1_storage_meta (version INTEGER PRIMARY KEY CHECK(version = 1));
INSERT INTO d1_storage_meta(version) VALUES (1);
CREATE TABLE d1_projects (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
  storage_revision INTEGER NOT NULL CHECK(storage_revision > 0),
  object_key TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX d1_projects_owner_updated ON d1_projects(owner_id,updated_at DESC);
CREATE TABLE d1_assets (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
  source_asset_id TEXT REFERENCES d1_assets(id),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0,1))
);
CREATE INDEX d1_assets_owner_created ON d1_assets(owner_id,created_at);
CREATE INDEX d1_assets_source ON d1_assets(source_asset_id);
CREATE TABLE d1_materials (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('personal','shared')),
  current_version_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX d1_materials_owner ON d1_materials(owner_id,updated_at DESC);
CREATE INDEX d1_materials_shared ON d1_materials(scope,updated_at DESC);
CREATE TABLE d1_material_versions (
  id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES d1_materials(id),
  version INTEGER NOT NULL, object_key TEXT UNIQUE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 524288), category TEXT NOT NULL, view_count INTEGER NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(material_id,version)
);
CREATE INDEX d1_versions_material ON d1_material_versions(material_id);
CREATE TABLE d1_project_assets (
  project_id TEXT NOT NULL REFERENCES d1_projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES d1_assets(id), PRIMARY KEY(project_id,asset_id)
);
CREATE INDEX d1_project_assets_asset ON d1_project_assets(asset_id);
CREATE TABLE d1_project_versions (
  project_id TEXT NOT NULL REFERENCES d1_projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES d1_material_versions(id), PRIMARY KEY(project_id,version_id)
);
CREATE INDEX d1_project_versions_version ON d1_project_versions(version_id);
CREATE TABLE d1_material_assets (
  version_id TEXT NOT NULL REFERENCES d1_material_versions(id),
  asset_id TEXT NOT NULL REFERENCES d1_assets(id), PRIMARY KEY(version_id,asset_id)
);
CREATE INDEX d1_material_assets_asset ON d1_material_assets(asset_id);
CREATE TABLE d1_cleanup_jobs (
  object_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, asset_id TEXT,
  eligible_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT, lease_until TEXT, next_attempt_at TEXT NOT NULL
);
CREATE INDEX d1_cleanup_owner_due ON d1_cleanup_jobs(owner_id,next_attempt_at,eligible_at);
CREATE TABLE d1_mutations (
  owner_id TEXT NOT NULL, request_key TEXT NOT NULL, resource TEXT NOT NULL,
  request_hash TEXT NOT NULL, response_key TEXT, response_json TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY(owner_id,request_key),
  CHECK(response_key IS NOT NULL OR response_json IS NOT NULL)
);
CREATE INDEX d1_mutations_age ON d1_mutations(created_at);
CREATE INDEX d1_mutations_object ON d1_mutations(response_key);
-- An assertion in a D1 batch aborts the entire transaction, including later writes.
-- These rows are inserted and removed in the same batch; none persist after success.
CREATE TABLE d1_checks (
  id TEXT PRIMARY KEY,
  conflict_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_conflict CHECK(conflict_ok=1),
  reference_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_reference CHECK(reference_ok=1)
);


CREATE TABLE d1_maintenance (owner_id TEXT PRIMARY KEY, next_run_at TEXT NOT NULL);
