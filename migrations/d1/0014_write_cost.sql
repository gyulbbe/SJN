-- Fewer rows per material save (docs/d1-write-cost-results-20261104.md). On 2026-11-03 the remote D1
-- wrote 130,499 rows in a day (free allowance 100,000), 98% of them from 1,157 edits of shared
-- materials at about 110 rows each: every index on a written column and every row a trigger writes
-- counts. No row is rewritten here, so applying this writes almost nothing.
--
-- Additive for code deployed before it, with one exception: that code's list image backfill names
-- d1_list_recent (INDEXED BY), dropped below. Deploy the code that no longer names it first, then
-- apply this migration. The readiness check (checkD1Storage) asks for nothing dropped here.

-- Indexes no query uses any more (each one cost a written row on every save that touched its columns):
-- the 0009 list orders by updated_at (the lists read the 0010 indexes by name since 2026-10-27; the
-- list image backfill now walks d1_list_all_new); created_at alone (the retry clean-up reads
-- d1_mutations_owner_age, 0008); material_id alone (UNIQUE(material_id,version) starts with it); and
-- the materials by updated_at, which only the old full list (to be removed) still sorted with.
DROP INDEX d1_list_lane;
DROP INDEX d1_list_category;
DROP INDEX d1_list_recent;
DROP INDEX d1_list_personal;
DROP INDEX d1_list_facet_order;
DROP INDEX d1_mutations_age;
DROP INDEX d1_versions_material;
DROP INDEX d1_materials_owner;
DROP INDEX d1_materials_shared;
DROP INDEX d1_materials_public;

-- A new version takes its brand's order from its own payload (catalog.brandId, what catalogStatements
-- links right after it), so the brand link no longer rewrites the row and its facet copies.
DROP TRIGGER d1_material_list_version_insert;
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
    coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=p.id AND b.option_kind='brand' AND o.id=b.option_id),(SELECT o.display_order FROM d1_catalog_options o WHERE o.id=p.brand_id AND o.kind='brand'),10000),substr(lower(trim(p.name)),1,100),m.created_at
  FROM (SELECT v.id,v.version,v.material_id,
    coalesce(json_extract(v.payload_json,'$.category'),'') AS category,
    json_extract(v.payload_json,'$.usage') AS usage,
    json_extract(v.payload_json,'$.catalog.brandId') AS brand_id,
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
  -- The counts: this version in and, when it is the material's new current version, the version it
  -- replaces out, by difference (an ordinary save with the same facets writes no count row); then that
  -- version is no longer current. (materials.ts moves current_version_id just before inserting the
  -- version; the material trigger leaves the old one current for this.)
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,SUM(d) FROM (
    SELECT active,lane,category,class,facet,value,1 AS d FROM d1_material_list_facets
    WHERE version_id=NEW.id AND is_current=1 AND scope='shared'
    UNION ALL
    SELECT active,lane,category,class,'' AS facet,'' AS value,1 FROM d1_material_list
    WHERE version_id=NEW.id AND is_current=1 AND scope='shared'
    UNION ALL
    SELECT f.active,f.lane,f.category,f.class,f.facet,f.value,-1 FROM d1_material_list o CROSS JOIN d1_material_list_facets f
    WHERE o.material_id=NEW.material_id AND o.is_current=1 AND o.version_id<>NEW.id
      AND f.version_id=o.version_id AND f.is_current=1 AND f.scope='shared'
      AND EXISTS(SELECT 1 FROM d1_material_list n WHERE n.version_id=NEW.id AND n.is_current=1)
    UNION ALL
    SELECT o.active,o.lane,o.category,o.class,'','',-1 FROM d1_material_list o
    WHERE o.material_id=NEW.material_id AND o.is_current=1 AND o.version_id<>NEW.id AND o.scope='shared'
      AND EXISTS(SELECT 1 FROM d1_material_list n WHERE n.version_id=NEW.id AND n.is_current=1)
  ) GROUP BY active,lane,category,class,facet,value HAVING SUM(d)<>0
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  UPDATE d1_material_list_facets SET is_current=0
  WHERE version_id IN (SELECT o.version_id FROM d1_material_list o
    WHERE o.material_id=NEW.material_id AND o.is_current=1 AND o.version_id<>NEW.id)
    AND EXISTS(SELECT 1 FROM d1_material_list n WHERE n.version_id=NEW.id AND n.is_current=1);
  UPDATE d1_material_list SET is_current=0
  WHERE material_id=NEW.material_id AND is_current=1 AND version_id<>NEW.id
    AND EXISTS(SELECT 1 FROM d1_material_list n WHERE n.version_id=NEW.id AND n.is_current=1);
END;

-- Same as 0011, writing only when the order differs (a version inserted by the trigger above already
-- has it).
DROP TRIGGER d1_material_list_brand_link;
CREATE TRIGGER d1_material_list_brand_link AFTER INSERT ON d1_material_version_options
WHEN NEW.option_kind='brand'
BEGIN
  UPDATE d1_material_list SET prio=coalesce((SELECT display_order FROM d1_catalog_options WHERE id=NEW.option_id),10000)
  WHERE version_id=NEW.version_id AND prio IS NOT coalesce((SELECT display_order FROM d1_catalog_options WHERE id=NEW.option_id),10000);
  UPDATE d1_material_list_facets SET prio=coalesce((SELECT display_order FROM d1_catalog_options WHERE id=NEW.option_id),10000)
  WHERE version_id=NEW.version_id AND prio IS NOT coalesce((SELECT display_order FROM d1_catalog_options WHERE id=NEW.option_id),10000);
END;

-- A material's state moved. When its owner, scope, purpose or activation changed, the state goes to
-- every version with the counts out and in again (as in 0009: what a version is listed as follows
-- them). Otherwise only the current version moved (and updated_at):
--   to a version already in the summary: the counts by difference, then the old and the new one;
--   to a version not inserted yet (an ordinary save, materials.ts): nothing here, the version's own
--   trigger does it when it arrives (the old one stays current until then, in the same batch).
-- Each version keeps the updated_at of when it was last current; readers take updated_at from
-- d1_materials for an older one.
DROP TRIGGER d1_material_list_material_update;
CREATE TRIGGER d1_material_list_material_update
AFTER UPDATE OF current_version_id,active,updated_at,scope,owner_id,purpose ON d1_materials
BEGIN
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,-1 FROM d1_material_list_facets
  WHERE version_id=OLD.current_version_id AND is_current=1 AND scope='shared'
    AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',-1 FROM d1_material_list
  WHERE version_id=OLD.current_version_id AND is_current=1 AND scope='shared'
    AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  UPDATE d1_material_list SET owner_id=NEW.owner_id,scope=NEW.scope,purpose=NEW.purpose,active=NEW.active,
    updated_at=NEW.updated_at,is_current=(version_id=NEW.current_version_id),
    class=(NEW.purpose='catalog')+recon_kind*2+(builtin_payload AND NEW.scope='shared')*8
  WHERE material_id=NEW.id
    AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active);
  UPDATE d1_material_list_facets SET scope=NEW.scope,active=NEW.active,updated_at=NEW.updated_at,
    is_current=(version_id=NEW.current_version_id),
    class=(SELECT l.class FROM d1_material_list l WHERE l.version_id=d1_material_list_facets.version_id)
  WHERE version_id IN (SELECT version_id FROM d1_material_list WHERE material_id=NEW.id)
    AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active);
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,1 FROM d1_material_list_facets
  WHERE version_id=NEW.current_version_id AND is_current=1 AND scope='shared'
    AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,'','',1 FROM d1_material_list
  WHERE version_id=NEW.current_version_id AND is_current=1 AND scope='shared'
    AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  -- The current version moved to one already in the summary (state unchanged): counts by difference.
  INSERT INTO d1_material_list_counts(active,lane,category,class,facet,value,n)
  SELECT active,lane,category,class,facet,value,SUM(d) FROM (
    SELECT active,lane,category,class,facet,value,-1 AS d FROM d1_material_list_facets
    WHERE version_id=OLD.current_version_id AND is_current=1 AND scope='shared'
    UNION ALL
    SELECT active,lane,category,class,'' AS facet,'' AS value,-1 FROM d1_material_list
    WHERE version_id=OLD.current_version_id AND is_current=1 AND scope='shared'
    UNION ALL
    SELECT active,lane,category,class,facet,value,1 FROM d1_material_list_facets
    WHERE version_id=NEW.current_version_id AND scope='shared'
    UNION ALL
    SELECT active,lane,category,class,'','',1 FROM d1_material_list
    WHERE version_id=NEW.current_version_id AND scope='shared'
  ) WHERE OLD.current_version_id IS NOT NEW.current_version_id
    AND NOT (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
    AND EXISTS(SELECT 1 FROM d1_material_list WHERE version_id=NEW.current_version_id)
  GROUP BY active,lane,category,class,facet,value HAVING SUM(d)<>0
  ON CONFLICT DO UPDATE SET n=n+excluded.n;
  UPDATE d1_material_list_facets SET updated_at=NEW.updated_at,is_current=(version_id=NEW.current_version_id)
  WHERE version_id IN (OLD.current_version_id,NEW.current_version_id)
    AND NOT (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
    AND EXISTS(SELECT 1 FROM d1_material_list WHERE version_id=NEW.current_version_id);
  UPDATE d1_material_list SET updated_at=NEW.updated_at,is_current=(version_id=NEW.current_version_id)
  WHERE version_id IN (OLD.current_version_id,NEW.current_version_id)
    AND NOT (OLD.owner_id IS NOT NEW.owner_id OR OLD.scope IS NOT NEW.scope OR OLD.purpose IS NOT NEW.purpose OR OLD.active IS NOT NEW.active)
    AND EXISTS(SELECT 1 FROM d1_material_list WHERE version_id=NEW.current_version_id);
END;
