# Deployment & E2E Runbook

Two identical paths — local anvil simulation (`scripts/run_local_sim.sh`, fully automated)
and live Base Sepolia. The scripts are the same; only the RPC, keys, and time handling
differ. The local sim has been executed end-to-end green (see §4).

## 1. Prerequisites

- Foundry (`forge`, `cast`, `anvil`)
- A funded deployer EOA on Base Sepolia (~0.05 ETH covers deploy + lifecycle)
- Env vars:
  - `BASE_SEPOLIA_RPC_URL` — e.g. `https://sepolia.base.org`
  - `DEPLOYER_KEY` — funded EOA private key
  - `MULTISIG_ADDRESS` — Safe/multisig that will hold timelock PROPOSER+CANCELLER
  - `FEE_RECIPIENT_ADDRESS`, `BACKEND_SIGNER_ADDRESS` — platform addresses
  - `STABLECOIN_ADDRESS` — test USDC. On Base Sepolia use Circle's testnet USDC if you can
    source it via faucet; otherwise deploy our stand-in first:
    `forge script MockStablecoin.s.sol --rpc-url $RPC --private-key $KEY --broadcast`
    (log line `MOCK_USDC: 0x…` is the address).

## 2. Deploy

```bash
forge script Deploy.s.sol \
  --rpc-url $RPC --private-key $DEPLOYER_KEY --broadcast --verify
```

Produces (logged + written to `deployments/deploy-84532.json`):
TimelockController (48h default; override with `TIMELOCK_DELAY_SECONDS`) → EscrowCore
UUPS proxy → DisputeModule UUPS proxy → wiring → allowlist → backend authorization →
ownership transfer initiated to timelock → **all deployer timelock roles renounced**
(including DEFAULT_ADMIN). No EOA can bypass the timelock after this point by design.

## 3. Lifecycle (per-actor keys; keepers replace vm.warp on live chains)

```bash
export CLIENT_KEY=… FREELANCER_KEY=… BACKEND_KEY=… JUROR1_KEY=… JUROR2_KEY=…
export JUROR3_KEY=… OWNER_KEY=$DEPLOYER_KEY

LIFECYCLE_PHASE=1 forge script Lifecycle.s.sol --rpc-url $RPC --broadcast -vvv
# … wait out the 7-day review timeout in real time (or a keeper calls it) …
LIFECYCLE_PHASE=2 forge script Lifecycle.s.sol --rpc-url $RPC --broadcast -vvv
# … wait out the 7-day challenge window …
LIFECYCLE_PHASE=3 forge script Lifecycle.s.sol --rpc-url $RPC --broadcast -vvv
```

Coverage per phase:

| Phase | Steps |
|-------|-------|
| 1 | P1 fund (1000 tUSDC) · M1 partial approve 70% (remainder 150 held) · post-approval `PartialAmount` dispute with REAL commit-reveal jury (2×ForFreelancer/1×ForClient) resolved ForFreelancer → remainder released in full · M2 full approve · M3 submit |
| 2 | M3 permissionless auto-release after review deadline · P2 fund (400) · M4 partial approve 25% (300 held) |
| 3 | M4 `claimRemainder` after uncontested window · third-party donation → owner `emergencyWithdraw` of exactly the surplus · hard reconciliation · pause/unpause smoke |

Phase 3 ends with on-chain reconciliation asserts: escrow balance == 0, earmark ledger
== 0, freelancer 1078e6, client 8900e6, fees 22e6. Any drift reverts the script.

## 4. Governance handoff (schedule → wait → execute)

```bash
MULTISIG_KEY=… HANDOFF_PHASE=1 forge script Handoff.s.sol --rpc-url $RPC --broadcast -vvv
# wait out the timelock delay (real time on Base; evm_increaseTime on anvil)
MULTISIG_KEY=… HANDOFF_PHASE=2 forge script Handoff.s.sol --rpc-url $RPC --broadcast -vvv
```

Schedules+executes `acceptOwnership()` on both proxies AND a representative admin op
(`setPlatformFeeBps(150)`) through the timelock, proving the full governance loop.
Note: `vm.warp` does NOT persist across broadcast transactions — time must elapse on the
node/chain between schedule and execute. This is why lifecycle/handoff are phased.

### Local verification of the complete flow

`zsh scripts/run_local_sim.sh` runs all of the above against fresh anvil (10s timelock,
node-clock advancement). Last run's final state, read back from the chain:

- escrow.owner() == dispute.owner() == timelock
- platformFeeBps() == 150 (set via timelock proposal)
- deployer holds no timelock roles (hasRole(DEFAULT_ADMIN, deployer) == false)
- escrow balance 0 / earmark ledger 0 after full lifecycle

## 5. Post-deploy checklist (Base Sepolia)

- [ ] Save `deployments/deploy-84532.json` (commit it — audit artifact)
- [ ] `forge verify-contract` each impl + proxy (Etherscan v2 API key)
- [ ] Multisig completes `acceptOwnership` proposals (§4) before any real funds move
- [ ] Indexer pointed at proxy addresses; events supersede placeholder ABIs (README)
- [ ] Re-run invariant suite against a fork of the deployed state before mainnet:
      `FOUNDRY_PROFILE=heavy forge test --match-contract EscrowInvariants`
