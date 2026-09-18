// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface DisputeModule uses to call into EscrowCore.
/// @dev Kept minimal on purpose — DisputeModule should only ever need these two entry points.
interface IEscrowCore {
    /// @notice Marks a milestone as under dispute. Reverts if the milestone isn't in a
    ///         disputable state for the given dispute type.
    function markDisputed(uint256 milestoneId, uint8 disputeType) external;

    /// @notice Executes the payout split decided by a resolved dispute.
    /// @param splitBps Freelancer's share in basis points (0-10000). Remainder (after fee)
    ///        refunds to the client.
    function resolvePayout(uint256 milestoneId, uint16 splitBps) external;
}
