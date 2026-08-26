// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EscrowCore
/// @notice Holds client funds in escrow across freelance-style milestones, releasing them on
///         client approval, timeout auto-release, or dispute resolution routed through
///         DisputeModule. Upgradeable (UUPS), pausable, reentrancy-guarded.
/// @dev Partial approvals hold the un-approved remainder in escrow behind a challenge window
///      (see `challengeWindow`) so the freelancer has something real to dispute. The remainder
///      refunds to the client only after the window expires claim-free, or per an arbiter/jury
///      split if disputed in time.
contract EscrowCore is
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum ProjectStatus {
        Created,
        Funded,
        Closed
    }

    /// @dev Terminal states are distinct (Approved / AutoReleased / Resolved) so on-chain
    ///      readers can tell *how* a milestone closed without re-indexing events.
    ///      `Approved` additionally covers the post-partial-approval challenge window:
    ///      remainderHeld(milestoneId) != 0 means the window is live or undisputed funds
    ///      are still awaiting `claimRemainder`.
    enum MilestoneStatus {
        Created,
        Funded,
        InProgress,
        Submitted,
        Disputed,
        Approved,
        AutoReleased,
        Resolved
    }

    /// @dev Mirrors DisputeModule.DisputeType. Kept as uint8 here to avoid a hard dependency
    ///      on DisputeModule's enum layout — DisputeModule casts its enum to uint8 when calling in.
    uint8 internal constant DISPUTE_TYPE_CANCELLATION = 2;

    struct Project {
        uint256 id;
        address client;
        address freelancer;
        address token;
        uint256 totalAmount;
        uint32 milestoneCount;
        ProjectStatus status;
        uint64 createdAt;
    }

    struct Milestone {
        uint256 id;
        uint256 projectId;
        uint32 idx;
        uint128 amount; // stablecoin amounts fit comfortably in uint128
        MilestoneStatus status;
        uint32 approvedBps; // set on approval/dispute resolution; 10000 = full
        uint64 reviewDeadline; // unix ts, set at submit
        bytes32 deliverableHash; // sha256(deliverable)
        bytes32 proofOfWorkHash; // sha256(recording || process files)
        uint64 submittedAt;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public disputeModule;

    address public platformFeeRecipient;
    uint256 public platformFeeBps; // default 200 (2%); hard cap 5000 (50%)
    uint256 public defaultReviewTimeout; // seconds; default 604800 (7 days)

    /// @notice Window during which a partially-approved milestone's remainder stays in
    ///         escrow and may be contested via dispute before the client claims it.
    uint256 public challengeWindow; // seconds; default 604800 (7 days)

    uint256 public nextProjectId;
    uint256 public nextMilestoneId;

    mapping(address => bool) public allowedTokens;

    mapping(uint256 => Project) public projects;
    mapping(uint256 => Milestone) public milestones;
    mapping(uint256 => uint256[]) internal projectMilestoneIds;

    // Denormalized lookups set once at creation — saves SLOADs on the hot payout path.
    mapping(uint256 => address) public milestoneClient;
    mapping(uint256 => address) public milestoneFreelancer;
    mapping(uint256 => address) public milestoneToken;

    // Sum of live (not-yet-released) allocations per token, INCLUDING remainders held
    // behind challenge windows. emergencyWithdraw can never touch this.
    mapping(address => uint256) public totalEscrowedByToken;

    // --- partial-approval challenge window state ---
    // Un-approved remainder held in escrow after a partial approval (0 = nothing held).
    mapping(uint256 => uint128) public remainderHeld;
    // Deadline until which the held remainder may be contested via dispute.
    mapping(uint256 => uint64) public challengeDeadline;

    uint256[43] private __gap;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed client,
        address indexed freelancer,
        address token,
        uint256 totalAmount
    );
    event ProjectFunded(uint256 indexed projectId, uint256 amount);
    event MilestoneStarted(uint256 indexed milestoneId, address indexed freelancer);
    event MilestoneSubmitted(
        uint256 indexed milestoneId,
        bytes32 deliverableHash,
        bytes32 proofOfWorkHash,
        uint64 reviewDeadline
    );
    event MilestoneApproved(uint256 indexed milestoneId, uint32 approvedBps, address indexed approver);
    event AutoReleased(uint256 indexed milestoneId, uint32 approvedBps);
    event MilestoneDisputed(uint256 indexed milestoneId, uint8 disputeType);
    event DisputeResolved(uint256 indexed milestoneId, uint16 splitBps);
    event FundsReleased(uint256 indexed milestoneId, uint256 freelancerAmount, uint256 fee, uint256 clientRefund);
    event RemainderHeld(uint256 indexed milestoneId, uint256 amount, uint64 challengeDeadline);
    event RemainderClaimed(uint256 indexed milestoneId, uint256 amount);
    event TokenAllowlistUpdated(address indexed token, bool allowed);
    event DisputeModuleSet(address indexed module);
    event ChallengeWindowSet(uint256 seconds_);
    event PlatformFeeBpsSet(uint256 bps);
    event ReviewTimeoutSet(uint256 seconds_);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error TokenNotAllowed(address token);
    error InvalidParty();
    error InvalidArrayLength();
    error InvalidAmount();
    error TooManyMilestones();
    error NotClient();
    error NotFreelancer();
    error NotDisputeModule();
    error WrongProjectStatus();
    error WrongMilestoneStatus();
    error NotYetDue();
    error InvalidBps();
    error ZeroHash();
    error FeeTooHigh();
    error TimeoutTooShort();
    error InsufficientSurplus();
    error NotDisputable();
    error NothingToClaim();
    error ChallengeWindowOpen();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyDisputeModule() {
        if (msg.sender != disputeModule) revert NotDisputeModule();
        _;
    }

    // ---------------------------------------------------------------------
    // Init / upgrade
    // ---------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address platformFeeRecipient_) external initializer {
        if (owner_ == address(0) || platformFeeRecipient_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        platformFeeRecipient = platformFeeRecipient_;
        platformFeeBps = 200; // 2%
        defaultReviewTimeout = 7 days;
        challengeWindow = 7 days;
        nextProjectId = 1;
        nextMilestoneId = 1;
    }

    /// @dev Upgrades should be routed through a TimelockController set as owner in production.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setDisputeModule(address module) external onlyOwner {
        if (module == address(0)) revert ZeroAddress();
        disputeModule = module;
        emit DisputeModuleSet(module);
    }

    function setPlatformFeeBps(uint256 bps) external onlyOwner {
        if (bps > 5000) revert FeeTooHigh();
        platformFeeBps = bps;
        emit PlatformFeeBpsSet(bps);
    }

    function setDefaultReviewTimeout(uint256 seconds_) external onlyOwner {
        if (seconds_ < 1 hours) revert TimeoutTooShort();
        defaultReviewTimeout = seconds_;
        emit ReviewTimeoutSet(seconds_);
    }

    function setChallengeWindow(uint256 seconds_) external onlyOwner {
        if (seconds_ < 1 hours) revert TimeoutTooShort();
        challengeWindow = seconds_;
        emit ChallengeWindowSet(seconds_);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        allowedTokens[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }

    function setAllowedTokens(address[] calldata tokens, bool[] calldata alloweds) external onlyOwner {
        if (tokens.length != alloweds.length) revert InvalidArrayLength();
        for (uint256 i = 0; i < tokens.length; i++) {
            allowedTokens[tokens[i]] = alloweds[i];
            emit TokenAllowlistUpdated(tokens[i], alloweds[i]);
        }
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Rescue ONLY tokens that aren't backing a live milestone (including remainders
    ///         held behind challenge windows).
    /// @dev surplus = contractBalance(token) - totalEscrowedByToken[token].
    function emergencyWithdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 earmarked = totalEscrowedByToken[token];
        if (balance < earmarked || balance - earmarked < amount) revert InsufficientSurplus();
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Project / milestone lifecycle
    // ---------------------------------------------------------------------

    function createProject(
        address freelancer,
        address token,
        string[] calldata /* titles */, // stored off-chain by the backend indexer; kept for event context only
        uint256[] calldata amounts
    ) external whenNotPaused returns (uint256 projectId) {
        if (!allowedTokens[token]) revert TokenNotAllowed(token);
        if (freelancer == address(0) || freelancer == msg.sender) revert InvalidParty();
        if (amounts.length == 0) revert InvalidArrayLength();
        if (amounts.length > 50) revert TooManyMilestones();

        uint256 total;
        projectId = nextProjectId++;

        for (uint256 i = 0; i < amounts.length; i++) {
            // Explicit bound: silent truncation on the uint128 downcast below would
            // otherwise under-fund a milestone while charging the client in full.
            if (amounts[i] == 0 || amounts[i] > type(uint128).max) revert InvalidAmount();
            total += amounts[i];

            uint256 milestoneId = nextMilestoneId++;
            milestones[milestoneId] = Milestone({
                id: milestoneId,
                projectId: projectId,
                idx: uint32(i),
                amount: uint128(amounts[i]),
                status: MilestoneStatus.Created,
                approvedBps: 0,
                reviewDeadline: 0,
                deliverableHash: bytes32(0),
                proofOfWorkHash: bytes32(0),
                submittedAt: 0
            });
            milestoneClient[milestoneId] = msg.sender;
            milestoneFreelancer[milestoneId] = freelancer;
            milestoneToken[milestoneId] = token;
            projectMilestoneIds[projectId].push(milestoneId);
        }

        projects[projectId] = Project({
            id: projectId,
            client: msg.sender,
            freelancer: freelancer,
            token: token,
            totalAmount: total,
            milestoneCount: uint32(amounts.length),
            status: ProjectStatus.Created,
            createdAt: uint64(block.timestamp)
        });

        emit ProjectCreated(projectId, msg.sender, freelancer, token, total);
    }

    function fundProject(uint256 projectId) external whenNotPaused nonReentrant {
        Project storage p = projects[projectId];
        if (msg.sender != p.client) revert NotClient();
        if (p.status != ProjectStatus.Created) revert WrongProjectStatus();

        p.status = ProjectStatus.Funded;
        totalEscrowedByToken[p.token] += p.totalAmount;

        uint256[] storage ids = projectMilestoneIds[projectId];
        for (uint256 i = 0; i < ids.length; i++) {
            milestones[ids[i]].status = MilestoneStatus.Funded;
        }

        IERC20(p.token).safeTransferFrom(msg.sender, address(this), p.totalAmount);
        emit ProjectFunded(projectId, p.totalAmount);
    }

    function startMilestone(uint256 milestoneId) external whenNotPaused {
        Milestone storage m = milestones[milestoneId];
        if (msg.sender != milestoneFreelancer[milestoneId]) revert NotFreelancer();
        if (m.status != MilestoneStatus.Funded) revert WrongMilestoneStatus();
        m.status = MilestoneStatus.InProgress;
        emit MilestoneStarted(milestoneId, msg.sender);
    }

    /// @param deliverableHash sha256 of the final deliverable.
    /// @param proofOfWorkHash sha256 of the required proof-of-work bundle (screen recording +
    ///        process files). Required on every submission since payment is chunk-by-chunk.
    function submitMilestone(uint256 milestoneId, bytes32 deliverableHash, bytes32 proofOfWorkHash)
        external
        whenNotPaused
    {
        Milestone storage m = milestones[milestoneId];
        if (msg.sender != milestoneFreelancer[milestoneId]) revert NotFreelancer();
        if (m.status != MilestoneStatus.InProgress) revert WrongMilestoneStatus();
        if (deliverableHash == bytes32(0) || proofOfWorkHash == bytes32(0)) revert ZeroHash();

        m.status = MilestoneStatus.Submitted;
        m.deliverableHash = deliverableHash;
        m.proofOfWorkHash = proofOfWorkHash;
        m.submittedAt = uint64(block.timestamp);
        m.reviewDeadline = uint64(block.timestamp + defaultReviewTimeout);

        emit MilestoneSubmitted(milestoneId, deliverableHash, proofOfWorkHash, m.reviewDeadline);
    }

    /// @notice Client approves full or partial.
    ///
    /// Full approval (10000): freelancer share + fee leave escrow immediately.
    ///
    /// Partial approval (<10000): the freelancer's share and fee still leave immediately,
    /// but the un-approved remainder STAYS in escrow behind a challenge window. The
    /// freelancer may open a dispute against the remainder within `challengeWindow`
    /// (via DisputeModule); if the window expires uncontested, anyone may call
    /// `claimRemainder` to refund it to the client.
    /// @param approvedBps Basis points of the milestone amount released to the freelancer.
    function approveMilestone(uint256 milestoneId, uint32 approvedBps) external whenNotPaused nonReentrant {
        Milestone storage m = milestones[milestoneId];
        if (msg.sender != milestoneClient[milestoneId]) revert NotClient();
        if (m.status != MilestoneStatus.Submitted) revert WrongMilestoneStatus();
        if (approvedBps == 0 || approvedBps > 10000) revert InvalidBps();

        m.status = MilestoneStatus.Approved;
        m.approvedBps = approvedBps;
        emit MilestoneApproved(milestoneId, approvedBps, msg.sender);

        uint256 amount = m.amount;
        uint256 approvedGross = (uint256(amount) * approvedBps) / 10_000;
        uint256 fee = (approvedGross * platformFeeBps) / 10_000;
        uint256 netToWorker = approvedGross - fee;
        uint256 remainder = amount - approvedGross;

        address token = milestoneToken[milestoneId];

        if (remainder == 0) {
            // Full approval — everything leaves now.
            totalEscrowedByToken[token] -= amount;
            emit FundsReleased(milestoneId, netToWorker, fee, 0);
            _payout(token, milestoneId, netToWorker, fee, 0);
        } else {
            // Partial approval — release the approved portion, hold the remainder.
            totalEscrowedByToken[token] -= approvedGross;
            remainderHeld[milestoneId] = uint128(remainder);
            challengeDeadline[milestoneId] = uint64(block.timestamp + challengeWindow);
            emit FundsReleased(milestoneId, netToWorker, fee, 0);
            emit RemainderHeld(milestoneId, remainder, challengeDeadline[milestoneId]);
            _payout(token, milestoneId, netToWorker, fee, 0);
        }
    }

    /// @notice Permissionless. Once the challenge window has expired with no dispute, the
    ///         held remainder refunds to the client. Typically called by a keeper or the
    ///         client themselves.
    function claimRemainder(uint256 milestoneId) external nonReentrant {
        Milestone storage m = milestones[milestoneId];
        if (m.status != MilestoneStatus.Approved) revert WrongMilestoneStatus();

        uint256 held = remainderHeld[milestoneId];
        if (held == 0) revert NothingToClaim();
        if (block.timestamp <= challengeDeadline[milestoneId]) revert ChallengeWindowOpen();

        remainderHeld[milestoneId] = 0;
        totalEscrowedByToken[milestoneToken[milestoneId]] -= held;
        emit RemainderClaimed(milestoneId, held);

        IERC20(milestoneToken[milestoneId]).safeTransfer(milestoneClient[milestoneId], held);
    }

    /// @notice Permissionless — anyone (typically a keeper) may call this once the review
    ///         deadline has passed without client action. Acts as a full approval.
    function autoReleaseMilestone(uint256 milestoneId) external whenNotPaused nonReentrant {
        Milestone storage m = milestones[milestoneId];
        if (m.status != MilestoneStatus.Submitted) revert WrongMilestoneStatus();
        if (block.timestamp <= m.reviewDeadline) revert NotYetDue();

        m.status = MilestoneStatus.AutoReleased;
        m.approvedBps = 10000;

        uint128 amount = m.amount;
        uint256 gross = uint256(amount); // 10000 bps
        uint256 fee = (gross * platformFeeBps) / 10_000;
        uint256 netToWorker = gross - fee;

        address token = milestoneToken[milestoneId];
        totalEscrowedByToken[token] -= amount;

        emit AutoReleased(milestoneId, 10000);
        emit FundsReleased(milestoneId, netToWorker, fee, 0);
        _payout(token, milestoneId, netToWorker, fee, 0);
    }

    // ---------------------------------------------------------------------
    // Dispute hooks (DisputeModule only)
    // ---------------------------------------------------------------------

    /// @dev Cancellation disputes may be opened from any pre-submission status. All other
    ///      dispute types require either a submitted milestone OR a partially-approved
    ///      milestone whose remainder is still inside its challenge window — that window is
    ///      what gives the freelancer a real stake to contest.
    function markDisputed(uint256 milestoneId, uint8 disputeType) external onlyDisputeModule whenNotPaused {
        Milestone storage m = milestones[milestoneId];

        bool disputableForType;
        if (disputeType == DISPUTE_TYPE_CANCELLATION) {
            disputableForType = m.status == MilestoneStatus.Funded ||
                m.status == MilestoneStatus.InProgress ||
                m.status == MilestoneStatus.Submitted;
        } else {
            disputableForType = m.status == MilestoneStatus.Submitted ||
                (m.status == MilestoneStatus.Approved &&
                    remainderHeld[milestoneId] != 0 &&
                    block.timestamp <= challengeDeadline[milestoneId]);
        }

        if (!disputableForType) revert NotDisputable();

        m.status = MilestoneStatus.Disputed;
        emit MilestoneDisputed(milestoneId, disputeType);
    }

    /// @notice Executes the payout decided by a resolved dispute.
    /// @dev The payout base depends on what was actually contested:
    ///      - Pre-approval dispute (milestone never approved): base = full milestone amount.
    ///      - Post-approval dispute (remainder was held): base = the held remainder ONLY —
    ///        the already-released approved portion is untouched history.
    function resolvePayout(uint256 milestoneId, uint16 splitBps) external onlyDisputeModule nonReentrant {
        Milestone storage m = milestones[milestoneId];
        if (m.status != MilestoneStatus.Disputed) revert WrongMilestoneStatus();
        if (splitBps > 10000) revert InvalidBps();

        uint128 held = remainderHeld[milestoneId];
        uint256 base = held != 0 ? uint256(held) : uint256(m.amount);

        m.status = MilestoneStatus.Resolved;
        remainderHeld[milestoneId] = 0;

        uint256 gross = (base * splitBps) / 10_000;
        uint256 fee = (gross * platformFeeBps) / 10_000;
        uint256 netToWorker = gross - fee;
        uint256 refund = base - gross;

        address token = milestoneToken[milestoneId];
        totalEscrowedByToken[token] -= base;

        emit DisputeResolved(milestoneId, splitBps);
        emit FundsReleased(milestoneId, netToWorker, fee, refund);
        _payout(token, milestoneId, netToWorker, fee, refund);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev NOT marked nonReentrant. The guard lives on every external entry point above
    ///      (approveMilestone, claimRemainder, autoReleaseMilestone, resolvePayout).
    ///      OZ's ReentrancyGuard reverts on a *nested* nonReentrant call within the same
    ///      transaction — even from the same contract — so marking this nonReentrant too
    ///      would make every payout path revert unconditionally. Covered by regression tests.
    function _payout(address token, uint256 milestoneId, uint256 netToWorker, uint256 fee, uint256 refund)
        internal
    {
        // Interactions last (checks-effects-interactions) — callers update all state first.
        IERC20 erc20 = IERC20(token);
        if (netToWorker > 0) erc20.safeTransfer(milestoneFreelancer[milestoneId], netToWorker);
        if (fee > 0) erc20.safeTransfer(platformFeeRecipient, fee);
        if (refund > 0) erc20.safeTransfer(milestoneClient[milestoneId], refund);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getMilestone(uint256 milestoneId) external view returns (Milestone memory) {
        return milestones[milestoneId];
    }

    function getProject(uint256 projectId) external view returns (Project memory) {
        return projects[projectId];
    }

    function getProjectMilestones(uint256 projectId) external view returns (uint256[] memory) {
        return projectMilestoneIds[projectId];
    }

    function isAllowedToken(address token) external view returns (bool) {
        return allowedTokens[token];
    }

    /// @notice Convenience view: settlement state of a milestone's remainder.
    function getRemainderState(uint256 milestoneId)
        external
        view
        returns (uint128 held, uint64 deadline, bool claimableNow, bool disputableNow)
    {
        held = remainderHeld[milestoneId];
        deadline = challengeDeadline[milestoneId];
        claimableNow =
            milestones[milestoneId].status == MilestoneStatus.Approved &&
            held != 0 &&
            block.timestamp > deadline;
        disputableNow =
            milestones[milestoneId].status == MilestoneStatus.Approved &&
            held != 0 &&
            block.timestamp <= deadline;
    }
}
