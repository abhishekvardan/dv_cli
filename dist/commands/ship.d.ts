/**
 * `dv ship` — the cross-service deploy workflow.
 *
 * This is the reason the CLI exists rather than being three thin API wrappers. Each
 * individual call is easy; the sequence is not, because it spans git, GitHub, Vercel
 * and the running site, and every one of them has a different idea of what "done"
 * means. Getting the waits right is most of the work:
 *
 *  - GitHub reports check runs per commit SHA, and reports *none* for a few seconds
 *    after a push, which reads identically to "all passed" if you do not allow for it.
 *  - Vercel builds are triggered by the git push, not by this CLI, so the step is to
 *    find the deployment for our SHA rather than to create one.
 *  - A deployment being READY means the build finished, not that the site serves —
 *    hence the separate health check.
 */
import { type ParsedArgs } from '../cli/args.js';
export declare function shipCommand(args: ParsedArgs): Promise<void>;
