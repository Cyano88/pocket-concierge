# Pocket Concierge

Pocket Concierge is a deterministic authority and buyer-agent orchestrator for household missions.

The simple integration surface is:

- `POST /v1/okx/authority-check` — reusable 0.01-USDT purchase decision for any privacy-safe agent action.
- `POST /v1/errands` — create one idempotent household errand cycle.
- `POST /v1/errands/{errandId}/authorize` — approve the exact manifest and receive the buyer-side payment instruction.
- `POST /v1/errands/{errandId}/complete` — verify provider delivery and receive the authority receipt.

Start with [`docs/QUICKSTART.md`](docs/QUICKSTART.md) and copy [`examples/errand.json`](examples/errand.json). The existing `/v1/missions/*` routes remain the lower-level compatibility API.

Its first adapter supports a user-approved Nigerian bill purchase through Pocket Bills and the OKX Agent Payments Protocol. Before execution, a versioned mandate checks time, category, service, opaque recipient, action count, per-action spend, total mission spend, and approval threshold. The deterministic result is `APPROVE`, `ESCALATE`, or `BLOCK`; no LLM decides whether payment is allowed.

For OKX marketplace testing, `GET /v1/okx/authority-proof` always begins with a 0.01-USDT x402 challenge. The required signed replay returns the privacy-safe proof of a real delivered mission: payment transaction, downstream settlement, deterministic decision trace, recomputable authority receipt, and the five-minute integration contract. This public proof route never accepts or returns household account data.

The hosted Concierge service never:

- signs an OKX payment;
- holds an Agentic Wallet;
- receives a phone, meter, or smartcard number;
- receives Prava OAuth tokens or card credentials;
- silently retries an uncertain purchase.
- lets an exception override a hard category, recipient, expiry, or spending limit.

The Prava merchant-shopping action is deliberately not implemented in this baseline. It will be built as clearly new work during the Agentic Commerce Hackathon.

## State flow

```text
mandate -> APPROVE -----------------> approved -> executing -> delivered
        \-> ESCALATE -> exact exception /                 \-> needs_review
         \-> BLOCK
```

## Local setup

Requires Node.js 22.13 or newer. Node.js 24.15+ is recommended for the newer release-candidate status of the built-in SQLite module.

```powershell
npm install
$env:POCKET_CONCIERGE_AGENT_KEYS='demo-agent:replace-with-a-long-random-secret'
npm test
npm run typecheck
npm run start
```

## Privacy boundary

Mission actions and mandates use an opaque `privateInputRef`, such as `home-mobile`. The local buyer agent resolves that reference to a phone, meter, or smartcard number only when calling Pocket Bills. Concierge sees only the opaque reference.

After payment, the buyer sends the returned Pocket Bills `status.url` and `status.token` to the verification endpoint. Concierge performs one allowlisted status check, saves only sanitized settlement evidence, and does not persist or return the status token.

Terminal verification creates a canonical SHA-256 authority receipt. `GET /v1/authority/receipts/{receiptId}` is public and recomputes the receipt hash on every read. It contains a hash of the opaque private reference—not the reference, customer details, agent key, or status token.

## Five-minute agent integration

1. Create or preview a mission with `POST /v1/missions`, including the smallest acceptable mandate.
2. Inspect the immutable `manifestId` and each action's `authorityDecision`.
3. If it is `APPROVE`, approve that exact manifest. If it is `ESCALATE`, include an exception bound to the returned `decisionId`, exact `maximumUsdt`, fresh nonce, and short expiry. Stop on `BLOCK`.
4. Call `start`. The response tells the local buyer agent which Pocket Bills endpoint and public fields to use.
5. Resolve `privateInputRef` locally, obtain a fresh OKX payment quote, enforce `maximumUsdt`, and ask the user to confirm the exact charge.
6. Complete the x402 request locally. Send only the returned `status.url` and `status.token` to `verify`.
7. Treat only a Concierge `delivered` state with both downstream evidence and an `authorityReceiptId` as success. Escalate `needs_review`; never blindly repay.

Every protected request uses:

```http
Authorization: Bearer <agent-key>
Content-Type: application/json
```

Use [openapi.yaml](./openapi.yaml) as the machine-readable contract and [examples/mission.json](./examples/mission.json) as a copy-paste request. The baseline boundary is recorded in [docs/PRE_HACKATHON_BASELINE.md](./docs/PRE_HACKATHON_BASELINE.md).

An escalation approval body is deliberately small:

```json
{
  "manifestId": "immutable-manifest-hash",
  "exception": {
    "decisionId": "pd_...",
    "nonce": "human-approval-0001",
    "approvedMaximumUsdt": "0.25",
    "expiresAt": "2026-07-25T04:10:00.000Z"
  }
}
```

The exception is consumed atomically when `start` first changes the action to `executing`. Replaying `start` returns the same deterministic downstream order; it does not create another authorization.

The local buyer client keeps the household reference out of Concierge and implements three deliberately separate phases:

```powershell
$env:CONCIERGE_BASE_URL='http://127.0.0.1:4310'
$env:POCKET_CONCIERGE_AGENT_KEY='replace-with-your-agent-key'
$env:POCKET_CONCIERGE_LOCAL_BINDING_KEY='replace-with-a-separate-long-local-secret'

# 1. Preview the immutable mission. No quote or payment.
node examples/prepare-okx-bill.mjs examples/mission.json examples/private-inputs.example.json

# 2. After approving the mission, obtain and validate a fresh quote. No signing or payment.
node examples/prepare-okx-bill.mjs examples/mission.json .\private-inputs.json `
  --approve --quote --state .\.data\family-week.quote.json

# 3. Only after reviewing the displayed network, token, amount, recipient, and ceiling:
node examples/prepare-okx-bill.mjs examples/mission.json .\private-inputs.json `
  --approve --confirm-payment --state .\.data\family-week.quote.json
```

The quote state is authenticated against the exact mission and private merchant request. It expires after four minutes. Immediately before invoking the fund-moving command, the client irreversibly marks it `payment_in_progress`, preventing a blind second payment after a crash or ambiguous CLI result.

The same merchant parameters are included in both the quote command and the confirmed payment replay. Do not copy only the `paymentId`: Pocket Bills also requires the stable `externalOrderId`, service identifiers, and locally resolved customer reference to deliver the purchase.

After success, the Pocket Bills status proof is encrypted locally with AES-256-GCM until Concierge verifies delivery. If verification is temporarily unavailable, retry only the proof:

```powershell
node examples/prepare-okx-bill.mjs examples/mission.json .\private-inputs.json `
  --approve --resume-verification --state .\.data\family-week.quote.json
```

Never re-run `--confirm-payment` for a state marked `payment_in_progress`, `paid_response_received`, or `paid_pending_verification`.

## Persistence

Set `POCKET_CONCIERGE_DB_PATH=.data/concierge.sqlite` to enable durable SQLite storage with WAL and optimistic revision checks. Without it, the service intentionally uses an in-memory store for local tests.

For the first public demo, run one service instance with one persistent volume. A horizontally scaled deployment should replace SQLite with a shared transactional database while preserving the `MissionStore` compare-and-update contract.

## NFT Mint & Deliver pilot

The NFT adapter is intentionally disabled by default. Its narrow supported contract is:

- Ethereum mainnet only.
- SeaDrop 1.0 public FCFS mints only.
- Exactly one NFT per order.
- A 1-USDT X Layer service fee through the paid order endpoint.
- A separate native-ETH execution deposit sent before the mint window.
- Pocket temporarily mints to its treasury and transfers the exact token to the declared recipient.

Create the paid order with `POST /v1/okx/nft-mints/orders` using
[examples/nft-mint-order.json](./examples/nft-mint-order.json). The signed replay returns an
`orderAccessToken`, the Ethereum treasury address, and the required maximum deposit. The caller then
sends ETH from the immutable `fundingAddress` and submits the full Ethereum transaction hash:

During the controlled pilot, set `POCKET_CONCIERGE_NFT_PILOT_KEY` to a separate secret of at least
32 characters. Callers must send it as `X-Pocket-Pilot-Key` before Pocket returns an x402 challenge.
Remove the environment variable only after the mint, delivery, and refund demonstrations pass and the
service is ready for public orders.

```http
POST /v1/nft-mints/orders/{externalId}/funding
X-Order-Token: nmt_...
Content-Type: application/json

{"depositTransactionHash":"0x..."}
```

Pocket independently verifies chain ID 1 through its configured mainnet RPC, successful receipt,
sender, treasury destination, value, confirmations, expiry, and global transaction-hash uniqueness.
Only then does the order become `armed`.

The execution worker endpoints require a separate operator key. `prepare` reads the public stage,
wallet mint count, supply, creator payout, and fee-recipient restrictions directly from SeaDrop 1.0.
For unrestricted stages, any configured fee is routed to the collection's creator payout address. For
restricted stages, Pocket uses only a fee recipient enumerated by the collection. It then encodes
`mintPublic`, validates the call, binds the collection and quantity, enforces the mint and total ETH
caps, and returns a 30-second plan. `minted` verifies that the onchain transaction exactly matches that
plan and extracts the token ID from the collection's `Transfer` event. `delivered` verifies the exact
treasury-to-recipient token transfer.

The checked-in service does not contain or accept a raw treasury private key. Enabling this feature
requires a hardened signer worker. Until that signer, automated refunds, a fork test, and one controlled
low-value live mint pass, the endpoint must not be listed or advertised as live.

## Railway deployment

The checked-in [railway.json](./railway.json) uses Railpack, runs one replica, requires a `/data` volume, builds with `npm ci && npm run build`, starts the compiled server, and checks `/health`.

Required service variables:

```text
POCKET_CONCIERGE_AGENT_KEYS=<owner-id>:<long-random-agent-secret>
POCKET_CONCIERGE_DB_PATH=/data/concierge.sqlite
RAILPACK_NODE_VERSION=24.18.0
OKX_API_KEY=<OKX developer credential>
OKX_SECRET_KEY=<OKX developer credential>
OKX_PASSPHRASE=<OKX developer credential>
POCKET_CONCIERGE_PUBLIC_URL=https://pocket-concierge-production.up.railway.app
POCKET_CONCIERGE_OKX_PAY_TO=<X Layer wallet address>
POCKET_CONCIERGE_DEMO_RECEIPT_ID=<verified public receipt id>
POCKET_CONCIERGE_DEMO_TX_HASH=<verified X Layer payment transaction>
POCKET_CONCIERGE_NFT_MINT_ENABLED=false
ETHEREUM_RPC_URL=<private Ethereum mainnet RPC>
POCKET_CONCIERGE_NFT_TREASURY_ADDRESS=<Ethereum execution treasury>
POCKET_CONCIERGE_NFT_ORDER_TOKEN_SECRET=<at-least-32-random-characters>
POCKET_CONCIERGE_NFT_OPERATOR_KEY=<separate-at-least-32-random-characters>
POCKET_CONCIERGE_NFT_PILOT_KEY=<separate-at-least-32-random-characters>
POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI=<operator-approved Ethereum fee ceiling>
POCKET_CONCIERGE_NFT_MAX_ORDER_WEI=100000000000000000
```

The agent secret must be generated in Railway or another secret manager. Never commit it or the local binding key.

### Assisted OKX execution worker

The pilot worker is deliberately interactive. It never reads a private key and never broadcasts by
default. It fetches a short-lived operator plan, checks Ethereum chain ID 1, the configured treasury,
the action-specific target, calldata hash, native value, gas limit, operator fee ceiling, order caps,
and expiry, then runs the OKX transaction security scan.

Dry-run a prepared action:

```powershell
$env:POCKET_CONCIERGE_URL='https://pocket-concierge-production.up.railway.app'
$env:POCKET_CONCIERGE_NFT_OPERATOR_KEY='<operator key>'
$env:POCKET_CONCIERGE_NFT_TREASURY_ADDRESS='<Ethereum execution treasury>'
$env:POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI='<wei ceiling>'
npm run nft:worker -- mint <externalId>
```

After reviewing the JSON summary, add `--execute`. The worker requires the exact plan ID twice: once
before asking OKX Agentic Wallet to prepare the call, and again after OKX returns its own confirmation
message. Only that second confirmation permits the required `--force` replay.

Use `deliver` for the verified ERC-721 transfer and `refund` for the exact unused-ETH refund:

```powershell
npm run nft:worker -- deliver <externalId> --execute
npm run nft:worker -- refund <externalId> --execute
```

OKX Agentic Wallet's contract-call interface does not accept a caller-selected transaction nonce or
maximum fee per gas. This worker therefore remains an assisted pilot, not an unattended FCFS sniper.
The server still verifies every resulting Ethereum transaction before advancing the order.

Run the read-only mainnet preflight before any funded test:

```powershell
$env:ETHEREUM_RPC_URL='<private Ethereum mainnet HTTPS RPC>'
$env:POCKET_CONCIERGE_NFT_TREASURY_ADDRESS='<Ethereum execution treasury>'
npm run nft:preflight
```

It verifies chain ID 1, live SeaDrop 1.0 bytecode, the treasury balance, and current fee estimates. It
does not sign or broadcast and never prints the private RPC URL.

To test the complete direct builder against a known active public stage without broadcasting:

```powershell
$env:NFT_PREFLIGHT_CONTRACT='<active SeaDrop ERC-721 contract>'
npm run nft:direct-smoke
```

The smoke test reads the current stage, limits, supply, fee routing and block time, encodes the exact
one-token call, validates it, and estimates gas from the configured treasury. Its output omits the
collection, treasury, fee-recipient and RPC addresses.
