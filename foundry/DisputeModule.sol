// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./IEscrowCore.sol";

/// @title DisputeModule
/// @notice Commit-reveal dispute resolution for EscrowCore milestones.
/// @dev v1: resolution is backend-adjudicated — an authorized backend supplies the outcome
///      and split after tallying revealed votes off-chain. Juror votes are recorded on-chain
///      as an audit trail but do not themselves constrain the payout in v1. This is a
///      deliberate, disclosed tradeoff (jurors are platform-team members in Phase 1); v2/v3
///      is expected to compute the tally on-chain and make resolveDispute permissionless.
contract DisputeModule is
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum DisputeType {
        Quality,
        Scope,
        Cancellation,
        AiFlag,
        PartialAmount
    }

    enum DisputePhase {
        Evidence,
        Commit,
        Reveal,
        Resolved
    }

    /// @dev Individual juror ballot. Distinct from DisputeOutcome below — collapsing these
    ///      into one enum in an earlier draft is what dropped the tie case; kept separate here.
    enum Vote {
        Abstain,
        ForFreelancer,
        ForClient
    }

    /// @dev What a dispute actually resolves to. TieEscalated is a real, reachable outcome:
    ///      zero reveals at deadline, or a genuine split jury, both route here.
    enum DisputeOutcome {
        ForFreelancer,
        ForClient,
        TieEscalated
    }

    struct Dispute {
        uint256 id;
        uint256 milestoneId;
        DisputeType disputeType;
        address raisedBy;
        string reason; // short summary only; full detail lives off-chain in the backend
        uint8 jurorCount;
        DisputePhase phase;
        uint64 commitDeadline;
        uint64 revealDeadline;
        DisputeOutcome outcome; // meaningful only once phase == Resolved
        uint16 splitBps; // final freelancer share, set at resolution
        uint64 createdAt;
        uint8 revealedCount;
    }

    struct JurorVote {
        bytes32 commitment; // keccak256(abi.encodePacked(vote, salt, msg.sender))
        Vote revealedVote;
        bool committed;
        bool revealed;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public escrowCore;
    mapping(address => bool) public authorizedBackends;

    uint256 public nextDisputeId;

    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => uint256) public activeDisputeForMilestone; // milestoneId -> disputeId (0 = none)
    mapping(uint256 => address[]) public disputeJurors;
    mapping(uint256 => mapping(address => JurorVote)) public votes;
    mapping(uint256 => mapping(address => bool)) internal isAssignedJuror;

    uint256 public commitWindow; // default 2 days
    uint256 public revealWindow; // default 2 days

    uint256[44] private __gap;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event DisputeOpened(uint256 indexed disputeId, uint256 indexed milestoneId, DisputeType disputeType, address raisedBy);
    event JurorsAssigned(uint256 indexed disputeId, address[] jurors);
    event VoteCommitted(uint256 indexed disputeId, address indexed juror, bytes32 commitment);
    event VoteRevealed(uint256 indexed disputeId, address indexed juror, Vote vote);
    event PhaseAdvanced(uint256 indexed disputeId, DisputePhase phase, uint64 deadline);
    event JurorNonParticipating(uint256 indexed disputeId, address indexed juror); // DB-side slash signal
    event DisputeResolved(uint256 indexed disputeId, DisputeOutcome outcome, uint16 splitBps);
    event BackendAuthorized(address indexed backend, bool authorized);
    event EscrowCoreSet(address indexed core);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwnerOrBackend();
    error InvalidJurorCount();
    error DisputeAlreadyActive();
    error WrongPhase();
    error LengthMismatch();
    error DuplicateJuror();
    error ZeroAddressJuror();
    error NotAssignedJuror();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error NotCommitted();
    error CommitMismatch();
    error NotAllJurorsAssigned();
    error CommitPhaseNotDone();
    error RevealPhaseNotDone();
    error QuorumNotMet();
    error InconsistentOutcome();
    error InvalidSplitBps();
    error DeadlineNotPassed();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwnerOrBackend() {
        if (msg.sender != owner() && !authorizedBackends[msg.sender]) revert NotOwnerOrBackend();
        _;
    }

    // ---------------------------------------------------------------------
    // Init / upgrade
    // ---------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address escrowCore_) external initializer {
        if (owner_ == address(0) || escrowCore_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        escrowCore = escrowCore_;
        nextDisputeId = 1;
        commitWindow = 2 days;
        revealWindow = 2 days;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setEscrowCore(address core) external onlyOwner {
        if (core == address(0)) revert ZeroAddress();
        escrowCore = core;
        emit EscrowCoreSet(core);
    }

    function setBackend(address backend, bool authorized) external onlyOwner {
        authorizedBackends[backend] = authorized;
        emit BackendAuthorized(backend, authorized);
    }

    function setWindows(uint256 commitWindow_, uint256 revealWindow_) external onlyOwner {
        commitWindow = commitWindow_;
        revealWindow = revealWindow_;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Dispute lifecycle
    // ---------------------------------------------------------------------

    function createDispute(
        uint256 milestoneId,
        DisputeType disputeType,
        address raisedBy,
        string calldata reason,
        uint8 jurorCount
    ) external onlyOwnerOrBackend whenNotPaused returns (uint256 disputeId) {
        if (jurorCount < 3 || jurorCount > 7 || jurorCount % 2 == 0) revert InvalidJurorCount();
        if (activeDisputeForMilestone[milestoneId] != 0) revert DisputeAlreadyActive();

        disputeId = nextDisputeId++;
        disputes[disputeId] = Dispute({
            id: disputeId,
            milestoneId: milestoneId,
            disputeType: disputeType,
            raisedBy: raisedBy,
            reason: reason,
            jurorCount: jurorCount,
            phase: DisputePhase.Evidence,
            commitDeadline: 0,
            revealDeadline: 0,
            outcome: DisputeOutcome.TieEscalated, // placeholder until resolved
            splitBps: 0,
            createdAt: uint64(block.timestamp),
            revealedCount: 0
        });
        activeDisputeForMilestone[milestoneId] = disputeId;

        // Event before the external call (slither reentrancy-events): emission order has no
        // semantic effect here since markDisputed reverting rolls the event back anyway.
        emit DisputeOpened(disputeId, milestoneId, disputeType, raisedBy);

        IEscrowCore(escrowCore).markDisputed(milestoneId, uint8(disputeType));
    }

    function assignJurors(uint256 disputeId, address[] calldata jurors) external onlyOwnerOrBackend {
        Dispute storage d = disputes[disputeId];
        if (d.phase != DisputePhase.Evidence) revert WrongPhase();
        if (jurors.length != d.jurorCount) revert LengthMismatch();

        for (uint256 i = 0; i < jurors.length; i++) {
            if (jurors[i] == address(0)) revert ZeroAddressJuror();
            for (uint256 j = i + 1; j < jurors.length; j++) {
                if (jurors[i] == jurors[j]) revert DuplicateJuror();
            }
            disputeJurors[disputeId].push(jurors[i]);
            isAssignedJuror[disputeId][jurors[i]] = true;
        }

        d.phase = DisputePhase.Commit;
        d.commitDeadline = uint64(block.timestamp + commitWindow);

        emit JurorsAssigned(disputeId, jurors);
        emit PhaseAdvanced(disputeId, DisputePhase.Commit, d.commitDeadline);
    }

    /// @param commitment MUST be keccak256(abi.encodePacked(vote, salt, msg.sender)).
    ///        Binding to msg.sender prevents a juror from copying another juror's commitment
    ///        before any reveal has landed.
    function commitVote(uint256 disputeId, bytes32 commitment) external whenNotPaused {
        Dispute storage d = disputes[disputeId];
        if (!isAssignedJuror[disputeId][msg.sender]) revert NotAssignedJuror();
        if (d.phase != DisputePhase.Commit) revert WrongPhase();

        JurorVote storage jv = votes[disputeId][msg.sender];
        if (jv.committed) revert AlreadyCommitted();

        jv.commitment = commitment;
        jv.committed = true;

        emit VoteCommitted(disputeId, msg.sender, commitment);
    }

    function revealVote(uint256 disputeId, Vote vote, bytes32 salt) external whenNotPaused {
        Dispute storage d = disputes[disputeId];
        if (!isAssignedJuror[disputeId][msg.sender]) revert NotAssignedJuror();
        if (d.phase != DisputePhase.Reveal) revert WrongPhase();

        JurorVote storage jv = votes[disputeId][msg.sender];
        if (!jv.committed) revert NotCommitted();
        if (jv.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(vote, salt, msg.sender)) != jv.commitment) revert CommitMismatch();

        jv.revealed = true;
        jv.revealedVote = vote;
        d.revealedCount += 1;

        emit VoteRevealed(disputeId, msg.sender, vote);
    }

    /// @dev Evidence -> Commit requires all jurors assigned (handled in assignJurors).
    ///      Commit -> Reveal requires either every assigned juror committed, or the commit
    ///      deadline has passed (mirrors the reveal-phase timeout so a stalled commit phase
    ///      can't block a dispute indefinitely).
    function advancePhase(uint256 disputeId) external onlyOwnerOrBackend {
        Dispute storage d = disputes[disputeId];

        if (d.phase == DisputePhase.Commit) {
            bool allCommitted = true;
            address[] storage jurors = disputeJurors[disputeId];
            for (uint256 i = 0; i < jurors.length; i++) {
                if (!votes[disputeId][jurors[i]].committed) {
                    allCommitted = false;
                    break;
                }
            }
            if (!allCommitted && block.timestamp <= d.commitDeadline) revert CommitPhaseNotDone();

            d.phase = DisputePhase.Reveal;
            d.revealDeadline = uint64(block.timestamp + revealWindow);
            emit PhaseAdvanced(disputeId, DisputePhase.Reveal, d.revealDeadline);
        } else {
            revert WrongPhase();
        }
    }

    /// @notice Backend-adjudicated resolution (v1). Enforces quorum and outcome/split
    ///         consistency on-chain even though the tally itself is computed off-chain.
    /// @param outcome Must be internally consistent with splitBps: majority outcomes force
    ///        a full/zero split; only TieEscalated admits an arbiter-chosen graded split.
    function resolveDispute(uint256 disputeId, DisputeOutcome outcome, uint16 splitBps)
        external
        onlyOwnerOrBackend
        nonReentrant
    {
        Dispute storage d = disputes[disputeId];
        if (d.phase != DisputePhase.Reveal) revert WrongPhase();
        if (splitBps > 10000) revert InvalidSplitBps();

        uint256 quorum = uint256(d.jurorCount) / 2 + 1;
        bool deadlinePassed = block.timestamp > d.revealDeadline;

        if (d.revealedCount == 0) {
            // Zero reveals: the only legal path forward is deadline-passed + TieEscalated.
            // Nothing else may resolve a dispute with no participation at all.
            if (!deadlinePassed) revert QuorumNotMet();
            if (outcome != DisputeOutcome.TieEscalated) revert InconsistentOutcome();
        } else if (d.revealedCount < quorum) {
            // Below quorum: only allowed once the deadline has passed, with at least one
            // reveal in hand (per the locked quorum rule).
            if (!deadlinePassed) revert QuorumNotMet();
        }
        // else: quorum met, resolve freely regardless of deadline.

        if (outcome == DisputeOutcome.ForFreelancer && splitBps != 10000) revert InconsistentOutcome();
        if (outcome == DisputeOutcome.ForClient && splitBps != 0) revert InconsistentOutcome();
        // TieEscalated: admin/backend may supply any splitBps in [0, 10000] — this IS the
        // arbiter's decision when the jury didn't produce a clean majority.

        _flagNonParticipants(disputeId);

        d.phase = DisputePhase.Resolved;
        d.outcome = outcome;
        d.splitBps = splitBps;
        activeDisputeForMilestone[d.milestoneId] = 0;

        emit DisputeResolved(disputeId, outcome, splitBps);

        IEscrowCore(escrowCore).resolvePayout(d.milestoneId, splitBps);
    }

    function _flagNonParticipants(uint256 disputeId) internal {
        address[] storage jurors = disputeJurors[disputeId];
        for (uint256 i = 0; i < jurors.length; i++) {
            if (!votes[disputeId][jurors[i]].revealed) {
                emit JurorNonParticipating(disputeId, jurors[i]);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return disputes[disputeId];
    }

    function getJurorVote(uint256 disputeId, address juror) external view returns (JurorVote memory) {
        return votes[disputeId][juror];
    }

    function getDisputeJurors(uint256 disputeId) external view returns (address[] memory) {
        return disputeJurors[disputeId];
    }

    function isJurorAssigned(uint256 disputeId, address juror) external view returns (bool) {
        return isAssignedJuror[disputeId][juror];
    }
}
