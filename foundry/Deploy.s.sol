// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./EscrowCore.sol";
import "./DisputeModule.sol";

/// @notice Deployment sequence matching the implementation plan:
///   1. TimelockController (48h delay, proposer = multisig)
///   2. EscrowCore impl + proxy, initialize(deployer, feeRecipient)
///   3. DisputeModule impl + proxy, initialize(deployer, escrowProxy)
///   4. Wire escrow.setDisputeModule(disputeProxy)
///   5. Allowlist the configured stablecoin, authorize the backend signer
///   6. Begin ownership handoff of both proxies to the timelock (2-step)
///
/// Governance end-state after this script: the multisig holds PROPOSER + CANCELLER on
/// the timelock; executorship is open; ALL timelock roles held by the deployer EOA are
/// renounced (including TIMELOCK_ADMIN_ROLE and DEFAULT_ADMIN_ROLE) so no EOA can
/// re-grant governance roles later. Changing that set requires a new timelock.
contract DeployScript is Script {
    function run() external {
        vm.startBroadcast();

        // 1. Timelock — multisig proposes/cancels, execution is open to anyone once a
        //    proposal's delay has elapsed.
        address[] memory proposers = new address[](1);
        proposers[0] = vm.envAddress("MULTISIG_ADDRESS");
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open executor role
        TimelockController timelock = new TimelockController(
            vm.envOr("TIMELOCK_DELAY_SECONDS", uint256(48 hours)),
            proposers,
            executors,
            msg.sender // temporary admin for setup only — fully renounced below
        );
        timelock.grantRole(timelock.CANCELLER_ROLE(), proposers[0]);

        // 2. EscrowCore
        EscrowCore escrowImpl = new EscrowCore();
        ERC1967Proxy escrowProxy =
            new ERC1967Proxy(address(escrowImpl), abi.encodeCall(EscrowCore.initialize, (msg.sender, vm.envAddress("FEE_RECIPIENT_ADDRESS"))));
        EscrowCore escrow = EscrowCore(address(escrowProxy));

        // 3. DisputeModule
        DisputeModule disputeImpl = new DisputeModule();
        ERC1967Proxy disputeProxy =
            new ERC1967Proxy(address(disputeImpl), abi.encodeCall(DisputeModule.initialize, (msg.sender, address(escrowProxy))));

        // 4. Wire
        escrow.setDisputeModule(address(disputeProxy));

        // 5. Config (owner == deployer until handoff completes)
        escrow.setAllowedToken(vm.envAddress("STABLECOIN_ADDRESS"), true);
        DisputeModule(address(disputeProxy)).setBackend(vm.envAddress("BACKEND_SIGNER_ADDRESS"), true);

        // 6. Ownership handoff: propose transfer to the timelock. acceptOwnership() must
        //    then be executed BY the timelock via a scheduled multisig proposal — that
        //    step is deliberately manual since it needs the delay to elapse.
        escrow.transferOwnership(address(timelock));
        DisputeModule(address(disputeProxy)).transferOwnership(address(timelock));

        // 7. Renounce every timelock role held by the deployer EOA. (OZ v5 has no
        //    separate TIMELOCK_ADMIN_ROLE; the timelock itself retains DEFAULT_ADMIN
        //    by design, so role changes remain possible only through its own delayed,
        //    multisig-proposed operations.) After this, no key can act outside that path.
        timelock.renounceRole(timelock.PROPOSER_ROLE(), msg.sender);
        timelock.renounceRole(timelock.EXECUTOR_ROLE(), msg.sender);
        timelock.renounceRole(timelock.CANCELLER_ROLE(), msg.sender);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), msg.sender);

        vm.stopBroadcast();

        _writeDeploymentArtifact(
            address(timelock),
            address(escrowImpl),
            address(disputeImpl),
            address(escrowProxy),
            address(disputeProxy),
            vm.envAddress("STABLECOIN_ADDRESS"),
            proposers[0],
            escrow.platformFeeRecipient(),
            vm.envAddress("BACKEND_SIGNER_ADDRESS"),
            vm.envOr("TIMELOCK_DELAY_SECONDS", uint256(48 hours))
        );

        console2.log("Timelock:", address(timelock));
        console2.log("EscrowCore proxy:", address(escrowProxy));
        console2.log("DisputeModule proxy:", address(disputeProxy));
        console2.log(
            "NEXT STEP: multisig schedules+executes acceptOwnership() on both proxies via the timelock."
        );
    }

    /// @dev Machine-readable artifact for downstream tooling (lifecycle/handoff scripts,
    ///      indexer bootstrap). Written relative to the foundry project root.
    function _writeDeploymentArtifact(
        address timelock,
        address escrowImpl,
        address disputeImpl,
        address escrowProxy,
        address disputeProxy,
        address stablecoin,
        address multisig,
        address feeRecipient,
        address backendSigner,
        uint256 timelockDelay
    ) internal {
        // stdJson pattern: intermediate serialize returns are ignored (state accumulates
        // internally under the "deployments" key); only the LAST return is written out.
        string memory obj = "deployments";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "timelock", timelock);
        vm.serializeAddress(obj, "escrowCoreImpl", escrowImpl);
        vm.serializeAddress(obj, "disputeModuleImpl", disputeImpl);
        vm.serializeAddress(obj, "escrowProxy", escrowProxy);
        vm.serializeAddress(obj, "disputeProxy", disputeProxy);
        vm.serializeAddress(obj, "stablecoin", stablecoin);
        vm.serializeAddress(obj, "multisig", multisig);
        vm.serializeAddress(obj, "feeRecipient", feeRecipient);
        vm.serializeAddress(obj, "backendSigner", backendSigner);
        string memory json = vm.serializeUint(obj, "timelockDelaySeconds", timelockDelay);
        vm.writeJson(json, string.concat("./deployments/deploy-", vm.toString(block.chainid), ".json"));
    }
}
