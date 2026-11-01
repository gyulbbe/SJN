-- 기본 배치: sets of products an administrator registers and anyone places with one press
-- (docs/fixture-layouts-results-20261101.md). Additive: no other table is rewritten and no row is added.
-- A small table (30 at most) read whole. `items_json` holds material ids, never version ids: a press
-- places each material's current version. `room_json` is the room it was registered in.
CREATE TABLE d1_fixture_layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  display_order INTEGER
    CHECK(display_order IS NULL OR (typeof(display_order)='integer' AND display_order BETWEEN 0 AND 9999)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  items_json TEXT NOT NULL,
  room_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
