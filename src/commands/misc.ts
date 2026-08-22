/**
 * `dv li …` (LinkedIn) and `dv vercel …`
 */

import { readFileSync } from 'node:fs';

import { UsageError, CancelledError } from '../cli/errors.js';
import { bool, num, str, type ParsedArgs } from '../cli/args.js';
import { c, confirm, info, json, out, relative, success, table, warn } from '../cli/ui.js';
import { linkedin } from '../api/linkedin.js';
import { missingScopes } from '../auth/tokens.js';

export async function linkedinCommand(args: ParsedArgs): Promise<void> {
  const sub = args.command[1] ?? 'me';
  const asJson = bool(args.flags, 'json');

  switch (sub) {
    case 'me':
    case 'profile': {
      const me = await linkedin.me();
      if (asJson) return json(me);

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

      const ok = await confirm('Post it?', bool(args.flags, 'yes', 'y'));
      if (!ok) {
        throw new CancelledError('Not posted.');
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

