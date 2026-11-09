-- Run read-only on the explicit isolated branch after0104; never resets data.
WITH original AS (
 SELECT content_body, content_body::jsonb AS j
 FROM app.company_content_versions
 WHERE id='a366b6f7-398e-4c2c-981a-7fc3d4b97f46'
), cases(name, body, expected) AS (
 SELECT 'actual approved post and valid image',content_body,true FROM original
 UNION ALL SELECT 'legacy text','Ordinary legacy post',true
 UNION ALL SELECT 'legacy limit retained',repeat('x',16384),true
 UNION ALL SELECT 'oversize legacy rejected',repeat('x',16385),false
 UNION ALL SELECT 'empty rejected','',false
 UNION ALL SELECT 'null rejected',NULL,false
 UNION ALL SELECT 'total payload cap',repeat('x',900001),false
 UNION ALL SELECT 'oversize publication',jsonb_set(j,'{body}',to_jsonb(repeat('x',16385)))::text,false FROM original
 UNION ALL SELECT 'whitespace publication',jsonb_set(j,'{body}','" "')::text,false FROM original
 UNION ALL SELECT 'wrong image digest',jsonb_set(j,'{image,sha256}',to_jsonb(repeat('0',64)))::text,false FROM original
 UNION ALL SELECT 'wrong media type',jsonb_set(j,'{image,mimeType}','"image/svg+xml"')::text,false FROM original
 UNION ALL SELECT 'wrong image dimension',jsonb_set(j,'{image,width}','1')::text,false FROM original
 UNION ALL SELECT 'null image',jsonb_set(j,'{image}','null')::text,false FROM original
 UNION ALL SELECT 'unknown image key',jsonb_set(j,'{image,extra}','"unbound"')::text,false FROM original
 UNION ALL SELECT 'unknown envelope key',(j||'{"extra":"unbound"}')::text,false FROM original
 UNION ALL SELECT 'escaped copy control',jsonb_set(j,'{body}',to_jsonb('text'||chr(8238)))::text,false FROM original
 UNION ALL SELECT 'raw control','text'||chr(8238),false
 UNION ALL SELECT 'oversize metadata',jsonb_set(j,'{artwork_instructions}',to_jsonb(repeat('x',17000)))::text,false FROM original
)
SELECT name, app_private.public_social_body_supported(body) IS NOT DISTINCT FROM expected AS passed
FROM cases;
