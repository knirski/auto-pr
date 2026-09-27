#!/usr/bin/env node
import{Yi,Ls}from"../auto-pr-generate-content-cli-akk24rc4.js";import{Ve,_,T,u,Ae,I,fe,q,qt,we,We,zc,pt,dt,gn,yn}from"../auto-pr-generate-content-cli-vgkh66tn.js";function p(i,r,n,a,o){return T(function*(){let l=r.join(n,a),s=yield*i.readFileString(l),e=r.dirname(o);yield*i.makeDirectory(e,{recursive:!0}),yield*i.writeFileString(o,s)})}var h=`Next steps (required for the workflow to create PRs):

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
including "Upgrading from the single-workflow version".`;function m(i){return T(function*(){let r=yield*we,n=yield*We,a=yield*Ae(zc(import.meta.url)).pipe(I((e)=>Error(`Invalid import.meta.url: ${e.message}`))),o=yield*n.fromFileUrl(a),l=n.join(n.dirname(o),"..",".."),s=Yi();for(let e of s){if(e.detectLegacy!==!0)continue;let t=n.join(i,e.dest);if(!(yield*r.exists(t)))continue;let d=yield*r.readFileString(t);if(Ls(d))return yield*qt({event:"init",status:"action_required",path:pt(t),message:"⚠ ACTION REQUIRED — migration incomplete. This is NOT a routine skip: the existing "+`${e.dest} predates the auto-pr security fix (ADR 0016). It is still push-triggered and still contains the privileged create job that a same-repo branch author can abuse. auto-pr-init did NOT modify or overwrite it. You must manually replace it with the new push-free auto-pr.yml and add auto-pr-create.yml, then create the "app-credentials" protected environment. See the "Upgrading from the single-workflow version" section of docs/INTEGRATION.md (https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md).`}),yield*u(Error(`Existing ${e.dest} predates the auto-pr security fix (ADR 0016): it is still push-triggered and must be manually migrated (see the "Upgrading from the single-workflow version" section of docs/INTEGRATION.md). No files were changed. Re-run auto-pr-init after replacing it with the new push-free workflow.`))}for(let e of s){let t=n.join(i,e.dest);if(yield*r.exists(t))yield*q({event:"init",status:"skipped",path:pt(t),reason:"already exists"});else if(e.content!==void 0)yield*r.writeFileString(t,e.content),yield*q({event:"init",status:"created",path:pt(t)});else if(e.from!==void 0)yield*p(r,n,l,e.from,t),yield*q({event:"init",status:"created",path:pt(t)})}yield*q({event:"init",status:"next_steps",message:h})})}if(Ve.main==Ve.module)yn(T(function*(){let i=yield*_(()=>process.cwd());yield*m(i)}).pipe(fe(dt),fe(gn)),"init");export{m as runInit};

//# debugId=75FEB859BE7E82D864756E2164756E21
//# sourceMappingURL=auto-pr-init.js.map
