// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "./MockERC20.sol";

/// @notice Deploys the test-USDC stand-in for E2E lifecycle runs. Not part of production
///         deployment; on mainnet STABLECOIN_ADDRESS points at real Circle USDC.
contract MockStablecoinScript is Script {
    function run() external {
        vm.startBroadcast();
        MockERC20 token = new MockERC20("Test USDC", "tUSDC", 6);
        vm.stopBroadcast();
        console2.log("MOCK_USDC:", address(token));
    }
}
