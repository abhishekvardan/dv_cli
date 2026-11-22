/**
 * Adding an account from an MCP client, without the secret passing through it.
 *
 * Whatever a tool receives is part of the conversation: a token typed into the chat is
 * stored in its history and sent to the model. So the tool does not take one. It opens
 * a terminal window on the user's own screen running the ordinary `dv auth login`, where
 * a pasted token is read with echo off and a browser sign-in happens in the browser. The
 * client is told only that the window was opened, and checks the result afterwards with
 * the accounts tool.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getProvider, resolveApp } from '../auth/providers.js';
import { openBrowser } from '../auth/loopback.js';
import { launchSpec } from './install.js';

export interface AddAccountPlan {
  argv: string[];
  /** A sign-in in the browser rather than a pasted token. */
  browser: boolean;
  /** Where to create a token, opened alongside the terminal for token sign-ins. */
  tokenPage?: string;
}

/** Decide how this provider can be signed in to, from what is configured. */
export function planAddAccount(providerId: string, nickname?: string): AddAccountPlan {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);
  const app = resolveApp(providerId);
  const browser =
    provider.methods.some((m) => m === 'device' || m === 'loopback')
    && Boolean(app.clientId)
    && !(provider.needsClientSecret && !app.clientSecret);

  const argv = ['auth', 'login', providerId];
  // Without an OAuth app the only way in is a token. Saying so up front skips a menu
  // whose other options would all fail.
  if (!browser && provider.methods.includes('token')) argv.push('--method', 'token');
  if (nickname) argv.push('--as', nickname);

  let tokenPage = provider.appSetupUrl;
  if (providerId === 'github') {
    // Pre-filled with the scopes dv uses, so the user only has to press Generate.
    tokenPage = `https://github.com/settings/tokens/new?description=dv&scopes=${provider.scopes.join(',')}`;
  }
  return { argv, browser, tokenPage: browser ? undefined : tokenPage };
}

/** Quote for a .cmd script line. */
const cmdQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** Quote for a POSIX shell script line. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Open a new terminal window running `dv <argv>`.
 *
 * A script file rather than a command line: nesting quotes through `start`, `cmd /k`
 * and a path with spaces in it is where this kind of thing breaks, and a script has
 * none of that. Returns false when no terminal could be opened.
 */
export function openTerminal(argv: string[], title: string): boolean {
  const spec = launchSpec();
  // The same dv the client launched, minus the trailing `mcp`.
  const base = [spec.command, ...spec.args.slice(0, -1)];
  const dir = mkdtempSync(join(tmpdir(), 'dv-signin-'));

  try {
    if (process.platform === 'win32') {
      const script = join(dir, 'dv-signin.cmd');
      writeFileSync(
        script,
        [
          '@echo off',
          `title ${title.replace(/[&|<>^]/g, '')}`,
          [...base, ...argv].map(cmdQuote).join(' '),
          'echo.',
          'echo You can close this window.',
          'pause >nul',
        ].join('\r\n'),
      );
      // Verbatim, so `start` sees an empty title and then the quoted script path exactly.
      spawn('cmd.exe', ['/c', 'start', '""', `"${script}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
      return true;
    }

    const script = join(dir, 'dv-signin.command');
    writeFileSync(
      script,
      ['#!/bin/sh', [...base, ...argv].map(shQuote).join(' '), 'echo', 'echo "You can close this window."', 'read _'].join('\n'),
    );
    chmodSync(script, 0o755);

    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    for (const [cmd, args] of [
      ['x-terminal-emulator', ['-e', script]],
      ['gnome-terminal', ['--', script]],
      ['konsole', ['-e', script]],
      ['xterm', ['-e', script]],
    ] as const) {
      try {
        const child = spawn(cmd, [...args], { detached: true, stdio: 'ignore' });
        child.on('error', () => undefined);
        child.unref();
        if (child.pid) return true;
      } catch {
        // try the next one
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Open the sign-in window, and the token page when a token is what is needed. */
export function startAddAccount(providerId: string, nickname?: string): { plan: AddAccountPlan; opened: boolean } {
  const plan = planAddAccount(providerId, nickname);
  const label = getProvider(providerId)?.label ?? providerId;
  const opened = openTerminal(plan.argv, `dv - add a ${label} account`);
  if (opened && plan.tokenPage) openBrowser(plan.tokenPage);
  return { plan, opened };
}
