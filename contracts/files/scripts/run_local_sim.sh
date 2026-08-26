#!/bin/zsh
# Full local simulation of Deploy -> Lifecycle (3 phases) -> Handoff on a fresh anvil.
# Mirrors the exact Base Sepolia runbook; only time advancement differs (node clock vs
# real waiting). Usage: zsh scripts/run_local_sim.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=http://localhost:8545
LOGDIR=${TMPDIR:-/tmp}/escrow-sim
mkdir -p "$LOGDIR"

pkill -f "anvil --port 8545" 2>/dev/null || true; sleep 1
anvil --port 8545 --chain-id 31337 > "$LOGDIR/anvil.log" 2>&1 &
sleep 2

# Ground-truth keys straight from anvil (no hand-typed constants).
PK=($(grep -oE '\([0-9]+\) 0x[0-9a-f]{64}' "$LOGDIR/anvil.log" | awk '{print $2}'))
DPK=${PK[1]}; MSK=${PK[2]}; FEEKEY=${PK[3]}; BK=${PK[4]}; CK=${PK[5]}; FK=${PK[6]}
J1K=${PK[7]}; J2K=${PK[8]}; J3K=${PK[9]}

echo "== 1. test USDC =="
STABLECOIN=$(forge script MockStablecoin.s.sol --rpc-url $RPC --private-key $DPK --broadcast -vvv 2>&1 | grep "MOCK_USDC:" | awk '{print $2}')
echo "stablecoin: $STABLECOIN"

echo "== 2. deploy =="
MULTISIG_ADDRESS=$(cast wallet address --private-key $MSK) \
FEE_RECIPIENT_ADDRESS=$(cast wallet address --private-key $FEEKEY) \
BACKEND_SIGNER_ADDRESS=$(cast wallet address --private-key $BK) \
STABLECOIN_ADDRESS=$STABLECOIN \
TIMELOCK_DELAY_SECONDS=10 \
forge script Deploy.s.sol --rpc-url $RPC --private-key $DPK --broadcast -vvv > "$LOGDIR/deploy.txt" 2>&1
grep -E "Timelock:|proxy:" "$LOGDIR/deploy.txt"

LIFECYCLE_ENV=(CLIENT_KEY=$CK FREELANCER_KEY=$FK BACKEND_KEY=$BK JUROR1_KEY=$J1K JUROR2_KEY=$J2K JUROR3_KEY=$J3K OWNER_KEY=$DPK)

echo "== 3. lifecycle phase 1 (fund, partial approve + jury dispute, full approve, submit M3) =="
env "${LIFECYCLE_ENV[@]}" LIFECYCLE_PHASE=1 forge script Lifecycle.s.sol --rpc-url $RPC --broadcast -vvv > "$LOGDIR/p1.txt" 2>&1
grep -E "\[P1|\[M1|\[M2|\[M3|Error:" "$LOGDIR/p1.txt" | grep -v staticcall || true

echo "== 4. advance node clock past review deadline (+8 days) =="
cast rpc evm_increaseTime 691200 --rpc-url $RPC > /dev/null && cast rpc evm_mine --rpc-url $RPC > /dev/null

echo "== 5. lifecycle phase 2 (autoRelease M3, P2 fund + partial approve M4) =="
env "${LIFECYCLE_ENV[@]}" LIFECYCLE_PHASE=2 forge script Lifecycle.s.sol --rpc-url $RPC --broadcast -vvv > "$LOGDIR/p2.txt" 2>&1
grep -E "\[M3|\[M4|Error:" "$LOGDIR/p2.txt" | grep -v staticcall || true

echo "== 6. advance node clock past challenge window (+8 days) =="
cast rpc evm_increaseTime 691200 --rpc-url $RPC > /dev/null && cast rpc evm_mine --rpc-url $RPC > /dev/null

echo "== 7. lifecycle phase 3 (claimRemainder, donation+rescue, reconcile) =="
env "${LIFECYCLE_ENV[@]}" LIFECYCLE_PHASE=3 forge script Lifecycle.s.sol --rpc-url $RPC --broadcast -vvv > "$LOGDIR/p3.txt" 2>&1
grep -E "\[M4|emergency|RECONCILED|admin\]|Error:" "$LOGDIR/p3.txt" | grep -v staticcall || true

echo "== 8. governance handoff: schedule -> wait out delay -> execute =="
MULTISIG_KEY=$MSK HANDOFF_PHASE=1 forge script Handoff.s.sol --rpc-url $RPC --broadcast -vvv > "$LOGDIR/handoff1.txt" 2>&1
grep -E "handoff\]|Error:" "$LOGDIR/handoff1.txt" | grep -v staticcall || true

cast rpc evm_increaseTime 15 --rpc-url $RPC > /dev/null && cast rpc evm_mine --rpc-url $RPC > /dev/null

MULTISIG_KEY=$MSK HANDOFF_PHASE=2 forge script Handoff.s.sol --rpc-url $RPC --broadcast -vvv > "$LOGDIR/handoff2.txt" 2>&1
grep -E "handoff\]|Error:" "$LOGDIR/handoff2.txt" | grep -v staticcall || true

echo "== SIM COMPLETE =="
