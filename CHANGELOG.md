# Changelog

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
