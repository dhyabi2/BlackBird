# New Critical Areas for VELA v2

This document lists three new categories of critical issues identified for brainstorming:

1. Pattern-matching risks
2. Small-amount alongside big-amount issues
3. Ease, scalability, and deployment issues

---

## 1. Pattern-matching risks

Pattern matching allows an observer to link deposits and withdrawals or identify VELA users. Every reproducible or distinguishing behavior is a risk.

### 1.1 Fixed denominations

- Using a small set of fixed amounts makes all withdrawals of the same size look identical, but it also means the amount itself is a coarse fingerprint.
- If few denominations are active, an observer can cluster withdrawals by denomination.

### 1.2 Deposit-to-withdrawal timing

- A withdrawal shortly after a deposit of the same denomination is a temporal link.
- Round numbers, business-hour patterns, and burst behavior reduce the anonymity set.

### 1.3 Address format and stealth-address derivation

- If stealth addresses use a predictable derivation, observers may recognize VELA withdrawals.
- Reusing view keys or spend keys across withdrawals creates linkability.

### 1.4 Withdrawal recipient clustering

- Withdrawals to addresses that later interact with the same services cluster the user.
- Dusting or change-management patterns can deanonymize.

### 1.5 ZK proof metadata

- Proof size, generation time, or public signal structure may fingerprint the VELA client.
- Reusing randomness or nonces across proofs is catastrophic.

### 1.6 Network and transport metadata

- HTTPS/Tor access patterns, User-Agent, request timing, and IP clustering can identify users.
- Fixed guardian/indexer endpoints create observable traffic patterns.

### 1.7 Fee patterns

- Fixed withdrawal fees or fee rounding can fingerprint transactions.
- Fee amounts visible on-chain correlate withdrawals.

### 1.8 Epoch and batching patterns

- Roots published at fixed epoch boundaries create predictable timing.
- Deposits and withdrawals clustered around epoch changes reduce anonymity.

---

## 2. Small-amount alongside big-amount issues

VELA should support both small and large value transfers without fragmenting privacy or usability.

### 2.1 Fixed denomination granularity

- A small set of denominations cannot represent arbitrary amounts.
- Users needing 0.15 XNO may have to do multiple withdrawals or over-deposit.

### 2.2 Minimum viable denomination

- Very small denominations may be uneconomical due to PoW/RPC costs and withdrawal fees.
- Dust outputs are impractical on Nano.

### 2.3 Proof cost independent of amount

- Groth16 proof generation costs the same CPU/time regardless of whether withdrawing 0.001 or 1000 XNO.
- Small withdrawals pay disproportionately high relative cost.

### 2.4 Fee structure

- Flat fees hurt small withdrawals; percentage fees may leak amount information.
- Fee must be visible on-chain, potentially linking withdrawals.

### 2.5 Pool liquidity fragmentation

- Separate pools per denomination fragment liquidity.
- A single mixed pool may break privacy if amounts are visible.

### 2.6 Confirmation and PoW cost

- Small amounts still require full PoW and Nano confirmation.
- No concept of "lower security" for smaller values.

### 2.7 Denomination standardization

- Users must know which denominations exist and split/combine withdrawals accordingly.
- Poor UX for non-technical users.

---

## 3. Ease, scalability, and deployment issues

VELA must be easy to run, scale with usage, and deploy without heroic effort.

### 3.1 Client proof generation

- snarkjs + Node bridge is slow and heavy.
- Proof generation time limits throughput and UX.

### 3.2 Trusted setup

- Groth16 requires a trusted setup per circuit change.
- Running an MPC ceremony is hard and risky.

### 3.3 Circuit size and constraints

- Depth-20 Poseidon Merkle tree is large.
- Larger circuits mean longer proving, bigger artifacts, and higher verification cost.

### 3.4 Indexer storage and computation

- Indexers must scan the entire Nano chain and build Merkle trees.
- Storage grows with deposits; recomputation is expensive.

### 3.5 Guardian operational complexity

- FROST DKG, share refresh, and secure key backup are hard.
- Running a guardian requires 24/7 availability and security expertise.

### 3.6 RPC dependency and rate limits

- Public RPCs throttle heavy usage.
- Running a dedicated Nano node is expensive.

### 3.7 PoW generation

- CPU PoW is slow for send blocks.
- Remote PoW providers can fail or censor.

### 3.8 Deployment and updates

- Circuit updates require client updates and new trusted setup.
- Coordinating guardian software updates is hard.

### 3.9 Onboarding and UX

- Users need to manage seeds, view keys, stealth addresses, and proofs.
- CLI-only prototype is not accessible.

### 3.10 Tor and networking

- Tor hidden services add latency and operational complexity.
- Not all users can or want to use Tor.

---

## Priority order for brainstorming

1. Pattern-matching: fixed denominations and timing
2. Small+big amounts: denomination scheme and fee structure
3. Scalability: client proof generation and circuit size
4. Ease/deployment: indexer storage and guardian operations
5. UX/onboarding
6. RPC/PoW dependency
