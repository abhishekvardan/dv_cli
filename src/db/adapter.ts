/**
 * Database providers.
 *
 * `dv db` was Supabase-only, which was wrong: Supabase, Neon, Render, Railway and a
 * plain Postgres URL are all "the database" from a user's point of view, and baking
 * one vendor into the command name would have meant a second, near-identical command
 * surface for every other one.
 *
 * An adapter supplies exactly one thing — a way to run SQL. Everything above it
 * (listing tables, describing columns, counting rows) is standard Postgres and is
 * written once here, so a new provider gets the whole surface for free.
 *
 * The reason adapters differ at all: almost no provider lets you run SQL over plain
 * HTTP. Supabase does, through its Management API. Neon does, through its serverless
 * SQL endpoint. Most others only give you a Postgres connection string, which needs a
 * real driver — hence `requiresDriver`, so the CLI can say so rather than fail oddly.
 */

import { CliError, EXIT } from '../cli/errors.js';

export interface DbTarget {
  /** Adapter id, e.g. "supabase". */
  provider: string;
  /** What identifies the database to that provider — a project ref, a branch, a URL. */
  ref: string;
  /** Shown in listings. */
  label?: string;
}

export interface DbAdapter {
  id: string;
  label: string;
  /**
   * True when this provider only exposes a Postgres connection string, so running SQL
   * needs a driver rather than an HTTP call.
   */
  requiresDriver?: boolean;
  /** How to obtain a ref, shown when none is set. */
  hint: string;
  /** Run SQL and return rows. */
  query(ref: string, sql: string): Promise<any[]>;
  /** Targets the user can pick from, when the provider can enumerate them. */
  list?(): Promise<DbTarget[]>;
}

const ADAPTERS = new Map<string, DbAdapter>();

export function registerAdapter(adapter: DbAdapter): void {
  ADAPTERS.set(adapter.id, adapter);
}

export function getAdapter(id: string): DbAdapter | undefined {
  return ADAPTERS.get(id);
}

export function adapters(): DbAdapter[] {
  return [...ADAPTERS.values()];
}

export function requireAdapter(id: string | undefined): DbAdapter {
  if (!id) {
    throw new CliError(
      'No database selected.',
      EXIT.usage,
      `dv db use   (providers: ${adapters().map((a) => a.id).join(', ')})`,
    );
  }
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new CliError(
      `Unknown database provider "${id}".`,
      EXIT.usage,
      `Available: ${adapters().map((a) => a.id).join(', ')}`,
    );
  }
  return adapter;
}

/* ───────────────── shared Postgres introspection ───────────────── */

/** Single-quote a literal for embedding in SQL. */
export function lit(value: string): string {
  return value.replace(/'/g, "''");
}

/** Double-quote an identifier. */
export function ident(value: string): string {
  return value.replace(/"/g, '""');
}

/**
 * Tables, views and matviews in a schema.
 *
 * `reltuples` is a planner estimate and is -1 until the table has been analyzed, which
 * is most tables on a young project — the caller renders that as unknown rather than
 * as zero, because the difference matters when checking whether a migration ran.
 */
export function tablesSql(schema: string): string {
  return `select c.relname as table,
                 n.nspname as schema,
                 c.reltuples::bigint as approx_rows,
                 pg_size_pretty(pg_total_relation_size(c.oid)) as size
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where c.relkind in ('r','p','v','m')
             and n.nspname = '${lit(schema)}'
           order by c.relname`;
}

export function describeSql(table: string, schema: string): string {
  return `select column_name as column,
                 data_type as type,
                 is_nullable as nullable,
                 column_default as default
            from information_schema.columns
           where table_schema = '${lit(schema)}' and table_name = '${lit(table)}'
           order by ordinal_position`;
}

export function countSql(table: string, schema: string): string {
  return `select count(*)::bigint as n from "${ident(schema)}"."${ident(table)}"`;
}

/**
 * Statements that change something.
 *
 * Deliberately generous: anything not clearly a read counts as a write, because the
 * cost of asking about a harmless query is a keystroke and the cost of not asking
 * about `drop table` is your data.
 */
const READ_ONLY = /^\s*(select|with|explain|show|table|values)\b/i;

export function isReadOnly(sql: string): boolean {
  const stripped = sql
    // Comments first, or `-- drop table x` would read as a comment-only statement.
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!stripped) return true;
  if (!READ_ONLY.test(stripped)) return false;
  // A CTE can still write: `with x as (delete from t returning *) select * from x`.
  return !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(stripped);
}
