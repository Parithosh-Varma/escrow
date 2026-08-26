# Storage Layout & UUPS Upgrade Guide (V1 → V2)

Audience: whoever authors `EscrowCoreV2` / `DisputeModuleV2`. Read this BEFORE writing a
single state variable. A wrong slot is silent fund corruption, not a revert.

Generated from `forge inspect <Contract> storage-layout` at V1 tag (solc 0.8.24, OZ v5).
Regenerate and diff as the FIRST step of any upgrade PR.

---

## 1. The rules (non-negotiable)

1. **Append-only.** Never remove, reorder, rename, or retype an existing state variable.
   Renames keep their slot but break tooling/indexers that rely on getters.
2. **New variables go where the gap was.** Both contracts reserve a trailing
   `uint256[__gap]` array exactly for this: shrink it **from the end**, by the number of
   new slots consumed, and declare the new variables **after** what used to be the last
   real variable (i.e., they occupy the former gap slots, contiguously).
3. **Never let total declared storage exceed slot 59 (EscrowCore) / 53 (DisputeModule)** —
   beyond that you're into slots that were never reserved. If the gap runs out, deploy a
   fresh proxy + migrate instead of overwriting unknown storage.
4. **OZ v5 inherited state lives in ERC-7201 namespaces, NOT in sequential slots**
   (`Initializable`, `Ownable`/`Ownable2Step`, `Pausable`, `ReentrancyGuard`, `UUPS` each
   hash to a dedicated namespace like `openzeppelin.storage.Ownable`). Consequences:
   - Sequential slots 0+ below are exclusively *this* contract's variables.
   - Do NOT add `OwnableUpgradeable`-style v4 parents or anything else that would claim
     sequential slots; keep inheritance set identical to V1.
5. **Structs inside mappings pack within each slot independently per mapping key**, but the
   struct's *field layout is frozen* once deployed. Adding a field to `Project`/`Milestone`
   shifts every later field — forbidden. Add parallel mappings instead
   (e.g., `mapping(uint256 => uint64) milestoneEscrowDeadline`).
6. **Constants/immuteables are fine to add freely** (no storage). Enums can gain new
   members only at the END (event/indexer compatibility aside).
7. Verify with tooling, not eyeballs:
   ```bash
   forge inspect EscrowCoreV1 storage-layout > /tmp/v1.txt
   forge inspect EscrowCoreV2 storage-layout > /tmp/v2.txt
   diff /tmp/v1.txt /tmp/v2.txt   # V1 rows must be byte-identical
   ```
   Consider a CI job that fails on any diff touching pre-existing rows.

### Worked example — adding one uint256 in V2

```solidity
uint256[43] private __gap;          // V1: slots 17..59

// V2:
uint256 public disputeFeeRecipient; // NEW: slot 17 (former gap[0])
uint256[42] private __gap;          // shrunk by 1: slots 18..59
```

---

## 2. EscrowCore @ slot map (V1)

Inherited (ERC-7201 namespaced, no sequential slots): Initializable, Ownable2Step,
Pausable, ReentrancyGuard, UUPS.

| Slot | Variable | Type | Notes |
|-----:|----------|------|-------|
| 0 | `disputeModule` | address | trusted caller for `markDisputed`/`resolvePayout` |
| 1 | `platformFeeRecipient` | address | fee sink |
| 2 | `platformFeeBps` | uint256 | ≤ 5000 enforced |
| 3 | `defaultReviewTimeout` | uint256 | seconds, ≥ 1h enforced |
| 4 | `challengeWindow` | uint256 | seconds, ≥ 1h enforced |
| 5 | `nextProjectId` | uint256 | starts at 1 |
| 6 | `nextMilestoneId` | uint256 | starts at 1 |
| 7 | `allowedTokens` | mapping(address ⇒ bool) | |
| 8 | `projects` | mapping(uint256 ⇒ Project) | Project: id, client, freelancer, token, totalAmount, uint32 count, uint8 status, uint64 createdAt |
| 9 | `milestones` | mapping(uint256 ⇒ Milestone) | Milestone: id, projectId, uint32 idx, uint128 amount, uint8 status, uint32 approvedBps, uint64 reviewDeadline, bytes32 deliverableHash, bytes32 powHash, uint64 submittedAt |
| 10 | `projectMilestoneIds` | mapping(uint256 ⇒ uint256[]) | internal |
| 11 | `milestoneClient` | mapping(uint256 ⇒ address) | denormalized hot-path cache |
| 12 | `milestoneFreelancer` | mapping(uint256 ⇒ address) | " |
| 13 | `milestoneToken` | mapping(uint256 ⇒ address) | " |
| 14 | `totalEscrowedByToken` | mapping(address ⇒ uint256) | **earmark ledger — emergencyWithdraw safety depends on it** |
| 15 | `remainderHeld` | mapping(uint256 ⇒ uint128) | challenge-window holds |
| 16 | `challengeDeadline` | mapping(uint256 ⇒ uint64) | " |
| 17–59 | `__gap` | uint256[43] | **43 free slots for V2** |

Next unreserved slot: **60** (do not use).

## 3. DisputeModule @ slot map (V1)

Inherited (ERC-7201 namespaces): Initializable, Ownable2Step, Pausable,
ReentrancyGuard, UUPS.

| Slot | Variable | Type | Notes |
|-----:|----------|------|-------|
| 0 | `escrowCore` | address | |
| 1 | `authorizedBackends` | mapping(address ⇒ bool) | v1 adjudicators |
| 2 | `nextDisputeId` | uint256 | starts at 1 |
| 3 | `disputes` | mapping(uint256 ⇒ Dispute) | Dispute: id, milestoneId, uint8 type, raisedBy, string reason, uint8 jurorCount, uint8 phase, uint64 commitDeadline, uint64 revealDeadline, uint8 outcome, uint16 splitBps, uint64 createdAt, uint8 revealedCount |
| 4 | `activeDisputeForMilestone` | mapping(uint256 ⇒ uint256) | 0 = none; one-dispute guard |
| 5 | `disputeJurors` | mapping(uint256 ⇒ address[]) | |
| 6 | `votes` | mapping(uint256 ⇒ mapping(address ⇒ JurorVote)) | JurorVote: bytes32 commitment, uint8 revealedVote, bool committed, bool revealed |
| 7 | `isAssignedJuror` | mapping(uint256 ⇒ mapping(address ⇒ bool)) | internal |
| 8 | `commitWindow` | uint256 | default 2 days |
| 9 | `revealWindow` | uint256 | default 2 days |
| 10–53 | `__gap` | uint256[44] | **44 free slots for V2** |

Next unreserved slot: **54** (do not use).

---

## 4. Upgrade procedure checklist

1. Branch → implement V2 following §1 rules.
2. `forge inspect ... storage-layout` diff: pre-existing rows byte-identical; gap shrunk
   by exactly the newly added slots; nothing past slot 59 / 53.
3. Unit + invariant suites re-run against V2 attached to a V1-state fixture
   (fund projects, partial approvals with live windows, open disputes — then upgrade).
   `forge test --match-contract EscrowInvariants` must stay green post-upgrade.
4. Full lifecycle smoke on Base Sepolia staging proxy before mainnet proposal.
5. Ship through governance: multisig proposes `upgradeToAndCall(v2, data)` on the timelock,
   waits out the delay, executes. No EOA shortcut exists by design (see Deploy.s.sol role
   renunciation).
6. Post-upgrade on-chain sanity: `totalEscrowedByToken(token)` equals indexer-computed sum
   of live allocations; a small approval + claim round-trip settles correctly.

## 5. Known sharp edges

- `claimRemainder` intentionally lacks `whenNotPaused` (clients may exit during incident).
  If V2 changes this, update the pause tests + README disclosure together.
- `_payout` is deliberately NOT `nonReentrant` (nested-guard regression — see unit tests).
  Any V2 refactor must keep guards on external entry points only.
- Fee math floors twice (bps split, then fee). Dust stays with... nobody: conservation is
  exact because `netToWorker + fee + remainder == amount` by construction. Preserve these
  exact identities in any V2 payout rewrite — the invariant suite will catch violations.
