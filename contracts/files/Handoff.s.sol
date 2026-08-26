// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./EscrowCore.sol";
import "./DisputeModule.sol";

/// @notice Completes the governance handoff left pending by Deploy.s.sol: the multisig
///         (timelock PROPOSER) schedules acceptOwnership() on BOTH proxies plus one
///         representative admin op (setPlatformFeeBps(150)), waits out the timelock delay,
///         then executes them. Afterwards the deployer EOA holds no authority anywhere:
///         every future admin action must traverse the timelock.
///
/// Env: ./deployments/deploy-<chainid>.json + MULTISIG_KEY. Two invocations, exactly like
/// the production multisig flow: HANDOFF_PHASE=1 schedules; once the on-chain delay has
/// elapsed (node clock on anvil via evm_increaseTime, real time on Base), HANDOFF_PHASE=2
/// executes. A single combined run is impossible because vm.warp does not persist across
/// broadcast transactions.
contract HandoffScript is Script {
    function run() external {
        string memory artifact =
            string.concat("./deployments/deploy-", vm.toString(block.chainid), ".json");
        address timelockAddr = vm.parseJsonAddress(vm.readFile(artifact), ".timelock");
        address escrowAddr = vm.parseJsonAddress(vm.readFile(artifact), ".escrowProxy");
        address disputeAddr = vm.parseJsonAddress(vm.readFile(artifact), ".disputeProxy");

        TimelockController timelock = TimelockController(payable(timelockAddr));
        EscrowCore escrow = EscrowCore(escrowAddr);
        DisputeModule dispute = DisputeModule(disputeAddr);
        uint256 delay = timelock.getMinDelay();

        bytes32 salt = 0; // deterministic ids
        bytes memory acceptEscrow = abi.encodeCall(escrow.acceptOwnership, ());
        bytes memory acceptDispute = abi.encodeCall(dispute.acceptOwnership, ());
        bytes memory setFee = abi.encodeCall(escrow.setPlatformFeeBps, (150));

        uint256 phase = vm.envOr("HANDOFF_PHASE", uint256(1));

        if (phase == 1) {
            uint256 msPk = vm.envUint("MULTISIG_KEY");
            vm.startBroadcast(msPk);
            timelock.schedule(escrowAddr, 0, acceptEscrow, bytes32(0), salt, delay);
            timelock.schedule(disputeAddr, 0, acceptDispute, bytes32(0), salt, delay);
            timelock.schedule(escrowAddr, 0, setFee, bytes32(0), keccak256("fee"), delay);
            vm.stopBroadcast();
            console2.log("[handoff] scheduled 3 ops; min delay (s):", delay);
        } else {
            if (
                block.timestamp <= _readyAt(timelock, escrowAddr, acceptEscrow, salt)
            ) revert("delay not elapsed yet: advance the clock, then re-run HANDOFF_PHASE=2");
            uint256 msPk = vm.envUint("MULTISIG_KEY");
            vm.startBroadcast(msPk); // executor role is public — anyone may execute
            timelock.execute(escrowAddr, 0, acceptEscrow, bytes32(0), salt);
            timelock.execute(disputeAddr, 0, acceptDispute, bytes32(0), salt);
            timelock.execute(escrowAddr, 0, setFee, bytes32(0), keccak256("fee"));
            vm.stopBroadcast();
        }

        if (phase == 2) {
            require(escrow.owner() == timelockAddr, "escrow owner handoff failed");
            require(dispute.owner() == timelockAddr, "dispute owner handoff failed");
            require(escrow.platformFeeBps() == 150, "timelock-driven fee change failed");
            console2.log("[handoff] COMPLETE: both proxies owned by timelock:", timelockAddr);
            console2.log("[handoff] platformFeeBps now:", escrow.platformFeeBps());
        }
    }

    function _readyAt(TimelockController timelock, address target, bytes memory data, bytes32 salt)
        internal
        view
        returns (uint256)
    {
        return timelock.getTimestamp(
            timelock.hashOperation(target, 0, data, bytes32(0), salt)
        );
    }
}
