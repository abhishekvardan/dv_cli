/**
 * The workflow runner.
 *
 * A workflow is an ordered list of steps that share one context object. The engine
 * owns everything that is the same for every workflow — progress rendering, timing,
 * skip handling, failing at the right step with the right message — so a workflow
 * definition is just what it actually does.
 *
 * The point of the CLI is here rather than in the per-provider commands: anyone can
 * call the GitHub API, but "push, open a PR, wait for CI, wait for the deployment,
 * check it is actually serving" spans four services and is where the real work is.
 */
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface StepOutcome {
    /** Shown next to the step name, e.g. a PR number or a URL. */
    detail?: string;
}
export interface Step<C> {
    name: string;
    /**
     * Return a reason to skip, or false to run.
     *
     * A skipped step says why. "Tests skipped" with no reason leaves you wondering
     * whether it was your flag or a missing script.
     */
    skip?: (ctx: C) => Promise<string | false> | string | false;
    run: (ctx: C) => Promise<StepOutcome | string | void>;
    /** A failure here is reported but does not stop the workflow. */
    optional?: boolean;
}
interface StepState {
    name: string;
    status: StepStatus;
    detail?: string;
    ms?: number;
}
export interface WorkflowResult<C> {
    ctx: C;
    ok: boolean;
    steps: StepState[];
}
export interface RunOptions {
    title: string;
    /** Print what would run and stop. */
    dryRun?: boolean;
}
/**
 * Run the steps in order, stopping at the first hard failure.
 *
 * Rendering redraws the whole list in place on a terminal, and prints one line per
 * step everywhere else — a progress display that repaints itself is unreadable in a
 * CI log, which is exactly where a deploy workflow ends up.
 */
export declare function runWorkflow<C>(steps: Step<C>[], ctx: C, options: RunOptions): Promise<WorkflowResult<C>>;
/** A short summary block at the end of a workflow. */
export declare function summary(rows: Array<[string, string]>): void;
export {};
