/**
 * `dv api <provider> <path>` — an authenticated request to any connector.
 *
 * The escape hatch that keeps the CLI from being a list of things I thought of.
 * Every connector, built-in or custom, is reachable the moment it has a credential:
 * auth, base URL, headers, error translation and exit codes are all handled, and
 * what comes back is the raw response for `jq` to work on.
 */

import { readFileSync } from 'node:fs';

import { UsageError } from '../cli/errors.js';
import { bool, str, unmanglePath, type ParsedArgs } from '../cli/args.js';
import { c, info, json, out } from '../cli/ui.js';
import { pick, redact } from '../cli/output.js';
import { getProvider, providerIds } from '../auth/providers.js';
import { call } from '../api/client.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

export async function apiCommand(args: ParsedArgs): Promise<void> {
  const providerId = args.command[1] ?? args.positional[0];
  if (!providerId) {
    throw new UsageError(
      'Which connector?',
      `One of: ${providerIds().join(', ')}\n  dv api github /user`,
    );
  }

  const provider = getProvider(providerId);
  if (!provider) {
    throw new UsageError(`No connector "${providerId}".`, 'dv connect list');
  }

  // Query parameters are safest given as repeated --query pairs rather than inline in
  // the path: an `&` in an unquoted argument is split by the shell before this process
  // ever sees it, which silently truncates the request.
  const rawPath = args.command[2] ?? args.positional[0] ?? str(args.flags, 'path');
  const path = rawPath ? unmanglePath(rawPath) : rawPath;
  if (!path) {
    throw new UsageError(
      'Which path?',
      `dv api ${providerId} ${provider.whoamiUrl ?? '/'}`,
    );
  }

  const method = (str(args.flags, 'method', 'X') ?? '').toUpperCase();
  if (method && !METHODS.includes(method)) {
    throw new UsageError(`"${method}" is not an HTTP method.`, `One of: ${METHODS.join(', ')}`);
  }

  // --data accepts inline JSON or @file, the convention curl set.
  const dataFlag = str(args.flags, 'data', 'd');
  let body: unknown;
  if (dataFlag !== undefined) {
    const raw = dataFlag.startsWith('@') ? readFileSync(dataFlag.slice(1), 'utf8') : dataFlag;
    try {
      body = JSON.parse(raw);
    } catch {
      // Not everything is JSON — a form body or GraphQL string is legitimate.
      body = raw;
    }
  }

  // Repeatable --query k=v.
  const queryFlag = args.flags['query'] ?? args.flags['q'];
  const query: Record<string, string> = {};
  if (queryFlag !== undefined && typeof queryFlag !== 'boolean') {
    for (const entry of Array.isArray(queryFlag) ? queryFlag : [queryFlag]) {
      const eq = entry.indexOf('=');
      if (eq === -1) throw new UsageError(`Query "${entry}" needs an =.`, '--query state=open');
      query[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }

  const headerFlag = args.flags['header'] ?? args.flags['H'];
  const headers: Record<string, string> = {};
  if (headerFlag !== undefined && typeof headerFlag !== 'boolean') {
    for (const entry of Array.isArray(headerFlag) ? headerFlag : [headerFlag]) {
      const colon = entry.indexOf(':');
      if (colon === -1) throw new UsageError(`Header "${entry}" needs a colon.`, '--header "Accept: application/json"');
      headers[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
    }
  }

  const result = await call(provider, path, {
    method: method || undefined,
    body,
    query,
    headers,
  });

  if (result === null) {
    // 204 and empty bodies are successes with nothing to print.
    info(c.dim('  (no content)'));
    return;
  }
  if (typeof result === 'string') {
    out(result);
    return;
  }

  // Secrets are masked by default. A raw endpoint can return a token, and printing it
  // puts a live credential in scrollback and in whatever captured the terminal.
  // `--reveal` is an explicit, visible decision.
  const reveal = bool(args.flags, 'reveal');
  const shaped = str(args.flags, 'fields')
    ? pick(result, str(args.flags, 'fields')!.split(',').map((f) => f.trim()).filter(Boolean))
    : result;
  const safe = reveal ? shaped : redact(shaped);

  // `--raw` prints one line, which pipes into jq more cheaply for large responses.
  if (bool(args.flags, 'raw')) out(JSON.stringify(safe));
  else json(safe);
}
