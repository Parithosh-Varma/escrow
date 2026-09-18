# Escrow Contracts

Milestone-based freelance escrow with commit-reveal jury disputes. Base (L2), Solidity
0.8.24, UUPS-upgradeable, OpenZeppelin v5.

## Setup

All contracts/tests/scripts live flat in this directory (`contracts/files/`).

```bash
forge init --no-commit .   # if lib/ isn't already populated
forge install OpenZeppelin/openzeppelin-contracts@v5.0.0 --no-commit
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.0.0 --no-commit
forge install foundry-rs/forge-std --no-commit
forge build
forge test -vvv
```

> **Tooling note:** keep `via_ir = false` (default here). With solc 0.8.24 +
> foundry 1.7.1, IR-based compilation miscompiles cheatcode-heavy test contracts
> — `block.timestamp` reads fold across `vm.warp` calls, silently breaking every
> time-based test. None of these contracts need IR optimization.

## Layout (flat)

```
contracts/files/
  IEscrowCore.sol          # interface DisputeModule calls through
  IDisputeModule.sol       # minimal surface for off-chain tooling
  EscrowCore.sol           # fund custody, milestone lifecycle, challenge window, payout
  DisputeModule.sol        # commit-reveal disputes, v1 backend-adjudicated
  MockERC20.sol            # standard + fee-on-transfer + bad-return variants
  Deploy.s.sol             # timelock + both proxies + wiring + role renunciation
  Lifecycle.s.sol          # E2E lifecycle (3 phases: every settlement path + reconciliation)
  Handoff.s.sol            # governance completion: schedule -> wait -> execute via timelock
  MockStablecoin.s.sol     # test-USDC stand-in for E2E runs
  scripts/run_local_sim.sh # one-command anvil simulation of deploy+lifecycle+handoff
  EscrowCore.t.sol         # lifecycle, conservation fuzz, regression tests
  EscrowInvariants.t.sol   # chaos invariant campaign (conservation, earmark-vs-rescue)
  docs/STATIC_ANALYSIS.md  # slither baseline + triage
  docs/STORAGE_LAYOUT.md   # V1 slot maps + V2 upgrade rules
  docs/DEPLOYMENT.md       # Base Sepolia runbook + local sim results
```

## Partial-approval challenge window (design)

A partial approval (`approvedBps < 10000`) releases the freelancer's share and fee
immediately but **holds the remainder in escrow** behind a challenge window
(`challengeWindow`, default 7 days):

- Within the window the freelancer may dispute via DisputeModule (`markDisputed`
  accepts `Approved` milestones with a held remainder). Resolution distributes **only
  the held remainder** according to the decided split.
- If the window expires uncontested, anyone may call `claimRemainder` (permissionless,
  keeper-friendly); funds always go to the client.
- Full approvals (10000) settle everything immediately as before — nothing is held.

This closes the gap where a partial refund left the freelancer with nothing real to
dispute on-chain (previously the remainder left escrow at approval time).

## Fixes applied from design review (for audit context)

Issues caught across spec review rounds, fixed here so an auditor isn't left
rediscovering them:

1. **Nested `nonReentrant` would revert every payout.** The internal payout helper is
   intentionally *not* marked `nonReentrant` — only external entry points are. Covered
   by the three `test_regression_*PathDoesNotRevertOnNestedGuard` tests.
2. **Token allowlist enforced on-chain** (`createProject` reverts on `TokenNotAllowed`);
   fee-on-transfer tokens never reach the allowlist in a real deployment — see
   `test_feeOnTransferTokenBlockedByAllowlist`.
3. **SafeERC20 everywhere**, proven by `test_revertingReturnTokenCannotMisAccount`: a
   token returning `false` cannot silently mis-account state.
4. **Commitments bound to `msg.sender`**
   (`keccak256(abi.encodePacked(vote, salt, msg.sender))`) — see `test_commitCopyAttackFails`.
5. **`Vote` vs `DisputeOutcome` kept as separate enums** so `TieEscalated` stays reachable.
6. **Zero-reveal disputes resolve only as `TieEscalated`, only after deadline** —
   `test_zeroRevealResolvesAsTieEscalatedAfterDeadline`.
7. **Majority outcomes force full/zero splits**; graded splits are arbiter-only —
   `test_majorityOutcomeForcesFullSplit`.
8. **Quorum rule enforced**: below-quorum resolution blocked until reveal deadline —
   `test_resolveBelowQuorumBlockedUntilDeadline`.
9. **On-chain one-dispute-per-milestone enforcement** via `activeDisputeForMilestone`.
10. **`emergencyWithdraw` constrained to un-earmarked surplus** — cannot touch live
    milestone allocations or held remainders. Two dedicated tests.
11. **Cancellation disputes reachable pre-submission; other types require submission or
    a live challenge window** — three dedicated tests.
12. **Double-action guards tested**: fund/submit/approve/dispute all revert on replay.
13. **Pause coverage**: every lifecycle path freezes; *in-flight* dispute resolution
    stays callable during incidents, by design — `test_pauseBlocksLifecycleButNotResolution`.
14. **uint128 bounds checked explicitly** in `createProject` — silent downcast truncation
    rejected (`test_amountAboveUint128Rejected`).
15. **Fee capped at 50%** (`test_feeCapEnforced`).
16. **Timelock role hygiene**: `Deploy.s.sol` renounces every timelock role from the
    deployer EOA (including `TIMELOCK_ADMIN_ROLE` / `DEFAULT_ADMIN_ROLE`) so no EOA can
    re-grant governance powers post-deploy. Governance set is intentionally frozen;
    changing it requires a new timelock.
17. **OZ v5 import paths** (`utils/PausableUpgradeable.sol`,
    `utils/ReentrancyGuardUpgradeable.sol`) matching the v5-only
    `__Ownable_init(address)` API used here.
18. **2-step ownership** on both contracts; storage gaps reserved for UUPS upgrades.

## Known v1 scope limits (disclosed, not bugs)

- **Dispute resolution is backend-adjudicated in v1.** Juror commit-reveal votes are
  recorded on-chain as an audit trail, but `resolveDispute` takes its outcome/split from
  an authorized backend call rather than tallying votes on-chain. Acceptable for Phase 1
  (platform-team jurors). Quorum, deadline, and outcome/split consistency ARE enforced
  on-chain even so. v2/v3 should tally on-chain and make resolution permissionless.
- **Juror staking is DB-only in v1.** Non-participation emits `JurorNonParticipating`
  so the backend can apply DB-side consequences.
- **Backend indexer ABI alignment is pending.** These contracts' events supersede the
  placeholder ABIs in `backend/src/modules/indexer/service.ts` (event shapes changed,
  ids are sequential uint256 rather than bytes32/UUIDs, and settlement now spans
  `FundsReleased` / `RemainderHeld` / `RemainderClaimed`). The indexer service needs a
  rewrite against the deployed ABI plus a chain-id ↔ DB-UUID mapping layer.
- **Owner should be a Safe multisig behind a `TimelockController` before mainnet.**
  `Deploy.s.sol` wires everything except the final `acceptOwnership()`, which must be
  executed BY the timelock via a scheduled multisig proposal.

## Pre-mainnet checklist

- [ ] Owner accepted by Safe multisig + TimelockController (deploy script gets you most
      of the way there — see the note on `acceptOwnership` above)
- [ ] Full security audit
- [ ] Legal sign-off on money-transmission / MSB licensing
- [ ] `forge test` green including fuzz runs above default count
- [ ] Testnet end-to-end run on Base Sepolia with real test-USDC lifecycle
