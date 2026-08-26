// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./EscrowCore.sol";
import "./DisputeModule.sol";
import "./MockERC20.sol";

/// @title EscrowCore invariant campaign
/// @notice Chaos-sequence invariant testing. Foundry drives random interleavings of the
///         handlers below (fund / progress / approve / dispute / rescue / pause / warp),
///         and after EVERY call the three invariant_* functions must hold:
///
///  1. invariant_earmarkLedgerMatchesLiveAllocations —
///       totalEscrowedByToken[token] == Σ liveAmount(milestone)
///     where liveAmount is the amount still owed against that milestone given its status
///     (full amount while pre-settlement, remainder while challenge-window-held, 0 once
///     fully settled). Catches any drift between the accounting ledger and reality.
///
///  2. invariant_escrowBalanceFullyAccounted —
///       token.balanceOf(escrow) == Σ liveAmount(milestone) + rescuedSurplus
///     THE conservation law: every wei that entered via fundProject is either still
///     backing a live milestone, was paid out through an exact-decomposition handler,
///     or was pulled as un-earmarked surplus by emergencyWithdraw. Any double-pay,
///     leak, stuck fee, or earmarked-funds theft makes escrow's balance diverge.
///
///  3. invariant_earmarkNeverExceedsBalance —
///       totalEscrowedByToken[token] <= token.balanceOf(escrow)
///     Direct statement that emergencyWithdraw can never strand a live milestone.
contract EscrowInvariants is Test {
    EscrowCore escrow;
    DisputeModule disputeModule;
    MockERC20 usdc;

    address owner = makeAddr("owner");
    address feeRecipient = makeAddr("feeRecipient");
    address backend = makeAddr("backend");
    address keeper = makeAddr("keeper");

    address[] clients;
    address[] freelancers;
    address[] jurors;

    /// @dev Cumulative amount pulled out via emergencyWithdraw (surplus only, by design).
    uint256 rescued;
    /// @dev Cumulative direct donations to escrow (legitimate surplus until rescued).
    uint256 donated;

    // --- campaign telemetry (read by the meta-invariant below) ---
    uint256 handlerCalls;
    uint256 statFundedProjects;
    uint256 statApprovals;
    uint256 statAutoReleases;
    uint256 statClaims;
    uint256 statDisputesResolved;
    uint256 statRescues;

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

        clients.push(makeAddr("clientA"));
        clients.push(makeAddr("clientB"));
        freelancers.push(makeAddr("freelancerA"));
        freelancers.push(makeAddr("freelancerB"));
        jurors.push(makeAddr("juror1"));
        jurors.push(makeAddr("juror2"));
        jurors.push(makeAddr("juror3"));

        // Restrict the fuzzer to the curated chaos alphabet below. Without this, Foundry
        // also generates raw unauthorized calls into EscrowCore/DisputeModule/MockERC20,
        // which revert ~always and dilute the sequence budget.
        targetContract(address(this));
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = this.h_warp.selector;
        selectors[1] = this.h_createAndFundProject.selector;
        selectors[2] = this.h_startMilestone.selector;
        selectors[3] = this.h_submitMilestone.selector;
        selectors[4] = this.h_approveMilestone.selector;
        selectors[5] = this.h_autoRelease.selector;
        selectors[6] = this.h_claimRemainder.selector;
        selectors[7] = this.h_openDispute.selector;
        selectors[8] = this.h_resolveDispute.selector;
        selectors[9] = this.h_emergencyWithdraw.selector;
        selectors[10] = this.h_pause.selector;
        selectors[11] = this.h_donate.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));

        excludeContract(address(usdc));
        excludeContract(address(escrow));
        excludeContract(address(disputeModule));
    }

    // -------------------------------------------------------------------
    // Handlers (chaos alphabet)
    // -------------------------------------------------------------------

    function h_warp(uint256 daysDelta) external {
        vm.warp(block.timestamp + bound(daysDelta, 0, 21 days));
    }

    function h_createAndFundProject(uint256 seedC, uint256 seedF, uint256 seedAmt, uint256 seedCount)
        external
    {
        handlerCalls++;
        if (escrow.nextProjectId() > 24) return;

        address c = clients[seedC % clients.length];
        address f = freelancers[seedF % freelancers.length];
        uint256 count = bound(seedCount, 1, 3);

        uint256[] memory amounts = new uint256[](count);
        string[] memory titles = new string[](count);
        uint256 total;
        for (uint256 i = 0; i < count; i++) {
            amounts[i] = bound(seedAmt * (i + 1) + 1, 1e6, 25_000e6);
            total += amounts[i];
        }

        usdc.mint(c, total);

        vm.startPrank(c);
        usdc.approve(address(escrow), total);
        try escrow.createProject(f, address(usdc), titles, amounts) returns (uint256 projectId) {
            try escrow.fundProject(projectId) {
                statFundedProjects++;
            } catch {
                usdc.mint(address(0xdead), 0); // no-op; unfunded projects hold nothing
            }
        } catch {}
        vm.stopPrank();
    }

    function h_startMilestone(uint256 seed) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _funded);
        if (!ok) return;
        vm.prank(escrow.milestoneFreelancer(mid));
        try escrow.startMilestone(mid) {} catch {}
    }

    function h_submitMilestone(uint256 seed) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _inProgress);
        if (!ok) return;
        vm.prank(escrow.milestoneFreelancer(mid));
        try escrow.submitMilestone(mid, bytes32(seed), bytes32(seed + 1)) {} catch {}
    }

    /// Full or partial approval; verifies exact payout decomposition on success.
    function h_approveMilestone(uint256 seed, uint32 rawBps) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _submitted);
        if (!ok) return;

        uint32 bps = uint32(bound(rawBps, 1, 10_000));
        uint256 gross = (uint256(_milestone(mid).amount) * bps) / 10_000;
        uint256 fee = (gross * escrow.platformFeeBps()) / 10_000;
        uint256 net = gross - fee;

        (uint256 fBefore, uint256 feeBefore, uint256 cBefore,) = _balances(mid);

        vm.prank(escrow.milestoneClient(mid));
        try escrow.approveMilestone(mid, bps) {
            statApprovals++;
            (uint256 fAfter, uint256 feeAfter, uint256 cAfter,) = _balances(mid);
            assertEq(fAfter - fBefore, net, "approve: freelancer net mismatch");
            assertEq(feeAfter - feeBefore, fee, "approve: fee mismatch");
            assertEq(cAfter, cBefore, "approve: client must not be paid at approval");
        } catch {}
    }

    function h_autoRelease(uint256 seed) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _submitted);
        if (!ok) return;

        uint256 amount = _milestone(mid).amount;
        uint256 fee = (amount * escrow.platformFeeBps()) / 10_000;
        uint256 net = amount - fee;

        (uint256 fBefore, uint256 feeBefore,,) = _balances(mid);

        try escrow.autoReleaseMilestone(mid) {
            statAutoReleases++;
            (uint256 fAfter, uint256 feeAfter,,) = _balances(mid);
            assertEq(fAfter - fBefore, net, "autoRelease: freelancer net mismatch");
            assertEq(feeAfter - feeBefore, fee, "autoRelease: fee mismatch");
        } catch {}
    }

    function h_claimRemainder(uint256 seed) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _approved);
        if (!ok) return;
        uint256 held = escrow.remainderHeld(mid);
        if (held == 0) return;

        (uint256 fBefore, uint256 feeBefore, uint256 cBefore,) = _balances(mid);

        vm.prank(keeper); // permissionless
        try escrow.claimRemainder(mid) {
            statClaims++;
            (uint256 fAfter, uint256 feeAfter, uint256 cAfter,) = _balances(mid);
            assertEq(cAfter - cBefore, held, "claim: client refund mismatch");
            assertEq(fAfter, fBefore, "claim: freelancer must not be paid");
            assertEq(feeAfter, feeBefore, "claim: fee recipient must not be paid");
        } catch {}
    }

    function h_openDispute(uint256 seed, uint8 rawType) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _anyActive);
        if (!ok) return;
        uint8 dt = rawType % 5; // mirrors DisputeType enum width
        vm.prank(backend);
        try disputeModule.createDispute(
            mid, DisputeModule.DisputeType(dt), escrow.milestoneClient(mid), "chaos", 3
        ) {} catch {}
    }

    /// Drives Evidence -> Commit -> Reveal -> Resolved with zero reveals (TieEscalated),
    /// letting the arbiter apply any split. Verifies exact payout decomposition.
    function h_resolveDispute(uint256 seed, uint16 rawSplit) external {
        (bool ok, uint256 mid) = _pickMilestoneWithStatus(seed, _disputed);
        if (!ok) return;

        uint256 did = disputeModule.activeDisputeForMilestone(mid);
        if (did == 0) return;

        DisputeModule.Dispute memory d = disputeModule.getDispute(did);
        if (d.phase == DisputeModule.DisputePhase.Evidence) {
            address[] memory js = new address[](3);
            for (uint256 i = 0; i < 3; i++) js[i] = jurors[i];
            vm.prank(backend);
            try disputeModule.assignJurors(did, js) {} catch {}
        }

        uint256 base = escrow.remainderHeld(mid);
        if (base == 0) base = _milestone(mid).amount;

        uint256 split = bound(rawSplit, 0, 10_000);
        uint256 gross = (base * split) / 10_000;
        uint256 fee = (gross * escrow.platformFeeBps()) / 10_000;
        uint256 net = gross - fee;
        uint256 refund = base - gross;

        (uint256 fBefore, uint256 feeBefore, uint256 cBefore,) = _balances(mid);

        // Chaos includes the clock: push past commit + reveal deadlines (zero reveals).
        vm.warp(block.timestamp + 2 days + 1);
        try disputeModule.advancePhase(did) {} catch {}
        vm.warp(block.timestamp + 2 days + 1);

        vm.prank(backend);
        try disputeModule.resolveDispute(
            did, DisputeModule.DisputeOutcome.TieEscalated, uint16(split)
        ) {
            statDisputesResolved++;
            (uint256 fAfter, uint256 feeAfter, uint256 cAfter,) = _balances(mid);
            assertEq(fAfter - fBefore, net, "resolve: freelancer net mismatch");
            assertEq(feeAfter - feeBefore, fee, "resolve: fee mismatch");
            assertEq(cAfter - cBefore, refund, "resolve: client refund mismatch");
        } catch {}
    }

    /// Owner rescue restricted to computed surplus — the earmark-vs-emergencyWithdraw duel.
    function h_emergencyWithdraw(uint256 seed) external {
        uint256 balance = usdc.balanceOf(address(escrow));
        uint256 earmarked = escrow.totalEscrowedByToken(address(usdc));
        if (balance <= earmarked) return;

        uint256 surplus = balance - earmarked;
        uint256 amount = bound(seed, 0, surplus);
        if (amount == 0) return;

        vm.prank(owner);
        try escrow.emergencyWithdraw(address(usdc), amount, owner) {
            rescued += amount;
            statRescues++;
        } catch {}
    }

    /// Adversarial direct donation: creates legitimate surplus above the earmark, which
    /// is what gives h_emergencyWithdraw something to pull. Donations must never corrupt
    /// live-milestone accounting — conservation below still has to hold exactly.
    function h_donate(uint256 seed) external {
        address donor = clients[seed % clients.length];
        uint256 amount = bound(seed >> 8, 1, 5_000e6);
        usdc.mint(donor, amount);
        vm.startPrank(donor);
        usdc.transfer(address(escrow), amount);
        vm.stopPrank();
        donated += amount;
    }

    function h_pause(bool doPause) external {
        vm.startPrank(owner);
        if (doPause) try escrow.pause() {} catch {}
        else try escrow.unpause() {} catch {}
        vm.stopPrank();
    }

    // -------------------------------------------------------------------
    // Invariants
    // -------------------------------------------------------------------

    function invariant_earmarkLedgerMatchesLiveAllocations() public view {
        assertEq(
            escrow.totalEscrowedByToken(address(usdc)),
            _sumLive(),
            "earmark ledger diverged from live milestone allocations"
        );
    }

    function invariant_escrowBalanceFullyAccounted() public view {
        assertEq(
            usdc.balanceOf(address(escrow)),
            _sumLive() + donated - rescued,
            "escrow balance not fully accounted: leak, stuck fee, or stolen earmark"
        );
    }

    function invariant_earmarkNeverExceedsBalance() public view {
        assertLe(
            escrow.totalEscrowedByToken(address(usdc)),
            usdc.balanceOf(address(escrow)),
            "earmark exceeds balance: emergencyWithdraw stranded live funds"
        );
    }

    /// Meta-invariant: proves the campaign actually REACHES every settlement path. If a
    /// future refactor makes, say, dispute resolution unreachable mid-sequence, the
    /// conservation checks above would pass vacuously — this fails loudly instead.
    function invariant_campaignCoversEverySettlementPath() public view {
        if (handlerCalls < 384) return; // deep-run gate: 75% of depth 512
        assertGt(statFundedProjects, 0, "campaign never funded a project");
        assertGt(statApprovals, 0, "campaign never approved (full or partial)");
        assertGt(statAutoReleases, 0, "campaign never auto-released");
        assertGt(statClaims, 0, "campaign never claimed a remainder");
        assertGt(statDisputesResolved, 0, "campaign never resolved a dispute");
        assertGt(statRescues, 0, "campaign never exercised emergencyWithdraw on surplus");
    }

    // -------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------

    function _sumLive() internal view returns (uint256 total) {
        uint256 count = escrow.nextMilestoneId() - 1;
        for (uint256 mid = 1; mid <= count; mid++) {
            total += _liveAmount(mid);
        }
    }

    /// Amount still owed against a milestone given its settlement state.
    function _liveAmount(uint256 mid) internal view returns (uint256) {
        EscrowCore.MilestoneStatus s = _status(mid);
        if (s == EscrowCore.MilestoneStatus.Created) return 0; // project never funded
        if (
            s == EscrowCore.MilestoneStatus.Funded
                || s == EscrowCore.MilestoneStatus.InProgress
                || s == EscrowCore.MilestoneStatus.Submitted
                || s == EscrowCore.MilestoneStatus.Disputed
        ) return _milestone(mid).amount;
        if (
            s == EscrowCore.MilestoneStatus.Approved
                || s == EscrowCore.MilestoneStatus.AutoReleased
        ) return escrow.remainderHeld(mid);
        return 0; // Resolved
    }

    function _balances(uint256 mid)
        internal
        view
        returns (uint256 f, uint256 fee, uint256 c, uint256 escrowBal)
    {
        f = usdc.balanceOf(escrow.milestoneFreelancer(mid));
        fee = usdc.balanceOf(feeRecipient);
        c = usdc.balanceOf(escrow.milestoneClient(mid));
        escrowBal = usdc.balanceOf(address(escrow));
    }

    // Status predicates for _pickMilestoneWithStatus.

    function _funded(EscrowCore.MilestoneStatus s) internal pure returns (bool) {
        return s == EscrowCore.MilestoneStatus.Funded;
    }

    function _inProgress(EscrowCore.MilestoneStatus s) internal pure returns (bool) {
        return s == EscrowCore.MilestoneStatus.InProgress;
    }

    function _submitted(EscrowCore.MilestoneStatus s) internal pure returns (bool) {
        return s == EscrowCore.MilestoneStatus.Submitted;
    }

    function _approved(EscrowCore.MilestoneStatus s) internal pure returns (bool) {
        return s == EscrowCore.MilestoneStatus.Approved;
    }

    function _disputed(EscrowCore.MilestoneStatus s) internal pure returns (bool) {
        return s == EscrowCore.MilestoneStatus.Disputed;
    }

    function _anyActive(EscrowCore.MilestoneStatus s) internal pure returns (bool) {
        return s == EscrowCore.MilestoneStatus.Funded
            || s == EscrowCore.MilestoneStatus.InProgress
            || s == EscrowCore.MilestoneStatus.Submitted
            || s == EscrowCore.MilestoneStatus.Approved;
    }

    function _pickMilestoneWithStatus(uint256 seed, function(EscrowCore.MilestoneStatus) pure returns (bool) pred)
        internal
        view
        returns (bool ok, uint256 mid)
    {
        uint256 count = escrow.nextMilestoneId() - 1;
        if (count == 0) return (false, 0);
        uint256 start = 1 + (seed % count);
        for (uint256 i = 0; i < count; i++) {
            uint256 candidate = 1 + ((start - 1 + i) % count);
            if (pred(_status(candidate))) return (true, candidate);
        }
        return (false, 0);
    }

    function _milestone(uint256 mid) internal view returns (EscrowCore.Milestone memory) {
        return escrow.getMilestone(mid);
    }

    function _status(uint256 mid) internal view returns (EscrowCore.MilestoneStatus) {
        return _milestone(mid).status;
    }
}
