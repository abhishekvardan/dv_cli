/**
 * One number per video in 0..1: how well it did, judged the same way every time.
 *
 * Each signal is scaled against a fixed anchor rather than against the channel's other
 * videos. With a handful of uploads, relative scaling would call the best of two weak
 * videos a 1.0; fixed anchors keep "good" meaning good.
 */

import type { CatalogEntry, Kind, VideoStats } from './catalog.js';

export interface RewardParts {
  retention: number;
  ctr?: number;
  subs: number;
  engagement: number;
}

/** What counts as excellent, per kind. A value at the anchor scores 1. */
export const ANCHORS: Record<Kind, { retention: number; ctr: number; subsPer1k: number; engagement: number }> = {
  // Shorts are watched in a feed: retention is the signal, thumbnails barely matter.
  short: { retention: 0.9, ctr: 0.1, subsPer1k: 5, engagement: 0.06 },
  long: { retention: 0.6, ctr: 0.1, subsPer1k: 10, engagement: 0.08 },
};

export const WEIGHTS: Record<Kind, { retention: number; ctr: number; subs: number; engagement: number }> = {
  short: { retention: 0.5, ctr: 0, subs: 0.25, engagement: 0.25 },
  long: { retention: 0.35, ctr: 0.3, subs: 0.2, engagement: 0.15 },
};

/** Below this many views the numbers are noise and the video is not scored. */
export const MIN_VIEWS = 20;
/** Numbers settle after a few days; younger videos are not scored. */
export const MIN_AGE_HOURS = 72;

const clamp = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export function rewardParts(s: VideoStats, kind: Kind): RewardParts {
  const a = ANCHORS[kind];
  const views = Math.max(1, s.views);
  return {
    retention: clamp(s.avgViewPct / 100 / a.retention),
    ctr: s.ctr === undefined ? undefined : clamp(s.ctr / a.ctr),
    subs: clamp(((s.subscribersGained / views) * 1000) / a.subsPer1k),
    engagement: clamp((s.likes + s.shares + s.comments) / views / a.engagement),
  };
}

/** Weighted sum; a missing CTR hands its weight to the other signals in proportion. */
export function reward(s: VideoStats, kind: Kind): number {
  const p = rewardParts(s, kind);
  const w = { ...WEIGHTS[kind] };
  if (p.ctr === undefined && w.ctr > 0) {
    const rest = w.retention + w.subs + w.engagement;
    const k = (rest + w.ctr) / rest;
    w.retention *= k;
    w.subs *= k;
    w.engagement *= k;
    w.ctr = 0;
  }
  return clamp(w.retention * p.retention + w.ctr * (p.ctr ?? 0) + w.subs * p.subs + w.engagement * p.engagement);
}

/** Why a video is not scored yet, or null when it is. */
export function notScoredReason(e: CatalogEntry, now = new Date()): string | null {
  if (!e.stats) return 'no stats yet (run dv yt stats)';
  const live = new Date(e.publishAt ?? e.uploadedAt).getTime();
  if (now.getTime() - live < MIN_AGE_HOURS * 3600_000) return `younger than ${MIN_AGE_HOURS} h`;
  if (e.stats.views < MIN_VIEWS) return `fewer than ${MIN_VIEWS} views`;
  return null;
}
