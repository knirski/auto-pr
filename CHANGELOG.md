# Changelog

## Unreleased

### ⚠️ Breaking Changes

- **Programmatic generate-content API:** `GeneratePrContentFromValuesParams` and `runGeneratePrContent` no longer accept `retryDelayMs: number`. Use **`retryDelay?: Duration`** (Effect `Duration`, e.g. `Duration.seconds(3)`, `Duration.zero` in tests) instead.
- **AI generation path:** Multi-commit PR title/description uses **`LanguageModel.generateText`** plus JSON parsing and `TitleDescriptionSchema` validation — not `generateObject` / OpenAI `json_schema` (incompatible with GitHub Models and many OpenAI-compatible servers).
- **AI providers:** Removed the Ollama-specific integration (`ollama` npm package, `AUTO_PR_AI_OLLAMA_MODEL`, workflow `ai_ollama_model` / setup-ollama steps). Use **`local`** with `AUTO_PR_AI_OPENAI_COMPAT_URL`, `AUTO_PR_AI_OPENAI_COMPAT_MODEL`, and optional `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`, or **`github-models`** with `AUTO_PR_AI_OPENAI_COMPAT_MODEL` and `GH_TOKEN`. The reusable generate workflow defaults to **`github-models`** on GitHub-hosted runners. **`AUTO_PR_AI_GITHUB_MODEL` is removed** — use `AUTO_PR_AI_OPENAI_COMPAT_MODEL` for both providers.

## [0.1.5](https://github.com/knirski/auto-pr/compare/v0.1.4...v0.1.5) (2026-07-14)


### Features

* AI observability — token usage logging, tool call tracing, transient error handling ([#93](https://github.com/knirski/auto-pr/issues/93)) ([e89fe15](https://github.com/knirski/auto-pr/commit/e89fe15dd6a9e89dbfd8eeb0fe798b1c00db9dbb))
* AI pipeline resilience — diff sanitization and git command timeouts ([#95](https://github.com/knirski/auto-pr/issues/95)) ([2b90631](https://github.com/knirski/auto-pr/commit/2b90631dcd922496642e415c84eba913ff473991))
* **ci:** default GitHub Models to gpt-4.1 for generate ([#103](https://github.com/knirski/auto-pr/issues/103)) ([9bcc57a](https://github.com/knirski/auto-pr/commit/9bcc57a6c04f7db70e974c434704b25e97b321ab))
* **ci:** pin and run local llama server via Docker in workflows and integration ([#120](https://github.com/knirski/auto-pr/issues/120)) ([0528e4e](https://github.com/knirski/auto-pr/commit/0528e4ec343fda0976319cccdf5c82e51e1d02ca))
* **ci:** pin SBOM Node via .nvmrc and run after core checks ([#98](https://github.com/knirski/auto-pr/issues/98)) ([04050c2](https://github.com/knirski/auto-pr/commit/04050c2b28b7249538b1a505ecbbfff1f98f7b20))
* **ci:** resolve OpenAI model id and run local happy-path tests ([#99](https://github.com/knirski/auto-pr/issues/99)) ([15b41a4](https://github.com/knirski/auto-pr/commit/15b41a4b4619b404a2f72dfbf8326d0077997473))
* **ci:** skip main CI on website-only changes and add ci-website ([#105](https://github.com/knirski/auto-pr/issues/105)) ([ad173ed](https://github.com/knirski/auto-pr/commit/ad173edf6079d08fbfb8008404a57fad5584e450))
* **config:** validate AUTO_PR_AI_OPENAI_COMPAT_URL shape, fail early ([#136](https://github.com/knirski/auto-pr/issues/136)) ([90dac30](https://github.com/knirski/auto-pr/commit/90dac30fe1c6d2617e8fc2d18e4693b86b7e9841))
* **prompt:** pass existing PR title into multi-commit generate flow ([#124](https://github.com/knirski/auto-pr/issues/124)) ([f6a72ea](https://github.com/knirski/auto-pr/commit/f6a72ea9545f0a169401aea6cf18dbae53ddd68b))
* **routing:** add schema-typed github model routing and artifacts ([#229](https://github.com/knirski/auto-pr/issues/229)) ([431a593](https://github.com/knirski/auto-pr/commit/431a593637b7478ba517385943ca69a988e62bc1))
* **website:** implement Starlight documentation website with GitHub Pages CI deployment ([#87](https://github.com/knirski/auto-pr/issues/87)) ([f98300b](https://github.com/knirski/auto-pr/commit/f98300b7d25b10d278dc837be1026c1dcf153d78))


### Bug Fixes

* **ai:** normalize parallel tool-call history ([#235](https://github.com/knirski/auto-pr/issues/235)) ([62de41d](https://github.com/knirski/auto-pr/commit/62de41dd0aa3fac46f2b339de79ffa00c2f6f9ec))
* **ci:** guard add-dist job to release-please branches only ([4ae434c](https://github.com/knirski/auto-pr/commit/4ae434ce742fd024ec2917b2ced7819d375cb463))
* **ci:** make patch gate practical and project gate informational ([#231](https://github.com/knirski/auto-pr/issues/231)) ([9e1c229](https://github.com/knirski/auto-pr/commit/9e1c22955da65ac6ca520ba00c0d60db3538135a))
* **ci:** run astro via bun to avoid system Node.js version check ([#89](https://github.com/knirski/auto-pr/issues/89)) ([42df3fd](https://github.com/knirski/auto-pr/commit/42df3fd5d72e3d52a4bfed81912a7d28de2e3a53))
* **ci:** set GH_REPO env in create step to restore gh pr create repo context ([b80bc90](https://github.com/knirski/auto-pr/commit/b80bc907fd78cf56a7ed1bf8de8c7b66cea70644))
* **ci:** suppress CodeQL untrusted-checkout alerts and remove unnecessary checkout ([#92](https://github.com/knirski/auto-pr/issues/92)) ([64d20cb](https://github.com/knirski/auto-pr/commit/64d20cb5a2a0b988c6375e7071666e0b16bfd574))
* **ci:** use client-id for create-github-app-token inputs ([#134](https://github.com/knirski/auto-pr/issues/134)) ([54a6f29](https://github.com/knirski/auto-pr/commit/54a6f29c0784bf823ac3c67979c2a8bc53eae5c7))
* **config:** normalize optional run branch ([#194](https://github.com/knirski/auto-pr/issues/194)) ([b884560](https://github.com/knirski/auto-pr/commit/b884560bed712db86a92663123f936fae1ffe2f4))
* **config:** trim required env values ([#195](https://github.com/knirski/auto-pr/issues/195)) ([57cfce4](https://github.com/knirski/auto-pr/commit/57cfce464838d84d10e5bef64598f7771e9e5e93))
* **core:** extract first balanced model JSON object ([#183](https://github.com/knirski/auto-pr/issues/183)) ([4e0352a](https://github.com/knirski/auto-pr/commit/4e0352a3423867548a1705b8047ef9674e28ce68))
* **deps:** update bun, typescript, and other tools to latest versions ([#252](https://github.com/knirski/auto-pr/issues/252)) ([70699e3](https://github.com/knirski/auto-pr/commit/70699e3ee65a1a5967637fd32511fb11df99003e))
* **deps:** update transitive dependencies to resolve security vulnerabilities ([f9c6e7c](https://github.com/knirski/auto-pr/commit/f9c6e7c76e7d6b2f8fb7947426e281048fd5dcb7))
* jitter retry schedules ([#167](https://github.com/knirski/auto-pr/issues/167)) ([a56dd26](https://github.com/knirski/auto-pr/commit/a56dd26411598e973cc66992ae0407eaaf23e5b1))
* **workflow:** harden output and diff caps ([#224](https://github.com/knirski/auto-pr/issues/224)) ([b295709](https://github.com/knirski/auto-pr/commit/b2957092c5b7823f6b1b013a11f0d88cbfd83306))
* **workflow:** provide ChildProcessSpawner to PR client layer ([#198](https://github.com/knirski/auto-pr/issues/198)) ([da31776](https://github.com/knirski/auto-pr/commit/da31776272eaba61614fe65ae3f66ce25c78bbaf))
* **workflow:** retry pull request lookup ([#182](https://github.com/knirski/auto-pr/issues/182)) ([40251e9](https://github.com/knirski/auto-pr/commit/40251e991345c1a9038c2abda029e3fc7c7a10f3))
* **workflows:** scope paths-filter predicate quantifier ([#216](https://github.com/knirski/auto-pr/issues/216)) ([37208f2](https://github.com/knirski/auto-pr/commit/37208f2bc550f3b7526a3c7bd581ded7f2dc6a5a))

## [0.1.4](https://github.com/knirski/auto-pr/compare/v0.1.3...v0.1.4) (2026-04-07)


### Features

* add integration tests and split unit vs integration scripts ([dec0c8a](https://github.com/knirski/auto-pr/commit/dec0c8affafceb10ea0c35f583afa5a6c3e33910))
* **ci:** merge local act runner, JSON PR content, and act-smoke ([636348c](https://github.com/knirski/auto-pr/commit/636348cc67ec4d41e190bc220d55578393e1bfa2))
* **ci:** merge reusable integration workflow and GitHub Models tests ([a7a783c](https://github.com/knirski/auto-pr/commit/a7a783cdae1bdcc5b7cb2e3937cd4b324d4938b8))
* **diff-tool:** add DiffToolkit and GitContext for improved git operations ([#85](https://github.com/knirski/auto-pr/issues/85)) ([1a19a61](https://github.com/knirski/auto-pr/commit/1a19a61006272b09875b0f706df4b7531d2affde))
* generate PR content via generateText and parseFirstJsonObject ([1cf7911](https://github.com/knirski/auto-pr/commit/1cf791153ae5bd58ca2308cf2314e04d971e863a))
* **local-ci:** add act-local-ci core and run-check-act CLI ([019fa0d](https://github.com/knirski/auto-pr/commit/019fa0d969125e19951e936f83f2fddf4fc04c26))
* **nix:** add aarch64-darwin support and macOS CI with direnv integration ([#78](https://github.com/knirski/auto-pr/issues/78)) ([da2303f](https://github.com/knirski/auto-pr/commit/da2303fd7e882e16d328fd7bd8451721a0b195f8))
* **pr-description:** add Benefits section and bullet-format Motivation ([#81](https://github.com/knirski/auto-pr/issues/81)) ([2b54d06](https://github.com/knirski/auto-pr/commit/2b54d0634eff511202e357c1c6c6ad5268d59023))


### Bug Fixes

* **actions:** derive semantic count from semantic_subjects when composite output missing ([f5e4746](https://github.com/knirski/auto-pr/commit/f5e474643f4cc6a504421dd21830a4a819a7c70c))
* **actions:** expose get-commits outputs from auto-pr-run-command ([bc95b98](https://github.com/knirski/auto-pr/commit/bc95b98d944a1b2cfc63f3f2e51127e2b1cc6b1a))
* **ci:** add llama-ci Dockerfile for integration resolve-llama-server-tag ([bfa0db0](https://github.com/knirski/auto-pr/commit/bfa0db0a3006a33ed628d7c3af7cb6082492bfd0))
* **ci:** fix scorecard permissions cap and nix build ref ([#84](https://github.com/knirski/auto-pr/issues/84)) ([77b2191](https://github.com/knirski/auto-pr/commit/77b219173225b29d67f0bd0220942c6b0fd9cd80))
* **ci:** github-models integration test and llama-ci pin ([91a79fc](https://github.com/knirski/auto-pr/commit/91a79fc31d920d03b65404156f216b98874571fc))
* **ci:** integration tests use slim bunfig and minimal llama chat payload ([fa60b9b](https://github.com/knirski/auto-pr/commit/fa60b9b4550e87de6400609cee051bde830508d3))
* **ci:** prevent integration concurrency collision between ci and ci-workflows ([#86](https://github.com/knirski/auto-pr/issues/86)) ([474e272](https://github.com/knirski/auto-pr/commit/474e27269bbfa88c63c1bfc7720424b4dd546a9d))
* **ci:** provide BunServices layer for run-check-act CLI ([acbe1f0](https://github.com/knirski/auto-pr/commit/acbe1f01ca0a2895aa14737287bd6053acaf1ffd))
* **ci:** set GH_TOKEN for gh in act-smoke workflow ([10d6bb9](https://github.com/knirski/auto-pr/commit/10d6bb90fd03590f5fe31514c444c0be353e9d4f))
* **ci:** smoke-test local llama via GET /models ([ff9e570](https://github.com/knirski/auto-pr/commit/ff9e570e525eaefbf2d9ea31255131a33d534eb5))
* **ci:** stabilize llama server integration and workflow self-pinning ([#67](https://github.com/knirski/auto-pr/issues/67)) ([a0233bd](https://github.com/knirski/auto-pr/commit/a0233bd6f5dd8a71872624e4ab9a84f4c5d6d81e))
* default github-models to phi-4-mini-instruct ([297dd06](https://github.com/knirski/auto-pr/commit/297dd06bfdc570616d4d074b5620792948c02a75))
* **nix:** update bun.nix for bun.lock ([a710d0c](https://github.com/knirski/auto-pr/commit/a710d0ca16f30695a173764499ab6678d3adbe6a))
* **workflows:** pin reusable callers to commit with valid nested actions ([e2a8f00](https://github.com/knirski/auto-pr/commit/e2a8f006274e715bcb680524cfb7e551759fccc1))

## [0.1.3](https://github.com/knirski/auto-pr/compare/v0.1.2...v0.1.3) (2026-04-01)


### Features

* **ai:** add config-driven AI provider abstraction (Phase 1-5) ([#35](https://github.com/knirski/auto-pr/issues/35)) ([d447e17](https://github.com/knirski/auto-pr/commit/d447e17772b5af6f8a8d2e55e5eb9cf8523da811))
* **ai:** add github-models and openai-compat providers (Phase 6) ([#39](https://github.com/knirski/auto-pr/issues/39)) ([e39c6e0](https://github.com/knirski/auto-pr/commit/e39c6e00775e7000a4be885f7c9046000c132e4e))
* **auto-pr:** enhance PR title inference, AI validation, and CLI options ([#56](https://github.com/knirski/auto-pr/issues/56)) ([cf2e032](https://github.com/knirski/auto-pr/commit/cf2e0322ec528323dcd1c8121b58687ae08a7dc2))
* **ci:** add dist management for Node-only installs and fix CI workflows ([#29](https://github.com/knirski/auto-pr/issues/29)) ([f7c7454](https://github.com/knirski/auto-pr/commit/f7c745499fb3b38a6de1fd041ee678a0f327fc91))
* **ci:** add Gitleaks scan and env example template ([39987d6](https://github.com/knirski/auto-pr/commit/39987d6a2dd39ef044ea3dd360599676580f9ce4))
* **errors:** add AiProviderError, DescriptionParseError, and validateTitleDescription ([#32](https://github.com/knirski/auto-pr/issues/32)) ([e0a73a5](https://github.com/knirski/auto-pr/commit/e0a73a59ad87873b88af8522a97f7c62330da497))
* hand off PR title and body via pr-title.txt and pr-body.md ([#45](https://github.com/knirski/auto-pr/issues/45)) ([d91047d](https://github.com/knirski/auto-pr/commit/d91047d1129099c0a96fde0d113f33e5fb106913))


### Bug Fixes

* add experimental features flag to nix run ([#48](https://github.com/knirski/auto-pr/issues/48)) ([1003217](https://github.com/knirski/auto-pr/commit/100321735cce8c0a95d605ee9aac173e4c9b4f31))

## [0.1.2](https://github.com/knirski/auto-pr/compare/v0.1.1...v0.1.2) (2026-03-18)


### Features

* **ci:** add minimal ci-workflows for .github-only changes ([#22](https://github.com/knirski/auto-pr/issues/22)) ([e236937](https://github.com/knirski/auto-pr/commit/e2369377ceac293bc73ebed3da1ba9b1fbdc4477))
* migrate to Bun package manager and test runner ([#14](https://github.com/knirski/auto-pr/issues/14)) ([bb66629](https://github.com/knirski/auto-pr/commit/bb6662972178f87a2668a776cbe044a79174cca0))
* Update workflow to use Bun and pin to current commit ([#23](https://github.com/knirski/auto-pr/issues/23)) ([ac7350a](https://github.com/knirski/auto-pr/commit/ac7350ac8c7b2fc604773049a9c3927587b209a8))
* **workflows:** add automated update of self-referential pins ([#19](https://github.com/knirski/auto-pr/issues/19)) ([180899a](https://github.com/knirski/auto-pr/commit/180899a3d218c302af760aa46095f83552f58292))


### Bug Fixes

* update dependencies for npm sbom compatibility ([#18](https://github.com/knirski/auto-pr/issues/18)) ([72880f7](https://github.com/knirski/auto-pr/commit/72880f7fab70a4129e626c7b225c37074e38c2e8))
* **workflows:** push from detached HEAD in update-workflow-pins ([#20](https://github.com/knirski/auto-pr/issues/20)) ([326c5eb](https://github.com/knirski/auto-pr/commit/326c5ebfdde8f56c34608dafcdc917b19e9e3740))
* **workflows:** skip auto-pr when branch is default branch ([#21](https://github.com/knirski/auto-pr/issues/21)) ([3265c8d](https://github.com/knirski/auto-pr/commit/3265c8d569b19900f1921fc24fdffa12a4d518bb))

## [0.1.1](https://github.com/knirski/auto-pr/compare/v0.1.0...v0.1.1) (2026-03-16)


### Bug Fixes

* harden security and address CodeQL alerts ([#11](https://github.com/knirski/auto-pr/issues/11)) ([240448b](https://github.com/knirski/auto-pr/commit/240448bc3de691e7bf546b234f678ba5a776020c))
* resolve various issues and improve workflow ([#13](https://github.com/knirski/auto-pr/issues/13)) ([c517058](https://github.com/knirski/auto-pr/commit/c5170584eb6e9c94e386a70e6438091f14f02eff))
* **workflow:** grant pull-requests: write in auto-pr.yml caller ([#9](https://github.com/knirski/auto-pr/issues/9)) ([c2af558](https://github.com/knirski/auto-pr/commit/c2af55867f1f692c77932b1b95f7b7dc4acca2b3))


### Performance Improvements

* **test:** replace subprocess CLI tests with in-process, add pool threads ([#12](https://github.com/knirski/auto-pr/issues/12)) ([501955a](https://github.com/knirski/auto-pr/commit/501955a1fefd356b3e7ec441301776dafe2c1790))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
