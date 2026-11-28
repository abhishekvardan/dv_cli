/**
 * `dv yt …` - YouTube uploads, including scheduled publishing.
 */

import { existsSync, readFileSync } from 'node:fs';

import { UsageError, CancelledError } from '../cli/errors.js';
import { bool, str, type ParsedArgs } from '../cli/args.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import { c, confirm, info, out, success, warn } from '../cli/ui.js';
import { record } from '../cli/journal.js';
import { missingScopes } from '../auth/tokens.js';
import { youtube, type Privacy } from '../api/youtube.js';

export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];

function needScopes(): void {
  const missing = missingScopes('google', YT_SCOPES);
  if (missing.length > 0) {
    throw new UsageError(
      'This Google login has no YouTube access yet.',
      'Run `dv auth login google` and approve YouTube when Google asks.\n' +
        'The YouTube Data API v3 must also be enabled on the same Cloud project as the OAuth client.',
    );
  }
}

/** "2026-11-29 18:00" or full ISO -> Date; local time when no offset is given. */
export function parseWhen(text: string, now = new Date()): Date {
  const d = new Date(text.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) throw new UsageError(`Could not read "${text}" as a time.`, 'Try: --publish-at "2026-11-29 18:00"');
  if (d.getTime() <= now.getTime()) throw new UsageError(`${d.toLocaleString()} is in the past.`, 'A scheduled publish has to be in the future.');
  return d;
}

function tagsOf(flag: unknown): string[] | undefined {
  if (flag === undefined || flag === true) return undefined;
  const all = (Array.isArray(flag) ? flag : [flag]).flatMap((t) => String(t).split(','));
  const tags = all.map((t) => t.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

export async function youtubeCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'me';
  const asJson = wantsJson(args.flags);
  const arg1 = args.command[2] ?? args.positional[0];

  switch (sub) {
    case 'me':
    case 'channel': {
      needScopes();
      const ch = await youtube.channel();
      if (asJson) return emit(ch, outputOpts(args.flags, 'yt'));
      out(c.bold(ch.title));
      if (ch.handle) out(`${c.dim('handle     ')} ${ch.handle}`);
      out(`${c.dim('subscribers')} ${ch.subscribers ?? '—'}`);
      out(`${c.dim('videos     ')} ${ch.videos ?? '—'}`);
      out(`${c.dim('id         ')} ${ch.id}`);
      return;
    }

    case 'upload': {
      const file = arg1 ?? str(args.flags, 'file', 'f');
      const title = str(args.flags, 'title', 't');
      if (!file || !title) {
        throw new UsageError(
          'Need a video file and --title.',
          'dv yt upload video.mp4 --title "pkgguard" --description-file desc.txt --publish-at "2026-11-29 18:00"',
        );
      }
      if (!existsSync(file)) throw new UsageError(`No file at ${file}.`);
      if (title.length > 100) throw new UsageError(`The title is ${title.length} characters; YouTube allows 100.`);

      const descFile = str(args.flags, 'description-file');
      const description = descFile ? readFileSync(descFile, 'utf8') : (str(args.flags, 'description', 'd') ?? '');
      if (description.length > 5000) throw new UsageError('The description is over YouTube\'s 5000 characters.');
      const thumbnail = str(args.flags, 'thumbnail');
      if (thumbnail && !existsSync(thumbnail)) throw new UsageError(`No thumbnail at ${thumbnail}.`);

      const at = str(args.flags, 'publish-at', 'at');
      const publishAt = at ? parseWhen(at) : undefined;
      const privacy = (str(args.flags, 'privacy') ?? 'private') as Privacy;
      if (!['private', 'unlisted', 'public'].includes(privacy)) {
        throw new UsageError(`Unknown privacy "${privacy}".`, 'One of: private, unlisted, public');
      }
      if (publishAt && str(args.flags, 'privacy') && privacy !== 'private') {
        throw new UsageError('A scheduled video is private until it publishes.', 'Drop --privacy when using --publish-at.');
      }
      const tags = tagsOf(args.flags['tags']);

      needScopes();

      // Publishing to a real audience under the user's name: shown in full, confirmed.
      out(c.bold('This will be uploaded to your YouTube channel:'));
      out(`${c.dim('file       ')} ${file}`);
      out(`${c.dim('title      ')} ${title}`);
      out(`${c.dim('description')} ${description.split('\n')[0]?.slice(0, 90) ?? ''}${description.length > 90 ? '…' : ''}`);
      if (tags) out(`${c.dim('tags       ')} ${tags.join(', ')}`);
      if (thumbnail) out(`${c.dim('thumbnail  ')} ${thumbnail}`);
      out(
        `${c.dim('visibility ')} ${publishAt ? `private, goes public ${publishAt.toLocaleString()}` : privacy}`,
      );
      const ok = await confirm(publishAt ? 'Upload and schedule it?' : 'Upload it?', bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Not uploaded.');

      info(c.dim('  uploading…'));
      const video = await youtube.upload({
        file,
        title,
        description,
        tags,
        categoryId: str(args.flags, 'category'),
        privacy,
        publishAt: publishAt?.toISOString(),
        madeForKids: bool(args.flags, 'kids'),
      });

      record({
        command: 'yt upload',
        provider: 'google',
        summary: `Uploaded "${title}" to YouTube (${video.id})${publishAt ? `, scheduled ${publishAt.toISOString()}` : ''}`,
        undo: { kind: 'youtube.video.delete', args: { videoId: video.id }, describe: `Delete YouTube video ${video.id}` },
      });

      if (thumbnail) {
        try {
          await youtube.setThumbnail(video.id, thumbnail);
        } catch (err: any) {
          // Custom thumbnails need a phone-verified channel; the upload itself stands.
          warn(`Thumbnail not set: ${err?.message ?? err}`);
          info(c.dim('  Custom thumbnails need a verified channel: https://www.youtube.com/verify'));
        }
      }

      if (asJson) return emit(video, outputOpts(args.flags, 'yt'));
      success(`Uploaded — ${video.url}`);
      out(`${c.dim('studio')} ${video.studioUrl}`);
      if (publishAt) {
        const confirmed = video.publishAt ? new Date(video.publishAt).toLocaleString() : null;
        if (confirmed) out(`${c.dim('goes public')} ${confirmed}`);
        else warn('YouTube did not echo a publish time. Check the video in Studio.');
        info(c.dim('  If your Cloud project is not audited by YouTube, Google keeps API uploads private and the'));
        info(c.dim('  schedule will not fire. `dv yt status ' + video.id + '` shows what YouTube decided.'));
      }
      return;
    }

    case 'status': {
      if (!arg1) throw new UsageError('Which video?', 'dv yt status <videoId>');
      needScopes();
      const v = await youtube.status(arg1);
      if (asJson) return emit(v, outputOpts(args.flags, 'yt'));
      out(c.bold(v.title));
      out(`${c.dim('privacy    ')} ${v.privacy}`);
      if (v.publishAt) out(`${c.dim('goes public')} ${new Date(v.publishAt).toLocaleString()}`);
      out(`${c.dim('processing ')} ${v.uploadStatus ?? '—'}`);
      if (v.rejectionReason) warn(`rejected: ${v.rejectionReason}`);
      if (v.failureReason) warn(`failed: ${v.failureReason}`);
      out(`${c.dim('link       ')} ${v.url}`);
      out(`${c.dim('studio     ')} ${v.studioUrl}`);
      return;
    }

    case 'rm':
    case 'delete': {
      if (!arg1) throw new UsageError('Which video?', 'dv yt rm <videoId>');
      needScopes();
      const ok = await confirm(`Delete YouTube video ${arg1}? This cannot be undone.`, bool(args.flags, 'yes', 'y'));
      if (!ok) throw new CancelledError('Not deleted.');
      await youtube.remove(arg1);
      record({
        command: 'yt rm',
        provider: 'google',
        summary: `Deleted YouTube video ${arg1}`,
        irreversible: 'YouTube cannot restore a deleted video.',
      });
      success('Deleted.');
      return;
    }

    default:
      throw new UsageError(`Unknown yt command "${sub}".`, 'Try: me, upload, status, rm');
  }
}
