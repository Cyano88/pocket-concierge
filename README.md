# Pocket Concierge

Pocket Concierge is a deterministic authority and buyer-agent orchestrator for household missions.

Its first adapter supports a user-approved Nigerian bill purchase through Pocket Bills and the OKX Agent Payments Protocol. Before execution, a versioned mandate checks time, category, service, opaque recipient, action count, per-action spend, total mission spend, and approval threshold. The deterministic result is `APPROVE`, `ESCALATE`, or `BLOCK`; no LLM decides whether payment is allowed.

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

After success, the Pocket Bills status proof is encrypted locally with AES-256-GCM until Concierge verifies delivery. If verification is temporarily unavailable, retry only the proof:

```powershell
node examples/prepare-okx-bill.mjs examples/mission.json .\private-inputs.json `
  --approve --resume-verification --state .\.data\family-week.quote.json
```

Never re-run `--confirm-payment` for a state marked `payment_in_progress`, `paid_response_received`, or `paid_pending_verification`.

## Persistence

Set `POCKET_CONCIERGE_DB_PATH=.data/concierge.sqlite` to enable durable SQLite storage with WAL and optimistic revision checks. Without it, the service intentionally uses an in-memory store for local tests.

For the first public demo, run one service instance with one persistent volume. A horizontally scaled deployment should replace SQLite with a shared transactional database while preserving the `MissionStore` compare-and-update contract.

## Railway deployment

The checked-in [railway.json](./railway.json) uses Railpack, runs one replica, requires a `/data` volume, builds with `npm ci && npm run build`, starts the compiled server, and checks `/health`.

Required service variables:

```text
POCKET_CONCIERGE_AGENT_KEYS=<owner-id>:<long-random-agent-secret>
POCKET_CONCIERGE_DB_PATH=/data/concierge.sqlite
RAILPACK_NODE_VERSION=24.18.0
```

The agent secret must be generated in Railway or another secret manager. Never commit it or the local binding key.
