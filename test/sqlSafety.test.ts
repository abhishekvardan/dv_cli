import { describe, expect, it } from 'vitest';

import { isReadOnly } from '../src/db/adapter.js';

describe('telling reads from writes', () => {
  it('treats plain selects as reads', () => {
    expect(isReadOnly('select * from tasks')).toBe(true);
    expect(isReadOnly('  SELECT id FROM tasks LIMIT 5')).toBe(true);
    expect(isReadOnly('explain analyze select 1')).toBe(true);
    expect(isReadOnly('show timezone')).toBe(true);
  });

  it('treats every mutating statement as a write', () => {
    for (const sql of [
      'insert into tasks (title) values (1)',
      'update tasks set done = true',
      'delete from tasks',
      'drop table tasks',
      'alter table tasks add column x int',
      'truncate tasks',
      'create index on tasks (id)',
      'grant all on tasks to anon',
    ]) {
      expect(isReadOnly(sql), sql).toBe(false);
    }
  });

  it('catches a write hidden inside a CTE', () => {
    // Starts with `with`, which looks like a read, but deletes rows.
    expect(
      isReadOnly('with gone as (delete from tasks where done returning *) select * from gone'),
    ).toBe(false);
  });

  it('allows a read-only CTE', () => {
    expect(isReadOnly('with recent as (select * from tasks) select * from recent')).toBe(true);
  });

  it('is not fooled by a comment', () => {
    // `--` would make the whole thing look like a comment if comments were not stripped
    // before the check, and a leading comment must not hide the statement after it.
    expect(isReadOnly('-- drop table tasks\nselect 1')).toBe(true);
    expect(isReadOnly('/* harmless */ delete from tasks')).toBe(false);
    expect(isReadOnly('select 1 -- delete from tasks')).toBe(true);
  });

  it('treats an unrecognised statement as a write', () => {
    // Anything not clearly a read is confirmed: the cost of asking about a harmless
    // query is one keystroke, the cost of not asking about a destructive one is data.
    expect(isReadOnly('vacuum full')).toBe(false);
    expect(isReadOnly('call do_something()')).toBe(false);
  });

  it('treats an empty statement as harmless', () => {
    expect(isReadOnly('')).toBe(true);
    expect(isReadOnly('   ')).toBe(true);
    expect(isReadOnly('-- just a comment')).toBe(true);
  });
});
