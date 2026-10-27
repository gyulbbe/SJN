-- Material list order (docs/material-order-results-20261027.md): an administrator's priority on shared
-- materials, and the summary columns and indexes the four list orders read. Additive only: code deployed
-- before this migration keeps working (it reads the 0009 columns and indexes, which stay), and the
-- triggers keep the new columns right for every writer, including that older code.
--
-- d1_materials.priority: 1 comes first; NULL is no priority (the API sets it on shared materials only).
-- Summary copies: prio = the priority of a shared material, otherwise 10000; name_key = lower(trim(name))
-- (the payload name, per version; SQL lower() and trim() are ASCII and spaces only), its first 100
-- characters so that a list cursor stays short; created_at = the material's registration time.
ALTER TABLE d1_materials ADD COLUMN priority INTEGER
  CHECK(priority IS NULL OR (typeof(priority)='integer' AND priority BETWEEN 1 AND 9999));
ALTER TABLE d1_material_list ADD COLUMN prio INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE d1_material_list ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
ALTER TABLE d1_material_list ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE d1_material_list_facets ADD COLUMN prio INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE d1_material_list_facets ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
ALTER TABLE d1_material_list_facets ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

-- Fill from the existing rows (the same values as the triggers below), before the indexes. No priority
-- exists yet, so prio keeps its default.
UPDATE d1_material_list SET
  name_key=substr(lower(trim(coalesce((SELECT json_extract(v.payload_json,'$.name') FROM d1_material_versions v WHERE v.id=d1_material_list.version_id),''))),1,100),
  created_at=(SELECT m.created_at FROM d1_materials m WHERE m.id=d1_material_list.material_id);
UPDATE d1_material_list_facets SET (name_key,created_at)=
  (SELECT l.name_key,l.created_at FROM d1_material_list l WHERE l.version_id=d1_material_list_facets.version_id);

-- Each list order has the 0009 index shapes (editor tab lane, category, all, one owner's personal ones,
-- a facet value) with its own columns: priority (prio, name, id), name (read backwards for the reverse
-- order) and newest registered first. Every partial WHERE has two conditions, which keeps the plans
-- index-only (a third one, like 0009's d1_list_lane active=1, makes SQLite read each table row too);
-- the personal ones carry what a personal part filters on.
CREATE INDEX d1_list_lane_prio ON d1_material_list(active,lane,prio,name_key,material_id,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_category_prio ON d1_material_list(active,category,prio,name_key,material_id,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_all_prio ON d1_material_list(active,prio,name_key,material_id,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_personal_prio ON d1_material_list(owner_id,prio,name_key,material_id,active,lane,category,class)
  WHERE is_current=1 AND scope='personal';
CREATE INDEX d1_list_facet_prio ON d1_material_list_facets(active,facet,value,prio,name_key,material_id,lane,category,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_lane_name ON d1_material_list(active,lane,name_key,material_id,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_category_name ON d1_material_list(active,category,name_key,material_id,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_all_name ON d1_material_list(active,name_key,material_id,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_personal_name ON d1_material_list(owner_id,name_key,material_id,active,lane,category,class)
  WHERE is_current=1 AND scope='personal';
CREATE INDEX d1_list_facet_name ON d1_material_list_facets(active,facet,value,name_key,material_id,lane,category,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_lane_new ON d1_material_list(active,lane,created_at DESC,material_id DESC,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_category_new ON d1_material_list(active,category,created_at DESC,material_id DESC,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_all_new ON d1_material_list(active,created_at DESC,material_id DESC,class)
  WHERE is_current=1 AND scope='shared';
CREATE INDEX d1_list_personal_new ON d1_material_list(owner_id,created_at DESC,material_id DESC,active,lane,category,class)
  WHERE is_current=1 AND scope='personal';
CREATE INDEX d1_list_facet_new ON d1_material_list_facets(active,facet,value,created_at DESC,material_id DESC,lane,category,class)
  WHERE is_current=1 AND scope='shared';

-- The version triggers of 0009, with the new columns.
DROP TRIGGER d1_material_list_version_insert;
DROP TRIGGER d1_material_list_version_update;
CREATE TRIGGER d1_material_list_version_insert AFTER INSERT ON d1_material_versions
BEGIN
  INSERT INTO d1_material_list(version_id,material_id,version,owner_id,scope,purpose,active,updated_at,is_current,
    category,usage,lane,code,recon_kind,builtin_payload,class,search_catalog,search_picker,search_library,prio,name_key,created_at)
  SELECT p.id,m.id,p.version,m.owner_id,m.scope,m.purpose,m.active,m.updated_at,m.current_version_id=p.id,
    p.category,p.usage,
    CASE WHEN p.category='tile' THEN CASE WHEN p.usage IN ('wall','floor','both') THEN p.usage ELSE 'tile' END ELSE 'fixture' END,
    p.code,p.recon_kind,p.builtin,
    (m.purpose='catalog')+p.recon_kind*2+(p.builtin AND m.scope='shared')*8,
    lower(p.name||' '||p.brand||' '||p.code||' '||p.sub||' '||p.color||' '||p.composition||' '||p.finish),
    lower(p.name||' '||p.brand||' '||p.code),
    lower(p.name||' '||p.brand||' '||p.code||' '||p.color||' '||p.finish),
    CASE WHEN m.scope='shared' THEN coalesce(m.priority,10000) ELSE 10000 END,substr(lower(trim(p.name)),1,100),m.created_at
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
  INSERT OR IGNORE INTO d1_material_list_facets(version_id,facet,value,material_id,scope,active,is_current,updated_at,lane,category,class,prio,name_key,created_at)
  SELECT l.version_id,f.facet,f.value,l.material_id,l.scope,l.active,l.is_current,l.updated_at,l.lane,l.category,l.class,l.prio,l.name_key,l.created_at
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
    category,usage,lane,code,recon_kind,builtin_payload,class,search_catalog,search_picker,search_library,prio,name_key,created_at)
  SELECT p.id,m.id,p.version,m.owner_id,m.scope,m.purpose,m.active,m.updated_at,m.current_version_id=p.id,
    p.category,p.usage,
    CASE WHEN p.category='tile' THEN CASE WHEN p.usage IN ('wall','floor','both') THEN p.usage ELSE 'tile' END ELSE 'fixture' END,
    p.code,p.recon_kind,p.builtin,
    (m.purpose='catalog')+p.recon_kind*2+(p.builtin AND m.scope='shared')*8,
    lower(p.name||' '||p.brand||' '||p.code||' '||p.sub||' '||p.color||' '||p.composition||' '||p.finish),
    lower(p.name||' '||p.brand||' '||p.code),
    lower(p.name||' '||p.brand||' '||p.code||' '||p.color||' '||p.finish),
    CASE WHEN m.scope='shared' THEN coalesce(m.priority,10000) ELSE 10000 END,substr(lower(trim(p.name)),1,100),m.created_at
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
  INSERT OR IGNORE INTO d1_material_list_facets(version_id,facet,value,material_id,scope,active,is_current,updated_at,lane,category,class,prio,name_key,created_at)
  SELECT l.version_id,f.facet,f.value,l.material_id,l.scope,l.active,l.is_current,l.updated_at,l.lane,l.category,l.class,l.prio,l.name_key,l.created_at
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

-- A priority set on a material (or its scope moved): copy prio to its versions' rows. The counts do not
-- change, and the 0009 material trigger (state, current version) never writes these columns. Two
-- triggers so that a priority change does not rewrite the created_at indexes.
CREATE TRIGGER d1_material_list_priority AFTER UPDATE OF priority,scope ON d1_materials
WHEN OLD.priority IS NOT NEW.priority OR OLD.scope IS NOT NEW.scope
BEGIN
  UPDATE d1_material_list SET prio=CASE WHEN NEW.scope='shared' THEN coalesce(NEW.priority,10000) ELSE 10000 END
  WHERE material_id=NEW.id;
  UPDATE d1_material_list_facets SET prio=CASE WHEN NEW.scope='shared' THEN coalesce(NEW.priority,10000) ELSE 10000 END
  WHERE version_id IN (SELECT version_id FROM d1_material_list WHERE material_id=NEW.id);
END;
CREATE TRIGGER d1_material_list_created AFTER UPDATE OF created_at ON d1_materials
WHEN OLD.created_at IS NOT NEW.created_at
BEGIN
  UPDATE d1_material_list SET created_at=NEW.created_at WHERE material_id=NEW.id;
  UPDATE d1_material_list_facets SET created_at=NEW.created_at
  WHERE version_id IN (SELECT version_id FROM d1_material_list WHERE material_id=NEW.id);
END;
