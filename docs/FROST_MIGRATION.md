# FROST 2-of-3 Threshold Custody: Deployment & Migration Runbook

This runbook moves the pool from single-key custody (one VPS holding
`GUARDIAN_SEED`) to 2-of-3 FROST(Ed25519, Blake2b-512) threshold custody
across three machines, without losing funds and without breaking existing
deposits.

## Architecture

- **guardian-1** (existing VPS, coordinator): runs the indexer + guardian as
  today, holds FROST share 1, orchestrates signing ceremonies.
- **guardian-2** (second VPS): runs `vela_cosigner`, holds share 2.
- **guardian-3** (low-cost VPS): runs `vela_cosigner`, holds share 3.

Any 2 of 3 shares sign; the full pool private key never exists anywhere —
key generation is a true DKG (no trusted dealer). Cosigners are not blind
signers: before contributing a share they independently recompute the block
hash from raw fields, re-verify the Groth16 proof, check the Merkle root
with the indexer, enforce their own persisted nullifier set, and check the
ledger through their own RPC view. A compromised coordinator alone can move
funds only through a valid withdrawal.

The ciphersuite is implemented first-party in `frost/src/suite.rs`: an
unmodified-frost-core ciphersuite substituting Blake2b-512 for SHA-512, so
joint signatures verify as ordinary Nano signatures. The ciphersuite ID
string is a frozen protocol constant embedded in all deployed key material —
never change it without a fresh DKG and full fund migration.

## 0. Prerequisites

- Two new VPSes (any provider; the third can be the cheapest tier — it only
  needs Python, Node, Tor, and a few MB of state). Ideally a different
  provider/region than guardian-1.
- SSH key access to all three machines.
- `frost/` builds: `cd frost && cargo build --release`.

## 1. Set up the new machines

On each new VPS (as root):

```bash
bash setup_cosigner_vps.sh 2   # or 3 on the third machine
```

This installs deps, prompts for the shared `COSIGNER_API_KEY` (generate one:
`openssl rand -hex 32`), the box's own `NANO_RPC_KEY`, and the indexer URL,
and creates a Tor hidden service for the cosigner port.

From the dev machine, deploy code and build the CLI:

```bash
COSIGNER_HOST=root@<host2> bash scripts/deploy_cosigner.sh
COSIGNER_HOST=root@<host3> bash scripts/deploy_cosigner.sh
```

On guardian-1, also build/install the CLI and configure the coordinator env
(add to the guardian service environment):

```
FROST_DATA_DIR=/opt/vela/data/frost
FROST_ID=1
FROST_COSIGNERS=2@http://<cosigner2>,3@http://<cosigner3>
COSIGNER_API_KEY=<shared key>
FROST_GUARDIAN_BIN=/opt/vela/bin/frost-guardian
```

(For Tor-only cosigners, front the onion address with a local
`torsocks`/privoxy proxy or expose the port on a private interface.)

## 2. Key generation ceremony (DKG)

Copy `config/frost_hosts.example.json`, fill in real hosts, then:

```bash
python3 scripts/frost_ceremony.py --hosts config/frost_hosts.json
```

Per denomination this runs the 3-round DKG (secrets never leave each box),
cross-checks that all three machines derived the same group public key,
test-signs with every 2-of-3 pair while the key still holds nothing, and
only then installs `group_pubkey` — the file whose presence switches the
guardian, indexer, and web clients over to the new pool address.

Rehearse locally first (no remote hosts needed): point all three entries at
local temp dirs with `"ssh": null`.

## 3. Fund migration

On guardian-1, with the guardian service **stopped** (so it doesn't race the
sweep with its own receives):

```bash
systemctl stop vela-guardian
python3 scripts/migrate_pool.py            # add --dry-run first
systemctl start vela-guardian
```

Per denomination the script: drains receivables into the old account,
sweeps the full balance to the threshold account (the old key's last
signature), threshold-receives it (cosigners verify the source send
on-chain), waits for confirmation at each step, and records the old pubkey
in `legacy_pubkeys` so pre-migration deposit commitments remain provable
and indexable. It is journaled (`data/migration_journal.json`), idempotent,
and resumable; funds rest safely between any two steps.

**The script never deletes `GUARDIAN_SEED`.** Keep it offline until you
have independently confirmed all threshold-account balances (it can still
receive stragglers sent to the old address); destroy it only then.

## 4. What changes at runtime

- `pool_pubkey()/pool_address()` return the FROST group key for migrated
  denominations; unmigrated ones keep the seed key (per-denomination
  rollout is supported).
- Guardian signing (`receive` and `withdraw`) goes through the 2-round
  FROST ceremony with the first available cosigner; either cosigner being
  up is sufficient (liveness: 2-of-3).
- `pool_keypair()` hard-raises for migrated denominations — no code path
  can accidentally use a single key.
- `/api/pool_address` also returns `legacy_pubkeys`; web clients try all
  candidates when matching old shields.

## 5. Verification & tests

- `bash` e2e of the CLI + DKG + signing: `tests/test_frost_stack.py`
  (3-party DKG, real cosigner HTTP service, joint signature verified with
  `ed25519_blake2b`, tampered-context/unknown-type/bad-key refusals).
- Ceremony rehearsal: local-mode `frost_ceremony.py` run.

## Recovery scenarios

- **One machine lost:** funds are safe and live (any 2 of 3 sign). Build a
  replacement box and run a fresh ceremony + migration to rotate to a new
  2-of-3 key set (repeat this runbook; the current threshold key plays the
  role of the "old" key — its sweep is signed by the remaining 2 shares).
- **Two machines lost:** funds are frozen (by design, they cannot be
  stolen either). This is why the third, low-cost share exists — keep an
  offline backup of one cosigner's `data/frost` directory if you want an
  extra recovery path, understanding it weakens the 2-machine compromise
  bound to that backup's storage.
