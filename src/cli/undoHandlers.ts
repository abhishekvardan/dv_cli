/**
 * How each recorded write is taken back.
 *
 * Kept apart from the journal itself so that module stays free of API imports — it is
 * used by tests and by the policy layer, neither of which should drag a network client
 * in behind them.
 *
 * The handler name recorded in an entry is a stable contract. Renaming one breaks undo
 * for every entry already written, which is precisely when someone needs it, so add new
 * names rather than repurposing old ones.
 */

import { vercel } from '../api/vercel.js';
import { youtube } from '../api/youtube.js';
import { CliError, EXIT } from './errors.js';
import { registerUndo } from './journal.js';
import { dropSecret, retrieveSecret } from './vault.js';

/* ─────────────────────────── Vercel ─────────────────────────── */

registerUndo('vercel.env.remove', async (args) => {
  await vercel.removeEnv(args.projectId, args.envId);
});

registerUndo('vercel.env.restore', async (args) => {
  // Restoring a deleted variable means creating it again. The value was captured at
  // delete time, because Vercel will not hand it back afterwards — but it lives in the
  // vault rather than in the journal entry, so only a handle travels here.
  const value = retrieveSecret(args.valueRef);
  if (value === undefined) {
    throw new CliError(
      `The saved value for ${args.key} is no longer available.`,
      EXIT.notFound,
      'Stashed values expire after 14 days. Set it again with:\n' +
        `dv vercel env add ${args.projectId} --key ${args.key} --value <value>`,
    );
  }

  await vercel.addEnv(args.projectId, {
    key: args.key,
    value,
    target: args.target,
    type: args.type,
  });

  // Restored, so there is no longer a reason to keep the secret on disk.
  dropSecret(args.valueRef);
});

registerUndo('vercel.deploy.rollback', async (args) => {
  // Undoing a rollback is another rollback, in the other direction: redeploy whatever
  // was live before. Rebuilding from source could produce a different artefact, so the
  // original deployment id is what gets promoted.
  await vercel.redeploy(args.deploymentId, args.project, 'production');
});

registerUndo('vercel.domain.remove', async (args) => {
  await vercel.removeDomain(args.projectId, args.domain);
});

registerUndo('vercel.domain.restore', async (args) => {
  await vercel.addDomain(args.projectId, args.domain);
});

registerUndo('vercel.dns.remove', async (args) => {
  await vercel.removeDnsRecord(args.domain, args.recordId);
});

registerUndo('vercel.dns.restore', async (args) => {
  await vercel.addDnsRecord(args.domain, {
    type: args.type,
    name: args.name,
    value: args.value,
    ttl: args.ttl,
  });
});

registerUndo('vercel.drain.remove', async (args) => {
  await vercel.removeLogDrain(args.drainId);
});

/* ─────────────────────────── YouTube ─────────────────────────── */

registerUndo('youtube.video.delete', async (args) => {
  await youtube.remove(String(args.videoId));
});
