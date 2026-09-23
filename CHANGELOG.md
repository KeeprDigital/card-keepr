# Changelog

## 0.1.0 (2026-09-22)


### ⚠ BREAKING CHANGES

* **staging:** move extended scenarios out of the release path ([#393](https://github.com/KeeprDigital/card-keepr/issues/393))

### Features

* **cli:** one-command releases ([#407](https://github.com/KeeprDigital/card-keepr/issues/407)) ([5556ebc](https://github.com/KeeprDigital/card-keepr/commit/5556ebc71fccbd382516e4712cee1122e418006b))
* **cli:** promote the latest successful staging release with one confirmation ([#424](https://github.com/KeeprDigital/card-keepr/issues/424)) ([99eadd3](https://github.com/KeeprDigital/card-keepr/commit/99eadd3460d2d61f4880d5e5025ef7d55f658943))
* **cli:** read owner secrets from the repo-root .env ([#412](https://github.com/KeeprDigital/card-keepr/issues/412)) ([a9a43f8](https://github.com/KeeprDigital/card-keepr/commit/a9a43f8ed40629fa28ae09da4164f44fd08a2025))
* compact source show summary, paged request detail and per-command timeouts ([#410](https://github.com/KeeprDigital/card-keepr/issues/410)) ([d547287](https://github.com/KeeprDigital/card-keepr/commit/d547287a075200b4304d520bdd8e024e21a402f0))
* incremental source refresh and adaptive per-host pacing ([#404](https://github.com/KeeprDigital/card-keepr/issues/404)) ([00bce15](https://github.com/KeeprDigital/card-keepr/commit/00bce15b1abd62ef8b2f4e88bf4e40486f672172))
* **magic:** make the Scryfall facts-only import (tranche 0) publishable ([#408](https://github.com/KeeprDigital/card-keepr/issues/408)) ([e7ee25b](https://github.com/KeeprDigital/card-keepr/commit/e7ee25b933a221f2093548ed7b579525986da697))
* **pokemon:** prepare the full TCGdex declared-catalogue import ([#416](https://github.com/KeeprDigital/card-keepr/issues/416)) ([a78c639](https://github.com/KeeprDigital/card-keepr/commit/a78c639ddb20eb89e2ae0f1f6a4f60edf5e599c1))
* **release:** production promotion from a successful staging outcome ([#411](https://github.com/KeeprDigital/card-keepr/issues/411)) ([a614885](https://github.com/KeeprDigital/card-keepr/commit/a614885ad0115445d4992fc99d6b65a7dee20536))
* **riftbound:** add the HexDeck search census scope ([#414](https://github.com/KeeprDigital/card-keepr/issues/414)) ([47a267b](https://github.com/KeeprDigital/card-keepr/commit/47a267b90b1f65ab4ea7fee31bb49812aa76ae5a))
* **riftbound:** add the Piltover Archive gallery census scope ([#413](https://github.com/KeeprDigital/card-keepr/issues/413)) ([bb537ff](https://github.com/KeeprDigital/card-keepr/commit/bb537ff7eec81ba1516230dd4c97c6757a874649))
* select and publish image tranches incrementally ([#409](https://github.com/KeeprDigital/card-keepr/issues/409)) ([#415](https://github.com/KeeprDigital/card-keepr/issues/415)) ([07e2c54](https://github.com/KeeprDigital/card-keepr/commit/07e2c54f476da213e570e9141430ff05ca8ef5d2))


### Bug Fixes

* accept Bandai release dates with event qualifiers and treat same-site redirects as discoveries ([#334](https://github.com/KeeprDigital/card-keepr/issues/334)) ([d4e4611](https://github.com/KeeprDigital/card-keepr/commit/d4e4611a279c6a29bfc8e3ea96b2b033a9ba3d22))
* accept Bandai release dates with event qualifiers and treat same-site redirects as discoveries ([#334](https://github.com/KeeprDigital/card-keepr/issues/334)) ([c854336](https://github.com/KeeprDigital/card-keepr/commit/c8543363d1dc51e2909ecbfe5270f68d205b7a7a))
* **export:** admit season Release precision in export record schema v5 ([#406](https://github.com/KeeprDigital/card-keepr/issues/406)) ([23f2854](https://github.com/KeeprDigital/card-keepr/commit/23f2854ce7ce6c1a2c11f245f114ef4897a94e27))
* **release:** bind exact-commit CI gates to the named CI run's check suite ([#400](https://github.com/KeeprDigital/card-keepr/issues/400)) ([1996212](https://github.com/KeeprDigital/card-keepr/commit/1996212b3f43783ed180e6b2dab7936e93f21db3))


### Refactoring

* **staging:** move extended scenarios out of the release path ([#393](https://github.com/KeeprDigital/card-keepr/issues/393)) ([6e41f74](https://github.com/KeeprDigital/card-keepr/commit/6e41f744551170e89c5234d1c05a3bca52cd3260))


### Documentation

* record the repository rules for the release front door ([#392](https://github.com/KeeprDigital/card-keepr/issues/392)) ([f14e168](https://github.com/KeeprDigital/card-keepr/commit/f14e168a61b962228c68bd8c90c5b6ab7560da52)), closes [#238](https://github.com/KeeprDigital/card-keepr/issues/238)
* **repo-rules:** record the allow auto-merge setting ([#398](https://github.com/KeeprDigital/card-keepr/issues/398)) ([3808696](https://github.com/KeeprDigital/card-keepr/commit/38086962ca91a4ad213d727d37433767325ef9b3))


### Build and CI

* add conventional PR title check and release-please ([#391](https://github.com/KeeprDigital/card-keepr/issues/391)) ([0d0157b](https://github.com/KeeprDigital/card-keepr/commit/0d0157bb0152e3e56cc14e2c14215129b8600bc9))
* skip heavy jobs for docs-only changes ([#403](https://github.com/KeeprDigital/card-keepr/issues/403)) ([ca81b8d](https://github.com/KeeprDigital/card-keepr/commit/ca81b8dc4627b256c5e74de5d22cbbc1513a50b3))
