/**
 * `dv yt …` - YouTube uploads, including scheduled publishing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { UsageError, CancelledError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { emit, outputOpts, wantsJson } from '../cli/output.js';
import { c, confirm, info, out, success, table, warn } from '../cli/ui.js';
import { record } from '../cli/journal.js';
import { missingScopes } from '../auth/tokens.js';
import { parseReachCsv, reach, videoAnalytics, youtube, type Privacy } from '../api/youtube.js';
import { FORMATS, isFormat, loadCatalog, saveCatalog, tagVideo, type Kind } from '../youtube/catalog.js';
import { notScoredReason, reward } from '../youtube/reward.js';
import { plan as makePlan, type Plan } from '../youtube/bandit.js';
import { dvHome } from '../config/paths.js';
import { join } from 'node:path';

export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];
export const YT_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

function needAnalytics(): void {
  if (missingScopes('google', [YT_ANALYTICS_SCOPE]).length > 0) {
    throw new UsageError(
      'This Google login cannot read YouTube Analytics yet.',
      'Run `dv auth login google` and approve "View YouTube Analytics reports".\n' +
        'Also enable "YouTube Analytics API" and "YouTube Reporting API" on the OAuth client\'s Cloud project.',
    );
  }
}

/** The project/format tags an upload or `yt tag` was given; null when none. */
function tagsFrom(args: ParsedArgs, title: string): { project: string; format: (typeof FORMATS)[number]; kind: Kind } | null {
  const project = str(args.flags, 'project');
  const format = str(args.flags, 'format');
  if (!project && !format) return null;
  if (!project || !format) throw new UsageError('Give both --project and --format.', `Formats: ${FORMATS.join(', ')}`);
  if (!isFormat(format)) throw new UsageError(`Unknown format "${format}".`, `One of: ${FORMATS.join(', ')}`);
  const kind: Kind = bool(args.flags, 'short') || /#shorts/i.test(title) ? 'short' : 'long';
  return { project, format, kind };
}

const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function planMarkdown(p: Plan, start: Date): string {
  const lines = [`# Next ${p.kind === 'short' ? 'Shorts' : 'videos'}: plan from dv yt learn`, ''];
  lines.push(
    p.exploring
      ? `Exploring: only ${p.scored} video(s) scored so far, so untried project × format pairs still get many slots.`
      : `${p.scored} videos scored. Strong pairs get more slots; uncertain ones still get some.`,
    '',
    '| Day | Project | Format | Why |',
    '|---|---|---|---|',
  );
  p.slots.forEach((s, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    lines.push(`| ${day} | ${s.arm.project} | ${s.arm.format} | ${s.why} |`);
  });
  const tried = p.arms.filter((a) => a.n > 0).sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0));
  if (tried.length) {
    lines.push('', '## Scored so far', '', '| Project | Format | Videos | Mean reward |', '|---|---|---|---|');
    for (const a of tried) lines.push(`| ${a.project} | ${a.format} | ${a.n} | ${a.mean!.toFixed(2)} |`);
  }
  if (p.skipped.length) {
    lines.push('', '## Not scored yet', '');
    for (const s of p.skipped) lines.push(`- ${s.title} (${s.videoId}): ${s.reason}`);
  }
  return lines.join('\n') + '\n';
}

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
      const label = tagsFrom(args, title);

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

      if (label) {
        const cat = loadCatalog();
        tagVideo(cat, { videoId: video.id, title, ...label, publishAt: video.publishAt });
        saveCatalog(cat);
      }

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

    case 'tag': {
      if (!arg1) throw new UsageError('Which video?', 'dv yt tag <videoId> --project dv --format tutorial [--short]');
      needScopes();
      const v = await youtube.status(arg1);
      const label = tagsFrom(args, v.title);
      if (!label) throw new UsageError('Give --project and --format.', `Formats: ${FORMATS.join(', ')}`);
      const cat = loadCatalog();
      const e = tagVideo(cat, { videoId: v.id, title: v.title, ...label, publishAt: v.publishAt });
      saveCatalog(cat);
      success(`Tagged "${e.title}" as ${e.project} × ${e.format} (${e.kind}).`);
      return;
    }

    case 'catalog':
    case 'ls': {
      const cat = loadCatalog();
      const rows = Object.values(cat.videos);
      if (asJson) return emit(rows, outputOpts(args.flags, 'yt'));
      if (rows.length === 0) return info('Nothing tagged yet. Upload with --project/--format, or `dv yt tag <id>`.');
      table(rows, [
        { header: 'video', value: (v) => v.videoId },
        { header: 'kind', value: (v) => v.kind },
        { header: 'project', value: (v) => v.project },
        { header: 'format', value: (v) => v.format },
        { header: 'title', value: (v) => v.title, max: 48 },
        { header: 'views', value: (v) => (v.stats ? String(v.stats.views) : '—'), align: 'right' },
      ]);
      return;
    }

    case 'stats': {
      needAnalytics();
      const days = num(args.flags, 'days', 28);
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const rows = await videoAnalytics(isoDay(start), isoDay(end));

      const cat = loadCatalog();
      const at = new Date().toISOString();
      for (const r of rows) {
        const e = cat.videos[r.videoId];
        if (!e) continue;
        e.stats = { ...r, impressions: e.stats?.impressions, ctr: e.stats?.ctr, at };
      }
      saveCatalog(cat);

      const view = rows.map((r) => {
        const e = cat.videos[r.videoId];
        return {
          ...r,
          title: e?.title ?? '(untagged)',
          tag: e ? `${e.project} × ${e.format}` : '—',
          ctr: e?.stats?.ctr,
          reward: e?.stats && !notScoredReason(e) ? reward(e.stats, e.kind) : undefined,
        };
      });
      if (asJson) return emit(view, outputOpts(args.flags, 'yt'));
      if (view.length === 0) {
        info(`No views in the last ${days} days yet. Analytics trail by about two days.`);
        return;
      }
      table(view, [
        { header: 'title', value: (v) => v.title, max: 36 },
        { header: 'tag', value: (v) => v.tag, max: 26 },
        { header: 'views', value: (v) => String(v.views), align: 'right' },
        { header: 'avg %', value: (v) => `${v.avgViewPct.toFixed(0)}%`, align: 'right' },
        { header: 'ctr', value: (v) => pct(v.ctr), align: 'right' },
        { header: 'subs', value: (v) => `+${v.subscribersGained}`, align: 'right' },
        { header: 'likes', value: (v) => String(v.likes), align: 'right' },
        { header: 'reward', value: (v) => (v.reward === undefined ? c.dim('—') : v.reward.toFixed(2)), align: 'right' },
      ]);
      const untagged = view.filter((v) => v.tag === '—').length;
      if (untagged) info(c.dim(`  ${untagged} untagged: dv yt tag <id> --project … --format … so the planner can learn from them.`));
      return;
    }

    case 'reach': {
      needAnalytics();
      const cat = loadCatalog();
      if (arg1 === 'setup') {
        const id = await reach.createJob();
        cat.reachJobId = id;
        saveCatalog(cat);
        success(`Reach reporting job ready (${id}).`);
        info(c.dim('  YouTube fills it daily, about two days behind. Run `dv yt reach` after that.'));
        return;
      }
      const jobId = cat.reachJobId ?? (await reach.findJob());
      if (!jobId) throw new UsageError('No reach job yet.', 'dv yt reach setup');
      const { count, csvs } = await reach.download(jobId);
      const rows = parseReachCsv(csvs);
      for (const r of rows) {
        const e = cat.videos[r.videoId];
        if (e?.stats) {
          e.stats.impressions = r.impressions;
          e.stats.ctr = r.ctr;
        }
      }
      cat.reachJobId = jobId;
      saveCatalog(cat);
      if (asJson) return emit(rows, outputOpts(args.flags, 'yt'));
      if (count === 0) return info('No reach reports yet. The first ones arrive about two days after `dv yt reach setup`.');
      table(rows, [
        { header: 'video', value: (r) => cat.videos[r.videoId]?.title ?? r.videoId, max: 44 },
        { header: 'impressions', value: (r) => String(r.impressions), align: 'right' },
        { header: 'ctr', value: (r) => pct(r.ctr), align: 'right' },
      ]);
      info(c.dim(`  from ${count} daily report(s). Run \`dv yt stats\` first so new videos have a row to attach CTR to.`));
      return;
    }

    case 'learn':
    case 'plan': {
      const kind: Kind = str(args.flags, 'kind') === 'long' ? 'long' : 'short';
      const slots = num(args.flags, 'slots', 7);
      const projectsFlag = str(args.flags, 'projects');
      const projects = projectsFlag ? projectsFlag.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const cat = loadCatalog();
      const p = makePlan(cat, { kind, slots, projects, seed: num(args.flags, 'seed', Date.now()) });
      if (p.arms.length === 0) {
        throw new UsageError('Nothing to plan from yet.', 'Tag videos with --project/--format, or pass --projects dv,pkgguard,…');
      }
      const startFlag = str(args.flags, 'start');
      const start = startFlag ? new Date(startFlag) : new Date(Date.now() + 86_400_000);
      const md = planMarkdown(p, start);
      writeFileSync(join(dvHome(), 'yt-plan.md'), md);
      if (asJson) {
        return emit(
          {
            kind: p.kind,
            exploring: p.exploring,
            scored: p.scored,
            slots: p.slots.map((s) => ({ project: s.arm.project, format: s.arm.format, why: s.why, draw: s.draw })),
            arms: p.arms.filter((a) => a.n > 0),
            skipped: p.skipped,
          },
          outputOpts(args.flags, 'yt'),
        );
      }
      out(md);
      info(c.dim(`  saved to ${join(dvHome(), 'yt-plan.md')}`));
      return;
    }

    default:
      throw new UsageError(`Unknown yt command "${sub}".`, 'Try: me, upload, status, rm, tag, catalog, stats, reach, learn');
  }
}
