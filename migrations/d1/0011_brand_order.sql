-- Brand order (docs/material-order-results-20261027.md): the list orders' priority is the order an
-- administrator gives a brand in 분류 관리, not a number on each material. Additive for code deployed
-- before it: the 0010 columns, indexes and trigger names stay (its readiness check looks for them).
--
-- display_order: an option's or subcategory's 표시 순서, NULL when none is given (none is, yet: every
-- existing one starts blank). 0 comes first. The material form lists them by it, then by name; the
-- material lists order a version by its brand's display_order (prio), then by name. sort_order (0003)
-- is no longer read.
ALTER TABLE d1_catalog_options ADD COLUMN display_order INTEGER
  CHECK(display_order IS NULL OR (typeof(display_order)='integer' AND display_order BETWEEN 0 AND 9999));
ALTER TABLE d1_material_subcategories ADD COLUMN display_order INTEGER
  CHECK(display_order IS NULL OR (typeof(display_order)='integer' AND display_order BETWEEN 0 AND 9999));

-- No brand has an order yet, so every summary row goes back to no priority; the per-material priority
-- of 0010 is no longer used (its column stays, cleared).
DROP TRIGGER d1_material_list_priority;
UPDATE d1_materials SET priority=NULL WHERE priority IS NOT NULL;
UPDATE d1_material_list SET prio=10000 WHERE prio<>10000;
UPDATE d1_material_list_facets SET prio=10000 WHERE prio<>10000;

-- The version triggers of 0010, with prio read from the version's brand.
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
    coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=p.id AND b.option_kind='brand' AND o.id=b.option_id),10000),substr(lower(trim(p.name)),1,100),m.created_at
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
    coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=p.id AND b.option_kind='brand' AND o.id=b.option_id),10000),substr(lower(trim(p.name)),1,100),m.created_at
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

-- A save links the brand after it inserts the version (catalogStatements): the link sets prio, and a
-- removed link clears it.
CREATE TRIGGER d1_material_list_brand_link AFTER INSERT ON d1_material_version_options
WHEN NEW.option_kind='brand'
BEGIN
  UPDATE d1_material_list SET prio=coalesce((SELECT display_order FROM d1_catalog_options WHERE id=NEW.option_id),10000)
  WHERE version_id=NEW.version_id;
  UPDATE d1_material_list_facets SET prio=coalesce((SELECT display_order FROM d1_catalog_options WHERE id=NEW.option_id),10000)
  WHERE version_id=NEW.version_id;
END;
CREATE TRIGGER d1_material_list_brand_unlink AFTER DELETE ON d1_material_version_options
WHEN OLD.option_kind='brand'
BEGIN
  UPDATE d1_material_list SET prio=coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=OLD.version_id AND b.option_kind='brand' AND o.id=b.option_id),10000) WHERE version_id=OLD.version_id;
  UPDATE d1_material_list_facets SET prio=coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=OLD.version_id AND b.option_kind='brand' AND o.id=b.option_id),10000) WHERE version_id=OLD.version_id;
END;
-- A brand's order set or cleared: every version of that brand (through d1_version_options_filter).
CREATE TRIGGER d1_material_list_brand_order AFTER UPDATE OF display_order ON d1_catalog_options
WHEN NEW.kind='brand' AND OLD.display_order IS NOT NEW.display_order
BEGIN
  UPDATE d1_material_list SET prio=coalesce(NEW.display_order,10000)
  WHERE version_id IN (SELECT version_id FROM d1_material_version_options WHERE option_kind='brand' AND option_id=NEW.id);
  UPDATE d1_material_list_facets SET prio=coalesce(NEW.display_order,10000)
  WHERE version_id IN (SELECT version_id FROM d1_material_version_options WHERE option_kind='brand' AND option_id=NEW.id);
END;
-- Kept under its 0010 name (that code's readiness check looks for it): a per-material priority written
-- by that code no longer changes the order; prio stays the brand's.
CREATE TRIGGER d1_material_list_priority AFTER UPDATE OF priority,scope ON d1_materials
WHEN OLD.priority IS NOT NEW.priority OR OLD.scope IS NOT NEW.scope
BEGIN
  UPDATE d1_material_list SET prio=coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=d1_material_list.version_id AND b.option_kind='brand' AND o.id=b.option_id),10000) WHERE material_id=NEW.id;
  UPDATE d1_material_list_facets SET prio=coalesce((SELECT o.display_order FROM d1_material_version_options b CROSS JOIN d1_catalog_options o WHERE b.version_id=d1_material_list_facets.version_id AND b.option_kind='brand' AND o.id=b.option_id),10000)
  WHERE version_id IN (SELECT version_id FROM d1_material_list WHERE material_id=NEW.id);
END;
