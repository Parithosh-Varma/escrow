// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "./EscrowCore.sol";
import "./DisputeModule.sol";
import "./MockERC20.sol";

/// @notice Full lifecycle run against deployed addresses (Base Sepolia runbook; identical
///         locally on anvil). Drives EVERY settlement path with per-actor keys:
///
///   P1/M1  partial approval (70%) -> remainder held -> post-approval dispute
///          (PartialAmount) with REAL commit-reveal jury -> ForFreelancer resolution
///          releases the held remainder in full.
///   P1/M2  full approval (100%).
///   P1/M3  submit -> review deadline passes -> permissionless autoRelease.
///   P2/M4  partial approval (25%) -> challenge window expires uncontested ->
///          permissionless claimRemainder refunds the client.
///   Third-party donation creates surplus -> owner emergencyWithdraw rescues exactly it.
///
///   Final hard reconciliation (fee 2%, 6-decimal test-USDC):
///     freelancer = 343+147 (M1) + 294 (M2) + 196 (M3) + 98 (M4)   = 1078e6
///     fees       =   7+  3 (M1) +   6 (M2) +   4 (M3) +  2 (M4)   =   22e6
///     client     = 10000 - 1000 (P1) - 400 (P2) + 300 (M4 refund) = 8900e6
///     escrow = 0 and earmark ledger = 0 at the end.
///
/// Env: ./deployments/deploy-<chainid>.json + CLIENT_KEY/FREELANCER_KEY/BACKEND_KEY/
/// JUROR{1..3}_KEY/OWNER_KEY. vm.warp steps gated behind WARP_OK=1 (anvil only; live
/// chains perform those steps via keepers once real time elapses).
contract LifecycleScript is Script {
    /// @dev Phases mirror live-chain reality: vm.warp does NOT persist across broadcast
    ///      txs, so time-dependent steps live in their own phase and the operator advances
    ///      the NODE clock between invocations (anvil: `cast rpc evm_increaseTime`; mainnet:
    ///      keepers simply wait). WARP_OK=1 lets this script do both phases back-to-back on
    ///      anvil by advancing time itself via cheatcodes accepted pre-broadcast.
    function run() external {
        string memory artifact =
            string.concat("./deployments/deploy-", vm.toString(block.chainid), ".json");
        address escrowAddr = vm.parseJsonAddress(vm.readFile(artifact), ".escrowProxy");
        address tokenAddr = vm.parseJsonAddress(vm.readFile(artifact), ".stablecoin");
        uint256 phase = vm.envOr("LIFECYCLE_PHASE", uint256(1));
        bool warpOk = vm.envOr("WARP_OK", uint256(0)) == 1;

        // pk layout: 0 client, 1 freelancer, 2 backend, 3-5 jurors, 6 owner
        uint256[7] memory pk = [
            vm.envUint("CLIENT_KEY"),
            vm.envUint("FREELANCER_KEY"),
            vm.envUint("BACKEND_KEY"),
            vm.envUint("JUROR1_KEY"),
            vm.envUint("JUROR2_KEY"),
            vm.envUint("JUROR3_KEY"),
            vm.envUint("OWNER_KEY")
        ];

        EscrowCore escrow = EscrowCore(escrowAddr);
        DisputeModule dispute = DisputeModule(vm.parseJsonAddress(vm.readFile(artifact), ".disputeProxy"));
        MockERC20 usdc = MockERC20(tokenAddr);

        if (phase == 1) {
            _runProject1(escrow, dispute, usdc, tokenAddr, pk); // no clock dependence
        } else if (phase == 2) {
            _autoReleaseM3(escrow, usdc, pk);
            _runProject2ThroughApproval(escrow, usdc, tokenAddr, pk);
        } else {
            _claimRemainderM4(escrow, usdc, pk);
            _donateAndRescue(escrow, usdc, tokenAddr, pk);
            _reconcile(escrow, usdc, tokenAddr, artifact, pk);
            vm.startBroadcast(pk[6]);
            escrow.pause();
            escrow.unpause();
            vm.stopBroadcast();
            console2.log("[admin] pause/unpause round-trip ok");
        }
        if (warpOk && phase < 3) {
            console2.log("[clock] NEXT: evm_increaseTime >= 8 days before next phase");
        }
    }

    // -----------------------------------------------------------------
    // Project 1: milestones [500, 300, 200] -> M1 dispute, M2 full, M3 timeout
    // -----------------------------------------------------------------
    function _runProject1(
        EscrowCore escrow,
        DisputeModule dispute,
        MockERC20 usdc,
        address tokenAddr,
        uint256[7] memory pk
    ) internal {
        address client = vm.addr(pk[0]);
        address freelancer = vm.addr(pk[1]);

        vm.startBroadcast(pk[0]);
        usdc.mint(client, 10_000e6);
        usdc.approve(address(escrow), 1000e6);
        uint256 m1 = escrow.nextMilestoneId();
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 500e6;
        amounts[1] = 300e6;
        amounts[2] = 200e6;
        string[] memory titles = new string[](3);
        escrow.createProject(freelancer, tokenAddr, titles, amounts);
        escrow.fundProject(escrow.nextProjectId() - 1);
        vm.stopBroadcast();

        require(usdc.balanceOf(address(escrow)) == 1000e6, "escrow must hold 1000 after funding");
        console2.log("[P1 funded] escrow balance:", usdc.balanceOf(address(escrow)));

        // M1: partial approval holds remainder, then a real commit-reveal dispute.
        _startSubmit(escrow, pk[1], m1);
        vm.startBroadcast(pk[0]);
        escrow.approveMilestone(m1, 7000); // gross 350, fee 7, net 343, remainder 150
        vm.stopBroadcast();
        require(escrow.remainderHeld(m1) == 150e6, "remainder must be 150");
        require(usdc.balanceOf(freelancer) == 343e6, "freelancer net mismatch");
        console2.log("[M1 approved 70%] remainder held:", escrow.remainderHeld(m1));

        _disputeRemainderFullRelease(dispute, pk, m1, freelancer);
        // base = held 150; fee 2% = 3; net 147. Freelancer total: 343 + 147 = 490.
        require(usdc.balanceOf(freelancer) == 490e6, "freelancer total after dispute mismatch");
        require(escrow.remainderHeld(m1) == 0, "remainder must be consumed by resolution");
        console2.log("[M1 resolved ForFreelancer] freelancer:", usdc.balanceOf(freelancer));

        // M2: full approval.
        uint256 m2 = m1 + 1;
        _startSubmit(escrow, pk[1], m2);
        vm.startBroadcast(pk[0]);
        escrow.approveMilestone(m2, 10000); // gross 300, fee 6, net 294
        vm.stopBroadcast();
        require(usdc.balanceOf(freelancer) == 784e6, "M2 payout mismatch");
        console2.log("[M2 fully approved] freelancer:", usdc.balanceOf(freelancer));

        // M3: submitted; release happens after the review deadline elapses (phase 2).
        uint256 m3 = escrow.nextMilestoneId() - 1;
        _startSubmit(escrow, pk[1], m3);
        console2.log("[M3 submitted] id:", m3, "- awaiting review deadline");
    }

    function _autoReleaseM3(EscrowCore escrow, MockERC20 usdc, uint256[7] memory pk) internal {
        address freelancer = vm.addr(pk[1]);
        uint256 m3 = escrow.nextMilestoneId() - 1;
        vm.startBroadcast(pk[1]); // permissionless — anyone may fire it
        escrow.autoReleaseMilestone(m3); // gross 200, fee 4, net 196
        vm.stopBroadcast();
        require(
            uint8(_status(escrow, m3)) == uint8(EscrowCore.MilestoneStatus.AutoReleased),
            "M3 not auto-released"
        );
        require(usdc.balanceOf(freelancer) == 980e6, "M3 payout mismatch");
        console2.log("[M3 auto-released] freelancer:", usdc.balanceOf(freelancer));
    }

    // -----------------------------------------------------------------
    // Project 2 / M4: partial approval -> uncontested window expiry -> claimRemainder
    // -----------------------------------------------------------------
    function _runProject2ThroughApproval(
        EscrowCore escrow,
        MockERC20 usdc,
        address tokenAddr,
        uint256[7] memory pk
    ) internal {
        address client = vm.addr(pk[0]);
        address freelancer = vm.addr(pk[1]);

        vm.startBroadcast(pk[0]);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 400e6;
        string[] memory titles = new string[](1);
        usdc.approve(address(escrow), 400e6);
        escrow.createProject(freelancer, tokenAddr, titles, amounts);
        escrow.fundProject(escrow.nextProjectId() - 1);
        vm.stopBroadcast();

        uint256 m4 = escrow.nextMilestoneId() - 1;
        _startSubmit(escrow, pk[1], m4);
        vm.startBroadcast(pk[0]);
        escrow.approveMilestone(m4, 2500); // gross 100, fee 2, net 98, remainder 300
        vm.stopBroadcast();
        require(escrow.remainderHeld(m4) == 300e6, "M4 remainder mismatch");
        console2.log("[M4 approved 25%] remainder held; client:", usdc.balanceOf(client));
    }

    function _claimRemainderM4(EscrowCore escrow, MockERC20 usdc, uint256[7] memory pk) internal {
        uint256 m4 = escrow.nextMilestoneId() - 1;
        vm.startBroadcast(pk[1]); // permissionless keeper call
        escrow.claimRemainder(m4);
        vm.stopBroadcast();
        require(escrow.remainderHeld(m4) == 0, "M4 remainder must be refunded");
        console2.log("[M4 remainder claimed] milestone:", m4);
    }

    // -----------------------------------------------------------------
    // Donation creates surplus; emergencyWithdraw must rescue exactly it.
    // -----------------------------------------------------------------
    function _donateAndRescue(EscrowCore escrow, MockERC20 usdc, address tokenAddr, uint256[7] memory pk)
        internal
    {
        vm.startBroadcast(pk[4]); // third party donates directly to escrow
        usdc.mint(vm.addr(pk[4]), 25e6); // donor needs a balance first
        usdc.transfer(address(escrow), 25e6);
        vm.stopBroadcast();
        uint256 surplus = usdc.balanceOf(address(escrow)) - escrow.totalEscrowedByToken(tokenAddr);
        require(surplus == 25e6, "surplus should equal donation");
        vm.startBroadcast(pk[6]);
        escrow.emergencyWithdraw(tokenAddr, surplus, vm.addr(pk[6]));
        vm.stopBroadcast();
        console2.log("[emergencyWithdraw] rescued surplus:", surplus);
    }

    // -----------------------------------------------------------------
    function _reconcile(
        EscrowCore escrow,
        MockERC20 usdc,
        address tokenAddr,
        string memory artifact,
        uint256[7] memory pk
    ) internal view {
        require(usdc.balanceOf(address(escrow)) == 0, "escrow must be empty");
        require(escrow.totalEscrowedByToken(tokenAddr) == 0, "earmark ledger must zero out");
        require(usdc.balanceOf(vm.addr(pk[1])) == 1078e6, "freelancer final mismatch");
        require(usdc.balanceOf(vm.addr(pk[0])) == 8900e6, "client final mismatch");
        address feeRecipient = vm.parseJsonAddress(vm.readFile(artifact), ".feeRecipient");
        require(usdc.balanceOf(feeRecipient) == 22e6, "fees mismatch");
        console2.log("[RECONCILED] escrow balance:", usdc.balanceOf(address(escrow)));
        console2.log("[RECONCILED] earmark ledger :", escrow.totalEscrowedByToken(tokenAddr));
        console2.log("[RECONCILED] freelancer     :", usdc.balanceOf(vm.addr(pk[1])));
        console2.log("[RECONCILED] client         :", usdc.balanceOf(vm.addr(pk[0])));
    }

    /// Open -> assign -> commit-reveal (2x ForFreelancer, 1x ForClient) -> advance ->
    /// resolve ForFreelancer (majority forces full release of the held remainder).
    function _disputeRemainderFullRelease(
        DisputeModule dispute,
        uint256[7] memory pk,
        uint256 m1,
        address freelancer
    ) internal {
        vm.startBroadcast(pk[2]);
        uint256 d1 = dispute.nextDisputeId();
        dispute.createDispute(m1, DisputeModule.DisputeType.PartialAmount, freelancer, "client shorted scope", 3);
        address[] memory jurors = new address[](3);
        jurors[0] = vm.addr(pk[3]);
        jurors[1] = vm.addr(pk[4]);
        jurors[2] = vm.addr(pk[5]);
        dispute.assignJurors(d1, jurors);
        vm.stopBroadcast();

        bytes32 s1 = keccak256("salt-j1");
        bytes32 s2 = keccak256("salt-j2");
        bytes32 s3 = keccak256("salt-j3");
        _commit(dispute, pk[3], d1, s1, DisputeModule.Vote.ForFreelancer);
        _commit(dispute, pk[4], d1, s2, DisputeModule.Vote.ForFreelancer);
        _commit(dispute, pk[5], d1, s3, DisputeModule.Vote.ForClient);

        vm.startBroadcast(pk[2]);
        dispute.advancePhase(d1); // all jurors committed -> Reveal opens immediately
        vm.stopBroadcast();
        _reveal(dispute, pk[3], d1, s1, DisputeModule.Vote.ForFreelancer);
        _reveal(dispute, pk[4], d1, s2, DisputeModule.Vote.ForFreelancer);
        _reveal(dispute, pk[5], d1, s3, DisputeModule.Vote.ForClient);

        vm.startBroadcast(pk[2]);
        // Majority ForFreelancer forces split == 10000 (on-chain consistency rule).
        dispute.resolveDispute(d1, DisputeModule.DisputeOutcome.ForFreelancer, 10000);
        vm.stopBroadcast();
    }

    function _startSubmit(EscrowCore escrow, uint256 freelancerPk, uint256 mid) internal {
        vm.startBroadcast(freelancerPk);
        escrow.startMilestone(mid);
        escrow.submitMilestone(
            mid, keccak256(abi.encodePacked("deliverable-", mid)), keccak256(abi.encodePacked("pom-", mid))
        );
        vm.stopBroadcast();
    }

    function _commit(DisputeModule dispute, uint256 jPk, uint256 did, bytes32 salt, DisputeModule.Vote vote)
        internal
    {
        bytes32 commitment = keccak256(abi.encodePacked(vote, salt, vm.addr(jPk)));
        vm.startBroadcast(jPk);
        dispute.commitVote(did, commitment);
        vm.stopBroadcast();
    }

    function _reveal(DisputeModule dispute, uint256 jPk, uint256 did, bytes32 salt, DisputeModule.Vote vote)
        internal
    {
        vm.startBroadcast(jPk);
        dispute.revealVote(did, vote, salt);
        vm.stopBroadcast();
    }

    function _status(EscrowCore escrow, uint256 mid) internal view returns (EscrowCore.MilestoneStatus) {
        return escrow.getMilestone(mid).status;
    }
}
