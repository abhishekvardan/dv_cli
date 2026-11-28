/**
 * What each upload *is* (project, format, short or long) and the last numbers seen for it.
 *
 * YouTube knows views; only we know that a video was "a dv tutorial". The learning
 * planner needs both, so they live together in ~/.dv/youtube.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dvHome } from '../config/paths.js';

export const FORMATS = ['tutorial', 'problem-solution', 'explainer', 'build-log', 'tip', 'launch'] as const;
export type Format = (typeof FORMATS)[number];
export type Kind = 'short' | 'long';

export interface VideoStats {
  views: number;
  minutesWatched: number;
  avgViewDuration: number;
  /** 0..100 (YouTube's averageViewPercentage). */
  avgViewPct: number;
  likes: number;
  shares: number;
  comments: number;
  subscribersGained: number;
  /** From the reach report; absent until it has data. */
  impressions?: number;
  /** 0..1 */
  ctr?: number;
  at: string;
}

export interface CatalogEntry {
  videoId: string;
  title: string;
  project: string;
  format: Format;
  kind: Kind;
  publishAt?: string;
  uploadedAt: string;
  stats?: VideoStats;
}

export interface Catalog {
  videos: Record<string, CatalogEntry>;
  reachJobId?: string;
}

export function catalogPath(): string {
  return join(dvHome(), 'youtube.json');
}

export function loadCatalog(): Catalog {
  try {
    const raw = JSON.parse(readFileSync(catalogPath(), 'utf8'));
    return { videos: raw.videos ?? {}, reachJobId: raw.reachJobId };
  } catch {
    return { videos: {} };
  }
}

export function saveCatalog(cat: Catalog): void {
  const home = dvHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = catalogPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cat, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported everywhere */
  }
}

export function isFormat(v: string): v is Format {
  return (FORMATS as readonly string[]).includes(v);
}

export function tagVideo(cat: Catalog, entry: Omit<CatalogEntry, 'uploadedAt'> & { uploadedAt?: string }): CatalogEntry {
  const prev = cat.videos[entry.videoId];
  const next: CatalogEntry = {
    ...prev,
    ...entry,
    uploadedAt: entry.uploadedAt ?? prev?.uploadedAt ?? new Date().toISOString(),
  };
  cat.videos[entry.videoId] = next;
  return next;
}
