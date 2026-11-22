/**
 * The vault exists for one reason: a secret captured so it can be restored must not end
 * up somewhere that gets printed. The last test here is the one that matters.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dropSecret, retrieveSecret, stashSecret } from '../src/cli/vault.js';
import { record, readJournal } from '../src/cli/journal.js';
import { redact } from '../src/cli/output.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dv-vault-'));
  process.env.DV_HOME = home;
});

afterEach(() => {
  delete process.env.DV_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('stashing a value', () => {
  it('round-trips through an opaque handle', () => {
    const ref = stashSecret('re_9Kd2LmQp7xVn4TbW');
    expect(ref).toMatch(/^s_/);
    expect(retrieveSecret(ref)).toBe('re_9Kd2LmQp7xVn4TbW');
  });

  it('does not put the value in the handle', () => {
    const ref = stashSecret('super-secret-value');
    expect(ref).not.toContain('super-secret');
  });

  it('gives different handles to identical values', () => {
    expect(stashSecret('same')).not.toBe(stashSecret('same'));
  });

  it('forgets a value once dropped', () => {
    const ref = stashSecret('temporary');
    dropSecret(ref);
    expect(retrieveSecret(ref)).toBeUndefined();
  });

  it('returns undefined for an unknown handle rather than an empty string', () => {
    // The caller must be able to tell "gone" from "was empty" — restoring a variable as
    // blank would be worse than leaving it missing.
    expect(retrieveSecret('s_nothing')).toBeUndefined();
  });

  it('expires old values instead of keeping them forever', () => {
    const ref = stashSecret('old');
    const path = join(home, 'undo-secrets.json');
    const entries = JSON.parse(readFileSync(path, 'utf8'));
    entries[ref].at = Date.now() - 15 * 24 * 60 * 60 * 1000;
    writeFileSync(path, JSON.stringify(entries));

    expect(retrieveSecret(ref)).toBeUndefined();
  });
});

describe('the journal never carries a secret', () => {
  it('records a handle, so printing the journal cannot disclose the value', () => {
    const secret = 're_9Kd2LmQp7xVn4TbW';
    const ref = stashSecret(secret);

    record({
      command: 'vercel env rm',
      provider: 'vercel',
      summary: 'Removed RESEND_API_KEY from college-lms',
      undo: {
        kind: 'vercel.env.restore',
        args: { projectId: 'college-lms', key: 'RESEND_API_KEY', valueRef: ref },
        describe: 'Recreate RESEND_API_KEY on college-lms',
      },
    });

    // Everything a person or a script can get out of the journal, checked against the
    // raw secret. Redaction alone would not catch this: the key is `value`, which is not
    // a secret-looking name, and an API key like `re_…` matches no known token shape.
    const onDisk = readFileSync(join(home, 'journal.jsonl'), 'utf8');
    expect(onDisk).not.toContain(secret);

    const printed = JSON.stringify(redact(readJournal()));
    expect(printed).not.toContain(secret);

    // And the handle is there, so the undo still works.
    expect(printed).toContain(ref);
  });
});
