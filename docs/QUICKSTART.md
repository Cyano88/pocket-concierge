# Pocket Concierge: five-minute integration

Pocket Concierge has two jobs:

1. Before an agent spends, return `APPROVE`, `ESCALATE`, or `BLOCK`.
2. For supported household errands, coordinate buyer-authorized payment and return verified delivery proof.

The hosted service never receives a wallet key or a raw phone, meter, smartcard, or email. Keep those values in the buyer agent's local vault and send only an opaque `privateInputRef`.

## 1. Check whether a purchase is allowed

Call:

```text
POST https://pocket-concierge-production.up.railway.app/v1/okx/authority-check
```

The first response is a 0.01-USDT exact x402 challenge on X Layer. Pay and replay the same request body from [`examples/authority-check.json`](../examples/authority-check.json).

The result has one decision and one next action:

```json
{
  "decision": "APPROVE",
  "nextAction": {
    "type": "execute_within_mandate",
    "maximumUsdt": "0.20"
  }
}
```

An empty paid replay returns a safe working example so marketplace reviewers always receive a deliverable.

## 2. Create a household errand cycle

Request an agent API key, then send [`examples/errand.json`](../examples/errand.json):

```http
POST /v1/errands
Authorization: Bearer <agent-key>
Content-Type: application/json
```

`externalId + cycleId` is the idempotency key. Replaying the exact same cycle returns the original errand; changing its immutable fields returns `409`.

For a fresh, copy-paste run that creates and authorizes one MTN data cycle:

```powershell
$env:POCKET_CONCIERGE_AGENT_KEY = "<agent-key>"
node examples/errand-quickstart.mjs
```

The script stops at the buyer-side payment instruction. That boundary is intentional: resolve `privateInputRef` locally, request a live quote, show the exact charge, and let the buyer agent sign only after confirmation.

The response always contains one `nextAction`. For an approved MTN data pilot it points to:

```text
POST /v1/errands/{errandId}/authorize
```

Send the returned `manifestId`. Concierge then returns the exact Pocket Bills request template and maximum allowed USDT. Merge the private customer fields locally, obtain a fresh OKX payment quote, show it to the user, and pay only after confirmation.

## 3. Complete and verify

After Pocket Bills returns `statusUrl` and `statusToken`, send them once:

```http
POST /v1/errands/{errandId}/complete
Authorization: Bearer <agent-key>
Content-Type: application/json

{
  "statusUrl": "https://bills.hashpaylink.com/v1/okx/settlements/pst_...",
  "statusToken": "<private-token>"
}
```

Concierge verifies the settlement against the immutable errand, discards the token, and returns `delivered` with a recomputable authority receipt. An uncertain provider result becomes `needs_review`; never create a second payment.

## Current verified scope

- Live pilot: MTN data through Pocket Bills.
- Adapter contract present: data, electricity, and TV.
- Not yet exposed on the OKX bill rail: airtime.
- Planned but not implemented: paid PolyDesk briefs and merchant shopping.
