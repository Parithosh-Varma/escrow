# Static Analysis Report — Slither 0.11.4 (solc 0.8.24)

Scope: `EscrowCore.sol`, `DisputeModule.sol` (+ deps). Command:
`slither EscrowCore.sol` / `slither DisputeModule.sol` (per-file to skip lib noise).
Date: 2026-08-26. Re-run after every contract change; findings below are the V1 baseline.

## Findings & dispositions

| Detector | Location | Severity | Disposition |
|----------|----------|----------|-------------|
| missing-zero-check | `initialize`/`setDisputeModule`/`setEscrowCore` | Low | **FIXED** — `ZeroAddress()` guards added pre-deploy |
| events-maths | `setPlatformFeeBps` state change without event | Low | **FIXED** — `PlatformFeeBpsSet` / `ReviewTimeoutSet` emitted (indexer parity) |
| reentrancy-events | `createDispute` emitted `DisputeOpened` after external call | Informational | **FIXED** — event moved before `markDisputed`; no semantic change (revert rolls back emission either way) |
| divide-before-multiply | bps fee math (`approveMilestone`, `resolvePayout`) | Informational | Accepted. Two-level floor division; identities `net+fee+remainder == amount` hold exactly by construction; enforced continuously by invariant suite (`invariant_escrowBalanceFullyAccounted`, 187k-call campaign green) |
| uninitialized-local | `total` in `createProject` | Informational | False positive — zero-default accumulator, summed then stored |
| incorrect-equality | `getRemainderState` view | Informational | View-only status derivation; no risk |
| timestamp dependence | review/challenge/dispute windows | Disclosure | By design; 15s L2 block-time drift acceptable for day-scale windows |
| costly-loop | `createProject` milestone loop | Gas note | Hard-capped at 50 milestones |
| naming-convention / assembly / pragma-mix / unused-state(`__gap`) | OZ + gap pattern | Informational | Expected for UUPS + OZ v5 |

## Residual risk accepted for V1

- Backend-adjudicated dispute resolution (disclosed v1 scope limit — see README).
- `block.timestamp` as clock on L2 (sequencer-controlled but economically irrational to
  manipulate at these magnitudes).

## Complementary assurance

- Foundry chaos-invariant campaign: `EscrowInvariants.t.sol`
  (`FOUNDRY_PROFILE=heavy forge test --match-contract EscrowInvariants`):
  250 runs × 750 calls, payout-conservation + earmark-vs-emergencyWithdraw properties,
  plus meta-invariant proving every settlement path is exercised per run.
