import { describe, expect, it, vi } from 'vitest';

import { explainProviderError, pick, redact, withRetry } from '../src/cli/output.js';

describe('redact', () => {
  it('masks values under secret-looking keys', () => {
    const masked = redact({ name: 'app', access_token: 'ghp_abcdefghijklmnop' }) as any;
    expect(masked.name).toBe('app');
    expect(masked.access_token).not.toContain('abcdefghijklmnop');
  });

  it('masks a credential even under an innocent key name', () => {
    // A token is just a string; the key it arrives under is not always a clue.
    const masked = redact({ value: ['sbp', '_', '0123456789abcdef'.repeat(2), '01234567'].join('') }) as any;
    expect(masked.value).not.toContain('0123456789abcdef');
  });

  it('masks JWTs, which is what most OAuth responses actually contain', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
    expect((redact({ session: jwt }) as any).session).not.toContain('eyJzdWIi');
  });

  it('reaches into nested objects and arrays', () => {
    const masked = redact({ envs: [{ key: 'API', client_secret: 'GOCSPX-supersecret' }] }) as any;
    expect(masked.envs[0].client_secret).not.toContain('supersecret');
    expect(masked.envs[0].key).toBe('API');
  });

  it('leaves ordinary values alone', () => {
    const input = { id: 1, name: 'x', nested: { count: 2 } };
    expect(redact(input)).toEqual(input);
  });

  it('does not recurse forever on a cycle', () => {
    const a: any = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe('pick', () => {
  it('keeps only the requested fields', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('applies element-wise to arrays', () => {
    expect(pick([{ a: 1, b: 2 }, { a: 3, b: 4 }], ['a'])).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('follows dotted paths', () => {
    expect(pick({ link: { repo: 'x', org: 'y' } }, ['link.repo'])).toEqual({ 'link.repo': 'x' });
  });

  it('omits fields that are absent rather than emitting undefined', () => {
    expect(pick({ a: 1 }, ['a', 'missing'])).toEqual({ a: 1 });
  });

  it('returns the value untouched when no fields are given', () => {
    expect(pick({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe('explainProviderError', () => {
  it('finds the message wherever the provider put it', () => {
    expect(explainProviderError({ message: 'Bad credentials' }, 'x')).toBe('Bad credentials');
    expect(explainProviderError({ error: { message: 'Not found' } }, 'x')).toBe('Not found');
    expect(explainProviderError({ error_description: 'expired' }, 'x')).toBe('expired');
    expect(explainProviderError({ error: 'invalid_grant' }, 'x')).toBe('invalid_grant');
    expect(explainProviderError({ errors: [{ message: 'field required' }] }, 'x')).toBe('field required');
  });

  it('falls back when there is nothing usable', () => {
    expect(explainProviderError({}, 'HTTP 500')).toBe('HTTP 500');
    expect(explainProviderError(null, 'HTTP 500')).toBe('HTTP 500');
  });
});

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
      return 'ok';
    });
    expect(await withRetry(fn, { baseMs: 1 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a settled answer', async () => {
    // Retrying a 403 wastes time and rate limit while looking like a hang.
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    await expect(withRetry(fn, { baseMs: 1 })).rejects.toThrow('forbidden');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt limit and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('still down'), { status: 500 });
    });
    await expect(withRetry(fn, { attempts: 2, baseMs: 1 })).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries network errors that carry no status', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      if (++calls === 1) throw new Error('fetch failed');
      return 'ok';
    });
    expect(await withRetry(fn, { baseMs: 1 })).toBe('ok');
  });
});
