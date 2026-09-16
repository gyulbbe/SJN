-- Additive catalog schema; existing project versions remain immutable.
CREATE TABLE d1_catalog_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO d1_catalog_meta VALUES(1,1);
CREATE TABLE d1_catalog_options (
 id TEXT PRIMARY KEY NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('color','brand','composition','finish')),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 normalized_name TEXT NOT NULL,
 color_hex TEXT CHECK(color_hex IS NULL OR (kind='color' AND length(color_hex)=7 AND substr(color_hex,1,1)='#' AND substr(color_hex,2) NOT GLOB '*[^0-9a-fA-F]*')),
 sort_order INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(kind,normalized_name), UNIQUE(id,kind)
);
CREATE INDEX d1_catalog_options_list ON d1_catalog_options(kind,active,sort_order,normalized_name);
CREATE TABLE d1_material_subcategories (
 id TEXT PRIMARY KEY NOT NULL,
 category_code TEXT NOT NULL CHECK(category_code IN ('tile','toilet','basin','vanity','bath','shower','faucet','mirror','door','window','glassPartition','mirrorCabinet','wallShelf','wallCabinet','lowPartition','showerCurtain')),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 normalized_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(category_code,normalized_name), UNIQUE(id,category_code)
);
CREATE INDEX d1_subcategories_list ON d1_material_subcategories(category_code,active,sort_order);
ALTER TABLE d1_materials ADD COLUMN purpose TEXT NOT NULL DEFAULT 'catalog' CHECK(purpose IN ('catalog','project'));
UPDATE d1_materials SET purpose='project' WHERE EXISTS (
 SELECT 1 FROM d1_material_versions v WHERE v.material_id=d1_materials.id AND json_type(v.payload_json,'$.reconstruction')='object'
);
CREATE INDEX d1_materials_public ON d1_materials(purpose,scope,active,updated_at DESC);
ALTER TABLE d1_material_versions ADD COLUMN subcategory_id TEXT REFERENCES d1_material_subcategories(id);
CREATE TABLE d1_material_version_options (
 version_id TEXT NOT NULL REFERENCES d1_material_versions(id) ON DELETE CASCADE,
 option_id TEXT NOT NULL, option_kind TEXT NOT NULL,
 PRIMARY KEY(version_id,option_id),
 FOREIGN KEY(option_id,option_kind) REFERENCES d1_catalog_options(id,kind)
);
CREATE UNIQUE INDEX d1_version_single_brand ON d1_material_version_options(version_id) WHERE option_kind='brand';
CREATE INDEX d1_version_options_filter ON d1_material_version_options(option_kind,option_id,version_id);
-- Prevent assigning a subcategory belonging to a different rendering category.
CREATE TRIGGER d1_version_subcategory_insert BEFORE INSERT ON d1_material_versions
WHEN NEW.subcategory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM d1_material_subcategories WHERE id=NEW.subcategory_id AND category_code=NEW.category)
BEGIN SELECT RAISE(ABORT,'invalid subcategory category'); END;
CREATE TRIGGER d1_version_subcategory_update BEFORE UPDATE OF subcategory_id,category ON d1_material_versions
WHEN NEW.subcategory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM d1_material_subcategories WHERE id=NEW.subcategory_id AND category_code=NEW.category)
BEGIN SELECT RAISE(ABORT,'invalid subcategory category'); END;
