// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title DecentralizedEscrow
 * @author Parithosh Varma
 * @notice Trustless multi-party escrow with dispute resolution, timeout refunds, and arbiter registry
 * @dev Supports native ETH and ERC-20, uses ReentrancyGuard + SafeERC20 + CEI pattern
 * @custom:security-contact demgufever@gmail.com
 */
contract DecentralizedEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Lifecycle states for an escrow
    enum EscrowStatus { Pending, Funded, Completed, Disputed, Refunded }

    /// @notice Core escrow data stored per escrowId
    struct Escrow {
        address buyer;
        address seller;
        address arbiter;
        address token;
        uint256 amount;
        uint256 feePercent;
        uint256 createdAt;
        uint256 expiration;
        EscrowStatus status;
        bool buyerConfirmed;
        bool sellerConfirmed;
        uint256 disputeCount;
        uint256 lastDisputeTime;
        address resolver; // who resolved the dispute
    }

    /// @notice Whitelisted arbiter metadata
    struct Arbiter {
        bool isApproved;
        uint256 reputation;
        uint256 casesResolved;
        uint256 totalDisputes;
    }

    address public admin;
    address public treasury;
    uint256 public defaultFeePercent;
    uint256 public constant MAX_FEE = 200;
    uint256 public constant MIN_FEE = 5;
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant DISPUTE_COOLDOWN = 24 hours;
    bool public paused;

    uint256 public escrowCount;
    mapping(uint256 => Escrow) public escrows;
    mapping(address => Arbiter) public arbiters;
    address[] public arbiterList;

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        address arbiter,
        address token,
        uint256 amount,
        uint256 expiration,
        uint256 feePercent
    );

    event FundsDeposited(uint256 indexed escrowId, address indexed depositor, uint256 amount);
    event BuyerConfirmed(uint256 indexed escrowId);
    event SellerConfirmed(uint256 indexed escrowId);
    event EscrowCompleted(uint256 indexed escrowId, address token, uint256 amount, uint256 fee);
    event DisputeOpened(uint256 indexed escrowId, address indexed opener);
    event DisputeResolved(uint256 indexed escrowId, EscrowStatus status, address indexed resolver);
    event EscrowRefunded(uint256 indexed escrowId, uint256 amount);
    event ArbiterAdded(address indexed arbiter);
    event ArbiterRemoved(address indexed arbiter);
    event ArbiterReputationUpdated(address indexed arbiter, uint256 newScore);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event TreasuryUpdated(address indexed newTreasury);
    event DefaultFeeUpdated(uint256 newFee);
    event EmergencyWithdraw(address indexed token, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Escrow: not admin");
        _;
    }

    modifier onlyBuyer(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].buyer, "Escrow: not buyer");
        _;
    }

    modifier onlySeller(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].seller, "Escrow: not seller");
        _;
    }

    modifier onlyArbiter(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].arbiter, "Escrow: not arbiter");
        _;
    }

    modifier onlyParticipant(uint256 escrowId) {
        Escrow storage e = escrows[escrowId];
        require(
            msg.sender == e.buyer || msg.sender == e.seller || msg.sender == e.arbiter,
            "Escrow: not participant"
        );
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Escrow: paused");
        _;
    }

    modifier validEscrow(uint256 escrowId) {
        require(escrowId < escrowCount, "Escrow: does not exist");
        _;
    }

    modifier validDuration(uint256 expiration) {
        require(
            expiration >= block.timestamp + MIN_DURATION &&
            expiration <= block.timestamp + MAX_DURATION,
            "Escrow: invalid duration"
        );
        _;
    }

    modifier validFee(uint256 feePercent) {
        require(feePercent >= MIN_FEE && feePercent <= MAX_FEE, "Escrow: invalid fee");
        _;
    }

    constructor(address _admin, address _treasury, uint256 _defaultFeePercent) {
        require(_admin != address(0), "Escrow: zero admin");
        require(_treasury != address(0), "Escrow: zero treasury");
        require(
            _defaultFeePercent >= MIN_FEE && _defaultFeePercent <= MAX_FEE,
            "Escrow: invalid fee"
        );
        admin = _admin;
        treasury = _treasury;
        defaultFeePercent = _defaultFeePercent;
    }

    // Arbiter Registry

    function addArbiter(address arbiter) external onlyAdmin {
        require(arbiter != address(0), "Escrow: zero address");
        require(!arbiters[arbiter].isApproved, "Escrow: already arbiter");
        arbiters[arbiter] = Arbiter({
            isApproved: true,
            reputation: 100,
            casesResolved: 0,
            totalDisputes: 0
        });
        arbiterList.push(arbiter);
        emit ArbiterAdded(arbiter);
    }

    function removeArbiter(address arbiter) external onlyAdmin {
        require(arbiters[arbiter].isApproved, "Escrow: not arbiter");
        arbiters[arbiter].isApproved = false;
        for (uint256 i = 0; i < arbiterList.length; i++) {
            if (arbiterList[i] == arbiter) {
                arbiterList[i] = arbiterList[arbiterList.length - 1];
                arbiterList.pop();
                break;
            }
        }
        emit ArbiterRemoved(arbiter);
    }

    function isApprovedArbiter(address arbiter) public view returns (bool) {
        return arbiters[arbiter].isApproved;
    }

    function getArbiterCount() external view returns (uint256) {
        return arbiterList.length;
    }

    function getArbiter(uint256 index) external view returns (address) {
        require(index < arbiterList.length, "Escrow: index out of bounds");
        return arbiterList[index];
    }

    function updateReputation(address arbiter, uint256 newScore) external onlyAdmin {
        require(arbiters[arbiter].isApproved, "Escrow: not arbiter");
        require(newScore <= 100, "Escrow: max 100");
        arbiters[arbiter].reputation = newScore;
        emit ArbiterReputationUpdated(arbiter, newScore);
    }

    // Escrow Creation

    function createEscrow(
        address seller,
        address arbiter,
        address token,
        uint256 amount,
        uint256 expiration,
        uint256 feePercent
    ) external whenNotPaused returns (uint256) {
        require(seller != address(0), "Escrow: zero seller");
        require(arbiter == address(0) || isApprovedArbiter(arbiter), "Escrow: invalid arbiter");
        require(amount > 0, "Escrow: zero amount");
        require(msg.sender != seller, "Escrow: buyer == seller");

        uint256 effectiveFee = feePercent;
        if (effectiveFee == 0) {
            effectiveFee = defaultFeePercent;
        }
        require(effectiveFee >= MIN_FEE && effectiveFee <= MAX_FEE, "Escrow: invalid fee");
        require(expiration >= block.timestamp + MIN_DURATION, "Escrow: expiration too soon");
        require(expiration <= block.timestamp + MAX_DURATION, "Escrow: expiration too far");

        uint256 escrowId = escrowCount;
        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            arbiter: arbiter,
            token: token,
            amount: amount,
            feePercent: effectiveFee,
            createdAt: block.timestamp,
            expiration: expiration,
            status: EscrowStatus.Pending,
            buyerConfirmed: false,
            sellerConfirmed: false,
            disputeCount: 0,
            lastDisputeTime: 0,
            resolver: address(0)
        });
        escrowCount++;

        emit EscrowCreated(escrowId, msg.sender, seller, arbiter, token, amount, expiration, effectiveFee);
        return escrowId;
    }

    function batchCreateEscrow(
        address[] calldata sellers,
        address[] calldata arbitersList_,
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata expirations,
        uint256[] calldata feePercents
    ) external whenNotPaused returns (uint256[] memory) {
        uint256 len = sellers.length;
        require(
            len == arbitersList_.length &&
            len == tokens.length &&
            len == amounts.length &&
            len == expirations.length &&
            len == feePercents.length,
            "Escrow: length mismatch"
        );
        require(len <= 50, "Escrow: batch too large");

        uint256[] memory ids = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            ids[i] = this.createEscrow(sellers[i], arbitersList_[i], tokens[i], amounts[i], expirations[i], feePercents[i]);
        }
        return ids;
    }

    // Deposit

    function deposit(uint256 escrowId) external payable whenNotPaused validEscrow(escrowId) {
        _deposit(escrowId);
    }

    function _deposit(uint256 escrowId) internal {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Pending, "Escrow: not pending");
        require(msg.sender == e.buyer, "Escrow: not buyer");

        if (e.token == address(0)) {
            require(msg.value == e.amount, "Escrow: incorrect ETH amount");
        } else {
            require(msg.value == 0, "Escrow: ETH not expected");
            IERC20 token = IERC20(e.token);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), e.amount);
            uint256 balanceAfter = token.balanceOf(address(this));
            require(balanceAfter >= before + e.amount, "Escrow: transfer underflow");
        }

        e.status = EscrowStatus.Funded;
        emit FundsDeposited(escrowId, msg.sender, e.amount);
    }

    function batchDeposit(uint256[] calldata escrowIds) external payable whenNotPaused {
        uint256 len = escrowIds.length;
        require(len <= 50, "Escrow: batch too large");
        uint256 remaining = msg.value;
        for (uint256 i = 0; i < len; i++) {
            uint256 eId = escrowIds[i];
            Escrow storage e = escrows[eId];
            require(e.status == EscrowStatus.Pending, "Escrow: not pending");
            require(msg.sender == e.buyer, "Escrow: not buyer");
            if (e.token == address(0)) {
                require(remaining >= e.amount, "Escrow: insufficient ETH");
                remaining -= e.amount;
            } else {
                IERC20 token = IERC20(e.token);
                uint256 before = token.balanceOf(address(this));
                token.safeTransferFrom(msg.sender, address(this), e.amount);
                uint256 balanceAfter = token.balanceOf(address(this));
                require(balanceAfter >= before + e.amount, "Escrow: transfer underflow");
            }
            e.status = EscrowStatus.Funded;
            emit FundsDeposited(eId, msg.sender, e.amount);
        }
        if (remaining > 0) {
            (bool refund, ) = payable(msg.sender).call{ value: remaining }("");
            require(refund, "Escrow: refund failed");
        }
    }

    // Confirmation Flow

    function confirmByBuyer(uint256 escrowId) external whenNotPaused nonReentrant validEscrow(escrowId) onlyBuyer(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Funded || e.status == EscrowStatus.Pending, "Escrow: invalid state");
        require(!e.buyerConfirmed, "Escrow: already confirmed");

        e.buyerConfirmed = true;

        if (e.status == EscrowStatus.Funded && e.sellerConfirmed) {
            _executeRelease(escrowId);
        }

        emit BuyerConfirmed(escrowId);
    }

    function confirmBySeller(uint256 escrowId) external whenNotPaused nonReentrant validEscrow(escrowId) onlySeller(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Funded || e.status == EscrowStatus.Pending, "Escrow: invalid state");
        require(!e.sellerConfirmed, "Escrow: already confirmed");

        e.sellerConfirmed = true;

        if (e.status == EscrowStatus.Funded && e.buyerConfirmed) {
            _executeRelease(escrowId);
        }

        emit SellerConfirmed(escrowId);
    }

    function release(uint256 escrowId) external whenNotPaused nonReentrant validEscrow(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Funded, "Escrow: not funded");

        if (e.buyerConfirmed && e.sellerConfirmed) {
            _executeRelease(escrowId);
        } else {
            require(
                msg.sender == e.buyer || msg.sender == e.seller,
                "Escrow: both confirmations required"
            );
            if (msg.sender == e.buyer) {
                e.buyerConfirmed = true;
                emit BuyerConfirmed(escrowId);
            } else {
                e.sellerConfirmed = true;
                emit SellerConfirmed(escrowId);
            }
            if (e.buyerConfirmed && e.sellerConfirmed) {
                _executeRelease(escrowId);
            }
        }
    }

    function _executeRelease(uint256 escrowId) internal {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Funded, "Escrow: not funded");
        e.status = EscrowStatus.Completed;
        uint256 fee = (e.amount * e.feePercent) / 10000;
        uint256 payout = e.amount - fee;

        if (e.token == address(0)) {
            (bool successSeller, ) = payable(e.seller).call{ value: payout }("");
            require(successSeller, "Escrow: seller transfer failed");
            if (fee > 0) {
                (bool successFee, ) = payable(treasury).call{ value: fee }("");
                require(successFee, "Escrow: fee transfer failed");
            }
        } else {
            IERC20 token = IERC20(e.token);
            token.safeTransfer(e.seller, payout);
            if (fee > 0) {
                token.safeTransfer(treasury, fee);
            }
        }

        emit EscrowCompleted(escrowId, e.token, payout, fee);
    }

    // Dispute Resolution

    function openDispute(uint256 escrowId) external whenNotPaused validEscrow(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Funded, "Escrow: not funded");
        require(
            msg.sender == e.buyer || msg.sender == e.seller,
            "Escrow: only buyer or seller"
        );
        require(
            block.timestamp >= e.lastDisputeTime + DISPUTE_COOLDOWN,
            "Escrow: dispute cooldown"
        );
        require(e.disputeCount < 3, "Escrow: max disputes reached");
        require(e.arbiter != address(0), "Escrow: no arbiter assigned");

        e.status = EscrowStatus.Disputed;
        e.disputeCount++;
        e.lastDisputeTime = block.timestamp;

        arbiters[e.arbiter].totalDisputes++;

        emit DisputeOpened(escrowId, msg.sender);
    }

    function resolveDispute(
        uint256 escrowId,
        EscrowStatus resolution
    ) external whenNotPaused nonReentrant validEscrow(escrowId) onlyArbiter(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Disputed, "Escrow: not disputed");
        require(
            resolution == EscrowStatus.Completed || resolution == EscrowStatus.Refunded,
            "Escrow: invalid resolution"
        );

        e.status = resolution;
        e.resolver = msg.sender;

        if (resolution == EscrowStatus.Completed) {
            uint256 fee = (e.amount * e.feePercent) / 10000;
            uint256 payout = e.amount - fee;
            if (e.token == address(0)) {
                (bool successSeller, ) = payable(e.seller).call{ value: payout }("");
                require(successSeller, "Escrow: seller transfer failed");
                if (fee > 0) {
                    (bool successFee, ) = payable(treasury).call{ value: fee }("");
                    require(successFee, "Escrow: fee transfer failed");
                }
            } else {
                IERC20 token = IERC20(e.token);
                token.safeTransfer(e.seller, payout);
                if (fee > 0) {
                    token.safeTransfer(treasury, fee);
                }
            }
            arbiters[msg.sender].casesResolved++;
            emit EscrowCompleted(escrowId, e.token, payout, fee);
        } else if (resolution == EscrowStatus.Refunded) {
            if (e.token == address(0)) {
                (bool successBuyer, ) = payable(e.buyer).call{ value: e.amount }("");
                require(successBuyer, "Escrow: buyer refund failed");
            } else {
                IERC20(e.token).safeTransfer(e.buyer, e.amount);
            }
            arbiters[msg.sender].casesResolved++;
            emit EscrowRefunded(escrowId, e.amount);
        }

        emit DisputeResolved(escrowId, resolution, msg.sender);
    }

    // Refund Mechanism

    function requestRefund(uint256 escrowId) external whenNotPaused nonReentrant validEscrow(escrowId) onlyBuyer(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(
            e.status == EscrowStatus.Funded || e.status == EscrowStatus.Pending,
            "Escrow: cannot refund"
        );
        require(block.timestamp >= e.expiration, "Escrow: not expired");

        e.status = EscrowStatus.Refunded;

        if (e.token == address(0)) {
            if (address(this).balance >= e.amount) {
                (bool success, ) = payable(e.buyer).call{ value: e.amount }("");
                require(success, "Escrow: refund failed");
            }
        } else {
            IERC20 token = IERC20(e.token);
            uint256 balance = token.balanceOf(address(this));
            if (balance >= e.amount) {
                token.safeTransfer(e.buyer, e.amount);
            }
        }

        emit EscrowRefunded(escrowId, e.amount);
    }

    // Admin Functions

    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function updateTreasury(address newTreasury) external onlyAdmin {
        require(newTreasury != address(0), "Escrow: zero address");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function updateDefaultFee(uint256 newFee) external onlyAdmin {
        require(newFee >= MIN_FEE && newFee <= MAX_FEE, "Escrow: invalid fee");
        defaultFeePercent = newFee;
        emit DefaultFeeUpdated(newFee);
    }

    function emergencyWithdraw(address token) external onlyAdmin nonReentrant {
        require(paused, "Escrow: not paused");
        uint256 balance;
        if (token == address(0)) {
            balance = address(this).balance;
            (bool success, ) = payable(admin).call{ value: balance }("");
            require(success, "Escrow: withdraw failed");
        } else {
            IERC20 erc20 = IERC20(token);
            balance = erc20.balanceOf(address(this));
            erc20.safeTransfer(admin, balance);
        }
        emit EmergencyWithdraw(token, balance);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Escrow: zero address");
        admin = newAdmin;
    }

    receive() external payable {
        revert("Escrow: no direct ETH");
    }
}
