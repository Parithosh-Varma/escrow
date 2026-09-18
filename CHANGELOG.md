# Changelog

All notable changes to the Decentralized Escrow System are documented here.

## [Unreleased]

### Added
- Landing page at `/` (hero with sealed-escrow visual, chains strip, how-it-works, features, security, closing CTA); console moved to `/app.html` with a back-to-site link. `?contract=` is carried through landing links into the console.
- Split hosting: landing deploys from `site/` to escrow-dlp.pages.dev, console deploys from `app/` to escrow-app.pages.dev (absolute cross-links both ways). SDK ABI import and README paths updated to match.
- Console wallet connection: EIP-6963 multi-wallet discovery with delayed-injection retry (MetaMask, Coinbase, Rabby, Trust…); page no longer errors on load when no wallet is present — an inline hint with install links appears instead; clearer messages for rejected/pending requests and mobile wallet browsers.

### Changed
- Redesigned the DApp UI (`frontend/index.html`) as "Escrow Ledger": pine-ink + brass + bone palette, Fraunces display with Inter body and Plex Mono for on-chain data, three-arc seal mark
- Lookup card now renders the escrow lifecycle as a stamped pipeline (Pending → Funded → Completed, with Disputed/Refunded branches) instead of raw JSON
- Expiration input is now a date-time picker instead of a raw unix timestamp; fee field correctly labeled in bps
- All inputs have real labels; toasts use `role="status"`; `prefers-reduced-motion` respected

## [1.2.0] - 2026-09-18

### Added
- Moved Foundry contracts to separate `foundry/` directory to avoid Hardhat compilation conflicts
- Improved Hardhat configuration for better Node 24 compatibility

### Changed
- Updated dependency versions for security patches
- Improved project structure for better separation of concerns

### Fixed
- Resolved Hardhat compilation issues with Foundry contracts
- Fixed peer dependency conflicts in package.json

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
