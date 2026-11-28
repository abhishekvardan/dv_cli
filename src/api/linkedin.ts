/**
 * LinkedIn.
 *
 * What LinkedIn's API actually permits, since this is easy to get wrong and the
 * DevOS app previously filled the gap with invented profile data:
 *
 *  - `/v2/userinfo` (OpenID) returns name, picture, locale and email. That is all.
 *  - Headline, connections, and current position are NOT available on the standard
 *    developer tier. `r_basicprofile` gates them and requires a partner agreement.
 *  - Reading your own posts requires `r_member_social`, also partner-gated. Posting
 *    with `w_member_social` is available to everyone.
 *
 * So this client can post and identify you, and cannot read your feed. Anything it
 * cannot get is reported as unavailable rather than filled in.
 */

import { readFileSync } from 'node:fs';

import { AuthError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';

const BASE = 'https://api.linkedin.com';

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken('linkedin');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      // Required on /rest endpoints; harmless on /v2.
      'LinkedIn-Version': '202405',
      'X-Restli-Protocol-Version': '2.0.0',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    throw new AuthError('LinkedIn rejected the credential.', 'dv auth login linkedin');
  }
  if (res.status === 403) {
    const body: any = await res.json().catch(() => ({}));
    throw new ProviderError(
      `LinkedIn refused: ${body?.message ?? 'insufficient permission'}`,
      403,
      'Most profile and feed fields need a partner-tier agreement. `dv li me` shows what the standard tier can read.',
    );
  }
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new ProviderError(`LinkedIn ${res.status}: ${body?.message ?? res.statusText}`, res.status);
  }
  return res.status === 204 ? null : res.json();
}

export interface LinkedInMe {
  sub: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  emailVerified?: boolean;
  picture?: string;
  locale?: string;
  /** Fields the standard tier cannot provide, named so the caller can say so. */
  unavailable: string[];
}

export const linkedin = {
  /** Identity via OpenID Connect. The only profile endpoint open to every app. */
  async me(): Promise<LinkedInMe> {
    const data = await call('/v2/userinfo');
    return {
      sub: data.sub,
      name: data.name,
      givenName: data.given_name,
      familyName: data.family_name,
      email: data.email,
      emailVerified: data.email_verified,
      picture: data.picture,
      locale: typeof data.locale === 'string' ? data.locale : data.locale?.language,
      // Stated explicitly rather than left as suspiciously absent fields.
      unavailable: ['headline', 'connections', 'currentPosition', 'skills', 'posts'],
    };
  },

  /**
   * Post text, optionally with a link.
   *
   * The author URN comes from `/v2/userinfo`; there is no way to post without knowing
   * it, and it must be `urn:li:person:{sub}`.
   */
  async share(input: { text: string; url?: string; urlTitle?: string; visibility?: 'PUBLIC' | 'CONNECTIONS' }) {
    const me = await this.me();
    const author = `urn:li:person:${me.sub}`;

    const body: any = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: input.text },
          shareMediaCategory: input.url ? 'ARTICLE' : 'NONE',
          ...(input.url
            ? {
                media: [
                  {
                    status: 'READY',
                    originalUrl: input.url,
                    ...(input.urlTitle ? { title: { text: input.urlTitle } } : {}),
                  },
                ],
              }
            : {}),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': input.visibility ?? 'PUBLIC',
      },
    };

    const res = await fetch(`${BASE}/v2/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken('linkedin')}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 403) {
      throw new ProviderError(
        'LinkedIn refused the post.',
        403,
        'Posting needs the `w_member_social` scope. Run `dv auth login linkedin` and approve it.',
      );
    }
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      throw new ProviderError(`LinkedIn ${res.status}: ${err?.message ?? res.statusText}`, res.status);
    }

    // The post id comes back in a header, not the body.
    const id = res.headers.get('x-restli-id') ?? undefined;
    return {
      id,
      url: id ? `https://www.linkedin.com/feed/update/${id}` : undefined,
    };
  },

  /**
   * Post text with a native video: register an upload, PUT the bytes, wait until
   * LinkedIn has processed the asset, then publish a VIDEO share that points at it.
   * All of it works with `w_member_social` on the standard tier.
   */
  async shareVideo(input: {
    text: string;
    file: string;
    title?: string;
    visibility?: 'PUBLIC' | 'CONNECTIONS';
    onProgress?: (msg: string) => void;
  }) {
    const me = await this.me();
    const author = `urn:li:person:${me.sub}`;
    const say = input.onProgress ?? (() => {});

    const reg = await call('/v2/assets?action=registerUpload', {
      method: 'POST',
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
          owner: author,
          serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
        },
      }),
    });
    const asset: string = reg?.value?.asset;
    const uploadUrl: string =
      reg?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
    if (!asset || !uploadUrl) throw new ProviderError('LinkedIn did not return an upload slot for the video.', 502);

    say('uploading video…');
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${await accessToken('linkedin')}`, 'Content-Type': 'application/octet-stream' },
      body: readFileSync(input.file),
    });
    if (!put.ok) throw new ProviderError(`LinkedIn video upload failed: ${put.status} ${put.statusText}`, put.status);

    // Processing usually takes seconds to a couple of minutes.
    say('waiting for LinkedIn to process it…');
    const assetId = asset.split(':').pop()!;
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const a = await call(`/v2/assets/${encodeURIComponent(assetId)}`);
      const status = a?.recipes?.[0]?.status;
      if (status === 'AVAILABLE') break;
      if (status === 'PROCESSING_FAILED' || status === 'CLIENT_ERROR') {
        throw new ProviderError(`LinkedIn could not process the video (${status}).`, 502);
      }
      if (Date.now() > deadline) throw new ProviderError('LinkedIn is still processing the video after 10 minutes.', 504);
      await new Promise((r) => setTimeout(r, 5000));
    }

    const body = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: input.text },
          shareMediaCategory: 'VIDEO',
          media: [{ status: 'READY', media: asset, ...(input.title ? { title: { text: input.title } } : {}) }],
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': input.visibility ?? 'PUBLIC' },
    };
    const res = await fetch(`${BASE}/v2/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken('linkedin')}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      throw new ProviderError(`LinkedIn ${res.status}: ${err?.message ?? res.statusText}`, res.status);
    }
    const id = res.headers.get('x-restli-id') ?? undefined;
    return { id, url: id ? `https://www.linkedin.com/feed/update/${id}` : undefined };
  },
};
