#!/usr/bin/env node
/**
 * Start the dv MCP server for the Claude Code plugin.
 *
 * dv by Abhishek Vardan Botta.
 *
 * A launcher rather than `"command": "dv"` because neither obvious choice works
 * everywhere: on Windows a bare `dv` or `npx` is a `.cmd` shim that cannot be spawned
 * without a shell, and `npx` on every start is slow. So, in order:
 *
 *  1. DV_MCP_ENTRY, if set — a dist/index.js to run, for developing dv itself.
 *  2. A globally installed dv (`npm install -g @abhishekvardanbotta/dv`). Preferred: it is
 *     the same dv the user's terminal runs, logins and all.
 *  3. `npx -y @abhishekvardanbotta/dv@latest`, so the plugin works with nothing installed.
 *
 * Writes nothing to stdout itself — stdout belongs to the MCP protocol.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = '@abhishekvardanbotta/dv';

function globalEntry() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const entry = join(root, ...PACKAGE.split('/'), 'dist', 'index.js');
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

const entry = process.env.DV_MCP_ENTRY || globalEntry();

const child = entry
  ? spawn(process.execPath, [entry, 'mcp'], { stdio: 'inherit' })
  : spawn('npx', ['-y', `${PACKAGE}@latest`, 'mcp'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

child.on('error', (err) => {
  process.stderr.write(`dv plugin: could not start the dv MCP server: ${err.message}\n`);
  process.stderr.write(`Install it with: npm install -g ${PACKAGE}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Forward a shutdown from the client to the server.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
