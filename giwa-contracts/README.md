# GIWA Pocket Mandates

`GiwaMandateExecutor` is the GIWA-native permission layer for Pocket Concierge. It lets a user authorize one agent to make bounded ERC-20 payments to one declared recipient without transferring custody to Pocket.

Each mandate fixes the token, recipient, per-payment maximum, total cap, activation time, expiry, interval, and purpose hash. The owner can pause or irrevocably revoke it. One-time exceptions are bound to an exact payment reference and cannot override the token, recipient, expiry, revocation state, or remaining total cap.

The contract returns three deterministic preview decisions:

- `APPROVE`: the action fits the mandate or a valid one-time exception.
- `ESCALATE`: the amount or interval needs an owner-approved exception.
- `BLOCK`: a hard boundary prevents execution.

## GIWA Sepolia

- Chain ID: `91342`
- RPC: `https://sepolia-rpc.giwa.io`
- Explorer: `https://sepolia-explorer.giwa.io`

## Local verification

```powershell
npm install
npm test
npm run compile
```

## Deployment

Keep the deployer key outside source control. Copy `.env.example` to `.env`, fund the deployer with GIWA Sepolia test ETH, then run:

```powershell
npm run deploy:giwa
npx hardhat verify --network giwaSepolia <deployed-address>
```

Never commit `.env`, a private key, or deployment credentials.
