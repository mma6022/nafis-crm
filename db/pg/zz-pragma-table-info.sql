-- SQLite table-valued function used by schema-ensure helpers:
--   SELECT name FROM pragma_table_info('table')
--   SELECT 1 FROM pragma_table_info(?) WHERE name=?
CREATE OR REPLACE FUNCTION pragma_table_info(p_table text)
RETURNS TABLE(
  cid integer,
  name text,
  type text,
  "notnull" integer,
  dflt_value text,
  pk integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (a.attnum - 1)::integer AS cid,
    a.attname::text AS name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS "notnull",
    pg_get_expr(d.adbin, d.adrelid) AS dflt_value,
    COALESCE((
      SELECT i.n
      FROM (
        SELECT k.attname AS col, row_number() OVER (ORDER BY k.attnum) AS n
        FROM pg_index x
        JOIN pg_attribute k ON k.attrelid = x.indrelid AND k.attnum = ANY(x.indkey)
        WHERE x.indrelid = a.attrelid AND x.indisprimary
      ) i WHERE i.col = a.attname
    ), 0)::integer AS pk
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = current_schema()
    AND c.relname = p_table
    AND a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY a.attnum;
$$;
