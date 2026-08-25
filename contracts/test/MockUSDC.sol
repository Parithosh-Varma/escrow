// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Mock ERC-20 with 6 decimals for testing the escrow (mints 1M to deployer)
 */
contract MockUSDC is ERC20 {
    uint8 private _decimals;

    constructor() ERC20("Mock USDC", "mUSDC") {
        _decimals = 6;
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint tokens to any address (test helper)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Faucet: mint 10,000 mUSDC to caller (convenient for local testing)
    function faucet() external {
        _mint(msg.sender, 10_000 * 10 ** 6);
    }

    /// @notice Faucet with custom amount
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}
