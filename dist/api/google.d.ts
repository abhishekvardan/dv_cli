/**
 * Gmail and Calendar.
 *
 * 401 and 403 are kept apart throughout. A 401 means the access token is stale and
 * refreshing fixes it; a 403 means the *grant* lacks a scope, and refreshing forever
 * will never help — the user has to log in again and approve more. Collapsing the two
 * into "auth error" is what makes an integration feel randomly broken.
 */
export interface MailSummary {
    id: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    snippet: string;
    unread: boolean;
    starred: boolean;
    important: boolean;
}
export declare const gmail: {
    profile(): Promise<any>;
    /**
     * Search, returning summaries.
     *
     * Metadata format only: the list gives ids, and pulling `format=full` for every hit
     * would download every body just to show a subject line.
     */
    search(query: string, limit?: number): Promise<MailSummary[]>;
    read(id: string): Promise<{
        id: any;
        threadId: any;
        from: string;
        to: string;
        cc: string;
        subject: string;
        date: string;
        labels: any;
        body: string;
    }>;
    labels(): Promise<any>;
    /**
     * Send a message.
     *
     * RFC 2822 assembled here and base64url encoded — Gmail's `messages/send` takes a
     * raw message, not fields. Standard base64 is rejected: `+` and `/` are not valid
     * in the `raw` parameter.
     */
    send(input: {
        to: string;
        subject: string;
        body: string;
        cc?: string;
        replyTo?: string;
    }): Promise<any>;
    modify(id: string, add?: string[], remove?: string[]): Promise<any>;
};
export interface CalEvent {
    id: string;
    summary: string;
    start: string;
    end: string;
    allDay: boolean;
    location?: string;
    attendees: number;
    htmlLink?: string;
}
export declare const calendar: {
    events(opts?: {
        days?: number;
        limit?: number;
        calendarId?: string;
    }): Promise<CalEvent[]>;
    create(input: {
        summary: string;
        start: string;
        end: string;
        description?: string;
        location?: string;
        attendees?: string[];
        calendarId?: string;
    }): Promise<CalEvent>;
    delete(eventId: string, calendarId?: string): Promise<void>;
    /**
     * Free gaps within working hours.
     *
     * All-day entries block the whole day; treating them as zero-length would report a
     * day as free when it is not. Events marked `transparent` ("free" in the UI) are
     * ignored, which is what that flag means.
     */
    freeSlots(opts?: {
        days?: number;
        minMinutes?: number;
        startHour?: number;
        endHour?: number;
    }): Promise<{
        start: string;
        end: string;
        minutes: number;
    }[]>;
};
export declare const googleUserinfo: () => Promise<any>;
