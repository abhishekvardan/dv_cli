/**
 * `dv gmail …` and `dv cal …`
 */

import { readFileSync } from 'node:fs';

import { UsageError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { c, confirm, info, json, out, relative, success, table } from '../cli/ui.js';
import { calendar, gmail } from '../api/google.js';
import { missingScopes } from '../auth/tokens.js';

/** `"Name" <a@b.com>` -> `Name`. */
function shortAddress(header: string): string {
  const first = (header ?? '').split(',')[0]?.trim() ?? '';
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(first);
  return (named ? named[1]! : first.replace(/[<>]/g, '')).trim() || '—';
}

export async function gmailCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'search';
  const asJson = bool(args.flags, 'json');
  const arg1 = args.command[2] ?? args.positional[0];

  switch (sub) {
    case 'search':
    case 'ls': {
      // Default to the inbox rather than every message ever, which is what an empty
      // Gmail query means.
      const query = arg1 ?? str(args.flags, 'query', 'q') ?? 'in:inbox';
      const messages = await gmail.search(query, num(args.flags, 'limit', 20));
      if (asJson) return json(messages);
      if (messages.length === 0) return info(`Nothing matched "${query}".`);

      table(messages, [
        { header: '', value: (m) => (m.unread ? c.cyan('●') : ' ') },
        { header: 'from', value: (m) => shortAddress(m.from), max: 24 },
        { header: 'subject', value: (m) => (m.unread ? c.bold(m.subject) : m.subject), max: 56 },
        { header: 'when', value: (m) => relative(m.date) },
        { header: 'id', value: (m) => c.dim(m.id) },
      ]);
      info('');
      info(c.dim(`  dv gmail read <id>`));
      return;
    }

    case 'read': {
      const id = arg1 ?? str(args.flags, 'id');
      if (!id) throw new UsageError('Which message?', 'dv gmail read 18f2a…   (ids come from `dv gmail search`)');
      const msg = await gmail.read(id);
      if (asJson) return json(msg);

      out(c.bold(msg.subject));
      out(`${c.dim('from')} ${msg.from}`);
      out(`${c.dim('to  ')} ${msg.to}`);
      if (msg.cc) out(`${c.dim('cc  ')} ${msg.cc}`);
      out(`${c.dim('date')} ${msg.date}`);
      out('');
      out(msg.body || c.dim('(no text body — the message may be HTML-only or an attachment)'));
      return;
    }

    case 'labels': {
      const labels = await gmail.labels();
      if (asJson) return json(labels);
      table(labels, [
        { header: 'label', value: (l: any) => l.name },
        { header: 'type', value: (l: any) => c.dim(l.type ?? '') },
        { header: 'id', value: (l: any) => c.dim(l.id) },
      ]);
      return;
    }

    case 'send': {
      const to = str(args.flags, 'to');
      const subject = str(args.flags, 'subject', 's');
      const fromFile = str(args.flags, 'file', 'f');
      const bodyFlag = str(args.flags, 'body', 'b');

      if (!to || !subject || (!bodyFlag && !fromFile)) {
        throw new UsageError(
          'Need --to, --subject and either --body or --file.',
          'dv gmail send --to a@b.com --subject "Hi" --body "Hello"',
        );
      }

      // A missing send scope produces a 403 that says nothing useful, so it is
      // checked before the message is composed.
      const missing = missingScopes('google', ['https://www.googleapis.com/auth/gmail.send']);
      if (missing.length > 0) {
        throw new UsageError(
          'This login cannot send mail — the gmail.send scope was not granted.',
          'Run `dv auth login google` and approve sending.',
        );
      }

      const body = fromFile ? readFileSync(fromFile, 'utf8') : bodyFlag!;

      // Sending is outward-facing and cannot be undone.
      out(`${c.dim('to     ')} ${to}`);
      out(`${c.dim('subject')} ${subject}`);
      out(`${c.dim('body   ')} ${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`);
      const ok = await confirm('Send this email?', bool(args.flags, 'yes', 'y'));
      if (!ok) {
        info('Not sent.');
        return;
      }

      const sent = await gmail.send({ to, subject, body, cc: str(args.flags, 'cc') });
      success(`Sent (message ${sent.id}).`);
      return;
    }

    case 'read-later':
    case 'archive': {
      const id = arg1;
      if (!id) throw new UsageError('Which message?', 'dv gmail archive <id>');
      await gmail.modify(id, [], ['INBOX']);
      success('Archived.');
      return;
    }

    case 'star': {
      const id = arg1;
      if (!id) throw new UsageError('Which message?', 'dv gmail star <id>');
      await gmail.modify(id, ['STARRED'], []);
      success('Starred.');
      return;
    }

    case 'profile': {
      const profile = await gmail.profile();
      if (asJson) return json(profile);
      out(`${c.dim('address')} ${profile.emailAddress}`);
      out(`${c.dim('messages')} ${profile.messagesTotal}`);
      out(`${c.dim('threads ')} ${profile.threadsTotal}`);
      return;
    }

    default:
      throw new UsageError(
        `Unknown gmail command "${sub}".`,
        'Try: search, read, send, labels, archive, star, profile',
      );
  }
}

export async function calendarCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'events';
  const asJson = bool(args.flags, 'json');

  switch (sub) {
    case 'events':
    case 'ls': {
      const events = await calendar.events({
        days: num(args.flags, 'days', 7),
        limit: num(args.flags, 'limit', 25),
      });
      if (asJson) return json(events);
      if (events.length === 0) return info('Nothing scheduled in that window.');

      table(events, [
        {
          header: 'when',
          value: (e) =>
            e.allDay
              ? `${e.start} ${c.dim('(all day)')}`
              : new Date(e.start).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                }),
          max: 26,
        },
        { header: 'event', value: (e) => c.bold(e.summary), max: 46 },
        { header: 'where', value: (e) => e.location ?? '', max: 24 },
        { header: 'people', value: (e) => (e.attendees ? String(e.attendees) : ''), align: 'right' },
      ]);
      return;
    }

    case 'free': {
      const slots = await calendar.freeSlots({
        days: num(args.flags, 'days', 5),
        minMinutes: num(args.flags, 'min', 30),
        startHour: num(args.flags, 'start', 9),
        endHour: num(args.flags, 'end', 18),
      });
      if (asJson) return json(slots);
      if (slots.length === 0) return info('No gaps that long in the window.');

      table(slots, [
        {
          header: 'day',
          value: (s) => new Date(s.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        },
        {
          header: 'from',
          value: (s) => new Date(s.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        },
        {
          header: 'to',
          value: (s) => new Date(s.end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        },
        { header: 'length', value: (s) => `${Math.floor(s.minutes / 60)}h ${s.minutes % 60}m`, align: 'right' },
      ]);
      return;
    }

    case 'add': {
      const summary = str(args.flags, 'title', 't') ?? args.command[2] ?? args.positional[0];
      const start = str(args.flags, 'start');
      if (!summary || !start) {
        throw new UsageError(
          'Need a title and --start.',
          'dv cal add --title "Review" --start "2026-08-20T15:00" --minutes 45',
        );
      }
      const minutes = num(args.flags, 'minutes', 30);
      const startDate = new Date(start);
      if (Number.isNaN(startDate.getTime())) {
        throw new UsageError(`Could not read "${start}" as a date.`, 'Try an ISO form: 2026-08-20T15:00');
      }
      const end = str(args.flags, 'end') ?? new Date(startDate.getTime() + minutes * 60_000).toISOString();

      const attendeesFlag = args.flags['attendee'];
      const attendees =
        attendeesFlag === undefined
          ? undefined
          : Array.isArray(attendeesFlag)
            ? attendeesFlag
            : [String(attendeesFlag)];

      // Creating an event may notify other people, so it is confirmed.
      out(`${c.dim('event')} ${summary}`);
      out(`${c.dim('start')} ${startDate.toLocaleString()}`);
      out(`${c.dim('end  ')} ${new Date(end).toLocaleString()}`);
      if (attendees?.length) out(`${c.dim('invite')} ${attendees.join(', ')}`);
      const ok = await confirm('Create this event?', bool(args.flags, 'yes', 'y'));
      if (!ok) {
        info('Not created.');
        return;
      }

      const event = await calendar.create({
        summary,
        start: startDate.toISOString(),
        end,
        description: str(args.flags, 'description', 'd'),
        location: str(args.flags, 'where'),
        attendees,
      });
      success(`Created "${event.summary}".`);
      if (event.htmlLink) out(event.htmlLink);
      return;
    }

    case 'rm': {
      const id = args.command[2] ?? args.positional[0];
      if (!id) throw new UsageError('Which event?', 'dv cal rm <id>   (ids come from --json)');
      const ok = await confirm(`Delete event ${id}?`, bool(args.flags, 'yes', 'y'));
      if (!ok) return info('Not deleted.');
      await calendar.delete(id);
      success('Deleted.');
      return;
    }

    default:
      throw new UsageError(`Unknown cal command "${sub}".`, 'Try: events, free, add, rm');
  }
}
