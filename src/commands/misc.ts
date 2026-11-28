/**
 * `dv li …` (LinkedIn) and `dv vercel …`
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { UsageError, CancelledError } from '../cli/errors.js';
import { record } from '../cli/journal.js';
import { cancelLater, laterDir, listLater, runLater, scheduleLater } from '../cli/later.js';
import { parseWhen } from './youtube.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import { c, confirm, info, json, out, relative, success, table, warn } from '../cli/ui.js';
import { linkedin } from '../api/linkedin.js';
import { missingScopes } from '../auth/tokens.js';

export async function linkedinCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'me';
  // --snapshot and --diff consume the JSON payload, so they imply it.
  const asJson = wantsJson(args.flags);

  switch (sub) {
    case 'me':
    case 'profile': {
      const me = await linkedin.me();
      if (asJson) return emit(me, outputOpts(args.flags, 'li'));

      out(c.bold(me.name ?? '(no name returned)'));
      if (me.email) out(`${c.dim('email  ')} ${me.email}${me.emailVerified ? c.green(' verified') : ''}`);
      if (me.locale) out(`${c.dim('locale ')} ${me.locale}`);
      out(`${c.dim('urn    ')} urn:li:person:${me.sub}`);
      if (me.picture) out(`${c.dim('picture')} ${me.picture}`);

      // Said plainly. The web app used to invent these fields, which is worse than
      // leaving them out.
      info('');
      info(c.dim(`  Not available on the standard API tier: ${me.unavailable.join(', ')}.`));
      info(c.dim('  Those fields need a LinkedIn partner agreement — no CLI can read them without one.'));
      return;
    }

    case 'post':
    case 'share': {
      const fromFile = str(args.flags, 'file', 'f');
      const text = fromFile ? readFileSync(fromFile, 'utf8') : (str(args.flags, 'text', 't') ?? args.command[2] ?? args.positional[0]);
      if (!text) {
        throw new UsageError(
          'What should the post say?',
          'dv li post --text "Shipped the CLI today." --url https://example.com',
        );
      }

      const missing = missingScopes('linkedin', ['w_member_social']);
      if (missing.length > 0) {
        throw new UsageError(
          'This login cannot post — the w_member_social scope was not granted.',
          'Run `dv auth login linkedin` and approve posting.',
        );
      }

      const visibility = bool(args.flags, 'connections') ? 'CONNECTIONS' : 'PUBLIC';

      // Publishing to a real audience under the user's name. Always shown in full
      // and always confirmed.
      out(c.bold('This will be posted to LinkedIn as you:'));
      out('');
      out(text);
      if (str(args.flags, 'url')) out(c.dim(`\n[link] ${str(args.flags, 'url')}`));
      out('');
      out(`${c.dim('visibility')} ${visibility === 'PUBLIC' ? 'anyone' : 'connections only'}`);

      const video = str(args.flags, 'video');
      if (video && !existsSync(video)) throw new UsageError(`No video at ${video}.`);
      if (video) out(`${c.dim('video     ')} ${video}`);

      const at = str(args.flags, 'at');
      if (at) {
        const when = parseWhen(at);
        out(`${c.dim('posts at  ')} ${when.toLocaleString()} ${c.dim('(this PC must be on; it posts late rather than never)')}`);
        const ok = await confirm('Schedule it?', bool(args.flags, 'yes', 'y'));
        if (!ok) throw new CancelledError('Not scheduled.');
        // The text and video are pinned now, so later edits to the source files do not
        // change what goes out.
        const dir = laterDir();
        const stamp = Date.now().toString(36);
        const textFile = join(dir, `li-${stamp}.txt`);
        writeFileSync(textFile, text);
        const argv = ['li', 'post', '--file', textFile];
        if (video) argv.push('--video', resolve(video));
        if (visibility === 'CONNECTIONS') argv.push('--connections');
        const job = scheduleLater({ at: when, argv, label: `LinkedIn: ${text.split('\n')[0]!.slice(0, 60)}` });
        record({
          command: 'li post --at',
          provider: 'linkedin',
          summary: `Scheduled a LinkedIn post for ${when.toISOString()} (${job.id})`,
          undo: { kind: 'later.cancel', args: { id: job.id }, describe: `Cancel scheduled job ${job.id}` },
        });
        success(`Scheduled ${job.id} for ${when.toLocaleString()}${job.hidden ? '' : ' (a console window will show briefly while it posts)'}.`);
        info(c.dim(`  dv later   lists it · dv later cancel ${job.id}`));
        return;
      }

      const ok = await confirm('Post it?', bool(args.flags, 'yes', 'y'));
      if (!ok) {
        throw new CancelledError('Not posted.');
      }

      if (video) {
        const result = await linkedin.shareVideo({ text, file: video, visibility, onProgress: (m) => info(c.dim(`  ${m}`)) });
        success('Posted.');
        if (result.url) out(result.url);
        return;
      }

      const result = await linkedin.share({
        text,
        url: str(args.flags, 'url'),
        urlTitle: str(args.flags, 'url-title'),
        visibility,
      });
      success('Posted.');
      if (result.url) out(result.url);
      else warn('LinkedIn did not return a post id, so there is no link to show.');
      return;
    }

    case 'feed':
    case 'posts':
      // Refusing clearly beats returning an empty list that looks like "no posts".
      throw new UsageError(
        'Reading your LinkedIn posts is not possible with this API access.',
        'It needs `r_member_social`, which LinkedIn only grants under a partner agreement.\n' +
          'Run `dv li me` to see what the standard tier can read.',
      );

    default:
      throw new UsageError(`Unknown li command "${sub}".`, 'Try: me, post');
  }
}


/** `dv later` - jobs scheduled to run on this machine (e.g. LinkedIn posts). */
export async function laterCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'ls';
  if (sub === 'run') {
    // Invoked by the scheduled task itself.
    const id = args.command[2] ?? args.positional[0];
    if (!id) throw new UsageError('Which job?', 'dv later run l_abc123');
    process.exitCode = runLater(id);
    return;
  }
  if (sub === 'cancel' || sub === 'rm') {
    const id = args.command[2] ?? args.positional[0];
    if (!id) throw new UsageError('Which job?', 'dv later cancel l_abc123');
    const ok = await confirm(`Cancel scheduled job ${id}?`, bool(args.flags, 'yes', 'y'));
    if (!ok) throw new CancelledError('Kept.');
    cancelLater(id);
    success(`Cancelled ${id}.`);
    return;
  }
  const jobs = listLater();
  if (wantsJson(args.flags)) return emit(jobs, outputOpts(args.flags, 'later'));
  if (jobs.length === 0) return info('Nothing scheduled.');
  table(jobs, [
    { header: 'id', value: (j) => j.id },
    { header: 'when', value: (j) => new Date(j.at).toLocaleString(), max: 24 },
    { header: 'state', value: (j) => j.state },
    { header: 'what', value: (j) => j.label, max: 60 },
  ]);
}
