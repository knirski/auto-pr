#!/usr/bin/env node
import{i as h}from"../auto-pr-get-commits-p5wzpwwb.js";import{Ad as y,Bd as g,Fc as a,Mb as t,dc as d,fc as u,m,wd as f}from"../auto-pr-get-commits-gdmf6v06.js";function p(){return[{dest:".github/workflows/auto-pr.yml",from:".github/workflows/auto-pr.yml"},{dest:".github/PULL_REQUEST_TEMPLATE.md",from:".github/PULL_REQUEST_TEMPLATE.md"},{dest:".nvmrc",from:".nvmrc"}]}function P(r,n,s,c,o){return t.gen(function*(){let l=n.join(s,c),e=yield*r.readFileString(l),i=n.dirname(o);yield*r.makeDirectory(i,{recursive:!0}),yield*r.writeFileString(o,e)})}function E(r){return t.gen(function*(){let n=yield*d.FileSystem,s=yield*u.Path,c=yield*t.fromResult(h.fromString(import.meta.url)).pipe(t.mapError((e)=>Error(`Invalid import.meta.url: ${e.message}`))),o=yield*s.fromFileUrl(c),l=s.join(s.dirname(o),"..","..");for(let e of p()){let i=s.join(r,e.dest);if(yield*n.exists(i))yield*t.log({event:"init",status:"skipped",path:a(i),reason:"already exists"});else if(e.content!==void 0)yield*n.writeFileString(i,e.content),yield*t.log({event:"init",status:"created",path:a(i)});else if(e.from!==void 0)yield*P(n,s,l,e.from,i),yield*t.log({event:"init",status:"created",path:a(i)})}yield*t.log({event:"init",status:"next_steps",message:`Next steps (required for the workflow to create PRs):
1. Create a GitHub App: https://github.com/settings/apps/new
   - Permissions: Contents, Pull requests (Read and write)
   - Webhook: Uncheck Active
2. Generate a private key (app settings → Private keys)
3. Install the app on this repository
4. Add secrets to Settings → Secrets and variables → Actions:
   - APP_ID (from app settings → About)
   - APP_PRIVATE_KEY (full contents of the .pem file)

Then push to ai/* to test:
  git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for full instructions.`})})}if(m.main==m.module)g(t.gen(function*(){let r=yield*t.sync(()=>process.cwd());yield*E(r)}).pipe(t.provide(f),t.provide(y)),"init");export{E as runInit};

//# debugId=D2BB5A1F1D538D9364756E2164756E21
//# sourceMappingURL=auto-pr-init.js.map
