#!/usr/bin/env python3
"""
FROST 2-of-3 distributed key generation ceremony for the VELA pool.

Runs the three-round DKG once per denomination across the three guardian
machines. Secret material NEVER leaves each machine: every round executes the
frost-guardian CLI on the participant's own host (over SSH for remote hosts),
and only public round packages transit through this orchestrator. At no point
does the full pool private key exist anywhere — that is the entire point.

After part 3, the ceremony test-signs a dummy message with each 2-of-3 pair
and verifies the joint signature, then installs group_pubkey files. This is
safe because the freshly generated key holds no funds yet.

Host configuration (config/frost_hosts.json):
[
  {"id": 1, "ssh": null,                  "dir": "data/frost", "bin": "frost/target/release/frost-guardian"},
  {"id": 2, "ssh": "root@cosigner2.host", "dir": "/opt/vela/data/frost", "bin": "/opt/vela/bin/frost-guardian"},
  {"id": 3, "ssh": "root@cosigner3.host", "dir": "/opt/vela/data/frost", "bin": "/opt/vela/bin/frost-guardian"}
]
"ssh": null means run locally. For a local-only rehearsal, point all three
entries at different local dirs with "ssh": null.

Usage:
  python3 scripts/frost_ceremony.py --hosts config/frost_hosts.json [--denominations 1e29,1e30,...]
"""
import argparse
import json
import shlex
import subprocess
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from src.vela_constants import DENOMINATIONS  # noqa: E402

MIN_SIGNERS = 2


class Host:
    def __init__(self, cfg: dict):
        self.id = int(cfg["id"])
        self.ssh = cfg.get("ssh")
        self.ssh_key = cfg.get("ssh_key")
        self.dir = cfg["dir"]
        self.bin = cfg["bin"]

    def _ssh_base(self) -> list:
        base = ["ssh"]
        if self.ssh_key:
            base += ["-i", os.path.expanduser(self.ssh_key)]
        return base + [self.ssh]

    def run(self, args: list, stdin: str = None) -> str:
        """Run a command on this host; return stdout."""
        if self.ssh:
            cmd = self._ssh_base() + [" ".join(shlex.quote(a) for a in args)]
        else:
            cmd = args
        proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise RuntimeError(f"host {self.id}: {' '.join(args[:2])} failed: {proc.stderr.strip()}")
        return proc.stdout

    def frost(self, subargs: list) -> dict:
        out = self.run([self.bin] + subargs)
        return json.loads(out.strip().splitlines()[-1])

    def write_file(self, path: str, content: str):
        if self.ssh:
            self.run(["mkdir", "-p", os.path.dirname(path)])
            proc = subprocess.run(
                self._ssh_base() + [f"cat > {shlex.quote(path)}"],
                input=content, capture_output=True, text=True, timeout=60,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"host {self.id}: write {path} failed: {proc.stderr.strip()}")
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(content)

    def path(self, *parts) -> str:
        return os.path.join(self.dir, *parts)


def dkg_for_denomination(hosts: list, denom: int) -> str:
    """Run the full DKG for one denomination; returns the group pubkey hex."""
    print(f"\n=== DKG for denomination {denom} ===")
    n = len(hosts)
    for h in hosts:
        # Refuse to overwrite an existing key share.
        kp = h.path(str(denom), "key_package")
        check = ["test", "-e", kp]
        try:
            h.run(check)
            raise RuntimeError(
                f"host {h.id} already has a key share for {denom} at {kp}; "
                "refusing to overwrite (delete it manually to re-run)"
            )
        except RuntimeError as e:
            if "refusing to overwrite" in str(e):
                raise
            # test -e failed -> file absent -> fine
        h.run(["mkdir", "-p", h.path(str(denom))])

    # Round 1: every host generates commitments.
    r1_packages = {}
    for h in hosts:
        out = h.frost([
            "dkg-part1", "--id", str(h.id),
            "--max-signers", str(n), "--min-signers", str(MIN_SIGNERS),
            "--secret-out", h.path(str(denom), "dkg_r1.secret"),
        ])
        r1_packages[h.id] = out["round1_package"]
        print(f"  host {h.id}: round 1 done")

    # Round 2: distribute peers' round-1 packages; collect per-peer round-2.
    r2_outgoing = {}  # sender -> {recipient: package}
    for h in hosts:
        peers = {str(i): p for i, p in r1_packages.items() if i != h.id}
        peers_path = h.path(str(denom), "dkg_r1_peers.json")
        h.write_file(peers_path, json.dumps(peers))
        out = h.frost([
            "dkg-part2",
            "--secret-in", h.path(str(denom), "dkg_r1.secret"),
            "--round1", peers_path,
            "--secret-out", h.path(str(denom), "dkg_r2.secret"),
        ])
        r2_outgoing[h.id] = {int(k): v for k, v in out["round2_packages"].items()}
        print(f"  host {h.id}: round 2 done")

    # Round 3: deliver each host the packages addressed to it; finalize.
    group_pubkeys = set()
    for h in hosts:
        incoming = {
            str(sender): pkgs[h.id]
            for sender, pkgs in r2_outgoing.items()
            if sender != h.id
        }
        r2_path = h.path(str(denom), "dkg_r2_in.json")
        h.write_file(r2_path, json.dumps(incoming))
        out = h.frost([
            "dkg-part3",
            "--secret-in", h.path(str(denom), "dkg_r2.secret"),
            "--round1", h.path(str(denom), "dkg_r1_peers.json"),
            "--round2", r2_path,
            "--key-package-out", h.path(str(denom), "key_package"),
        ])
        group_pubkeys.add(out["group_pubkey"])
        h.write_file(h.path(str(denom), "public_key_package"), out["public_key_package"])
        print(f"  host {h.id}: round 3 done, group pubkey {out['group_pubkey'][:16]}...")

    if len(group_pubkeys) != 1:
        raise RuntimeError(f"group pubkey mismatch across hosts: {group_pubkeys}")
    group_pubkey = group_pubkeys.pop()

    # Test-sign with every 2-of-3 pair BEFORE any funds touch this key.
    test_msg = "f" * 64
    for a, b in [(0, 1), (0, 2), (1, 2)]:
        ha, hb = hosts[a], hosts[b]
        sig = threshold_sign_pair(ha, hb, denom, test_msg)
        chk = hosts[0].frost([
            "verify", "--pubkey", group_pubkey, "--msg", test_msg, "--signature", sig,
        ])
        if not chk.get("valid"):
            raise RuntimeError(f"test signature by pair ({ha.id},{hb.id}) failed verification")
        print(f"  pair ({ha.id},{hb.id}): test signature verified")

    # Install group_pubkey files last: their presence is what switches the
    # guardian/indexer over to threshold custody for this denomination.
    for h in hosts:
        h.write_file(h.path(str(denom), "group_pubkey"), group_pubkey + "\n")
    print(f"  denomination {denom}: group pubkey installed on all hosts")
    return group_pubkey


def threshold_sign_pair(ha, hb, denom: int, msg_hex: str) -> str:
    """Sign msg with hosts ha and hb (used only for post-DKG test signing)."""
    commits = {}
    for h in (ha, hb):
        out = h.frost([
            "commit",
            "--key-package", h.path(str(denom), "key_package"),
            "--nonces-out", h.path(str(denom), "test.nonces"),
        ])
        commits[h.id] = out["commitments"]
    commits_path = ha.path(str(denom), "test_commits.json")
    ha.write_file(commits_path, json.dumps({str(k): v for k, v in commits.items()}))
    sp = ha.frost(["signing-package", "--msg", msg_hex, "--commitments", commits_path])["signing_package"]
    shares = {}
    for h in (ha, hb):
        out = h.frost([
            "sign",
            "--key-package", h.path(str(denom), "key_package"),
            "--nonces", h.path(str(denom), "test.nonces"),
            "--signing-package", sp,
        ])
        shares[h.id] = out["signature_share"]
    shares_path = ha.path(str(denom), "test_shares.json")
    ha.write_file(shares_path, json.dumps({str(k): v for k, v in shares.items()}))
    out = ha.frost([
        "aggregate",
        "--public-key-package", ha.path(str(denom), "public_key_package"),
        "--signing-package", sp,
        "--shares", shares_path,
    ])
    return out["signature"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hosts", required=True, help="JSON host config")
    ap.add_argument("--denominations", help="comma-separated raw amounts (default: all)")
    args = ap.parse_args()

    with open(args.hosts) as f:
        hosts = [Host(c) for c in json.load(f)]
    if len(hosts) != 3 or sorted(h.id for h in hosts) != [1, 2, 3]:
        sys.exit("expected exactly hosts with ids 1, 2, 3")

    from decimal import Decimal
    denoms = (
        [int(Decimal(d)) for d in args.denominations.split(",")]
        if args.denominations
        else sorted(DENOMINATIONS)
    )
    for d in denoms:
        if d not in DENOMINATIONS:
            sys.exit(f"{d} is not a protocol denomination: {sorted(DENOMINATIONS)}")

    results = {}
    for denom in denoms:
        results[denom] = dkg_for_denomination(hosts, denom)

    print("\n=== Ceremony complete ===")
    for denom, pub in results.items():
        print(f"  {denom}: group pubkey {pub}")
    print(
        "\nNext: run scripts/migrate_pool.py to move funds from the old\n"
        "single-key pool accounts into the new threshold accounts."
    )


if __name__ == "__main__":
    main()
