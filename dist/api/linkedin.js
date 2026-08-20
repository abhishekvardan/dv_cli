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
import { AuthError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';
const BASE = 'https://api.linkedin.com';
async function call(path, init = {}) {
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
        const body = await res.json().catch(() => ({}));
        throw new ProviderError(`LinkedIn refused: ${body?.message ?? 'insufficient permission'}`, 403, 'Most profile and feed fields need a partner-tier agreement. `dv li me` shows what the standard tier can read.');
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ProviderError(`LinkedIn ${res.status}: ${body?.message ?? res.statusText}`, res.status);
    }
    return res.status === 204 ? null : res.json();
}
export const linkedin = {
    /** Identity via OpenID Connect. The only profile endpoint open to every app. */
    async me() {
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
    async share(input) {
        const me = await this.me();
        const author = `urn:li:person:${me.sub}`;
        const body = {
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
            throw new ProviderError('LinkedIn refused the post.', 403, 'Posting needs the `w_member_social` scope. Run `dv auth login linkedin` and approve it.');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new ProviderError(`LinkedIn ${res.status}: ${err?.message ?? res.statusText}`, res.status);
        }
        // The post id comes back in a header, not the body.
        const id = res.headers.get('x-restli-id') ?? undefined;
        return {
            id,
            url: id ? `https://www.linkedin.com/feed/update/${id}` : undefined,
        };
    },
};
//# sourceMappingURL=linkedin.js.map