-- 위생도기 kinds an administrator manages in 분류 관리 (docs/fixture-kinds-results-20261028.md).
-- Additive: no material, version or list row is rewritten. A material's kind stays its payload's
-- `category`; a new kind's code ('k-' and ten letters or digits) is stored there the same way, and the
-- 0009 list triggers already put every non-tile category in the 위생도기 lane, filtered by category=?.
--
-- The built-in kinds are listed with their present order. Tiles, 샤워 커튼, 문 and 창 are not managed
-- kinds (stored kinds of the photo-analysis standard model): they are not here. A built-in kind's name
-- is fixed; its order and use (active) are an administrator's. 기타 is always last (no order).
CREATE TABLE d1_material_kinds (
  code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 40),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  normalized_name TEXT NOT NULL UNIQUE,
  display_order INTEGER
    CHECK(display_order IS NULL OR (typeof(display_order)='integer' AND display_order BETWEEN 0 AND 9999)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO d1_material_kinds(code,name,normalized_name,display_order,builtin) VALUES
  ('toilet','변기','변기',0,1),
  ('basin','세면대','세면대',1,1),
  ('vanity','하부장','하부장',2,1),
  ('bath','욕조','욕조',3,1),
  ('shower','샤워 설비','샤워 설비',4,1),
  ('faucet','수전','수전',5,1),
  ('mirror','거울','거울',6,1),
  ('glassPartition','유리 파티션','유리 파티션',7,1),
  ('mirrorCabinet','거울 수납장','거울 수납장',8,1),
  ('wallShelf','벽 선반','벽 선반',9,1),
  ('wallCabinet','벽 수납장','벽 수납장',10,1),
  ('lowPartition','낮은 칸막이','낮은 칸막이',11,1),
  ('other','기타','기타',NULL,1);

-- Whether an added kind still has a material (any version, personal or shared, active or not) before
-- it is deleted. Only added kinds' versions are in it: empty when built, one row per such version later.
CREATE INDEX d1_versions_added_kind ON d1_material_versions(category) WHERE substr(category,1,2)='k-';
