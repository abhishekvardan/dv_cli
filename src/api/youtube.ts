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
    throw new ProviderError(
      'The YouTube Data API is not enabled on your Google Cloud project.',
      res.status,
      'Enable "YouTube Data API v3" at https://console.cloud.google.com/apis/library/youtube.googleapis.com\n' +
        '(same project as dv\'s Google OAuth client), wait a minute, then retry.',
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
