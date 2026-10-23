-- Material list summary for paged lists (docs/material-paging-results-20261022.md).
-- Additive only: existing tables keep their shape, so code deployed before this migration keeps working,
-- and the triggers below keep the summary right for every writer, including that older code.
--
-- d1_material_list: one row per material version. Copies of the material state (owner, scope, purpose,
-- active, updated_at, is_current) and what lists filter on, taken from the payload. `class` packs the
-- visibility facts each list checks: 1 = purpose 'catalog'; 2·4 = reconstruction (0 absent, 1 JSON null,
-- 2 another false value, 3 a true value, times 2); 8 = one of the four bundled samples
-- (isBuiltInExampleMaterial in src/lib/catalog-visibility.ts) on a shared material.
CREATE TABLE d1_material_list (
  version_id TEXT PRIMARY KEY NOT NULL,
  material_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  purpose TEXT NOT NULL,
  active INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  is_current INTEGER NOT NULL,
  category TEXT NOT NULL,
  usage TEXT,
  lane TEXT NOT NULL,
  code TEXT NOT NULL,
  recon_kind INTEGER NOT NULL,
  builtin_payload INTEGER NOT NULL,
  class INTEGER NOT NULL,
  search_catalog TEXT NOT NULL,
  search_picker TEXT NOT NULL,
  search_library TEXT NOT NULL
) WITHOUT ROWID;
-- One row per facet value of a version (src/lib/catalog/facets.ts facetValues), with the state the
-- facet filter orders and narrows by.
CREATE TABLE d1_material_list_facets (
  version_id TEXT NOT NULL,
  facet TEXT NOT NULL,
  value TEXT NOT NULL,
  material_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  active INTEGER NOT NULL,
  is_current INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  lane TEXT NOT NULL,
  category TEXT NOT NULL,
  class INTEGER NOT NULL,
  PRIMARY KEY(version_id, facet, value)
) WITHOUT ROWID;
-- Current shared materials counted per facet value; facet '' counts the materials themselves.
-- Rows that reach 0 stay (lists read n>0) so a save never scans this table.
CREATE TABLE d1_material_list_counts (
  active INTEGER NOT NULL,
  lane TEXT NOT NULL,
  category TEXT NOT NULL,
  class INTEGER NOT NULL,
  facet TEXT NOT NULL,
  value TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY(active, lane, category, class, facet, value)
) WITHOUT ROWID;

-- Fill from the existing rows (the same SELECTs as the triggers, without the one-version WHERE).
INSERT INTO d1_material_list(version_id,material_id,version,owner_id,scope,purpose,active,updated_at,is_current,
  category,usage,lane,code,recon_kind,builtin_payload,class,search_catalog,search_picker,search_library)
SELECT p.id,m.id,p.version,m.owner_id,m.scope,m.purpose,m.active,m.updated_at,m.current_version_id=p.id,
  p.category,p.usage,
  CASE WHEN p.category='tile' THEN CASE WHEN p.usage IN ('wall','floor','both') THEN p.usage ELSE 'tile' END ELSE 'fixture' END,
  p.code,p.recon_kind,p.builtin,
  (m.purpose='catalog')+p.recon_kind*2+(p.builtin AND m.scope='shared')*8,
  lower(p.name||' '||p.brand||' '||p.code||' '||p.sub||' '||p.color||' '||p.composition||' '||p.finish),
  lower(p.name||' '||p.brand||' '||p.code),
  lower(p.name||' '||p.brand||' '||p.code||' '||p.color||' '||p.finish)
FROM (SELECT v.id,v.version,v.material_id,
  coalesce(json_extract(v.payload_json,'$.category'),'') AS category,
  json_extract(v.payload_json,'$.usage') AS usage,
  coalesce(json_extract(v.payload_json,'$.name'),'') AS name,
  coalesce(json_extract(v.payload_json,'$.brand'),'') AS brand,
  coalesce(json_extract(v.payload_json,'$.code'),'') AS code,
  coalesce(json_extract(v.payload_json,'$.subcategoryName'),'') AS sub,
  coalesce(json_extract(v.payload_json,'$.color'),'') AS color,
  coalesce(json_extract(v.payload_json,'$.composition'),'') AS composition,
  coalesce(json_extract(v.payload_json,'$.finish'),'') AS finish,
  CASE json_type(v.payload_json,'$.reconstruction')
    WHEN 'null' THEN 1 WHEN 'false' THEN 2
    WHEN 'integer' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>0)
    WHEN 'real' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>0)
    WHEN 'text' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>'')
    ELSE CASE WHEN json_type(v.payload_json,'$.reconstruction') IS NULL THEN 0 ELSE 3 END END AS recon_kind,
  coalesce(json_extract(v.payload_json,'$.scope')='shared' AND json_extract(v.payload_json,'$.category')='tile'
    AND json_extract(v.payload_json,'$.version')=1 AND json_extract(v.payload_json,'$.brand')='공간미리 예시'
    AND json_extract(v.payload_json,'$.description')='코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.'
    AND ((json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-01' AND json_extract(v.payload_json,'$.name')='라이트 스톤')
      OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-02' AND json_extract(v.payload_json,'$.name')='웜 샌드')
      OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-03' AND json_extract(v.payload_json,'$.name')='차콜 스톤')
      OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-04' AND json_extract(v.payload_json,'$.name')='클라우드 화이트')),0) AS builtin
  FROM d1_material_versions v) p
JOIN d1_materials m ON m.id=p.material_id;
-- Colour and surface split on '·' and trimmed of what String.prototype.trim removes; size joins the
-- positive dimensions with 'X' (two for a tile, three for a product).
INSERT OR IGNORE INTO d1_material_list_facets(version_id,facet,value,material_id,scope,active,is_current,updated_at,lane,category,class)
SELECT l.version_id,f.facet,f.value,l.material_id,l.scope,l.active,l.is_current,l.updated_at,l.lane,l.category,l.class
FROM d1_material_list l JOIN (
  SELECT v.id AS version_id,'color' AS facet,trim(j.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS value
  FROM d1_material_versions v,json_each('['||replace(json_quote(json_extract(v.payload_json,'$.color')),'·','","')||']') j
  UNION ALL
  SELECT v.id,'finish',trim(j.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
  FROM d1_material_versions v,json_each('['||replace(json_quote(json_extract(v.payload_json,'$.finish')),'·','","')||']') j
  UNION ALL
  SELECT v.id,'size',substr(
    CASE WHEN json_extract(v.payload_json,'$.widthMm')>0 THEN 'X'||json_extract(v.payload_json,'$.widthMm') ELSE '' END||
    CASE WHEN json_extract(v.payload_json,'$.heightMm')>0 THEN 'X'||json_extract(v.payload_json,'$.heightMm') ELSE '' END||
    CASE WHEN coalesce(json_extract(v.payload_json,'$.category'),'')<>'tile' AND json_extract(v.payload_json,'$.depthMm')>0 THEN 'X'||json_extract(v.payload_json,'$.depthMm') ELSE '' END,2)
  FROM d1_material_versions v
) f ON f.version_id=l.version_id
WHERE f.value IS NOT NULL AND f.value<>'';
INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
SELECT active,lane,category,class,facet,value,COUNT(*) FROM d1_material_list_facets
WHERE is_current=1 AND scope='shared' GROUP BY active,lane,category,class,facet,value;
INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
SELECT active,lane,category,class,'','',COUNT(*) FROM d1_material_list
WHERE is_current=1 AND scope='shared' GROUP BY active,lane,category,class;

-- Shared current materials by editor tab (lane), by category and by recency; one owner's personal ones.
CREATE INDEX d1_list_lane ON d1_material_list(lane,updated_at DESC,material_id DESC,class)
  WHERE is_current=1 AND scope='shared' AND active=1;
CREATE INDEX d1_list_category ON d1_material_list(active,category,updated_at DESC,material_id DESC,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_recent ON d1_material_list(active,updated_at DESC,material_id DESC,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_personal ON d1_material_list(owner_id,updated_at DESC,material_id DESC)
  WHERE is_current=1 AND scope='personal';
CREATE INDEX d1_list_material ON d1_material_list(material_id);
CREATE INDEX d1_list_code ON d1_material_list(code);
CREATE INDEX d1_list_facet_order ON d1_material_list_facets(active,facet,value,updated_at DESC,material_id DESC,lane,category,class)
  WHERE is_current=1 AND scope='shared';

-- A new version (materials.ts inserts the material, or moves current_version_id, before the version).
CREATE TRIGGER d1_material_list_version_insert AFTER INSERT ON d1_material_versions
BEGIN
  INSERT INTO d1_material_list(version_id,material_id,version,owner_id,scope,purpose,active,updated_at,is_current,
    category,usage,lane,code,recon_kind,builtin_payload,class,search_catalog,search_picker,search_library)
  SELECT p.id,m.id,p.version,m.owner_id,m.scope,m.purpose,m.active,m.updated_at,m.current_version_id=p.id,
    p.category,p.usage,
    CASE WHEN p.category='tile' THEN CASE WHEN p.usage IN ('wall','floor','both') THEN p.usage ELSE 'tile' END ELSE 'fixture' END,
    p.code,p.recon_kind,p.builtin,
    (m.purpose='catalog')+p.recon_kind*2+(p.builtin AND m.scope='shared')*8,
    lower(p.name||' '||p.brand||' '||p.code||' '||p.sub||' '||p.color||' '||p.composition||' '||p.finish),
    lower(p.name||' '||p.brand||' '||p.code),
    lower(p.name||' '||p.brand||' '||p.code||' '||p.color||' '||p.finish)
  FROM (SELECT v.id,v.version,v.material_id,
    coalesce(json_extract(v.payload_json,'$.category'),'') AS category,
    json_extract(v.payload_json,'$.usage') AS usage,
    coalesce(json_extract(v.payload_json,'$.name'),'') AS name,
    coalesce(json_extract(v.payload_json,'$.brand'),'') AS brand,
    coalesce(json_extract(v.payload_json,'$.code'),'') AS code,
    coalesce(json_extract(v.payload_json,'$.subcategoryName'),'') AS sub,
    coalesce(json_extract(v.payload_json,'$.color'),'') AS color,
    coalesce(json_extract(v.payload_json,'$.composition'),'') AS composition,
    coalesce(json_extract(v.payload_json,'$.finish'),'') AS finish,
    CASE json_type(v.payload_json,'$.reconstruction')
      WHEN 'null' THEN 1 WHEN 'false' THEN 2
      WHEN 'integer' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>0)
      WHEN 'real' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>0)
      WHEN 'text' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>'')
      ELSE CASE WHEN json_type(v.payload_json,'$.reconstruction') IS NULL THEN 0 ELSE 3 END END AS recon_kind,
    coalesce(json_extract(v.payload_json,'$.scope')='shared' AND json_extract(v.payload_json,'$.category')='tile'
      AND json_extract(v.payload_json,'$.version')=1 AND json_extract(v.payload_json,'$.brand')='공간미리 예시'
      AND json_extract(v.payload_json,'$.description')='코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.'
      AND ((json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-01' AND json_extract(v.payload_json,'$.name')='라이트 스톤')
        OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-02' AND json_extract(v.payload_json,'$.name')='웜 샌드')
        OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-03' AND json_extract(v.payload_json,'$.name')='차콜 스톤')
        OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-04' AND json_extract(v.payload_json,'$.name')='클라우드 화이트')),0) AS builtin
    FROM d1_material_versions v WHERE v.id=NEW.id) p
  JOIN d1_materials m ON m.id=p.material_id;
  INSERT OR IGNORE INTO d1_material_list_facets(version_id,facet,value,material_id,scope,active,is_current,updated_at,lane,category,class)
  SELECT l.version_id,f.facet,f.value,l.material_id,l.scope,l.active,l.is_current,l.updated_at,l.lane,l.category,l.class
  FROM d1_material_list l JOIN (
    SELECT v.id AS version_id,'color' AS facet,trim(j.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS value
    FROM d1_material_versions v,json_each('['||replace(json_quote(json_extract(v.payload_json,'$.color')),'·','","')||']') j WHERE v.id=NEW.id
    UNION ALL
    SELECT v.id,'finish',trim(j.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
    FROM d1_material_versions v,json_each('['||replace(json_quote(json_extract(v.payload_json,'$.finish')),'·','","')||']') j WHERE v.id=NEW.id
    UNION ALL
    SELECT v.id,'size',substr(
      CASE WHEN json_extract(v.payload_json,'$.widthMm')>0 THEN 'X'||json_extract(v.payload_json,'$.widthMm') ELSE '' END||
      CASE WHEN json_extract(v.payload_json,'$.heightMm')>0 THEN 'X'||json_extract(v.payload_json,'$.heightMm') ELSE '' END||
      CASE WHEN coalesce(json_extract(v.payload_json,'$.category'),'')<>'tile' AND json_extract(v.payload_json,'$.depthMm')>0 THEN 'X'||json_extract(v.payload_json,'$.depthMm') ELSE '' END,2)
    FROM d1_material_versions v WHERE v.id=NEW.id
  ) f ON f.version_id=l.version_id
  WHERE l.version_id=NEW.id AND f.value IS NOT NULL AND f.value<>'';
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,1 FROM d1_material_list_facets
  WHERE version_id=NEW.id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',1 FROM d1_material_list
  WHERE version_id=NEW.id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
END;

-- Versions are immutable, but a payload fixed in place (a data repair) is summarised again.
CREATE TRIGGER d1_material_list_version_update AFTER UPDATE OF payload_json,material_id,version ON d1_material_versions
BEGIN
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,-1 FROM d1_material_list_facets
  WHERE version_id=OLD.id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',-1 FROM d1_material_list
  WHERE version_id=OLD.id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  DELETE FROM d1_material_list_facets WHERE version_id=OLD.id;
  DELETE FROM d1_material_list WHERE version_id=OLD.id;
  INSERT INTO d1_material_list(version_id,material_id,version,owner_id,scope,purpose,active,updated_at,is_current,
    category,usage,lane,code,recon_kind,builtin_payload,class,search_catalog,search_picker,search_library)
  SELECT p.id,m.id,p.version,m.owner_id,m.scope,m.purpose,m.active,m.updated_at,m.current_version_id=p.id,
    p.category,p.usage,
    CASE WHEN p.category='tile' THEN CASE WHEN p.usage IN ('wall','floor','both') THEN p.usage ELSE 'tile' END ELSE 'fixture' END,
    p.code,p.recon_kind,p.builtin,
    (m.purpose='catalog')+p.recon_kind*2+(p.builtin AND m.scope='shared')*8,
    lower(p.name||' '||p.brand||' '||p.code||' '||p.sub||' '||p.color||' '||p.composition||' '||p.finish),
    lower(p.name||' '||p.brand||' '||p.code),
    lower(p.name||' '||p.brand||' '||p.code||' '||p.color||' '||p.finish)
  FROM (SELECT v.id,v.version,v.material_id,
    coalesce(json_extract(v.payload_json,'$.category'),'') AS category,
    json_extract(v.payload_json,'$.usage') AS usage,
    coalesce(json_extract(v.payload_json,'$.name'),'') AS name,
    coalesce(json_extract(v.payload_json,'$.brand'),'') AS brand,
    coalesce(json_extract(v.payload_json,'$.code'),'') AS code,
    coalesce(json_extract(v.payload_json,'$.subcategoryName'),'') AS sub,
    coalesce(json_extract(v.payload_json,'$.color'),'') AS color,
    coalesce(json_extract(v.payload_json,'$.composition'),'') AS composition,
    coalesce(json_extract(v.payload_json,'$.finish'),'') AS finish,
    CASE json_type(v.payload_json,'$.reconstruction')
      WHEN 'null' THEN 1 WHEN 'false' THEN 2
      WHEN 'integer' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>0)
      WHEN 'real' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>0)
      WHEN 'text' THEN 2+(json_extract(v.payload_json,'$.reconstruction')<>'')
      ELSE CASE WHEN json_type(v.payload_json,'$.reconstruction') IS NULL THEN 0 ELSE 3 END END AS recon_kind,
    coalesce(json_extract(v.payload_json,'$.scope')='shared' AND json_extract(v.payload_json,'$.category')='tile'
      AND json_extract(v.payload_json,'$.version')=1 AND json_extract(v.payload_json,'$.brand')='공간미리 예시'
      AND json_extract(v.payload_json,'$.description')='코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.'
      AND ((json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-01' AND json_extract(v.payload_json,'$.name')='라이트 스톤')
        OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-02' AND json_extract(v.payload_json,'$.name')='웜 샌드')
        OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-03' AND json_extract(v.payload_json,'$.name')='차콜 스톤')
        OR (json_extract(v.payload_json,'$.code')='EXAMPLE-STONE-04' AND json_extract(v.payload_json,'$.name')='클라우드 화이트')),0) AS builtin
    FROM d1_material_versions v WHERE v.id=NEW.id) p
  JOIN d1_materials m ON m.id=p.material_id;
  INSERT OR IGNORE INTO d1_material_list_facets(version_id,facet,value,material_id,scope,active,is_current,updated_at,lane,category,class)
  SELECT l.version_id,f.facet,f.value,l.material_id,l.scope,l.active,l.is_current,l.updated_at,l.lane,l.category,l.class
  FROM d1_material_list l JOIN (
    SELECT v.id AS version_id,'color' AS facet,trim(j.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) AS value
    FROM d1_material_versions v,json_each('['||replace(json_quote(json_extract(v.payload_json,'$.color')),'·','","')||']') j WHERE v.id=NEW.id
    UNION ALL
    SELECT v.id,'finish',trim(j.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
    FROM d1_material_versions v,json_each('['||replace(json_quote(json_extract(v.payload_json,'$.finish')),'·','","')||']') j WHERE v.id=NEW.id
    UNION ALL
    SELECT v.id,'size',substr(
      CASE WHEN json_extract(v.payload_json,'$.widthMm')>0 THEN 'X'||json_extract(v.payload_json,'$.widthMm') ELSE '' END||
      CASE WHEN json_extract(v.payload_json,'$.heightMm')>0 THEN 'X'||json_extract(v.payload_json,'$.heightMm') ELSE '' END||
      CASE WHEN coalesce(json_extract(v.payload_json,'$.category'),'')<>'tile' AND json_extract(v.payload_json,'$.depthMm')>0 THEN 'X'||json_extract(v.payload_json,'$.depthMm') ELSE '' END,2)
    FROM d1_material_versions v WHERE v.id=NEW.id
  ) f ON f.version_id=l.version_id
  WHERE l.version_id=NEW.id AND f.value IS NOT NULL AND f.value<>'';
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,1 FROM d1_material_list_facets
  WHERE version_id=NEW.id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',1 FROM d1_material_list
  WHERE version_id=NEW.id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
END;

-- A material's state moved (new current version, activation, or anything copied above): take the old
-- current version out of the counts, copy the state to every version of the material, add the new one.
CREATE TRIGGER d1_material_list_material_update
AFTER UPDATE OF current_version_id,active,updated_at,scope,owner_id,purpose ON d1_materials
BEGIN
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,-1 FROM d1_material_list_facets
  WHERE version_id=OLD.current_version_id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',-1 FROM d1_material_list
  WHERE version_id=OLD.current_version_id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  UPDATE d1_material_list SET owner_id=NEW.owner_id,scope=NEW.scope,purpose=NEW.purpose,active=NEW.active,
    updated_at=NEW.updated_at,is_current=(version_id=NEW.current_version_id),
    class=(NEW.purpose='catalog')+recon_kind*2+(builtin_payload AND NEW.scope='shared')*8
  WHERE material_id=NEW.id;
  UPDATE d1_material_list_facets SET scope=NEW.scope,active=NEW.active,updated_at=NEW.updated_at,
    is_current=(version_id=NEW.current_version_id),
    class=(SELECT l.class FROM d1_material_list l WHERE l.version_id=d1_material_list_facets.version_id)
  WHERE version_id IN (SELECT version_id FROM d1_material_list WHERE material_id=NEW.id);
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,1 FROM d1_material_list_facets
  WHERE version_id=NEW.current_version_id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',1 FROM d1_material_list
  WHERE version_id=NEW.current_version_id AND is_current=1 AND scope='shared'
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
END;
