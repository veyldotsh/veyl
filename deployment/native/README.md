# Native accounting build

These patches extend the pinned Ethereum zkAPI daemon and wallet with durable
call bindings and verified settlement lookup. `source-lock.json` records exact
upstream revisions, official patch hashes and every changed source-file hash.
The original proof assets and cryptographic verification remain in use.

The `Native accounting checks` workflow runs the complete Go suite and both Rust
wallet/companion library suites on Linux ARM64, then builds both executables.
The build uses synthetic signed fixtures and makes no paid inference calls or
blockchain transactions. A passing build is not funded production acceptance.

`accepted-build.json` pins the particular successful CI run, commit, binary
hashes and build scripts accepted for installation. Reports supplied beside an
arbitrary executable are not sufficient provenance. Download artifacts from
that exact authenticated GitHub run, compare their hashes, and preserve the
reports together with the binaries. Give the service user read and execute
permission on the staged binaries before verification.

Stage one candidate under `/home/veyl/veyl/native-releases/<name>` and a separate
worker release under `/home/veyl/veyl/releases/<name>`. The combined upgrade
script verifies the candidate, runs a resource-bounded unfunded smoke, preserves
the original native files, then switches the Veyl worker and native components
together. It retains the existing environment and wallet-profile paths and
restores all code pointers if health fails. It never enables transaction,
funding, fee-conversion or social-publishing flags.

Unknown and older untracked calls remain reserved. The journals retain at most
10,000 records per profile and stop admission instead of deleting evidence.
Preserve wallet files and journals during backup, recovery and upgrades.
