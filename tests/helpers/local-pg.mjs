/* ============================================================
   CED Intelligence Platform — disposable local PostgreSQL
   ------------------------------------------------------------
   Creates a brand-new, in-memory PostgreSQL for one test run,
   applies the migration chain to it, and presents the small
   slice of the supabase-js surface the integration suite uses —
   so the SAME suite that runs against a hosted development
   project can run against a database that lives and dies inside
   the process.

   WHY THIS EXISTS

   Migration 0006 turns ingest_assessment() into a wrapper over a
   new ingest_review(), which meant transcribing the 0003 body.
   docs/REAL_POSTGRES_VALIDATION.md names the real-Postgres run
   as the compensating control for that transcription. Without a
   local Postgres there was no way to run it, and no hosted
   database may be touched.

   WHAT THIS IS AND IS NOT

   It IS real PostgreSQL: PGlite is the PostgreSQL server source
   compiled to WebAssembly, running the real planner, the real
   plpgsql, the real constraint machinery, the real triggers.

   It is NOT PostgREST. supabase-js speaks HTTP to PostgREST;
   this speaks SQL directly. The adapter below reproduces the
   query SHAPES the suite uses, not PostgREST's semantics. What
   that leaves unproven is named in docs/REAL_POSTGRES_VALIDATION.md.

   It is also NOT the same PostgreSQL VERSION as the hosted
   development project (18.3 here, 17.6 there). A difference in
   behaviour between the two majors would not be caught.

   SAFETY

   There is no host, no port, no socket, and no credential. The
   database exists only in this process's memory and is gone when
   it exits. It cannot reach, and cannot be confused for, any
   hosted project.
   ============================================================ */

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '../../supabase/migrations');

/* pgcrypto is not bundled with PGlite. Migration 0001 asks for it, and
   NOTHING in the chain uses a function that only pgcrypto provides:
   gen_random_uuid() has been core since PostgreSQL 13 and sha256() since 11 —
   migration 0003 says so explicitly, and chose sha256() over digest() for
   exactly this reason.

   The statement is therefore tolerated rather than the extension faked, and
   `assertNoPgcryptoDependency()` below turns "nothing uses it" from a comment
   into a check. */
const TOLERATED = [
  { match: /create extension if not exists\s+"?pgcrypto"?/i,
    reason: 'pgcrypto is unavailable in PGlite and unused by the chain' }
];

export const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

export const migrationSource = file =>
  readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');

/* Splits a migration into executable statements.

   Naive splitting on ";" would tear every plpgsql body in half, so dollar-
   quoted blocks are tracked and their contents left alone. This handles the
   two forms the chain actually uses — $$ and $tag$ — and nothing else,
   because nothing else appears. */
export const splitStatements = sql => {
  const statements = [];
  let current = '';
  let dollarTag = null;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const rest = sql.slice(i);

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (rest.startsWith('*/')) { current += '/'; i++; inBlockComment = false; }
      continue;
    }
    if (dollarTag) {
      current += ch;
      if (rest.startsWith(dollarTag)) {
        current += dollarTag.slice(1);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (rest.startsWith('--')) { inLineComment = true; current += ch; continue; }
    if (rest.startsWith('/*')) { inBlockComment = true; current += ch; continue; }
    if (ch === "'") { inSingleQuote = true; current += ch; continue; }

    const dollar = rest.match(/^\$[A-Za-z_]*\$/);
    if (dollar) {
      dollarTag = dollar[0];
      current += dollarTag;
      i += dollarTag.length - 1;
      continue;
    }

    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
};

/* Turns "nothing in the chain needs pgcrypto" into an assertion rather than a
   claim. Only functions pgcrypto ALONE provides are listed; gen_random_uuid
   and sha256 are core and are deliberately absent. */
const PGCRYPTO_ONLY = /\b(digest|hmac|crypt|gen_salt|pgp_sym_encrypt|pgp_pub_encrypt|encrypt|decrypt)\s*\(/i;

export const assertNoPgcryptoDependency = () => {
  const offenders = [];
  migrationFiles().forEach(file => {
    const body = migrationSource(file)
      /* Comments mention digest() by name while explaining why it is NOT
         used, so they are stripped before the check. */
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (PGCRYPTO_ONLY.test(body)) offenders.push(file);
  });
  return offenders;
};

/* ---------- the adapter ----------
   The slice of supabase-js the integration suite uses, over SQL. */

const quoteIdent = name => `"${String(name).replace(/"/g, '""')}"`;

/* PostgREST serialises every row to JSON before it reaches supabase-js, so a
   timestamptz arrives as an ISO string and a bigint as a number. The driver
   here hands back JavaScript Date and BigInt, and the suite compares against
   strings and numbers. Normalising at the boundary keeps the test bodies
   identical between the two modes — the alternative was rewriting assertions
   to be transport-aware, which would weaken them against the hosted path. */
const toJsonShape = value => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(toJsonShape);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonShape(v);
    return out;
  }
  return value;
};

const buildQuery = (pg, table, columns = '*', options = {}) => {
  const state = {
    table,
    columns: columns || '*',
    filters: [],
    limit: null,
    /* `select('*', { count: 'exact', head: true })` asks PostgREST for a count
       and no rows. */
    head: options.head === true,
    count: options.count === 'exact',
    order: null
  };

  const where = () => {
    if (!state.filters.length) return { text: '', params: [] };
    const params = [];
    const clauses = state.filters.map(([column, value]) => {
      params.push(value);
      return `${quoteIdent(column)} = $${params.length}`;
    });
    return { text: ` where ${clauses.join(' and ')}`, params };
  };

  const run = async () => {
    const w = where();
    if (state.count) {
      const sql = `select count(*)::int as n from ${quoteIdent(state.table)}${w.text}`;
      const result = await pg.query(sql, w.params);
      return { data: state.head ? null : [], count: result.rows[0].n, error: null };
    }
    /* PostgREST accepts "a,b" for a projection; SQL wants "a", "b". */
    const projection = state.columns === '*'
      ? '*'
      : state.columns.split(',').map(c => quoteIdent(c.trim())).join(', ');
    const sql = `select ${projection} from ${quoteIdent(state.table)}${w.text}` +
      (state.order ? ` order by ${quoteIdent(state.order.column)} ${state.order.direction}` : '') +
      (state.limit === null ? '' : ` limit ${Number(state.limit)}`);
    try {
      const result = await pg.query(sql, w.params);
      return { data: toJsonShape(result.rows), count: result.rows.length, error: null };
    } catch (err) {
      return { data: null, count: null, error: { message: err.message } };
    }
  };

  const thenable = {
    eq(column, value) { state.filters.push([column, value]); return thenable; },
    limit(n) { state.limit = n; return thenable; },
    order(column, options = {}) {
      state.order = { column, direction: options.ascending === false ? 'desc' : 'asc' };
      return thenable;
    },
    then(onFulfilled, onRejected) {
      return run().then(onFulfilled, onRejected);
    }
  };
  return thenable;
};

const mutation = (pg, table, kind, values) => {
  const filters = [];

  const run = async () => {
    const params = [];
    const w = () => {
      if (!filters.length) return '';
      const clauses = filters.map(([column, value]) => {
        params.push(value);
        return `${quoteIdent(column)} = $${params.length}`;
      });
      return ` where ${clauses.join(' and ')}`;
    };

    try {
      if (kind === 'insert') {
        /* supabase-js accepts one row or an array of rows, and the suite uses
           both. Every row in an array shares one column list, as it does
           there. */
        const batch = Array.isArray(values) ? values : [values];
        if (!batch.length) return { data: null, error: null };
        const columns = Object.keys(batch[0]);
        const tuples = batch.map(row => {
          const placeholders = columns.map(c => {
            const v = row[c];
            params.push(v === undefined ? null : (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
            return `$${params.length}`;
          });
          return `(${placeholders.join(', ')})`;
        });
        await pg.query(
          `insert into ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) ` +
          `values ${tuples.join(', ')}`, params);
        return { data: null, error: null };
      }
      if (kind === 'update') {
        const columns = Object.keys(values);
        const sets = columns.map(c => {
          const v = values[c];
          params.push(v === undefined ? null : (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
          return `${quoteIdent(c)} = $${params.length}`;
        });
        await pg.query(`update ${quoteIdent(table)} set ${sets.join(', ')}${w()}`, params);
        return { data: null, error: null };
      }
      await pg.query(`delete from ${quoteIdent(table)}${w()}`, params);
      return { data: null, error: null };
    } catch (err) {
      /* supabase-js reports a database error in the result rather than
         throwing, and the suite asserts on error.message. */
      return { data: null, error: { message: err.message } };
    }
  };

  const thenable = {
    eq(column, value) { filters.push([column, value]); return thenable; },
    then(onFulfilled, onRejected) { return run().then(onFulfilled, onRejected); }
  };
  return thenable;
};

/* Argument order for a PostgREST rpc call is by NAME, so the adapter looks the
   function's parameters up in the catalog and binds by name. Passing an
   unknown parameter is an error there and is an error here. */
const callFunction = async (pg, name, args) => {
  const meta = await pg.query(
    `select p.proargnames,
            p.pronargs,
            p.proretset,
            array(select format_type(t, null)
                    from unnest(p.proargtypes) with ordinality as u(t, ord)
                   order by u.ord) as argtypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`, [name]);

  if (!meta.rows.length) {
    return { data: null, error: { message: `Could not find the function public.${name}` } };
  }
  if (meta.rows.length > 1) {
    return { data: null, error: {
      message: `Could not choose the best candidate function between: public.${name}` } };
  }

  const names = meta.rows[0].proargnames || [];
  /* Read from pg_proc rather than parsed out of the identity signature: a
     type whose name contains a space — "timestamp with time zone" is the one
     this schema uses everywhere — cannot be recovered by splitting a string. */
  const types = meta.rows[0].argtypes || [];
  const returnsSet = meta.rows[0].proretset === true;
  const supplied = Object.keys(args || {});
  const unknown = supplied.filter(key => !names.includes(key));
  if (unknown.length) {
    return { data: null, error: {
      message: `Could not find the function public.${name}(${supplied.join(', ')})` } };
  }

  const params = [];
  const call = names.map((argName, i) => {
    if (!Object.prototype.hasOwnProperty.call(args || {}, argName)) return 'default';
    let value = args[argName];
    /* jsonb parameters arrive as JavaScript objects over PostgREST; here they
       have to be serialised, and the cast has to be explicit because a text
       parameter bound to jsonb is ambiguous. */
    const type = types[i] || 'text';
    if (value !== null && typeof value === 'object') value = JSON.stringify(value);
    params.push(value === undefined ? null : value);
    return `$${params.length}::${type}`;
  });

  /* `default` cannot be mixed with positional arguments after a supplied one,
     so anything defaulted at the tail is simply dropped. */
  while (call.length && call[call.length - 1] === 'default') call.pop();
  if (call.includes('default')) {
    return { data: null, error: {
      message: `local-pg: ${name} was called with a gap in its argument list` } };
  }

  try {
    /* A set-returning function is a table over PostgREST and arrives as an
       array of row objects. A scalar function arrives as its single value. */
    if (returnsSet) {
      const result = await pg.query(
        `select * from public.${quoteIdent(name)}(${call.join(', ')})`, params);
      return { data: toJsonShape(result.rows), error: null };
    }
    const result = await pg.query(
      `select public.${quoteIdent(name)}(${call.join(', ')}) as result`, params);
    const value = result.rows.length ? toJsonShape(result.rows[0].result) : null;
    return { data: value === undefined ? null : value, error: null };
  } catch (err) {
    return { data: null, error: { message: err.message } };
  }
};

export const createLocalDb = pg => ({
  /* Escape hatch for the migration tests, which need to inspect the catalog
     and to seed pre-0006 rows. Never used by the shared suite bodies. */
  _pg: pg,
  rpc: (name, args) => callFunction(pg, name, args),
  from: table => ({
    select: (columns = '*', options = {}) => buildQuery(pg, table, columns, options),
    insert: values => mutation(pg, table, 'insert', values),
    update: values => mutation(pg, table, 'update', values),
    delete: () => mutation(pg, table, 'delete', null)
  })
});

/* ---------- lifecycle ---------- */

/* The roles a Supabase project already has and a vanilla PostgreSQL does not.
   Created before the chain runs, because migration 0001 revokes from `anon`
   and `authenticated` by name and would otherwise fail on a plain server.

   This is environment setup, not a migration change: `supabase start` creates
   exactly these. `service_role` gets BYPASSRLS because that is what makes the
   Vercel Function able to read a table with RLS forced and no policies — the
   property section A of the suite asserts. `anon` deliberately does not, so
   the RLS check below is a real check. */
export const bootstrapSupabaseRoles = async pg => {
  await pg.exec(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticator') then
        create role authenticator noinherit;
      end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant anon, authenticated, service_role to authenticator;
  `);
};

export const applyMigrations = async (pg, files) => {
  const applied = [];
  for (const file of files) {
    const statements = splitStatements(migrationSource(file));
    const tolerated = [];
    for (const statement of statements) {
      try {
        await pg.exec(statement);
      } catch (err) {
        const excuse = TOLERATED.find(t => t.match.test(statement));
        if (excuse) { tolerated.push({ statement: statement.slice(0, 60), reason: excuse.reason }); continue; }
        throw new Error(`${file}: ${err.message}\n  statement: ${statement.slice(0, 300)}`);
      }
    }
    applied.push({ file, statements: statements.length, tolerated });
  }
  return applied;
};

/* A brand-new database for one test file. `upTo` stops the chain early so the
   upgrade path can be exercised against a pre-0006 schema. */
export const startLocalPg = async ({ upTo = null, dataDir = null } = {}) => {
  cleanStaleDataDirs();
  const { PGlite } = await import('@electric-sql/pglite');
  /* A datadir on disk rather than in memory. PGlite's in-memory mode keeps
     the whole cluster inside the V8 heap, which a node:test worker running a
     1,900-line suite ran out of. A temporary directory is also easier to
     prove disposable: it is deleted by the caller and named per run. */
  const pg = dataDir ? await PGlite.create(`file://${dataDir}`) : await PGlite.create();
  await bootstrapSupabaseRoles(pg);

  const all = migrationFiles();
  const files = upTo ? all.slice(0, all.findIndex(f => f.startsWith(upTo)) + 1) : all;
  if (upTo && !files.length) throw new Error(`local-pg: no migration matching "${upTo}"`);

  const applied = await applyMigrations(pg, files);
  const version = (await pg.query('select version()')).rows[0].version;

  return {
    pg,
    db: createLocalDb(pg),
    applied,
    version,
    dataDir,
    /* Applies the remaining migrations — the upgrade path. */
    async upgrade(from) {
      const remaining = migrationFiles().slice(
        migrationFiles().findIndex(f => f.startsWith(from)) + 1);
      return applyMigrations(pg, remaining);
    },
    /* Disposable in the literal sense: the cluster is removed, not merely
       disconnected from. */
    async close({ removeDataDir = true } = {}) {
      await pg.close();
      if (dataDir && removeDataDir) {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  };
};

/* A per-run temporary datadir. Named so an abandoned one is obviously test
   scaffolding, and placed under the OS temp directory, never in the repo. */
export const disposableDataDir = label =>
  resolve(tmpdir(), `ced-local-pg-${label}-${process.pid}-${Date.now()}`);

/* A run killed by the operating system — which is how an out-of-memory run
   ends — never reaches close(), so its datadir survives. This sweeps what is
   obviously abandoned before starting a new one.

   An hour, not a minute: a concurrent run's directory must never be deleted
   out from under it, and nothing here is urgent enough to risk that. */
const STALE_AFTER_MS = 60 * 60 * 1000;

export const cleanStaleDataDirs = (now = Date.now()) => {
  let removed = 0;
  try {
    readdirSync(tmpdir())
      .filter(name => name.startsWith('ced-local-pg-'))
      .forEach(name => {
        const stamp = Number(name.split('-').pop());
        if (!Number.isFinite(stamp) || now - stamp < STALE_AFTER_MS) return;
        try {
          rmSync(resolve(tmpdir(), name), { recursive: true, force: true });
          removed++;
        } catch { /* in use, or already gone */ }
      });
  } catch { /* no temp directory to sweep is not a failure */ }
  return removed;
};
