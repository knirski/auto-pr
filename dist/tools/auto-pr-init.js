#!/usr/bin/env node
import{Gb as t,Yb as u,_b as m,i as p,qd as f,ud as y,vd as h,yc as a}from"../auto-pr-get-commits-5hc1jm00.js";function d(){return[{dest:".github/workflows/auto-pr.yml",from:".github/workflows/auto-pr.yml"},{dest:".github/PULL_REQUEST_TEMPLATE.md",from:".github/PULL_REQUEST_TEMPLATE.md"},{dest:".nvmrc",from:".nvmrc"}]}function g(i,r,s,c,o){return t.gen(function*(){let n=r.join(s,c),e=yield*i.readFileString(n),l=r.dirname(o);yield*i.makeDirectory(l,{recursive:!0}),yield*i.writeFileString(o,e)})}function P(i){return t.gen(function*(){let r=yield*u.FileSystem,s=yield*m.Path,c=yield*s.fromFileUrl(new URL(import.meta.url)),o=s.join(s.dirname(c),"..","..");for(let n of d()){let e=s.join(i,n.dest);if(yield*r.exists(e))yield*t.log({event:"init",status:"skipped",path:a(e),reason:"already exists"});else if(n.content!==void 0)yield*r.writeFileString(e,n.content),yield*t.log({event:"init",status:"created",path:a(e)});else if(n.from!==void 0)yield*g(r,s,o,n.from,e),yield*t.log({event:"init",status:"created",path:a(e)})}yield*t.log({event:"init",status:"next_steps",message:`Next steps (required for the workflow to create PRs):
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

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for full instructions.`})})}if(p.main==p.module)h(t.gen(function*(){let i=yield*t.sync(()=>process.cwd());yield*P(i)}).pipe(t.provide(f),t.provide(y)),"init");export{P as runInit};

//# debugId=63D3C1FE81ED516364756E2164756E21
//# sourceMappingURL=auto-pr-init.js.map
