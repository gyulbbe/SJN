-- App-owned user state; existing Better Auth tables and role assignments stay intact.
CREATE TABLE d1_user_management (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO d1_user_management(user_id,status,revision,updated_at)
  SELECT id,'active',0,updatedAt FROM "user";
CREATE TRIGGER d1_user_management_signup AFTER INSERT ON "user" BEGIN
  INSERT INTO d1_user_management(user_id,status,revision,updated_at) VALUES(NEW.id,'active',0,NEW.updatedAt);
END;
-- A concurrent OAuth callback must not recreate a suspended member's session.
CREATE TRIGGER d1_session_active_insert BEFORE INSERT ON "session"
WHEN NOT EXISTS(SELECT 1 FROM d1_user_management WHERE user_id=NEW.userId AND status='active') BEGIN
  SELECT RAISE(ABORT,'d1_account_suspended');
END;
CREATE TRIGGER d1_session_active_update BEFORE UPDATE ON "session"
WHEN NOT EXISTS(SELECT 1 FROM d1_user_management WHERE user_id=NEW.userId AND status='active') BEGIN
  SELECT RAISE(ABORT,'d1_account_suspended');
END;
CREATE TRIGGER d1_user_suspended_sessions AFTER UPDATE OF status ON d1_user_management
WHEN NEW.status='suspended' BEGIN
  DELETE FROM "session" WHERE userId=NEW.user_id;
END;
CREATE INDEX d1_user_management_status_idx ON d1_user_management(status,user_id);
CREATE INDEX d1_user_list_idx ON "user"(createdAt DESC,id DESC);
CREATE INDEX d1_user_name_idx ON "user"(name COLLATE NOCASE);
CREATE INDEX d1_user_email_idx ON "user"(email COLLATE NOCASE);
-- Audit identities deliberately survive later account/project removal. No tokens/documents are recorded.
CREATE TABLE d1_admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  project_id TEXT,
  project_revision INTEGER,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX d1_admin_audit_created_idx ON d1_admin_audit(created_at DESC,id DESC);
CREATE INDEX d1_admin_audit_actor_idx ON d1_admin_audit(actor_id,created_at DESC);
CREATE INDEX d1_admin_audit_target_idx ON d1_admin_audit(target_user_id,created_at DESC);
CREATE INDEX d1_admin_audit_project_idx ON d1_admin_audit(project_id,created_at DESC);
CREATE TABLE d1_admin_checks (
  id TEXT PRIMARY KEY NOT NULL,
  access_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_admin_access CHECK(access_ok=1),
  target_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_admin_target CHECK(target_ok=1),
  revision_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_admin_revision CHECK(revision_ok=1),
  last_admin_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_admin_last CHECK(last_admin_ok=1),
  self_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT d1_admin_self CHECK(self_ok=1)
);
CREATE TABLE d1_admin_project_assets (
  project_id TEXT NOT NULL REFERENCES d1_projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES d1_assets(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,asset_id)
);
CREATE TABLE d1_admin_project_versions (
  project_id TEXT NOT NULL REFERENCES d1_projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES d1_material_versions(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,version_id)
);
CREATE TABLE d1_admin_meta (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL
);
INSERT INTO d1_admin_meta(id,version) VALUES(1,1);
