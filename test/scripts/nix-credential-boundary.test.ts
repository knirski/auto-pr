// Nix credential-boundary regression suite (Workstream 2, Task 2.1).
//
// WHAT THIS FILE PROVES
// ----------------------
// docs/superpowers/specs/2026-07-23-repository-remediation-plan.md's Workstream 2 defect: a
// same-repository PR could cause the Nix job to check out PR-controlled code with a persisted,
// write-capable App token and execute `nix run .#update-bun-nix`. This is the same class of
// same-repo-pusher-as-attacker threat model as ADR 0016 (Workstream 1), applied to
// `.github/workflows/nix.yml` — a file `test/scripts/workflow-trust-boundary.test.ts` explicitly
// scoped OUT of its own suite as "explicitly Task 2.1's scope" (see that file's header).
//
// CURRENT STATE (unlike Workstream 1, this is not a RED-then-GREEN suite): Task 1.6b's job split
// (bun-nix-check / bun-nix-push / build), done to fix an unrelated CI regression, already
// satisfies every property below as a side effect. This suite locks that in as a named regression
// test so it cannot silently regress, rather than proving a fix that already shipped.
//
// WHY A PR-RESOLVED WORKFLOW FILE IS STILL SAFE (the "administrator-enforced permission ceiling"
// this suite is required to document per the plan, since nix.yml is NOT resolved from the default
// branch the way auto-pr-create.yml is): `ci.yml` runs on `pull_request` directly (no
// `workflow_run` indirection), so for a same-repo PR, GitHub resolves `ci.yml`/`nix.yml` from the
// PR's OWN merge ref — a same-repo PR author could edit either file. Two independent,
// non-YAML-editable controls make that safe:
//   1. The App credentials exist ONLY as `app-credentials` environment secrets (the repository-level
//      copies were deliberately removed, see workstream1-status project memory / PR #274-275
//      follow-through). A PR that edits nix.yml to drop `environment: app-credentials` from
//      `bun-nix-push` does not gain the secret some other way — `secrets.APP_ID`/`APP_PRIVATE_KEY`
//      simply resolve empty, because there is no repository-level fallback left to inherit.
//   2. If the PR's edited workflow instead KEEPS `environment: app-credentials` (required to reach
//      the secret at all), the environment's deployment-branch policy (admin-configured in repo
//      Settings, not the workflow YAML) rejects any job whose `GITHUB_REF` is not `main` — a
//      `pull_request` run's ref (`refs/pull/<n>/merge`) never matches, regardless of what the PR's
//      own copy of the `if:`/`needs:` gates say.
// Together, (1) removes the secret to steal and (2) makes the one place it Ubuntu still lives
// enforce a branch check the PR's own workflow edits cannot override. This suite cannot exercise
// (1)/(2) directly (they are live GitHub repository/environment state, not something the YAML
// encodes), so it instead asserts the structural properties that make the design self-consistent:
// every App-secret-consuming job in this file names the environment (already covered repo-wide by
// workflow-trust-boundary.test.ts's protected-environment / no-secret-fallback bullets), and no
// PR-reachable job in this file references the secret, mints a token, or writes at all.
//
// SCOPE: `.github/workflows/nix.yml` (bun-nix-check, bun-nix-push, build) and its caller
// `.github/workflows/ci.yml` (the `nix` job) and `.github/workflows/update-bun-nix.yml`.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

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
  readonly name: string;
  readonly raw: string;
  readonly doc: Record<string, unknown>;
}

function loadWorkflows(): readonly Workflow[] {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  return files.map((name) => {
    const raw = readFileSync(join(workflowsDir, name), "utf8");
    return { name, raw, doc: parseYaml(raw) };
  });
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

interface JobEntry {
  readonly id: string;
  readonly job: Record<string, unknown>;
}

function getJobs(doc: Record<string, unknown>): readonly JobEntry[] {
  const jobs = doc.jobs;
  if (!isRecord(jobs)) {
    return [];
  }
  return Object.entries(jobs)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([id, job]) => ({ id, job }));
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

function jobText(job: Record<string, unknown>): string {
  return JSON.stringify(job);
}

const nixWorkflow = findWorkflow("nix.yml");
const bunNixCheck = findJob(nixWorkflow, "bun-nix-check");
const bunNixPush = findJob(nixWorkflow, "bun-nix-push");
const buildJob = findJob(nixWorkflow, "build");

// The two jobs actually reached whenever ci.yml's `nix` job runs on a `pull_request` event
// (bun-nix-push is excluded by its own `if:`, asserted separately below).
const prReachableJobs: ReadonlyArray<{ id: string; job: Record<string, unknown> }> = [
  { id: "bun-nix-check", job: bunNixCheck },
  { id: "build", job: buildJob },
];

const ciWorkflow = findWorkflow("ci.yml");
const ciNixJob = findJob(ciWorkflow, "nix");

const updateBunNixWorkflow = findWorkflow("update-bun-nix.yml");

describe("Nix credential boundary: PR-reachable jobs are read-only", () => {
  test.each(prReachableJobs.map((j) => [j.id, j.job] as const))(
    "%s has permissions.contents === 'read' and no other permission keys",
    (_id, job) => {
      const perms = job.permissions;
      expect(isRecord(perms)).toBe(true);
      if (isRecord(perms)) {
        expect(perms.contents).toBe("read");
        expect(Object.keys(perms)).toEqual(["contents"]);
      }
    },
  );

  test.each(prReachableJobs.map((j) => [j.id, j.job] as const))(
    "%s's checkout step sets persist-credentials: false",
    (_id, job) => {
      const checkouts = getSteps(job).filter((s) => asString(s.uses)?.includes("actions/checkout"));
      expect(checkouts.length).toBeGreaterThan(0);
      for (const step of checkouts) {
        const withBlock = step.with;
        expect(isRecord(withBlock) && withBlock["persist-credentials"] === false).toBe(true);
      }
    },
  );

  test.each(prReachableJobs.map((j) => [j.id, j.job] as const))(
    "%s never mints a GitHub App token",
    (_id, job) => {
      const mintsToken = getSteps(job).some((s) =>
        asString(s.uses)?.includes("actions/create-github-app-token"),
      );
      expect(mintsToken).toBe(false);
    },
  );

  test.each(prReachableJobs.map((j) => [j.id, j.job] as const))(
    "%s never references the App secrets",
    (_id, job) => {
      const text = jobText(job);
      expect(text.includes("secrets.APP_ID")).toBe(false);
      expect(text.includes("secrets.APP_PRIVATE_KEY")).toBe(false);
    },
  );

  test.each(prReachableJobs.map((j) => [j.id, j.job] as const))(
    "%s contains no `git push`",
    (_id, job) => {
      const runBodies = getSteps(job)
        .map((s) => asString(s.run))
        .filter((r): r is string => r !== undefined)
        .join("\n");
      expect(runBodies).not.toMatch(/\bgit push\b/);
    },
  );
});

describe("Nix credential boundary: the write job is unreachable from any pull_request", () => {
  test("bun-nix-push's `if:` requires push_allowed, which ci.yml sets to false for every pull_request", () => {
    const ifExpr = asString(bunNixPush.if);
    // Exact match, not `.toContain("inputs.push_allowed")`: a substring check would let a
    // regression like `if: true || inputs.push_allowed` (which always runs, defeating the gate)
    // pass silently.
    expect(ifExpr).toBe(
      "needs.bun-nix-check.outputs.changed == 'true' && inputs.push_allowed && github.actor != 'dependabot[bot]'",
    );

    const withBlock = ciNixJob.with;
    expect(isRecord(withBlock)).toBe(true);
    if (isRecord(withBlock)) {
      const expr = asString(withBlock.push_allowed);
      // Task 1.6b root-cause fix: false for EVERY pull_request (not just forks, which the
      // pre-1.6b `head.repo.full_name == github.repository` check would have let through for
      // same-repo PRs — exactly this suite's threat model).
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
      expect(expr).toBe("${{ github.event_name != 'pull_request' }}");
    }
  });

  test("bun-nix-push needs bun-nix-check (verification precedes any privileged token mint)", () => {
    const needs = bunNixPush.needs;
    const needsList = Array.isArray(needs) ? needs : [needs];
    expect(needsList).toContain("bun-nix-check");
  });

  test("bun-nix-push declares the app-credentials environment", () => {
    expect(asString(bunNixPush.environment)).toBe("app-credentials");
  });

  test("a privileged ref (write job) is never a PR-controlled ref: ci.yml only passes github.head_ref when push_allowed is false", () => {
    const withBlock = ciNixJob.with;
    expect(isRecord(withBlock)).toBe(true);
    if (isRecord(withBlock)) {
      const refExpr = asString(withBlock.ref);
      const expected =
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
        "${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}";
      expect(refExpr).toBe(expected);
    }
  });
});

describe("Nix credential boundary: the manual trusted-update entry point is dispatch-only", () => {
  test("update-bun-nix.yml has no pull_request or push trigger", () => {
    const on = updateBunNixWorkflow.doc.on;
    expect(isRecord(on)).toBe(true);
    if (isRecord(on)) {
      expect(on.pull_request).toBeUndefined();
      expect(on.push).toBeUndefined();
      expect("workflow_dispatch" in on).toBe(true);
    }
  });
});
