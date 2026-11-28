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

import { analyticsRows, parseReachCsv } from '../src/api/youtube.js';
import { reward, rewardParts, notScoredReason } from '../src/youtube/reward.js';
import { buildArms, plan, rng, sampleBeta } from '../src/youtube/bandit.js';
import { YT_ANALYTICS_SCOPE } from '../src/commands/youtube.js';
import type { Catalog, VideoStats } from '../src/youtube/catalog.js';

const stats = (o: Partial<VideoStats> = {}): VideoStats => ({
  views: 1000, minutesWatched: 0, avgViewDuration: 0, avgViewPct: 45, likes: 30, shares: 5, comments: 5,
  subscribersGained: 4, at: '2026-12-10T00:00:00Z', ...o,
});

describe('analytics parsing', () => {
  it('maps columnHeaders and rows into objects', () => {
    const rows = analyticsRows({
      columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'averageViewPercentage' }, { name: 'subscribersGained' }],
      rows: [['abc', 120, 63.5, 3]],
    });
    expect(rows[0]).toMatchObject({ videoId: 'abc', views: 120, avgViewPct: 63.5, subscribersGained: 3, likes: 0 });
  });

  it('combines reach CSV days with impression-weighted CTR', () => {
    const head = 'date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr';
    const r = parseReachCsv([`${head}\n20261201,C,v1,100,0.1\n20261201,C,v2,50,0.02`, `${head}\n20261202,C,v1,300,0.02`]);
    const v1 = r.find((x) => x.videoId === 'v1')!;
    expect(v1.impressions).toBe(400);
    expect(v1.ctr).toBeCloseTo((10 + 6) / 400);
    expect(parseReachCsv(['nonsense'])).toEqual([]);
  });
});

describe('reward', () => {
  it('stays in 0..1 and rises with retention', () => {
    const lo = reward(stats({ avgViewPct: 20 }), 'short');
    const hi = reward(stats({ avgViewPct: 85 }), 'short');
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThan(lo);
  });

  it('hands a missing CTR weight to the other signals for long videos', () => {
    const p = rewardParts(stats(), 'long');
    expect(p.ctr).toBeUndefined();
    const withCtr = reward(stats({ ctr: 0.1 }), 'long');
    const without = reward(stats(), 'long');
    expect(withCtr).not.toBe(without);
    expect(without).toBeGreaterThan(0);
  });

  it('does not score young or barely-watched videos', () => {
    const now = new Date('2026-12-10T00:00:00Z');
    const base = { videoId: 'x', title: 't', project: 'dv', format: 'tutorial' as const, kind: 'short' as const };
    expect(notScoredReason({ ...base, uploadedAt: '2026-12-09T00:00:00Z', stats: stats() }, now)).toMatch(/younger/);
    expect(notScoredReason({ ...base, uploadedAt: '2026-12-01T00:00:00Z', stats: stats({ views: 3 }) }, now)).toMatch(/fewer/);
    expect(notScoredReason({ ...base, uploadedAt: '2026-12-01T00:00:00Z', stats: stats() }, now)).toBeNull();
  });
});

describe('bandit', () => {
  it('samples Beta draws in 0..1 with the right mean', () => {
    const r = rng(7);
    let s = 0;
    for (let i = 0; i < 4000; i++) s += sampleBeta(8, 2, r);
    expect(s / 4000).toBeCloseTo(0.8, 1);
  });

  const now = new Date('2026-12-20T00:00:00Z');
  const cat = (): Catalog => ({
    videos: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `g${i}`,
        { videoId: `g${i}`, title: 'good', project: 'dv', format: 'tutorial', kind: 'short', uploadedAt: '2026-12-01T00:00:00Z',
          stats: stats({ avgViewPct: 88, subscribersGained: 6, likes: 50 }) },
      ]).concat(
        Array.from({ length: 6 }, (_, i) => [
          `b${i}`,
          { videoId: `b${i}`, title: 'weak', project: 'pkgguard', format: 'explainer', kind: 'short', uploadedAt: '2026-12-01T00:00:00Z',
            stats: stats({ avgViewPct: 10, subscribersGained: 0, likes: 0, shares: 0, comments: 0 }) },
        ]),
      ),
    ),
  });

  it('updates beliefs from rewards', () => {
    const { arms, scored } = buildArms(cat(), 'short', [], now);
    expect(scored).toBe(12);
    const good = arms.find((a) => a.project === 'dv' && a.format === 'tutorial')!;
    const weak = arms.find((a) => a.project === 'pkgguard' && a.format === 'explainer')!;
    expect(good.mean!).toBeGreaterThan(weak.mean!);
    expect(good.alpha / (good.alpha + good.beta)).toBeGreaterThan(weak.alpha / (weak.alpha + weak.beta));
  });

  it('is reproducible with a seed and favours the strong arm without taking every slot', () => {
    const a = plan(cat(), { kind: 'short', slots: 7, seed: 42, now });
    const b = plan(cat(), { kind: 'short', slots: 7, seed: 42, now });
    expect(a.slots.map((s) => s.arm.format)).toEqual(b.slots.map((s) => s.arm.format));
    const strong = a.slots.filter((s) => s.arm.project === 'dv' && s.arm.format === 'tutorial').length;
    expect(strong).toBeGreaterThanOrEqual(1);
    expect(strong).toBeLessThan(7);
    expect(a.slots.some((s) => s.arm.project === 'pkgguard' && s.arm.format === 'explainer')).toBe(false);
  });

  it('explores evenly with no data', () => {
    const p = plan({ videos: {} }, { kind: 'short', slots: 7, projects: ['dv', 'pkgguard'], seed: 1, now });
    expect(p.exploring).toBe(true);
    expect(p.slots).toHaveLength(7);
    expect(p.slots.every((s) => s.why.startsWith('untried'))).toBe(true);
  });

  it('the Google login asks for analytics', () => {
    expect(BUILT_IN.google!.scopes).toContain(YT_ANALYTICS_SCOPE);
  });
});
