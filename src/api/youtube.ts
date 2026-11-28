/**
 * YouTube Data API v3: upload (resumable), thumbnails, status, delete.
 *
 * One caveat drives the shape of this module: Google locks every video uploaded through
 * an *unaudited* API project to private, whatever privacyStatus was asked for. A
 * scheduled publishAt on such a video never fires. `status()` reports that lock
 * (status.rejectionReason / the "locked" privacy) so the CLI can say it plainly instead
 * of letting a schedule silently not happen.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { AuthError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';

export type Privacy = 'private' | 'unlisted' | 'public';

export interface UploadInput {
  file: string;
  title: string;
  description?: string;
  tags?: string[];
  /** YouTube category id; 28 is Science & Technology. */
  categoryId?: string;
  privacy: Privacy;
  /** ISO time. Requires privacy "private"; YouTube flips it to public at that moment. */
  publishAt?: string;
  madeForKids?: boolean;
}

export interface VideoStatus {
  id: string;
  title: string;
  privacy: string;
  publishAt?: string;
  uploadStatus?: string;
  rejectionReason?: string;
  failureReason?: string;
  url: string;
  studioUrl: string;
}

async function googleError(res: Response): Promise<never> {
  const body: any = await res.json().catch(() => ({}));
  const err = body?.error;
  const reason = err?.errors?.[0]?.reason ?? '';
  const message = err?.message ?? res.statusText;
  if (res.status === 401) throw new AuthError('Google rejected the credential.', 'dv auth login google');
  if (reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(message)) {
    // The message names the API that is off, e.g. "YouTube Analytics API has not been used in project …".
    const which = /(YouTube [A-Za-z ]*?API(?: v\d)?)/.exec(message)?.[1] ?? 'A YouTube API';
    const host = /apis\/api\/([a-z.]+googleapis\.com)/.exec(message)?.[1] ?? 'youtube.googleapis.com';
    throw new ProviderError(
      `${which} is not enabled on your Google Cloud project.`,
      res.status,
      `Enable it at https://console.cloud.google.com/apis/library/${host}\n` +
        "(same project as dv's Google OAuth client), wait a minute, then retry.",
    );
  }
  if (res.status === 403 && /insufficient|scope/i.test(message + reason)) {
    throw new ProviderError(
      `Google refused: ${message}`,
      403,
      'This login lacks the YouTube scope. Run `dv auth login google` and approve YouTube access.',
    );
  }
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
    throw new ProviderError(`YouTube quota: ${message}`, res.status, 'The daily API quota resets at midnight Pacific time.');
  }
  throw new ProviderError(`YouTube ${res.status}: ${message}${reason ? ` (${reason})` : ''}`, res.status);
}

async function authed(url: string, init: RequestInit = {}): Promise<Response> {
  const go = async (force: boolean) =>
    fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await accessToken('google', { force })}`, ...(init.headers ?? {}) },
    });
  let res = await go(false);
  if (res.status === 401) res = await go(true);
  return res;
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** The request body for videos.insert. Exported for tests. */
export function videoResource(input: UploadInput): any {
  return {
    snippet: {
      title: input.title,
      description: input.description ?? '',
      ...(input.tags?.length ? { tags: input.tags } : {}),
      categoryId: input.categoryId ?? '28',
    },
    status: {
      privacyStatus: input.publishAt ? 'private' : input.privacy,
      ...(input.publishAt ? { publishAt: new Date(input.publishAt).toISOString() } : {}),
      selfDeclaredMadeForKids: input.madeForKids ?? false,
    },
  };
}

function toStatus(v: any): VideoStatus {
  const id = String(v.id);
  return {
    id,
    title: v.snippet?.title ?? '',
    privacy: v.status?.privacyStatus ?? 'unknown',
    publishAt: v.status?.publishAt,
    uploadStatus: v.status?.uploadStatus,
    rejectionReason: v.status?.rejectionReason,
    failureReason: v.status?.failureReason,
    url: `https://youtu.be/${id}`,
    studioUrl: `https://studio.youtube.com/video/${id}/edit`,
  };
}

export const youtube = {
  /** Resumable upload: one POST for the session, one PUT with the bytes. */
  async upload(input: UploadInput): Promise<VideoStatus> {
    const size = statSync(input.file).size;
    const type = mimeFor(input.file);

    const start = await authed(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': type,
      },
      body: JSON.stringify(videoResource(input)),
    });
    if (!start.ok) await googleError(start);
    const session = start.headers.get('location');
    if (!session) throw new ProviderError('YouTube did not return an upload session.', start.status);

    // The session URL carries its own authorisation; the bytes go in one request.
    const put = await fetch(session, {
      method: 'PUT',
      headers: { 'Content-Type': type, 'Content-Length': String(size) },
      body: readFileSync(input.file),
    });
    if (!put.ok) await googleError(put);
    return toStatus(await put.json());
  },

  async setThumbnail(videoId: string, file: string): Promise<void> {
    const res = await authed(`${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
      method: 'POST',
      headers: { 'Content-Type': mimeFor(file) },
      body: readFileSync(file),
    });
    if (!res.ok) await googleError(res);
  },

  async status(videoId: string): Promise<VideoStatus> {
    const res = await authed(`${API}/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`);
    if (!res.ok) await googleError(res);
    const body: any = await res.json();
    const v = body?.items?.[0];
    if (!v) throw new ProviderError(`No video ${videoId} on this channel.`, 404);
    return toStatus(v);
  },

  async channel(): Promise<{ id: string; title: string; handle?: string; subscribers?: string; videos?: string }> {
    const res = await authed(`${API}/channels?part=snippet,statistics&mine=true`);
    if (!res.ok) await googleError(res);
    const c: any = ((await res.json()) as any)?.items?.[0];
    if (!c) throw new ProviderError('This Google account has no YouTube channel.', 404);
    return {
      id: c.id,
      title: c.snippet?.title,
      handle: c.snippet?.customUrl,
      subscribers: c.statistics?.subscriberCount,
      videos: c.statistics?.videoCount,
    };
  },

  async remove(videoId: string): Promise<void> {
    const res = await authed(`${API}/videos?id=${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) await googleError(res);
  },
};

/* ───────────────────────── Analytics (views, retention) ───────────────────────── */

const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const REPORTING = 'https://youtubereporting.googleapis.com/v1';

export const ANALYTICS_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'averageViewPercentage',
  'likes',
  'shares',
  'comments',
  'subscribersGained',
] as const;

export interface VideoAnalytics {
  videoId: string;
  views: number;
  minutesWatched: number;
  avgViewDuration: number;
  avgViewPct: number;
  likes: number;
  shares: number;
  comments: number;
  subscribersGained: number;
}

/** Turn an Analytics API response (columnHeaders + rows) into objects. Exported for tests. */
export function analyticsRows(body: any): VideoAnalytics[] {
  const cols: string[] = (body?.columnHeaders ?? []).map((h: any) => h.name);
  const at = (name: string) => cols.indexOf(name);
  return (body?.rows ?? []).map((r: any[]) => {
    const n = (name: string) => Number(r[at(name)] ?? 0) || 0;
    return {
      videoId: String(r[at('video')]),
      views: n('views'),
      minutesWatched: n('estimatedMinutesWatched'),
      avgViewDuration: n('averageViewDuration'),
      avgViewPct: n('averageViewPercentage'),
      likes: n('likes'),
      shares: n('shares'),
      comments: n('comments'),
      subscribersGained: n('subscribersGained'),
    };
  });
}

export async function videoAnalytics(startDate: string, endDate: string): Promise<VideoAnalytics[]> {
  const q = new URLSearchParams({
    ids: 'channel==MINE',
    startDate,
    endDate,
    dimensions: 'video',
    metrics: ANALYTICS_METRICS.join(','),
    sort: '-views',
    maxResults: '200',
  });
  const res = await authed(`${ANALYTICS}?${q}`);
  if (!res.ok) await googleError(res);
  return analyticsRows(await res.json());
}

/* ───────────────────────── Reach (impressions, CTR) ───────────────────────── */

export const REACH_REPORT = 'channel_reach_basic_a1';

export interface Reach {
  videoId: string;
  impressions: number;
  /** 0..1 */
  ctr: number;
}

/** Parse reach CSVs and combine days per video; CTR is impression-weighted. Exported for tests. */
export function parseReachCsv(csvs: string[]): Reach[] {
  const acc = new Map<string, { imp: number; clicks: number }>();
  for (const csv of csvs) {
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    const head = lines[0]!.split(',');
    const vi = head.indexOf('video_id');
    const ii = head.indexOf('video_thumbnail_impressions');
    const ci = head.indexOf('video_thumbnail_impressions_ctr');
    if (vi < 0 || ii < 0 || ci < 0) continue;
    for (const line of lines.slice(1)) {
      const f = line.split(',');
      const imp = Number(f[ii]) || 0;
      let ctr = Number(f[ci]) || 0;
      // The report states CTR as a fraction; tolerate a percentage too.
      if (ctr > 1) ctr /= 100;
      const a = acc.get(f[vi]!) ?? { imp: 0, clicks: 0 };
      a.imp += imp;
      a.clicks += imp * ctr;
      acc.set(f[vi]!, a);
    }
  }
  return [...acc].map(([videoId, a]) => ({ videoId, impressions: a.imp, ctr: a.imp ? a.clicks / a.imp : 0 }));
}

export const reach = {
  async findJob(): Promise<string | undefined> {
    const res = await authed(`${REPORTING}/jobs`);
    if (!res.ok) await googleError(res);
    const jobs: any[] = ((await res.json()) as any)?.jobs ?? [];
    return jobs.find((j) => j.reportTypeId === REACH_REPORT)?.id;
  },

  async createJob(): Promise<string> {
    const existing = await reach.findJob();
    if (existing) return existing;
    const res = await authed(`${REPORTING}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportTypeId: REACH_REPORT, name: 'dv reach' }),
    });
    if (!res.ok) await googleError(res);
    return String(((await res.json()) as any).id);
  },

  /** Every report the job has produced since `since`, downloaded as CSV text. */
  async download(jobId: string, since?: string): Promise<{ count: number; csvs: string[] }> {
    const q = since ? `?startTimeAtOrAfter=${encodeURIComponent(since)}` : '';
    const res = await authed(`${REPORTING}/jobs/${jobId}/reports${q}`);
    if (!res.ok) await googleError(res);
    const reports: any[] = ((await res.json()) as any)?.reports ?? [];
    const csvs: string[] = [];
    for (const r of reports) {
      const d = await authed(String(r.downloadUrl));
      if (!d.ok) await googleError(d);
      csvs.push(await d.text());
    }
    return { count: reports.length, csvs };
  },
};
