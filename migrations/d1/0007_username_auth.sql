-- Better Auth username plugin: ID/password members alongside optional Google OAuth.
-- Credential members store a server-generated, non-deliverable email (<username>@users.sjn.invalid)
-- because "user"."email" stays NOT NULL UNIQUE. Existing Google members keep a NULL username.
-- Additive only: d1_auth_meta stays at version 1 so an already deployed Worker keeps working;
-- readiness detects this migration through the username columns instead.
ALTER TABLE "user" ADD COLUMN "username" TEXT;
ALTER TABLE "user" ADD COLUMN "displayUsername" TEXT;
CREATE UNIQUE INDEX "user_username_idx" ON "user" ("username");
