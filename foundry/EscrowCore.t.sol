// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "./EscrowCore.sol";
import "./DisputeModule.sol";
import "./MockERC20.sol";

contract EscrowCoreTest is Test {
    EscrowCore escrow;
    DisputeModule disputeModule;
    MockERC20 usdc;

    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("feeRecipient");
    address backend = makeAddr("backend");
    address client = makeAddr("client");
    address freelancer = makeAddr("freelancer");
    address keeper = makeAddr("keeper");

    uint256 constant COMMIT_WINDOW = 2 days;
    uint256 constant REVEAL_WINDOW = 2 days;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);

        EscrowCore escrowImpl = new EscrowCore();
        bytes memory escrowInit = abi.encodeCall(EscrowCore.initialize, (owner, feeRecipient));
        escrow = EscrowCore(address(new ERC1967Proxy(address(escrowImpl), escrowInit)));

        DisputeModule disputeImpl = new DisputeModule();
        bytes memory disputeInit = abi.encodeCall(DisputeModule.initialize, (owner, address(escrow)));
        disputeModule = DisputeModule(address(new ERC1967Proxy(address(disputeImpl), disputeInit)));

        vm.startPrank(owner);
        escrow.setDisputeModule(address(disputeModule));
        escrow.setAllowedToken(address(usdc), true);
        disputeModule.setBackend(backend, true);
        vm.stopPrank();

        usdc.mint(client, 10_000_000e6);
    }

    // -------------------------------------------------------------------
    // Regression: nested nonReentrant would make every payout path revert.
    // -------------------------------------------------------------------

    function test_regression_approvePathDoesNotRevertOnNestedGuard() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);

        vm.prank(client);
        escrow.approveMilestone(milestoneId, 10000);

        assertEq(uint8(_status(milestoneId)), uint8(EscrowCore.MilestoneStatus.Approved));
    }

    function test_regression_autoReleasePathDoesNotRevertOnNestedGuard() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);

        vm.warp(block.timestamp + 8 days);
        escrow.autoReleaseMilestone(milestoneId); // permissionless

        assertEq(uint8(_status(milestoneId)), uint8(EscrowCore.MilestoneStatus.AutoReleased));
    }

    function test_regression_resolvePathDoesNotRevertOnNestedGuard() public {
        (uint256 milestoneId, uint256 disputeId) =
            _createDisputedMilestone(1_000e6, DisputeModule.DisputeType.Quality);
        _assignJurors(disputeId, 3);
        _advancePastBothDeadlines(disputeId);

        vm.prank(backend);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.TieEscalated, 5000);

        assertEq(uint8(_status(milestoneId)), uint8(EscrowCore.MilestoneStatus.Resolved));
    }

    // -------------------------------------------------------------------
    // Payout conservation across every settlement path.
    // -------------------------------------------------------------------

    function testFuzz_payoutConservation(uint128 amount, uint32 approvedBps) public {
        amount = uint128(bound(amount, 1e6, 1_000_000e6));
        approvedBps = uint32(bound(approvedBps, 1, 10000));

        usdc.mint(client, amount);
        uint256 milestoneId = _createFundedSingleMilestoneProject(amount);
        _startAndSubmit(milestoneId);

        uint256 before = usdc.balanceOf(freelancer) + usdc.balanceOf(feeRecipient)
            + usdc.balanceOf(client) + usdc.balanceOf(address(escrow));

        vm.startPrank(client);
        escrow.approveMilestone(milestoneId, approvedBps);
        if (escrow.remainderHeld(milestoneId) != 0) {
            vm.warp(block.timestamp + 8 days);
            escrow.claimRemainder(milestoneId);
        }
        vm.stopPrank();

        uint256 after_ = usdc.balanceOf(freelancer) + usdc.balanceOf(feeRecipient)
            + usdc.balanceOf(client) + usdc.balanceOf(address(escrow));

        assertEq(after_, before, "conservation violated");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow must be empty after settlement");
        assertEq(escrow.totalEscrowedByToken(address(usdc)), 0, "accounting must zero out");
    }

    // -------------------------------------------------------------------
    // Partial approval: remainder held behind challenge window, then claimed.
    // -------------------------------------------------------------------

    function test_partialApprovalHoldsRemainder() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);

        uint256 freelBefore = usdc.balanceOf(freelancer);
        uint256 feeBefore = usdc.balanceOf(feeRecipient);

        vm.prank(client);
        escrow.approveMilestone(milestoneId, 7000);

        // gross 700e6, fee 14e6, net 686e6 — remainder stays in contract.
        assertEq(usdc.balanceOf(freelancer) - freelBefore, 686e6);
        assertEq(usdc.balanceOf(feeRecipient) - feeBefore, 14e6);
        assertEq(usdc.balanceOf(address(escrow)), 300e6, "remainder must stay held");
        assertEq(escrow.remainderHeld(milestoneId), 300e6);
        assertEq(escrow.totalEscrowedByToken(address(usdc)), 300e6);

        // Client cannot claim during the challenge window.
        vm.prank(client);
        vm.expectRevert(EscrowCore.ChallengeWindowOpen.selector);
        escrow.claimRemainder(milestoneId);
    }

    function test_claimRemainderAfterWindowPermissionless() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);

        vm.prank(client);
        escrow.approveMilestone(milestoneId, 7000);

        uint256 clientBefore = usdc.balanceOf(client);
        vm.warp(block.timestamp + 8 days);

        vm.prank(keeper); // anyone may claim; funds always go to the client
        escrow.claimRemainder(milestoneId);

        assertEq(usdc.balanceOf(client) - clientBefore, 300e6);
        assertEq(escrow.remainderHeld(milestoneId), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        // Double-claim reverts.
        vm.expectRevert(EscrowCore.NothingToClaim.selector);
        escrow.claimRemainder(milestoneId);
    }

    // -------------------------------------------------------------------
    // Post-approval dispute: split applies to the HELD REMAINDER only.
    // -------------------------------------------------------------------

    function test_postApprovalDisputeResolvesOverRemainderOnly() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);

        vm.prank(client);
        escrow.approveMilestone(milestoneId, 7000); // remainder 300e6 now held

        // Freelancer contests within the window.
        vm.prank(backend);
        uint256 disputeId = disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.PartialAmount, freelancer, "70% undervalues", 3
        );
        assertEq(uint8(_status(milestoneId)), uint8(EscrowCore.MilestoneStatus.Disputed));

        address[] memory jurors = _assignJurors(disputeId, 3);
        _commitAll(disputeId, jurors, DisputeModule.Vote.ForClient);
        vm.warp(block.timestamp + COMMIT_WINDOW + 1);
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);
        _revealAll(disputeId, jurors, DisputeModule.Vote.ForClient);

        uint256 freelBefore = usdc.balanceOf(freelancer);
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(backend);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.ForClient, 0);

        // Base was the 300e6 remainder; forced split 0 → whole remainder back to client.
        assertEq(usdc.balanceOf(freelancer) - freelBefore, 0);
        assertEq(usdc.balanceOf(client) - clientBefore, 300e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_status(milestoneId)), uint8(EscrowCore.MilestoneStatus.Resolved));
        assertEq(escrow.totalEscrowedByToken(address(usdc)), 0);

        // Claim path is dead after resolution.
        vm.expectRevert(EscrowCore.WrongMilestoneStatus.selector);
        escrow.claimRemainder(milestoneId);
    }

    function test_disputeFromApprovedBlockedAfterWindowExpires() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);

        vm.prank(client);
        escrow.approveMilestone(milestoneId, 7000);

        vm.warp(block.timestamp + 8 days); // window over

        vm.prank(backend);
        vm.expectRevert(EscrowCore.NotDisputable.selector);
        disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.PartialAmount, freelancer, "too late", 3
        );
    }

    // -------------------------------------------------------------------
    // Commit-copy attack must fail.
    // -------------------------------------------------------------------

    function test_commitCopyAttackFails() public {
        (, uint256 disputeId) = _createDisputedMilestone(1_000e6, DisputeModule.DisputeType.Quality);
        address[] memory jurors = _assignJurors(disputeId, 3);

        bytes32 salt = keccak256("secret");
        bytes32 jurorACommitment =
            keccak256(abi.encodePacked(DisputeModule.Vote.ForFreelancer, salt, jurors[0]));

        vm.prank(jurors[0]);
        disputeModule.commitVote(disputeId, jurorACommitment);

        // Juror B copies juror A's commitment verbatim. The commit itself succeeds —
        // but its reveal never can: the commitment is bound to juror A's address.
        vm.prank(jurors[1]);
        disputeModule.commitVote(disputeId, jurorACommitment);

        vm.warp(block.timestamp + COMMIT_WINDOW + 1); // C silent; deadline passes
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);

        vm.prank(jurors[0]);
        disputeModule.revealVote(disputeId, DisputeModule.Vote.ForFreelancer, salt);

        vm.prank(jurors[1]);
        vm.expectRevert(DisputeModule.CommitMismatch.selector);
        disputeModule.revealVote(disputeId, DisputeModule.Vote.ForFreelancer, salt);
    }

    // -------------------------------------------------------------------
    // Zero-reveal path resolves only as TieEscalated, only after deadline.
    // -------------------------------------------------------------------

    function test_zeroRevealResolvesAsTieEscalatedAfterDeadline() public {
        (, uint256 disputeId) = _createDisputedMilestone(1_000e6, DisputeModule.DisputeType.Quality);
        _assignJurors(disputeId, 3);

        vm.warp(block.timestamp + COMMIT_WINDOW + 1);
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);
        vm.warp(block.timestamp + REVEAL_WINDOW + 1); // zero reveals

        vm.prank(backend);
        vm.expectRevert(DisputeModule.InconsistentOutcome.selector);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.ForFreelancer, 10000);

        vm.prank(backend);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.TieEscalated, 5000);

        DisputeModule.Dispute memory d = disputeModule.getDispute(disputeId);
        assertEq(uint8(d.phase), uint8(DisputeModule.DisputePhase.Resolved));
        assertEq(uint8(d.outcome), uint8(DisputeModule.DisputeOutcome.TieEscalated));
    }

    // -------------------------------------------------------------------
    // Below-quorum resolution blocked until the reveal deadline passes.
    // -------------------------------------------------------------------

    function test_resolveBelowQuorumBlockedUntilDeadline() public {
        (, uint256 disputeId) = _createDisputedMilestone(1_000e6, DisputeModule.DisputeType.Quality);
        address[] memory jurors = _assignJurors(disputeId, 3);

        // Commit must happen while still in Commit phase.
        bytes32 salt = keccak256("only-vote");
        vm.prank(jurors[0]);
        disputeModule.commitVote(
            disputeId, keccak256(abi.encodePacked(DisputeModule.Vote.ForFreelancer, salt, jurors[0]))
        );

        // Advance to Reveal once the commit deadline passes with the other two silent.
        vm.warp(block.timestamp + COMMIT_WINDOW + 1);
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);

        vm.prank(jurors[0]);
        disputeModule.revealVote(disputeId, DisputeModule.Vote.ForFreelancer, salt);

        // 1 of 3 revealed < quorum (2), reveal deadline not passed → blocked.
        vm.prank(backend);
        vm.expectRevert(DisputeModule.QuorumNotMet.selector);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.ForFreelancer, 10000);

        // Deadline passes → below-quorum resolution allowed per the locked rule.
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        vm.prank(backend);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.ForFreelancer, 10000);
    }

    // -------------------------------------------------------------------
    // Majority outcomes force full/zero splits.
    // -------------------------------------------------------------------

    function test_majorityOutcomeForcesFullSplit() public {
        (, uint256 disputeId) = _createDisputedMilestone(1_000e6, DisputeModule.DisputeType.Quality);
        _assignJurors(disputeId, 3);

        // Zero reveals; consistency check only becomes reachable after the reveal
        // deadline (the quorum gate runs first).
        vm.warp(block.timestamp + COMMIT_WINDOW + 1);
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);

        vm.prank(backend);
        vm.expectRevert(DisputeModule.InconsistentOutcome.selector);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.ForFreelancer, 7000);
    }

    // -------------------------------------------------------------------
    // Double-action guards.
    // -------------------------------------------------------------------

    function test_doubleActionsRevert() public {
        (uint256 projectId, uint256 milestoneId) = _createFundedProjectWithIds(1_000e6);

        // double fund
        vm.prank(client);
        vm.expectRevert(EscrowCore.WrongProjectStatus.selector);
        escrow.fundProject(projectId);

        vm.startPrank(freelancer);
        escrow.startMilestone(milestoneId);
        escrow.submitMilestone(milestoneId, keccak256("d"), keccak256("p"));
        // double submit
        vm.expectRevert(EscrowCore.WrongMilestoneStatus.selector);
        escrow.submitMilestone(milestoneId, keccak256("d2"), keccak256("p2"));
        vm.stopPrank();

        vm.startPrank(client);
        escrow.approveMilestone(milestoneId, 7000);
        // double approve
        vm.expectRevert(EscrowCore.WrongMilestoneStatus.selector);
        escrow.approveMilestone(milestoneId, 7000);
        vm.stopPrank();

        // First dispute opens against the held remainder...
        vm.prank(backend);
        disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.PartialAmount, freelancer, "v1", 3
        );
        // ...second is blocked by the on-chain active-dispute mapping.
        vm.prank(backend);
        vm.expectRevert(DisputeModule.DisputeAlreadyActive.selector);
        disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.PartialAmount, freelancer, "v2", 3
        );
    }

    // -------------------------------------------------------------------
    // Pause coverage: lifecycle freezes; in-flight dispute resolution does not.
    // -------------------------------------------------------------------

    function test_pauseBlocksLifecycleButNotResolution() public {
        (, uint256 milestoneId) = _createFundedProjectWithIds(1_000e6);

        vm.startPrank(freelancer);
        escrow.startMilestone(milestoneId);
        escrow.submitMilestone(milestoneId, keccak256("d"), keccak256("p"));
        vm.stopPrank();

        // Dispute must exist BEFORE pausing — markDisputed carries whenNotPaused by design.
        vm.prank(backend);
        uint256 disputeId = disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.Quality, client, "incident", 3
        );
        _assignJurors(disputeId, 3);
        vm.warp(block.timestamp + COMMIT_WINDOW + 1);

        vm.prank(owner);
        escrow.pause();

        // Lifecycle paths freeze.
        vm.prank(client);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        escrow.approveMilestone(milestoneId, 10000);

        vm.prank(freelancer);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        escrow.submitMilestone(milestoneId, keccak256("x"), keccak256("y"));

        string[] memory titles = _titles();
        uint256[] memory amounts = _amounts(1);
        vm.prank(client);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        escrow.createProject(freelancer, address(usdc), titles, amounts);

        // In-flight resolution stays live during an incident, by design.
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
        vm.prank(backend);
        disputeModule.resolveDispute(disputeId, DisputeModule.DisputeOutcome.TieEscalated, 5000);
        assertEq(uint8(_status(milestoneId)), uint8(EscrowCore.MilestoneStatus.Resolved));

        vm.prank(owner);
        escrow.unpause();
    }

    // -------------------------------------------------------------------
    // emergencyWithdraw cannot touch earmarked funds.
    // -------------------------------------------------------------------

    function test_emergencyWithdrawCannotTouchEarmarkedFunds() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);
        _startAndSubmit(milestoneId);
        vm.prank(client);
        escrow.approveMilestone(milestoneId, 7000); // remainder still earmarked

        vm.prank(owner);
        vm.expectRevert(EscrowCore.InsufficientSurplus.selector);
        escrow.emergencyWithdraw(address(usdc), 300e6, owner);
    }

    function test_emergencyWithdrawAllowsSurplusOnly() public {
        _createFundedSingleMilestoneProject(1_000e6);

        usdc.mint(address(escrow), 50e6); // stray tokens sent directly

        vm.startPrank(owner);
        escrow.emergencyWithdraw(address(usdc), 50e6, owner); // pure surplus OK

        vm.expectRevert(EscrowCore.InsufficientSurplus.selector);
        escrow.emergencyWithdraw(address(usdc), 1, owner); // would dip into escrow
        vm.stopPrank();
    }

    // -------------------------------------------------------------------
    // Malicious-token defenses.
    // -------------------------------------------------------------------

    function test_feeOnTransferTokenBlockedByAllowlist() public {
        FeeOnTransferMockERC20 bad = new FeeOnTransferMockERC20();

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(EscrowCore.TokenNotAllowed.selector, address(bad)));
        escrow.createProject(freelancer, address(bad), _titles(), _amounts(1));
    }

    function test_revertingReturnTokenCannotMisAccount() public {
        RevertingReturnMockERC20 silent = new RevertingReturnMockERC20();
        vm.startPrank(owner);
        escrow.setAllowedToken(address(silent), true);
        vm.stopPrank();
        silent.mint(client, 1_000e6);

        string[] memory titles = _titles();
        uint256[] memory amounts = _amounts(1_000e6);
        vm.prank(client);
        uint256 projectId = escrow.createProject(freelancer, address(silent), titles, amounts);

        vm.startPrank(client);
        silent.approve(address(escrow), 1_000e6);
        silent.setTransfersDisabled(true); // token returns false instead of reverting

        vm.expectRevert(); // SafeERC20 surfaces the false return as a revert
        escrow.fundProject(projectId);

        // Nothing leaked into accounting despite the failed transfer.
        assertEq(escrow.totalEscrowedByToken(address(silent)), 0);
        assertEq(
            uint8(escrow.getProject(projectId).status),
            uint8(EscrowCore.ProjectStatus.Created)
        );
        vm.stopPrank();
    }

    // -------------------------------------------------------------------
    // Admin bounds.
    // -------------------------------------------------------------------

    function test_feeCapEnforced() public {
        vm.prank(owner);
        vm.expectRevert(EscrowCore.FeeTooHigh.selector);
        escrow.setPlatformFeeBps(5001);
    }

    function test_amountAboveUint128Rejected() public {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = uint256(type(uint128).max) + 1;

        vm.prank(client);
        vm.expectRevert(EscrowCore.InvalidAmount.selector);
        escrow.createProject(freelancer, address(usdc), _titles(), amounts);
    }

    // -------------------------------------------------------------------
    // Cancellation disputes are reachable pre-submission only.
    // -------------------------------------------------------------------

    function test_cancellationDisputableBeforeSubmission() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);

        vm.prank(backend);
        disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.Cancellation, client, "client wants out", 3
        );
    }

    function test_qualityDisputeRequiresSubmission() public {
        uint256 milestoneId = _createFundedSingleMilestoneProject(1_000e6);

        vm.prank(backend);
        vm.expectRevert(EscrowCore.NotDisputable.selector);
        disputeModule.createDispute(
            milestoneId, DisputeModule.DisputeType.Quality, client, "too early", 3
        );
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _createFundedSingleMilestoneProject(uint256 amount) internal returns (uint256 milestoneId) {
        (, milestoneId) = _createFundedProjectWithIds(amount);
    }

    function _createFundedProjectWithIds(uint256 amount)
        internal
        returns (uint256 projectId, uint256 milestoneId)
    {
        string[] memory titles = _titles();
        uint256[] memory amounts = _amounts(amount);

        vm.prank(client);
        projectId = escrow.createProject(freelancer, address(usdc), titles, amounts);

        milestoneId = escrow.getProjectMilestones(projectId)[0];

        vm.startPrank(client);
        usdc.approve(address(escrow), amount);
        escrow.fundProject(projectId);
        vm.stopPrank();
    }

    /// Creates a project, drives it to Submitted, opens a dispute on it (Evidence phase).
    function _createDisputedMilestone(uint256 amount, DisputeModule.DisputeType dtype)
        internal
        returns (uint256 milestoneId, uint256 disputeId)
    {
        milestoneId = _createFundedSingleMilestoneProject(amount);
        _startAndSubmit(milestoneId);

        vm.prank(backend);
        disputeId = disputeModule.createDispute(milestoneId, dtype, client, "test dispute", 3);
    }

    function _startAndSubmit(uint256 milestoneId) internal {
        vm.startPrank(freelancer);
        escrow.startMilestone(milestoneId);
        escrow.submitMilestone(milestoneId, keccak256("deliverable"), keccak256("proof"));
        vm.stopPrank();
    }

    function _assignJurors(uint256 disputeId, uint256 n) internal returns (address[] memory jurors) {
        jurors = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            jurors[i] = makeAddr(string.concat("juror-", vm.toString(disputeId), "-", vm.toString(i)));
        }
        vm.prank(backend);
        disputeModule.assignJurors(disputeId, jurors);
    }

    function _commitAll(uint256 disputeId, address[] memory jurors, DisputeModule.Vote vote) internal {
        for (uint256 i = 0; i < jurors.length; i++) {
            bytes32 salt = _salt(disputeId, i);
            vm.prank(jurors[i]);
            disputeModule.commitVote(disputeId, keccak256(abi.encodePacked(vote, salt, jurors[i])));
        }
    }

    function _revealAll(uint256 disputeId, address[] memory jurors, DisputeModule.Vote vote) internal {
        for (uint256 i = 0; i < jurors.length; i++) {
            vm.prank(jurors[i]);
            disputeModule.revealVote(disputeId, vote, _salt(disputeId, i));
        }
    }

    /// Warps past the commit deadline, advances to Reveal, warps past the reveal deadline.
    function _advancePastBothDeadlines(uint256 disputeId) internal {
        vm.warp(block.timestamp + COMMIT_WINDOW + 1);
        vm.prank(backend);
        disputeModule.advancePhase(disputeId);
        vm.warp(block.timestamp + REVEAL_WINDOW + 1);
    }

    function _salt(uint256 disputeId, uint256 i) internal pure returns (bytes32) {
        return keccak256(bytes.concat(bytes32(disputeId), bytes32(i)));
    }

    function _status(uint256 milestoneId) internal view returns (EscrowCore.MilestoneStatus) {
        return escrow.getMilestone(milestoneId).status;
    }

    function _titles() internal pure returns (string[] memory t) {
        t = new string[](1);
        t[0] = "Milestone 1";
    }

    function _amounts(uint256 amount) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = amount;
    }
}
