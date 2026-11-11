-- SQLite compatibility helpers for the Nafis Vam CRM PostgreSQL port.
-- Used so existing queries/triggers/CHECKs can run with minimal rewrites.

CREATE SCHEMA IF NOT EXISTS sqlite_compat;
SET search_path TO public, sqlite_compat;

-- Do not DROP these on a populated database: column defaults may depend on them.
-- CREATE OR REPLACE below is enough for re-runs.
-- DROP FUNCTION IF EXISTS datetime(TEXT);
-- DROP FUNCTION IF EXISTS strftime(TEXT, TEXT);
-- DROP FUNCTION IF EXISTS julianday(TEXT);


-- ---------- identity UDFs (ported from customer-integrity.ts) ----------
CREATE OR REPLACE FUNCTION crm_digits(value TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(
    translate(
      translate(COALESCE(value, ''),
        '۰۱۲۳۴۵۶۷۸۹', '0123456789'),
      '٠١٢٣٤٥٦٧٨٩', '0123456789'),
    '[^0-9]', '', 'g');
$$;

CREATE OR REPLACE FUNCTION crm_customer_mobile_key(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE n TEXT := crm_digits(value);
BEGIN
  IF n LIKE '0098%' AND length(n) = 14 THEN
    RETURN '0' || substr(n, 5);
  ELSIF n LIKE '98%' AND length(n) = 12 THEN
    RETURN '0' || substr(n, 3);
  ELSIF length(n) = 10 AND n LIKE '9%' THEN
    RETURN '0' || n;
  END IF;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION crm_customer_national_code_key(value TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT crm_digits(value);
$$;

CREATE OR REPLACE FUNCTION crm_persian_search_key(value TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT replace(replace(replace(normalize(COALESCE(value, ''), NFC), 'ي', 'ی'), 'ى', 'ی'), 'ك', 'ک');
$$;

-- Overloads for untyped / bigint arguments coming from INTEGER columns
CREATE OR REPLACE FUNCTION crm_customer_mobile_key(value ANYELEMENT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT crm_customer_mobile_key(value::text);
$$;
CREATE OR REPLACE FUNCTION crm_customer_national_code_key(value ANYELEMENT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT crm_customer_national_code_key(value::text);
$$;
CREATE OR REPLACE FUNCTION crm_persian_search_key(value ANYELEMENT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT crm_persian_search_key(value::text);
$$;

-- ---------- json helpers ----------
CREATE OR REPLACE FUNCTION json_valid(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF value IS NULL THEN RETURN 1=0; END IF; -- SQLite json_valid(NULL) is 0 / false
  PERFORM value::json;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

-- json_extract(json, path) where path is $.a.b or $[0] or $.a[0]
CREATE OR REPLACE FUNCTION json_extract(doc TEXT, path TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  j JSONB;
  p TEXT;
  parts TEXT[];
  cur JSONB;
  i INT;
  tok TEXT;
  idx INT;
BEGIN
  IF doc IS NULL OR path IS NULL THEN RETURN NULL; END IF;
  BEGIN
    j := doc::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  p := path;
  IF left(p, 1) = '$' THEN p := substr(p, 2); END IF;
  cur := j;
  -- tokenize .name and [n]
  WHILE p <> '' LOOP
    IF left(p, 1) = '.' THEN
      p := substr(p, 2);
      i := 1;
      WHILE i <= length(p) AND substr(p, i, 1) NOT IN ('.', '[') LOOP
        i := i + 1;
      END LOOP;
      tok := substr(p, 1, i - 1);
      p := substr(p, i);
      IF cur IS NULL OR jsonb_typeof(cur) <> 'object' THEN RETURN NULL; END IF;
      cur := cur -> tok;
    ELSIF left(p, 1) = '[' THEN
      i := position(']' IN p);
      IF i = 0 THEN RETURN NULL; END IF;
      BEGIN
        idx := substr(p, 2, i - 2)::INT;
      EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
      END;
      p := substr(p, i + 1);
      IF cur IS NULL OR jsonb_typeof(cur) <> 'array' THEN RETURN NULL; END IF;
      cur := cur -> idx;
    ELSE
      RETURN NULL;
    END IF;
  END LOOP;
  IF cur IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(cur) IN ('string', 'number', 'boolean') THEN
    -- scalar without quotes (SQLite json_extract returns unquoted scalars)
    IF jsonb_typeof(cur) = 'string' THEN
      RETURN cur #>> '{}';
    END IF;
    RETURN trim(both '"' from cur::text);
  END IF;
  RETURN cur::text;
END;
$$;

-- json_each(json) — table-valued, SQLite compatible column names
CREATE OR REPLACE FUNCTION json_each(doc TEXT)
RETURNS TABLE(key TEXT, value TEXT, type TEXT, atom TEXT, id INT, parent INT, fullkey TEXT, path TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  j JSONB;
  el JSONB;
  k TEXT;
  i INT;
BEGIN
  IF doc IS NULL THEN RETURN; END IF;
  BEGIN
    j := doc::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  IF jsonb_typeof(j) = 'array' THEN
    i := 0;
    FOR el IN SELECT * FROM jsonb_array_elements(j)
    LOOP
      key := i::text;
      type := jsonb_typeof(el);
      IF type = 'string' THEN
        value := el #>> '{}';
        atom := value;
      ELSIF type IN ('number', 'boolean') THEN
        value := trim(both '"' from el::text);
        atom := value;
      ELSE
        value := el::text;
        atom := NULL;
      END IF;
      id := i;
      parent := 0;
      fullkey := '$[' || i || ']';
      path := '$';
      RETURN NEXT;
      i := i + 1;
    END LOOP;
  ELSIF jsonb_typeof(j) = 'object' THEN
    i := 0;
    FOR k, el IN SELECT * FROM jsonb_each(j)
    LOOP
      key := k;
      type := jsonb_typeof(el);
      IF type = 'string' THEN
        value := el #>> '{}';
        atom := value;
      ELSIF type IN ('number', 'boolean') THEN
        value := trim(both '"' from el::text);
        atom := value;
      ELSE
        value := el::text;
        atom := NULL;
      END IF;
      id := i;
      parent := 0;
      fullkey := '$.' || k;
      path := '$';
      RETURN NEXT;
      i := i + 1;
    END LOOP;
  END IF;
END;
$$;

-- ---------- GLOB ----------
-- Convert a SQLite GLOB pattern to a POSIX regex.
CREATE OR REPLACE FUNCTION sqlite_glob_to_regex(pattern TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  out TEXT := '';
  i INT := 1;
  ch TEXT;
  n INT := length(pattern);
  inclass BOOLEAN := FALSE;
BEGIN
  IF pattern IS NULL THEN RETURN NULL; END IF;
  out := '^';
  WHILE i <= n LOOP
    ch := substr(pattern, i, 1);
    IF NOT inclass THEN
      IF ch = '*' THEN out := out || '.*';
      ELSIF ch = '?' THEN out := out || '.';
      ELSIF ch = '[' THEN out := out || '['; inclass := TRUE;
      ELSIF ch IN ('\', '.', '+', '(', ')', '{', '}', '|', '^', '$') THEN
        out := out || '\' || ch;
      ELSE
        out := out || ch;
      END IF;
    ELSE
      IF ch = ']' THEN out := out || ']'; inclass := FALSE;
      ELSE out := out || ch;
      END IF;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN out || '$';
END;
$$;

CREATE OR REPLACE FUNCTION sqlite_glob(pattern TEXT, value TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN pattern IS NULL OR value IS NULL THEN NULL
    ELSE value ~ sqlite_glob_to_regex(pattern)
  END;
$$;

-- ---------- date / time (text ISO, matching SQLite's common usage) ----------
-- Parse a SQLite time value ('now', ISO-8601, or already a timestamptz text).
CREATE OR REPLACE FUNCTION sqlite_parse_time(t TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  s TEXT := btrim(t);
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF lower(s) = 'now' THEN RETURN clock_timestamp() AT TIME ZONE 'utc'; END IF;
  -- 'YYYY-MM-DDTHH:MM:SS.mmmZ' and variants
  s := replace(s, 'T', ' ');
  IF s ~ 'Z$' THEN s := left(s, length(s)-1) || '+00'; END IF;
  BEGIN
    RETURN s::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      RETURN s::timestamp AT TIME ZONE 'utc';
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION sqlite_apply_modifier(ts TIMESTAMPTZ, mod TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  m TEXT := btrim(mod);
  sign INT := 1;
  n DOUBLE PRECISION;
  unit TEXT;
BEGIN
  IF m IS NULL OR ts IS NULL THEN RETURN ts; END IF;
  IF lower(m) IN ('utc', 'unixepoch', 'localtime', 'start of year', 'start of month', 'start of day') THEN
    IF lower(m) = 'start of day' THEN RETURN date_trunc('day', ts); END IF;
    IF lower(m) = 'start of month' THEN RETURN date_trunc('month', ts); END IF;
    IF lower(m) = 'start of year' THEN RETURN date_trunc('year', ts); END IF;
    RETURN ts;
  END IF;
  IF left(m,1) IN ('+','-') THEN
    IF left(m,1) = '-' THEN sign := -1; END IF;
    m := ltrim(substr(m,2));
  END IF;
  n := (regexp_match(m, '^[0-9]+(\.[0-9]+)?'))[1]::double precision;
  unit := btrim(regexp_replace(m, '^[0-9]+(\.[0-9]+)?\s*', ''));
  unit := rtrim(lower(unit), 's'); -- days/day, seconds/second
  IF unit IN ('day') THEN RETURN ts + (sign * n) * INTERVAL '1 day'; END IF;
  IF unit IN ('hour') THEN RETURN ts + (sign * n) * INTERVAL '1 hour'; END IF;
  IF unit IN ('minute') THEN RETURN ts + (sign * n) * INTERVAL '1 minute'; END IF;
  IF unit IN ('second') THEN RETURN ts + (sign * n) * INTERVAL '1 second'; END IF;
  IF unit IN ('month') THEN RETURN ts + (sign * n) * INTERVAL '1 month'; END IF;
  IF unit IN ('year') THEN RETURN ts + (sign * n) * INTERVAL '1 year'; END IF;
  RETURN ts;
END;
$$;

CREATE OR REPLACE FUNCTION sqlite_fmt_iso(ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char(ts AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z';
$$;

-- strftime(fmt, timestring, modifier...)
-- Supports the formats used in this CRM, especially %Y-%m-%dT%H:%M:%fZ
CREATE OR REPLACE FUNCTION strftime(fmt TEXT, timestring TEXT, VARIADIC mods TEXT[])
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  ts TIMESTAMPTZ := sqlite_parse_time(timestring);
  m TEXT;
  out TEXT;
BEGIN
  IF fmt IS NULL OR timestring IS NULL THEN RETURN NULL; END IF;
  FOREACH m IN ARRAY mods LOOP
    ts := sqlite_apply_modifier(ts, m);
  END LOOP;
  IF ts IS NULL THEN RETURN NULL; END IF;
  out := fmt;
  out := replace(out, '%Y', to_char(ts AT TIME ZONE 'utc', 'YYYY'));
  out := replace(out, '%m', to_char(ts AT TIME ZONE 'utc', 'MM'));
  out := replace(out, '%d', to_char(ts AT TIME ZONE 'utc', 'DD'));
  out := replace(out, '%H', to_char(ts AT TIME ZONE 'utc', 'HH24'));
  out := replace(out, '%M', to_char(ts AT TIME ZONE 'utc', 'MI'));
  out := replace(out, '%S', to_char(ts AT TIME ZONE 'utc', 'SS'));
  out := replace(out, '%f', to_char(ts AT TIME ZONE 'utc', 'SS.MS'));
  out := replace(out, '%s', floor(extract(epoch FROM ts))::bigint::text);
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION datetime(timestring TEXT, VARIADIC mods TEXT[])
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT strftime('%Y-%m-%d %H:%M:%S', timestring, VARIADIC mods);
$$;


-- julianday(timestring, modifier...) — SQLite: days since noon UTC Nov 24 4714 BC
CREATE OR REPLACE FUNCTION julianday(timestring TEXT, VARIADIC mods TEXT[])
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  ts TIMESTAMPTZ := sqlite_parse_time(timestring);
  m TEXT;
BEGIN
  IF timestring IS NULL THEN RETURN NULL; END IF;
  FOREACH m IN ARRAY mods LOOP
    ts := sqlite_apply_modifier(ts, m);
  END LOOP;
  IF ts IS NULL THEN RETURN NULL; END IF;
  -- Unix epoch 1970-01-01 00:00 UTC = Julian 2440587.5
  RETURN extract(epoch FROM ts) / 86400.0 + 2440587.5;
END;
$$;



CREATE OR REPLACE FUNCTION strftime(fmt TEXT, timestring TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT strftime(fmt, timestring, VARIADIC ARRAY[]::text[]);
$$;

CREATE OR REPLACE FUNCTION datetime(timestring TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT datetime(timestring, VARIADIC ARRAY[]::text[]);
$$;

CREATE OR REPLACE FUNCTION julianday(timestring TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT julianday(timestring, VARIADIC ARRAY[]::text[]);
$$;


CREATE OR REPLACE FUNCTION sqlite_julianday(timestring TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT julianday(timestring);
$$;

-- ---------- misc ----------
CREATE OR REPLACE FUNCTION ifnull(a ANYELEMENT, b ANYELEMENT)
RETURNS ANYELEMENT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(a, b);
$$;

-- sqlite_version placeholder
CREATE OR REPLACE FUNCTION sqlite_version()
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '3.pg-compat';
$$;

-- A sqlite_master compatibility view (populated by the migrator, plus live catalog).
-- The migrator also writes original SQLite CREATE texts into sqlite_master_sql.
CREATE TABLE IF NOT EXISTS sqlite_master_sql (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  tbl_name TEXT,
  sql TEXT,
  PRIMARY KEY (type, name)
);

CREATE OR REPLACE VIEW sqlite_master AS
  SELECT type, name, tbl_name, 0 AS rootpage, sql FROM sqlite_master_sql;


-- ---------- extra helpers for trigger/index port (idempotent) ----------

CREATE OR REPLACE FUNCTION instr(hay TEXT, needle TEXT)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN hay IS NULL OR needle IS NULL THEN NULL ELSE strpos(hay, needle) END;
$$;

CREATE OR REPLACE FUNCTION json_type(doc TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF doc IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_typeof(doc::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION json_array_length(doc TEXT)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF doc IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(doc::jsonb) <> 'array' THEN RETURN 0; END IF;
  RETURN jsonb_array_length(doc::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Avoid colliding with PG's json_each(json). Triggers are rewritten to this name.
CREATE OR REPLACE FUNCTION sqlite_json_each(doc TEXT)
RETURNS TABLE(key TEXT, value TEXT, type TEXT, atom TEXT, id INT, parent INT, fullkey TEXT, path TEXT)
LANGUAGE sql IMMUTABLE AS $$
  SELECT * FROM json_each(doc);
$$;

-- text || non-text (SQLite coerces; PG does not). NULL || x is NULL, like SQLite.
CREATE OR REPLACE FUNCTION sqlite_concat_text(a TEXT, b TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE a || b END;
$$;

DO $$
DECLARE
  lefts TEXT[] := ARRAY['bigint','integer','smallint','double precision','numeric','boolean'];
  rights TEXT[] := ARRAY['bigint','integer','smallint','double precision','numeric','boolean'];
  l TEXT; r TEXT;
BEGIN
  -- text || <nontext> and <nontext> || text and <nontext> || <nontext>
  FOREACH l IN ARRAY lefts LOOP
    BEGIN
      EXECUTE format(
        'CREATE FUNCTION sqlite_concat_t_%s(text, %s) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$ SELECT sqlite_concat_text($1, $2::text) $f$',
        replace(l, ' ', '_'), l);
      EXECUTE format(
        'CREATE OPERATOR || (LEFTARG = text, RIGHTARG = %s, FUNCTION = sqlite_concat_t_%s)',
        l, replace(l, ' ', '_'));
    EXCEPTION WHEN duplicate_function OR duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE FUNCTION sqlite_concat_%s_t(%s, text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$ SELECT sqlite_concat_text($1::text, $2) $f$',
        replace(l, ' ', '_'), l);
      EXECUTE format(
        'CREATE OPERATOR || (LEFTARG = %s, RIGHTARG = text, FUNCTION = sqlite_concat_%s_t)',
        l, replace(l, ' ', '_'));
    EXCEPTION WHEN duplicate_function OR duplicate_object THEN NULL;
    END;
  END LOOP;
  FOREACH l IN ARRAY lefts LOOP
    FOREACH r IN ARRAY rights LOOP
      BEGIN
        EXECUTE format(
          'CREATE FUNCTION sqlite_concat_%s_%s(%s, %s) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$ SELECT sqlite_concat_text($1::text, $2::text) $f$',
          replace(l, ' ', '_'), replace(r, ' ', '_'), l, r);
        EXECUTE format(
          'CREATE OPERATOR || (LEFTARG = %s, RIGHTARG = %s, FUNCTION = sqlite_concat_%s_%s)',
          l, r, replace(l, ' ', '_'), replace(r, ' ', '_'));
      EXCEPTION WHEN duplicate_function OR duplicate_object THEN NULL;
      END;
    END LOOP;
  END LOOP;
END
$$;

-- Immutable julianday for indexes: no 'now'/clock_timestamp.
CREATE OR REPLACE FUNCTION sqlite_julianday_immutable(t TEXT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT AS $$
DECLARE
  s TEXT := btrim(t);
  ts TIMESTAMP;
BEGIN
  IF s IS NULL OR lower(s) = 'now' THEN
    RAISE EXCEPTION 'sqlite_julianday_immutable cannot evaluate now';
  END IF;
  s := replace(s, 'T', ' ');
  IF s ~ 'Z$' THEN s := left(s, length(s)-1); END IF;
  s := regexp_replace(s, '[+-][0-9]{2}(:?[0-9]{2})?$', '');
  ts := s::timestamp;
  RETURN extract(epoch FROM (ts AT TIME ZONE 'utc')) / 86400.0 + 2440587.5;
END;
$$;

-- SQLite typeof() used in finance/GL CHECK constraints.
CREATE OR REPLACE FUNCTION typeof(v anyelement)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN v IS NULL THEN 'null'
    WHEN pg_typeof(v)::text IN ('bigint','integer','smallint','oid') THEN 'integer'
    WHEN pg_typeof(v)::text IN ('double precision','real','numeric') THEN 'real'
    WHEN pg_typeof(v)::text = 'bytea' THEN 'blob'
    ELSE 'text'
  END;
$$;
