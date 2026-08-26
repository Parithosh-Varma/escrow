// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain, standards-compliant mock stablecoin for happy-path tests.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Deducts a fee on every transfer. Used to prove the allowlist (not transfer-amount
///         trust) is what protects EscrowCore — this token should never pass allowlisting in
///         a real deployment, but the test suite uses it to confirm the contract doesn't
///         silently mis-account funds if one ever slipped through.
contract FeeOnTransferMockERC20 is ERC20 {
    uint256 public feeBps = 100; // 1%

    constructor() ERC20("Fee Mock", "FEEMOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * feeBps) / 10_000;
        _transfer(msg.sender, to, amount - fee);
        _burn(msg.sender, fee);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        uint256 fee = (amount * feeBps) / 10_000;
        _transfer(from, to, amount - fee);
        _burn(from, fee);
        return true;
    }
}

/// @notice Returns false instead of reverting on failed transfers, and accepts a flag to make
///         transfers silently no-op. Used to prove SafeERC20 (not raw IERC20 calls) is doing
///         the enforcement.
contract RevertingReturnMockERC20 is ERC20 {
    bool public transfersDisabled;

    constructor() ERC20("Bad Return Mock", "BADMOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTransfersDisabled(bool disabled) external {
        transfersDisabled = disabled;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (transfersDisabled) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (transfersDisabled) return false;
        return super.transferFrom(from, to, amount);
    }
}
