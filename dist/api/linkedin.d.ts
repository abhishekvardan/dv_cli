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
export declare const linkedin: {
    /** Identity via OpenID Connect. The only profile endpoint open to every app. */
    me(): Promise<LinkedInMe>;
    /**
     * Post text, optionally with a link.
     *
     * The author URN comes from `/v2/userinfo`; there is no way to post without knowing
     * it, and it must be `urn:li:person:{sub}`.
     */
    share(input: {
        text: string;
        url?: string;
        urlTitle?: string;
        visibility?: "PUBLIC" | "CONNECTIONS";
    }): Promise<{
        id: string | undefined;
        url: string | undefined;
    }>;
};
