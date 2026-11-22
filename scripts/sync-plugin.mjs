#!/usr/bin/env node
/**
 * Keep the Claude Code plugin in step with the package.
 *
 * The plugin ships its own copy of SKILL.md (a plugin is installed from git, not from
 * npm, so it cannot reach the package's copy) and states a version in two places. Both
 * drift the moment the package changes, so they are copied rather than edited by hand.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const skillTarget = join(root, 'plugin', 'skills', 'dv', 'SKILL.md');
mkdirSync(dirname(skillTarget), { recursive: true });
copyFileSync(join(root, 'SKILL.md'), skillTarget);

function setVersion(file, apply) {
  const path = join(root, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  apply(data);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

setVersion('plugin/.claude-plugin/plugin.json', (d) => {
  d.version = version;
});
setVersion('.claude-plugin/marketplace.json', (d) => {
  for (const plugin of d.plugins) if (plugin.name === 'dv') plugin.version = version;
});

process.stderr.write(`plugin synced to ${version}\n`);
