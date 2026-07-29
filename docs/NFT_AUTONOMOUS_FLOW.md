# Autonomous NFT mint and wallpaper flow

Pocket Concierge executes a narrow, auditable Ethereum workflow:

1. An agent previews one official SeaDrop 1.0 public mint for free.
2. It creates an idempotent order and pays the 1-USDT X Layer service fee.
3. The customer sends the disclosed maximum execution capital in native ETH.
4. Pocket verifies the deposit and arms the order.
5. For a scheduled order, Pocket prepares shortly before the onchain public-stage start.
6. The isolated Privy signer waits until the exact bound stage start, then signs one EIP-1559 transaction under the customer's price, total-cost, base-fee, and priority-fee ceilings.
7. Pocket verifies the mint receipt and token ID, transfers that exact NFT to the declared recipient, and refunds unused ETH.
8. After verified delivery, the customer may create a private desktop and mobile wallpaper pack.

This is launch-scheduled public-FCFS execution. It is not a guaranteed snipe. Congestion, sellout, stage changes, contract behavior, RPC failure, or a rejected transaction can still prevent a mint.

## Supported mint scope

- Ethereum mainnet only
- Official SeaDrop 1.0 `mintPublic`
- Public stage only
- Quantity exactly one
- Customer-funded execution
- Exact declared NFT recipient and refund address
- One treasury transaction at a time
- No allowlist proof, presale signature, arbitrary calldata, or general withdrawal API
- No replacement transaction in v1; same-nonce replacement remains disabled until independently proven

## Scheduled preview

```http
POST /v1/nft-mints/preview
Content-Type: application/json
```

```json
{
  "externalId": "jobber-launch-20260729-001",
  "collectionSlug": "official-collection-slug",
  "nftContract": "0x...",
  "nftRecipient": "0x...",
  "refundAddress": "0x...",
  "fundingAddress": "0x...",
  "quantity": 1,
  "maxMintPriceWei": "10000000000000000",
  "maxTotalCostWei": "15000000000000000",
  "expiresAt": "2026-07-30T12:00:00.000Z",
  "executionMode": "scheduled",
  "executionWindowSeconds": 300,
  "maxFeePerGasWei": "60000000000",
  "maxPriorityFeePerGasWei": "3000000000",
  "maxReplacementAttempts": 0
}
```

Use the identical body for `POST /v1/okx/nft-mints/orders`. The unpaid request returns an X Layer EIP-3009 HTTP 402 challenge. The signed replay returns the immutable order, access token, exact Ethereum deposit requirement, treasury address, and status route.

Fund before the public stage. Pocket will not sign before `stageStartTime`, and it blocks execution if the stable SeaDrop configuration changes.

## Private wallpaper pack

After the NFT reaches `delivered`, `refunding`, or `refunded`:

```http
POST /v1/nft-mints/orders/{externalId}/wallpaper
X-Order-Token: nmt_...
```

The response contains expiring downloads for:

- desktop PNG: 1920 x 1080
- mobile PNG: 1080 x 1920
- SHA-256 for each output
- source token URI and source-image hash

The pack is private-use by default. NFT ownership alone is not treated as a commercial content licence.

## Public wallpaper commerce

Free discovery:

```http
GET /v1/wallpapers
GET /v1/wallpapers/{assetId}
```

Paid full-resolution bundle:

```http
POST /v1/okx/wallpapers/purchase
Content-Type: application/json

{"assetId":"nwa_..."}
```

Only an operator-reviewed asset with CC0, public-domain, explicit commercial-license, or creator-opt-in evidence can appear in the catalog. The 0.01-USDT paid replay returns desktop/mobile downloads, file hashes, provenance, and the reviewed rights reference.

## Failure semantics

- Unrevealed metadata returns `WALLPAPER_METADATA_PENDING`; NFT delivery remains successful.
- Stage drift blocks signing.
- A closed execution window expires the order.
- A broadcast with an unknown outcome reserves its nonce and requires transaction recovery.
- A failed mint is verified onchain before refund calculation.
- Unused ETH is refunded only after the workflow accounts for verified mint, delivery, and refund gas.
