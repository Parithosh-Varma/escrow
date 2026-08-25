# Changelog

All notable changes to the Decentralized Escrow System are documented here.

## [1.1.0] - 2026-08-25

### Added
- View helpers `getEscrowDetails`, `isExpired`, `getFeePreview` for off-chain queries
- EscrowSDK validation (`isValidAddress`, `formatStatus`) and new wrappers for view helpers
- EscrowSDK event listeners `onEscrowRefunded` and `onFundsDeposited`
- MockUSDC `faucet()` helpers for local testing
- Hardhat networks for sepolia/polygon/arbitrum/optimism + gas reporter & coverage config
- Proper npm scripts (`test`, `test:gas`, `coverage`, `compile`, `deploy:*`)

### Changed
- Enhanced `hardhat.config.js` to load networks from env vars
- Improved `package.json` metadata (description, keywords, author, MIT license)
- Added NatSpec documentation to `DecentralizedEscrow` contract and structs

### Fixed
- `removeArbiter` now correctly cleans up `arbiterList` (swap-and-pop)
- `emergencyWithdraw` event now emits actual withdrawn amount (previous: always 0)
- Removed unused `disputeRateLimit` variable

## [1.0.1] - 2026-08-23

### Fixed
- `emergencyWithdraw` event amount bug
- `removeArbiter` stale entry in `arbiterList`

## [1.0.0] - 2026-06-23

### Added
- Initial decentralized escrow contract with ETH & ERC-20 support
- Arbiter registry with reputation tracking
- Batch create/deposit, dispute cooldown, timeout refund, emergency pause
- 39 Hardhat tests, deployment script, frontend SDK and demo DApp
- Flow chart and comprehensive README
