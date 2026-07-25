# Pocket Concierge

Pocket Concierge is a buyer/User Agent orchestrator for household missions.

The pre-hackathon baseline supports one action: a user-approved Nigerian bill purchase through Pocket Bills and the OKX Agent Payments Protocol. It plans the action, creates deterministic mission/cycle identifiers, waits for explicit approval, returns a buyer-side execution instruction, and verifies the token-scoped Pocket Bills status response.

The hosted Concierge service never:

- signs an OKX payment;
- holds an Agentic Wallet;
- receives a phone, meter, or smartcard number;
- receives Prava OAuth tokens or card credentials;
- silently retries an uncertain purchase.

The Prava merchant-shopping action is deliberately not implemented in this baseline. It will be built as clearly new work during the Agentic Commerce Hackathon.

## State flow

```text
planned -> approved -> executing -> delivered
                              \-> needs_review
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

Mission actions use an opaque `privateInputRef`, such as `home-mobile`. The local buyer agent resolves that reference to a phone, meter, or smartcard number only when calling Pocket Bills. Concierge sees only the opaque reference.

After payment, the buyer sends the returned Pocket Bills `status.url` and `status.token` to the verification endpoint. Concierge performs one allowlisted status check, saves only sanitized settlement evidence, and does not persist or return the status token.

## Five-minute agent integration

1. Create or preview a mission with `POST /v1/missions`.
2. Display the immutable `manifestId`, action, due time, and `maximumUsdt` to the user.
3. Approve that exact manifest with `POST /v1/missions/{externalId}/actions/{actionId}/approve`.
4. Call `start`. The response tells the local buyer agent which Pocket Bills endpoint and public fields to use.
5. Resolve `privateInputRef` locally, obtain a fresh OKX payment quote, enforce `maximumUsdt`, and ask the user to confirm the exact charge.
6. Complete the x402 request locally. Send only the returned `status.url` and `status.token` to `verify`.
7. Treat only a Concierge `delivered` state with a `receiptHash` as success. Escalate `needs_review`; never blindly repay.

Every protected request uses:

```http
Authorization: Bearer <agent-key>
Content-Type: application/json
```

Use [openapi.yaml](./openapi.yaml) as the machine-readable contract and [examples/mission.json](./examples/mission.json) as a copy-paste request. The baseline boundary is recorded in [docs/PRE_HACKATHON_BASELINE.md](./docs/PRE_HACKATHON_BASELINE.md).

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
