/**
 * Pure core for init tool. No Effect, no I/O.
 */

export interface InitFileSpec {
  readonly dest: string;
  readonly from?: string;
  readonly content?: string;
  /**
   * When true, an already-existing file at `dest` must be inspected before init proceeds, to
   * catch the pre-ADR-0016 vulnerable workflow shape (see {@link isLegacyPushWorkflow}). The
   * actual content read is I/O and lives in `auto-pr-init.ts`; this flag only marks *which* spec
   * to inspect, so `getInitFileSpecs` stays pure / data-only.
   */
  readonly detectLegacy?: boolean;
}

/** File specs for init: dest (relative to cwd), optional from (package path), optional inline content. */
export function getInitFileSpecs(): readonly InitFileSpec[] {
  return [
    {
      dest: ".github/workflows/auto-pr.yml",
      from: ".github/workflows/auto-pr.yml",
      // The privileged create phase now lives in a separate default-branch workflow
      // (auto-pr-create.yml). An existing auto-pr.yml that predates that split is still
      // push-triggered and vulnerable — flag it for the migration guard in runInit.
      detectLegacy: true,
    },
    {
      dest: ".github/workflows/auto-pr-create.yml",
      from: ".github/workflows/auto-pr-create.yml",
    },
    {
      dest: ".github/PULL_REQUEST_TEMPLATE.md",
      from: ".github/PULL_REQUEST_TEMPLATE.md",
    },
    { dest: ".nvmrc", from: ".nvmrc" },
    {
      dest: ".github/llama-server/Dockerfile",
      from: ".github/llama-server/Dockerfile",
    },
  ];
}

/**
 * Heuristic: does an existing `.github/workflows/auto-pr.yml` predate the ADR 0016 security fix?
 *
 * The secure post-fix entry workflow is triggered ONLY by `workflow_dispatch` + `schedule` and
 * contains a `discover:` job; it has no top-level `push:` trigger and holds no privileged create
 * job (that moved to the default-branch-evaluated `auto-pr-create.yml`). The old, vulnerable file
 * was `push`-triggered on `ai/**` and ran a privileged `create` job whose definition a same-repo
 * branch author fully controlled (ADR 0016 "The defect").
 *
 * We treat a file as legacy when it still declares a `push:` trigger AND is missing BOTH new
 * ingress markers (`workflow_dispatch:` and the `discover:` job). Matching is deliberately
 * text/regex-based, consistent with `test/scripts/workflow-trust-boundary.test.ts`'s style — not a
 * YAML parse; adding a YAML dependency here would be disproportionate for a one-shot install guard.
 *
 * Documented limits (intentional, not bugs):
 *   - It matches `push:` anywhere at the start of a line (after indentation), so a file that only
 *     mentions `push:` inside an unrelated block would be a false positive — but the current
 *     secure template contains no `push:` at all, so a false positive can only occur on a
 *     hand-edited file, where refusing to auto-proceed and asking the operator to check is the
 *     safe direction anyway.
 *   - It is fooled by a hand-edited legacy file that removed the `push:` trigger but kept the old
 *     privileged create job inline, or that commented `push:` out. Catching every such variant
 *     would require full semantic analysis; the goal here is the common, dangerous case: an
 *     adopter who upgraded the package and re-ran `auto-pr-init` while keeping their original
 *     push-triggered `auto-pr.yml` — and refusing to silently report success for it.
 */
export function isLegacyPushWorkflow(content: string): boolean {
  const hasPushTrigger = /^[ \t]*push:/m.test(content);
  const hasWorkflowDispatch = /^[ \t]*workflow_dispatch:/m.test(content);
  const hasDiscoverJob = /^[ \t]*discover:/m.test(content);
  return hasPushTrigger && !(hasWorkflowDispatch && hasDiscoverJob);
}
