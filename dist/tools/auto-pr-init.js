#!/usr/bin/env node
import{Q as a,W as u,Y as f,Z as y,da as g,va as h}from"../auto-pr-generate-content-y9kmgeyd.js";import{Ba as p,he as t,lg as d,og as m}from"../auto-pr-generate-content-whajt0bh.js";function P(r,s,o,l,n){return t.gen(function*(){let c=s.join(o,l),e=yield*r.readFileString(c),i=s.dirname(n);yield*r.makeDirectory(i,{recursive:!0}),yield*r.writeFileString(n,e)})}function v(r){return t.gen(function*(){let s=yield*d.FileSystem,o=yield*m.Path,l=yield*t.fromResult(g.fromString(import.meta.url)).pipe(t.mapError((e)=>Error(`Invalid import.meta.url: ${e.message}`))),n=yield*o.fromFileUrl(l),c=o.join(o.dirname(n),"..","..");for(let e of h()){let i=o.join(r,e.dest);if(yield*s.exists(i))yield*t.log({event:"init",status:"skipped",path:a(i),reason:"already exists"});else if(e.content!==void 0)yield*s.writeFileString(i,e.content),yield*t.log({event:"init",status:"created",path:a(i)});else if(e.from!==void 0)yield*P(s,o,c,e.from,i),yield*t.log({event:"init",status:"created",path:a(i)})}yield*t.log({event:"init",status:"next_steps",message:`Next steps (required for the workflow to create PRs):
1. Create a GitHub App: https://github.com/settings/apps/new
   - Permissions: Contents, Pull requests (Read and write)
   - Webhook: Uncheck Active
2. Generate a private key (app settings → Private keys)
3. Install the app on this repository
4. Add secrets to Settings → Secrets and variables → Actions:
   - APP_ID (from app settings → About)
   - APP_PRIVATE_KEY (full contents of the .pem file)

Then push to ai/** to test:
  git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for full instructions.`})})}if(p.main==p.module)y(t.gen(function*(){let r=yield*t.sync(()=>process.cwd());yield*v(r)}).pipe(t.provide(u),t.provide(f)),"init");export{v as runInit};

//# debugId=8EE71E3A60486B9264756E2164756E21
//# sourceMappingURL=auto-pr-init.js.map
