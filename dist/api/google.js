/**
 * Gmail and Calendar.
 *
 * 401 and 403 are kept apart throughout. A 401 means the access token is stale and
 * refreshing fixes it; a 403 means the *grant* lacks a scope, and refreshing forever
 * will never help — the user has to log in again and approve more. Collapsing the two
 * into "auth error" is what makes an integration feel randomly broken.
 */
import { AuthError, ProviderError } from '../cli/errors.js';
import { accessToken } from '../auth/tokens.js';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
async function call(url, init = {}, retried = false) {
    const token = await accessToken('google', { force: retried });
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers ?? {}),
        },
    });
    if (res.status === 401 && !retried) {
        // The stored expiry can be wrong — a clock adjustment, or a token revoked early.
        // One forced refresh distinguishes a stale token from a dead grant.
        return call(url, init, true);
    }
    if (res.status === 401) {
        throw new AuthError('Google rejected the credential.', 'dv auth login google');
    }
    if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        const reason = body?.error?.message ?? 'insufficient permission';
        throw new ProviderError(`Google refused: ${reason}`, 403, 'The grant is probably missing a scope. Run `dv auth login google` and approve everything requested.');
    }
    if (res.status === 429) {
        throw new ProviderError('Google is rate limiting requests. Try again shortly.', 429);
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ProviderError(`Google ${res.status}: ${body?.error?.message ?? res.statusText}`, res.status);
    }
    return res.status === 204 ? null : res.json();
}
const header = (msg, name) => msg?.payload?.headers?.find((h) => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
/** Depth-first walk for the readable body, preferring plain text. */
function bodyText(payload) {
    let html = '';
    let plain = '';
    const walk = (p) => {
        if (!p)
            return;
        if (Array.isArray(p.parts))
            return p.parts.forEach(walk);
        const data = p.body?.data;
        if (!data)
            return;
        const text = Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (p.mimeType === 'text/html')
            html += text;
        else if (p.mimeType === 'text/plain')
            plain += text;
    };
    walk(payload);
    return plain || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
export const gmail = {
    async profile() {
        return call(`${GMAIL}/profile`);
    },
    /**
     * Search, returning summaries.
     *
     * Metadata format only: the list gives ids, and pulling `format=full` for every hit
     * would download every body just to show a subject line.
     */
    async search(query, limit = 20) {
        const list = await call(`${GMAIL}/messages?maxResults=${Math.min(limit, 100)}&q=${encodeURIComponent(query)}`);
        const ids = (list.messages ?? []).map((m) => m.id);
        const params = new URLSearchParams({ format: 'metadata' });
        for (const h of ['Subject', 'From', 'To', 'Date'])
            params.append('metadataHeaders', h);
        const messages = await Promise.all(ids.map(async (id) => {
            const msg = await call(`${GMAIL}/messages/${id}?${params}`);
            const labels = msg.labelIds ?? [];
            const internal = Number(msg.internalDate);
            return {
                id: msg.id,
                threadId: msg.threadId,
                from: header(msg, 'From'),
                to: header(msg, 'To'),
                subject: header(msg, 'Subject') || '(no subject)',
                // internalDate is Gmail's own receipt time. The Date header is written by
                // the sending client and is routinely wrong.
                date: Number.isFinite(internal) ? new Date(internal).toISOString() : header(msg, 'Date'),
                snippet: msg.snippet ?? '',
                unread: labels.includes('UNREAD'),
                starred: labels.includes('STARRED'),
                important: labels.includes('IMPORTANT'),
            };
        }));
        return messages;
    },
    async read(id) {
        const msg = await call(`${GMAIL}/messages/${id}?format=full`);
        return {
            id: msg.id,
            threadId: msg.threadId,
            from: header(msg, 'From'),
            to: header(msg, 'To'),
            cc: header(msg, 'Cc'),
            subject: header(msg, 'Subject') || '(no subject)',
            date: header(msg, 'Date'),
            labels: msg.labelIds ?? [],
            body: bodyText(msg.payload),
        };
    },
    async labels() {
        const data = await call(`${GMAIL}/labels`);
        return data.labels ?? [];
    },
    /**
     * Send a message.
     *
     * RFC 2822 assembled here and base64url encoded — Gmail's `messages/send` takes a
     * raw message, not fields. Standard base64 is rejected: `+` and `/` are not valid
     * in the `raw` parameter.
     */
    async send(input) {
        const lines = [
            `To: ${input.to}`,
            input.cc ? `Cc: ${input.cc}` : null,
            input.replyTo ? `Reply-To: ${input.replyTo}` : null,
            `Subject: ${input.subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset="UTF-8"',
            '',
            input.body,
        ].filter((l) => l !== null);
        const raw = Buffer.from(lines.join('\r\n'), 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        return call(`${GMAIL}/messages/send`, { method: 'POST', body: JSON.stringify({ raw }) });
    },
    async modify(id, add = [], remove = []) {
        return call(`${GMAIL}/messages/${id}/modify`, {
            method: 'POST',
            body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
        });
    },
};
function normalizeEvent(e) {
    const allDay = Boolean(e.start?.date && !e.start?.dateTime);
    return {
        id: e.id,
        summary: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date ?? '',
        end: e.end?.dateTime ?? e.end?.date ?? '',
        allDay,
        location: e.location,
        attendees: e.attendees?.length ?? 0,
        htmlLink: e.htmlLink,
    };
}
export const calendar = {
    async events(opts = {}) {
        const days = opts.days ?? 7;
        const id = encodeURIComponent(opts.calendarId ?? 'primary');
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
        const data = await call(`${CALENDAR}/calendars/${id}/events?timeMin=${timeMin}&timeMax=${timeMax}` +
            `&maxResults=${Math.min(opts.limit ?? 25, 250)}&singleEvents=true&orderBy=startTime`);
        return (data.items ?? []).map(normalizeEvent);
    },
    async create(input) {
        const id = encodeURIComponent(input.calendarId ?? 'primary');
        const event = await call(`${CALENDAR}/calendars/${id}/events`, {
            method: 'POST',
            body: JSON.stringify({
                summary: input.summary,
                description: input.description,
                location: input.location,
                start: { dateTime: new Date(input.start).toISOString() },
                end: { dateTime: new Date(input.end).toISOString() },
                attendees: input.attendees?.map((email) => ({ email })),
            }),
        });
        return normalizeEvent(event);
    },
    async delete(eventId, calendarId = 'primary') {
        await call(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
            method: 'DELETE',
        });
    },
    /**
     * Free gaps within working hours.
     *
     * All-day entries block the whole day; treating them as zero-length would report a
     * day as free when it is not. Events marked `transparent` ("free" in the UI) are
     * ignored, which is what that flag means.
     */
    async freeSlots(opts = {}) {
        const days = opts.days ?? 5;
        const minMs = (opts.minMinutes ?? 30) * 60_000;
        const startHour = opts.startHour ?? 9;
        const endHour = Math.max(opts.endHour ?? 18, startHour + 1);
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
        const data = await call(`${CALENDAR}/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}` +
            `&maxResults=250&singleEvents=true&orderBy=startTime`);
        const busy = (data.items ?? [])
            .filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent')
            .map((e) => {
            const s = new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00`);
            const en = new Date(e.end?.dateTime ?? `${e.end?.date ?? e.start?.date}T23:59:59`);
            return { start: s.getTime(), end: en.getTime() };
        })
            .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end))
            .sort((a, b) => a.start - b.start);
        const slots = [];
        for (let d = 0; d < days; d++) {
            const day = new Date();
            day.setDate(day.getDate() + d);
            const from = new Date(day);
            from.setHours(startHour, 0, 0, 0);
            const to = new Date(day);
            to.setHours(endHour, 0, 0, 0);
            // Never offer a slot in the past.
            let cursor = Math.max(from.getTime(), Date.now());
            const limit = to.getTime();
            for (const b of busy) {
                if (b.end <= cursor || b.start >= limit)
                    continue;
                if (b.start - cursor >= minMs) {
                    slots.push({
                        start: new Date(cursor).toISOString(),
                        end: new Date(b.start).toISOString(),
                        minutes: Math.round((b.start - cursor) / 60_000),
                    });
                }
                cursor = Math.max(cursor, b.end);
            }
            if (limit - cursor >= minMs) {
                slots.push({
                    start: new Date(cursor).toISOString(),
                    end: new Date(limit).toISOString(),
                    minutes: Math.round((limit - cursor) / 60_000),
                });
            }
        }
        return slots;
    },
};
export const googleUserinfo = () => call('https://www.googleapis.com/oauth2/v3/userinfo');
//# sourceMappingURL=google.js.map