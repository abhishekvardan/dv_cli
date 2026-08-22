/**
 * `dv db …` — SQL from the terminal.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { CancelledError, UsageError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { describeShape, resolveCommand, type CommandShape } from '../cli/dispatch.js';
import { c, confirm, info, json, out, select, success, table } from '../cli/ui.js';
import { printResult } from '../cli/resultTable.js';
import { getOAuthApp, setOAuthApp } from '../config/store.js';
import '../db/providers.js';
import {
  SUPABASE_REGIONS,
  supabaseCreateProject,
  supabaseOrgs,
} from '../db/providers.js';
import {
  adapters,
  countSql,
  describeSql,
  isReadOnly,
  requireAdapter,
  tablesSql,
} from '../db/adapter.js';

const SHAPE: CommandShape = {
  verbs: {
    table: ['list', 'describe'],
    project: ['list', 'use', 'create'],
  },
  // `query` is standalone rather than a noun with verbs: what follows it is free-form
  // SQL, and the noun-verb resolver would read the first word of a statement as a
  // verb — turning `dv db query "select 1"` into an unknown command.
  standalone: ['query', 'q', 'sql', 'run', 'tables', 'describe', 'count', 'projects', 'use'],
};

/**
 * Which database to run against.
 *
 * Stored as `provider:ref` so one setting covers every provider — `supabase:abc123`,
 * `neon:postgres://…`. A bare `--project` is read as Supabase, which is what it meant
 * before this became multi-provider.
 */
function currentTarget(args: ParsedArgs): { provider: string; ref: string } {
  const explicit = str(args.flags, 'db', 'project', 'p');
  const saved = getOAuthApp('dv').projectRef;
  const raw = explicit ?? saved;

  if (!raw) {
    throw new UsageError(
      'No database selected.',
      `dv db use          pick one interactively
` +
        `Providers: ${adapters().map((a) => a.id).join(', ')}`,
    );
  }

  const sep = raw.indexOf(':');
  // A connection string contains "://", so only split on a provider prefix we know.
  if (sep > 0) {
    const head = raw.slice(0, sep);
    if (adapters().some((a) => a.id === head)) {
      return { provider: head, ref: raw.slice(sep + 1) };
    }
  }
  return { provider: 'supabase', ref: raw };
}

/** Run SQL against the selected database, whichever provider backs it. */
async function runSql(args: ParsedArgs, sql: string): Promise<any[]> {
  const { provider, ref } = currentTarget(args);
  return requireAdapter(provider).query(ref, sql);
}


/**
 * A password strong enough that it never needs thinking about.
 *
 * Avoids characters that get mangled when a connection string is pasted into a shell
 * or a URL, which is where this value invariably ends up.
 */
function generatePassword(length = 28): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export async function dbCommand(args: ParsedArgs): Promise<void> {
  const { key, rest } = resolveCommand(args, SHAPE);
  const asJson = bool(args.flags, 'json');

  switch (key) {
    case 'projects':
    case 'project list': {
      // Every provider that can enumerate its databases, together.
      const active = (() => {
        try {
          return currentTarget(args);
        } catch {
          return undefined;
        }
      })();

      const rows: Array<{ provider: string; ref: string; label?: string }> = [];
      for (const adapter of adapters()) {
        if (!adapter.list) continue;
        // One provider being unconnected must not hide the others.
        const found = await adapter.list().catch(() => []);
        rows.push(...found);
      }

      if (asJson) return json(rows);
      if (rows.length === 0) {
        return info('No databases found. Connect a provider first, e.g. dv connect supabase');
      }

      table(rows, [
        {
          header: '',
          value: (r) => (active && r.provider === active.provider && r.ref === active.ref ? c.green('*') : ' '),
        },
        { header: 'provider', value: (r) => r.provider },
        { header: 'ref', value: (r) => r.ref, max: 40 },
        { header: 'name', value: (r) => c.bold(r.label ?? ''), max: 34 },
      ]);
      info('');
      info(c.dim('  dv db use <ref>   to pick one'));
      return;
    }

    case 'use':
    case 'project use': {
      const wanted = rest[0];

      if (wanted) {
        // Validated before saving, so a typo is caught now rather than at the next
        // query — the old code quietly stored "render" as a Supabase project ref.
        const known = (id: string) => adapters().some((a) => a.id === id);
        const sep = wanted.indexOf(':');

        if (sep > 0) {
          const head = wanted.slice(0, sep);
          if (!known(head)) {
            throw new UsageError(
              `Unknown database provider "${head}".`,
              `Providers: ${adapters().map((a) => a.id).join(', ')}`,
            );
          }
          const adapter = requireAdapter(head);
          if (adapter.requiresDriver) throw new UsageError(`${adapter.label} cannot be queried by dv.`, adapter.hint);
          if (!wanted.slice(sep + 1)) throw new UsageError(`${adapter.label} needs a target.`, adapter.hint);
        } else if (known(wanted)) {
          // A bare provider name with nothing after it names a provider, not a database.
          const adapter = requireAdapter(wanted);
          throw new UsageError(
            adapter.requiresDriver
              ? `${adapter.label} cannot be queried by dv.`
              : `"${wanted}" is a provider, not a database.`,
            adapter.hint,
          );
        }
        // Otherwise a bare ref, which meant Supabase before this was multi-provider.

        setOAuthApp('dv', { projectRef: wanted });
        success(`Queries will run against ${c.bold(wanted)}.`);
        return;
      }

      const choices: Array<{ provider: string; ref: string; label?: string }> = [];
      for (const adapter of adapters()) {
        if (!adapter.list) continue;
        choices.push(...(await adapter.list().catch(() => [])));
      }
      if (choices.length === 0) {
        throw new UsageError(
          'No databases to choose from.',
          `Connect one first: ${adapters().filter((a) => !a.requiresDriver).map((a) => `dv connect ${a.id}`).join('  ')}`,
        );
      }
      if (!process.stdin.isTTY) {
        throw new UsageError('Which database?', 'dv db use <provider>:<ref>');
      }

      const chosen = await select(
        'Which database should queries run against?',
        choices.map((t, i) => ({
          value: t,
          label: t.label ?? t.ref,
          detail: `${t.provider}:${t.ref}`,
          recommended: i === 0,
        })),
      );
      const value = `${chosen.provider}:${chosen.ref}`;
      setOAuthApp('dv', { projectRef: value });
      success(`Queries will run against ${c.bold(chosen.label ?? chosen.ref)}.`);
      return;
    }

    case 'project create': {
      const name = rest[0] ?? str(args.flags, 'name');
      if (!name) {
        throw new UsageError(
          'What should the project be called?',
          'dv db project create my-app --region ap-south-1',
        );
      }

      const orgs = await supabaseOrgs();
      if (orgs.length === 0) throw new UsageError('No Supabase organizations on this account.');

      let org = orgs.find((o) => o.id === str(args.flags, 'org') || o.name === str(args.flags, 'org'));
      if (!org) {
        org =
          orgs.length === 1 || !process.stdin.isTTY
            ? orgs[0]!
            : await select(
                'Which organization?',
                orgs.map((o, i) => ({ value: o, label: o.name, detail: o.id, recommended: i === 0 })),
              );
      }

      const region = str(args.flags, 'region') ??
        (process.stdin.isTTY
          ? await select(
              'Which region?',
              SUPABASE_REGIONS.map((r, i) => ({
                value: r,
                label: r,
                // Closest to most of the existing projects on this account.
                recommended: i === SUPABASE_REGIONS.indexOf('ap-south-1'),
              })),
            )
          : 'us-east-1');

      // Generated rather than asked for: Supabase never shows this again, only lets
      // you reset it, so a weak or forgotten one is a real problem later.
      const dbPass = str(args.flags, 'db-password') ?? generatePassword();

      out(`${c.dim('name    ')} ${name}`);
      out(`${c.dim('org     ')} ${org.name}`);
      out(`${c.dim('region  ')} ${region}`);
      out(`${c.dim('plan    ')} ${str(args.flags, 'plan') ?? 'free'}`);
      out('');
      const ok = await confirm('Create this project?', bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Not created.');

      const project = await supabaseCreateProject({
        name,
        organizationId: org.id,
        region,
        dbPass,
        plan: str(args.flags, 'plan'),
      });

      const ref = project.ref ?? project.id;
      success(`Created ${c.bold(name)} (${ref})`);
      out('');
      // Shown once, deliberately prominent: there is no way to retrieve it later.
      out(c.yellow('  Database password (shown once, save it now):'));
      out(`  ${c.bold(dbPass)}`);
      out('');
      info(c.dim('  Provisioning takes a minute or two.'));
      info(c.dim(`  dv db use supabase:${ref}`));

      if (asJson) json({ ...project, dbPass });
      return;
    }

    case 'tables':
    case 'table list': {
      const rows = await runSql(args, tablesSql(str(args.flags, 'schema') ?? 'public'));
      if (asJson) return json(rows);
      if (rows.length === 0) return info('No tables in that schema.');
      table(rows, [
        { header: 'table', value: (r: any) => c.bold(r.table), max: 34 },
        { header: 'rows', value: (r: any) => (r.approx_rows < 0 ? '—' : String(r.approx_rows)), align: 'right' },
        { header: 'size', value: (r: any) => r.size ?? '—', align: 'right' },
      ]);
      info('');
      // reltuples is a planner estimate, refreshed by ANALYZE. Saying so avoids the
      // reasonable assumption that it is a count.
      // A dash is "never analyzed", not "empty" — an important difference when you
      // are checking whether a migration actually moved anything.
      info(c.dim('  Row counts are planner estimates; — means the table has not been analyzed.'));
      info(c.dim('  dv db count <table>   for an exact count'));
      return;
    }

    case 'describe':
    case 'table describe': {
      const name = rest[0];
      if (!name) throw new UsageError('Which table?', 'dv db describe tasks');
      const rows = await runSql(args, describeSql(name, str(args.flags, 'schema') ?? 'public'));
      if (asJson) return json(rows);
      if (rows.length === 0) {
        throw new UsageError(`No table "${name}" in that schema.`, 'dv db tables');
      }
      out(c.bold(name));
      out('');
      table(rows, [
        { header: 'column', value: (r: any) => r.column, max: 30 },
        { header: 'type', value: (r: any) => r.type, max: 26 },
        { header: 'null', value: (r: any) => (r.nullable === 'YES' ? c.dim('yes') : 'no') },
        { header: 'default', value: (r: any) => r.default ?? '', max: 30 },
      ]);
      return;
    }

    case 'count': {
      const name = rest[0];
      if (!name) throw new UsageError('Which table?', 'dv db count tasks');
      const counted = await runSql(args, countSql(name, str(args.flags, 'schema') ?? 'public'));
      const n = Number(counted[0]?.n ?? 0);
      if (asJson) return json({ table: name, rows: n });
      out(String(n));
      return;
    }

    case 'q':
    case 'sql':
    case 'run':
    case 'query': {
      const fromFile = str(args.flags, 'file', 'f');
      const sql = fromFile ? readFileSync(fromFile, 'utf8') : rest.join(' ');
      if (!sql.trim()) {
        throw new UsageError(
          'What should I run?',
          'dv db query "select * from tasks limit 5"\n' +
            'dv db query --file ./migration.sql',
        );
      }

      // Anything that is not clearly a read is confirmed. A CLI that runs `drop table`
      // without asking is one keystroke from ruining someone's afternoon.
      if (!isReadOnly(sql)) {
        out(c.yellow('This statement modifies the database:'));
        out('');
        out(sql.trim());
        out('');
        const ok = await confirm('Run it?', bool(args.flags, 'yes', 'y'));
        if (!ok) {
          const { CancelledError } = await import('../cli/errors.js');
          throw new CancelledError('Not run. The database is unchanged.');
        }
      }

      const rows = await runSql(args, sql);
      if (asJson) return json(rows);

      if (rows.length === 0) {
        // An empty result from a write is success, not "nothing found".
        info(isReadOnly(sql) ? 'No rows.' : 'Done. The statement returned no rows.');
        return;
      }
      const limit = num(args.flags, 'limit', 50);
      const layout = printResult(rows, {
        expanded: bool(args.flags, 'expanded', 'x'),
        plain: bool(args.flags, 'plain'),
        limit,
      });
      info('');
      const more =
        rows.length > limit
          ? `${limit} of ${rows.length} rows`
          : `${rows.length} row${rows.length === 1 ? '' : 's'}`;
      info(c.dim(`  ${more}`));
      // Only worth suggesting when it is not already what you are looking at.
      if (layout === 'grid') info(c.dim('  -x for one field per line, --json to pipe'));
      return;
    }

    default:
      throw new UsageError(
        key ? `Unknown db command "${key}".` : 'What would you like to do?',
        `${describeShape(SHAPE)}\n\n` +
          'e.g.  dv db use <ref>\n' +
          '      dv db tables\n' +
          '      dv db describe tasks\n' +
          '      dv db query "select id, title from tasks limit 5"',
      );
  }
}
