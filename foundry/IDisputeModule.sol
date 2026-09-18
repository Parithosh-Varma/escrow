// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface for the DisputeModule, exposed for off-chain tooling / future
///         contracts that need to check dispute state without importing the full implementation.
interface IDisputeModule {
    function activeDisputeForMilestone(uint256 milestoneId) external view returns (uint256);
}
