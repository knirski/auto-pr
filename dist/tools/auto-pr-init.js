#!/usr/bin/env node
import{Ha as d,Ja as m,Nb as u,Pb as a,Ub as f,ec as y,ic as g,j as p,jc as h,wa as t}from"../auto-pr-get-commits-rpvardsq.js";function P(r,n,o,c,s){return t.gen(function*(){let l=n.join(o,c),e=yield*r.readFileString(l),i=n.dirname(s);yield*r.makeDirectory(i,{recursive:!0}),yield*r.writeFileString(s,e)})}function E(r){return t.gen(function*(){let n=yield*d.FileSystem,o=yield*m.Path,c=yield*t.fromResult(f.fromString(import.meta.url)).pipe(t.mapError((e)=>Error(`Invalid import.meta.url: ${e.message}`))),s=yield*o.fromFileUrl(c),l=o.join(o.dirname(s),"..","..");for(let e of u()){let i=o.join(r,e.dest);if(yield*n.exists(i))yield*t.log({event:"init",status:"skipped",path:a(i),reason:"already exists"});else if(e.content!==void 0)yield*n.writeFileString(i,e.content),yield*t.log({event:"init",status:"created",path:a(i)});else if(e.from!==void 0)yield*P(n,o,l,e.from,i),yield*t.log({event:"init",status:"created",path:a(i)})}yield*t.log({event:"init",status:"next_steps",message:`Next steps (required for the workflow to create PRs):
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

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for full instructions.`})})}if(p.main==p.module)h(t.gen(function*(){let r=yield*t.sync(()=>process.cwd());yield*E(r)}).pipe(t.provide(y),t.provide(g)),"init");export{E as runInit};

//# debugId=6F53E2875116DD3564756E2164756E21
//# sourceMappingURL=auto-pr-init.js.map
