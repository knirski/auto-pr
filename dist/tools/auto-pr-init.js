#!/usr/bin/env node
import{Q as K,W as q,Y as x,Z as D,da as M,va as N,wa as W}from"../auto-pr-generate-content-hvzhznn5.js";import{Ca as Z,me as z,qg as $,tg as j}from"../auto-pr-generate-content-96vtxqej.js";function F(G,H,J,V,O){return z.gen(function*(){let Y=H.join(J,V),Q=yield*G.readFileString(Y),B=H.dirname(O);yield*G.makeDirectory(B,{recursive:!0}),yield*G.writeFileString(O,Q)})}var T=`Next steps (required for the workflow to create PRs):

The privileged "create" phase now runs from a PROTECTED ENVIRONMENT (ADR 0016). Setup is manual —
auto-pr-init only copies files; it never touches your GitHub settings.

1. Create a GitHub App: https://github.com/settings/apps/new
   - Permissions: Contents, Pull requests (Read and write)
   - Webhook: Uncheck Active
2. Generate a private key (app settings → Private keys) and install the app on this repository.
3. Create a GitHub Actions ENVIRONMENT named "app-credentials"
   (Settings → Environments → New environment) BEFORE the workflows first run:
   - Deployment branch policy: "Selected branches and tags", allowing ONLY your default branch (e.g. main).
     This is the load-bearing control: it keeps the App secret unreachable from an ai/** branch.
   - Disable "Allow administrators to bypass configured protection rules".
   - (Required reviewers are NOT a meaningful control on a single-owner repo — do not rely on them.)
   - WARNING: if a workflow references this environment before you create it, GitHub silently
     auto-creates it with NO protection rules (it does not error) — you would get an UNPROTECTED
     environment. Create it first, then verify with scripts/check-app-credentials-environment.sh.
4. Add the App credentials to that ENVIRONMENT (not as plain repository secrets):
   - APP_ID (from app settings → About)
   - APP_PRIVATE_KEY (full contents of the .pem file)
   First-time setup: add them straight to the environment — there is no migration.

How generation is triggered now (push no longer starts it):
  - Manual (immediate) — run the "Auto-PR" workflow for one ai/** branch:
      gh workflow run auto-pr.yml -f branch=ai/your-branch
    (or Actions → Auto-PR → Run workflow, and set the "branch" input).
  - Automatic (ongoing) — a schedule discovers ai/** branches without an open PR roughly every
    15 minutes. Because GitHub's scheduled runs are best-effort, end-to-end latency is realistically
    10-30+ minutes, not seconds.
  - Advanced/opt-in — repository_dispatch can restore seconds-latency but requires you to run a
    webhook/App bridge yourself. It is documented (not built in) — see INTEGRATION.md.

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for the full walkthrough,
including "Upgrading from the single-workflow version".`;function U(G){return z.gen(function*(){let H=yield*$.FileSystem,J=yield*j.Path,V=yield*z.fromResult(M.fromString(import.meta.url)).pipe(z.mapError((B)=>Error(`Invalid import.meta.url: ${B.message}`))),O=yield*J.fromFileUrl(V),Y=J.join(J.dirname(O),"..",".."),Q=N();for(let B of Q){if(B.detectLegacy!==!0)continue;let C=J.join(G,B.dest);if(!(yield*H.exists(C)))continue;let v=yield*H.readFileString(C);if(W(v))return yield*z.logError({event:"init",status:"action_required",path:K(C),message:"⚠ ACTION REQUIRED — migration incomplete. This is NOT a routine skip: the existing "+`${B.dest} predates the auto-pr security fix (ADR 0016). It is still push-triggered and still contains the privileged create job that a same-repo branch author can abuse. auto-pr-init did NOT modify or overwrite it. You must manually replace it with the new push-free auto-pr.yml and add auto-pr-create.yml, then create the "app-credentials" protected environment. See the "Upgrading from the single-workflow version" section of docs/INTEGRATION.md (https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md).`}),yield*z.fail(Error(`Existing ${B.dest} predates the auto-pr security fix (ADR 0016): it is still push-triggered and must be manually migrated (see the "Upgrading from the single-workflow version" section of docs/INTEGRATION.md). No files were changed. Re-run auto-pr-init after replacing it with the new push-free workflow.`))}for(let B of Q){let C=J.join(G,B.dest);if(yield*H.exists(C))yield*z.log({event:"init",status:"skipped",path:K(C),reason:"already exists"});else if(B.content!==void 0)yield*H.writeFileString(C,B.content),yield*z.log({event:"init",status:"created",path:K(C)});else if(B.from!==void 0)yield*F(H,J,Y,B.from,C),yield*z.log({event:"init",status:"created",path:K(C)})}yield*z.log({event:"init",status:"next_steps",message:T})})}if(Z.main==Z.module)D(z.gen(function*(){let G=yield*z.sync(()=>process.cwd());yield*U(G)}).pipe(z.provide(q),z.provide(x)),"init");export{U as runInit};

//# debugId=20A52D38962C9DB264756E2164756E21
//# sourceMappingURL=auto-pr-init.js.map
