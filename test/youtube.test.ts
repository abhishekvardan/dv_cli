import { describe, expect, it } from 'vitest';

import { mimeFor, videoResource } from '../src/api/youtube.js';
import { parseWhen, YT_SCOPES } from '../src/commands/youtube.js';
import { BUILT_IN } from '../src/auth/providers.js';
import { UsageError } from '../src/cli/errors.js';

describe('videoResource', () => {
  it('forces private and sets publishAt when scheduled', () => {
    const r = videoResource({ file: 'a.mp4', title: 'T', privacy: 'public', publishAt: '2026-11-29T12:30:00Z' });
    expect(r.status.privacyStatus).toBe('private');
    expect(r.status.publishAt).toBe('2026-11-29T12:30:00.000Z');
  });

  it('keeps the requested privacy without a schedule, defaults category and kids flag', () => {
    const r = videoResource({ file: 'a.mp4', title: 'T', privacy: 'unlisted' });
    expect(r.status.privacyStatus).toBe('unlisted');
    expect(r.status.publishAt).toBeUndefined();
    expect(r.status.selfDeclaredMadeForKids).toBe(false);
    expect(r.snippet.categoryId).toBe('28');
    expect(r.snippet.tags).toBeUndefined();
  });

  it('passes tags and description through', () => {
    const r = videoResource({ file: 'a.mp4', title: 'T', description: 'D', tags: ['x', 'y'], privacy: 'private' });
    expect(r.snippet.description).toBe('D');
    expect(r.snippet.tags).toEqual(['x', 'y']);
  });
});

describe('parseWhen', () => {
  const now = new Date('2026-11-28T00:00:00Z');

  it('reads "YYYY-MM-DD HH:MM" as local time', () => {
    const d = parseWhen('2026-11-29 18:00', now);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(29);
    expect(d.getHours()).toBe(18);
  });

  it('reads full ISO with an offset', () => {
    expect(parseWhen('2026-11-29T12:30:00Z', now).toISOString()).toBe('2026-11-29T12:30:00.000Z');
  });

  it('rejects the past and garbage', () => {
    expect(() => parseWhen('2026-11-27 10:00', now)).toThrow(UsageError);
    expect(() => parseWhen('tomorrowish', now)).toThrow(UsageError);
  });
});

describe('youtube wiring', () => {
  it('the Google login asks for every scope the yt commands check', () => {
    for (const s of YT_SCOPES) expect(BUILT_IN.google!.scopes).toContain(s);
  });

  it('maps file types', () => {
    expect(mimeFor('v.MP4')).toBe('video/mp4');
    expect(mimeFor('t.jpg')).toBe('image/jpeg');
    expect(mimeFor('x.bin')).toBe('application/octet-stream');
  });
});
