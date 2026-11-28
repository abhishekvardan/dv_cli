/**
 * Thompson sampling over (project × format) arms.
 *
 * Each arm keeps a Beta(α, β) belief about its reward. A scored video with reward r
 * adds r to α and 1 - r to β. To fill a slot, every arm draws from its Beta and the
 * highest draw wins: arms that did well win often, arms with little data are uncertain
 * and still win sometimes. That uncertainty is the exploration.
 */

import { FORMATS, type Catalog, type Kind } from './catalog.js';
import { notScoredReason, reward } from './reward.js';

export interface Arm {
  project: string;
  format: string;
  alpha: number;
  beta: number;
  /** Scored videos behind this arm. */
  n: number;
  /** Mean reward of those videos, or undefined with none. */
  mean?: number;
}

export interface Slot {
  arm: Arm;
  draw: number;
  why: string;
}

export interface Plan {
  kind: Kind;
  slots: Slot[];
  arms: Arm[];
  scored: number;
  skipped: { videoId: string; title: string; reason: string }[];
  exploring: boolean;
}

/** Small, seedable PRNG (mulberry32) so plans are reproducible in tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Marsaglia–Tsang gamma sampler. */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) return gamma(shape + 1, rand) * Math.pow(Math.max(rand(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rand: () => number): number {
  const x = gamma(alpha, rand);
  const y = gamma(beta, rand);
  return x / (x + y);
}

const key = (project: string, format: string) => `${project}\u0000${format}`;

/** Build every arm's belief from the catalog. Extra projects become untried arms. */
export function buildArms(cat: Catalog, kind: Kind, extraProjects: string[] = [], now = new Date()) {
  const arms = new Map<string, Arm>();
  const skipped: Plan['skipped'] = [];
  const projects = new Set(extraProjects);
  const videos = Object.values(cat.videos).filter((v) => v.kind === kind);
  for (const v of videos) projects.add(v.project);
  for (const p of projects) for (const f of FORMATS) arms.set(key(p, f), { project: p, format: f, alpha: 1, beta: 1, n: 0 });

  let scored = 0;
  const sums = new Map<string, number>();
  for (const v of videos) {
    const why = notScoredReason(v, now);
    if (why) {
      skipped.push({ videoId: v.videoId, title: v.title, reason: why });
      continue;
    }
    const r = reward(v.stats!, kind);
    const arm = arms.get(key(v.project, v.format))!;
    arm.alpha += r;
    arm.beta += 1 - r;
    arm.n += 1;
    sums.set(key(v.project, v.format), (sums.get(key(v.project, v.format)) ?? 0) + r);
    scored++;
  }
  for (const [k, s] of sums) {
    const arm = arms.get(k)!;
    arm.mean = s / arm.n;
  }
  return { arms: [...arms.values()], skipped, scored };
}

/**
 * Fill `slots` picks. After an arm is picked it gets a pending half-failure, so one lucky
 * arm cannot take the whole week on a single good video.
 */
export function plan(
  cat: Catalog,
  opts: { kind: Kind; slots: number; projects?: string[]; seed?: number; now?: Date },
): Plan {
  const { arms, skipped, scored } = buildArms(cat, opts.kind, opts.projects ?? [], opts.now);
  const rand = rng(opts.seed ?? Date.now());
  const pending = new Map<Arm, number>();
  const slots: Slot[] = [];
  if (arms.length === 0) return { kind: opts.kind, slots, arms, scored, skipped, exploring: true };

  for (let i = 0; i < opts.slots; i++) {
    let best: Arm | undefined;
    let bestDraw = -1;
    for (const arm of arms) {
      const d = sampleBeta(arm.alpha, arm.beta + (pending.get(arm) ?? 0), rand);
      if (d > bestDraw) {
        bestDraw = d;
        best = arm;
      }
    }
    pending.set(best!, (pending.get(best!) ?? 0) + 0.5);
    const why =
      best!.n === 0
        ? 'untried: exploring'
        : `${best!.n} video${best!.n === 1 ? '' : 's'}, mean reward ${best!.mean!.toFixed(2)}`;
    slots.push({ arm: best!, draw: bestDraw, why });
  }
  return { kind: opts.kind, slots, arms, scored, skipped, exploring: scored < 5 };
}
