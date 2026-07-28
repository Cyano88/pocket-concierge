# Pocket NFT Mint & Deliver: 90-second judge demo

## 0-15 seconds: state the job

“An agent receives one bounded mandate: mint one supported public SeaDrop NFT, deliver that exact
token to the buyer's wallet, and return unused ETH. The buyer pays a separate 1-USDT service fee on
X Layer.”

Open:

```text
https://pocket-concierge-docs-production.up.railway.app/#nft-proof
```

## 15-45 seconds: inspect the live public proof

Open:

```text
https://pocket-concierge-production.up.railway.app/v1/public/nft-pilot
```

Point out:

- `status: verified_complete`;
- the immutable spending limits and manifest hash;
- Nakamapes token ID `2847`;
- the separate X Layer service payment;
- the Ethereum funding, mint, delivery, and refund transactions;
- the exact refund amount and balanced execution accounting;
- the recomputable `proofHash`;
- the privacy inclusion and exclusion lists.

This proof is from the managed-policy pilot. The isolated worker could sign only the exact
Ethereum-mainnet transaction plan approved by Pocket's deterministic policy checks.

## 45-65 seconds: verify delivery independently

Follow `explorers.nftOwner` from the proof. The NFT owner is the declared recipient:

```text
0xa2Ae0A3B3eD7B30AB049685a934de587a0F51d66
```

The explorer verifies delivery independently; judges do not need to trust a Pocket database claim.

## 65-80 seconds: explain the safety boundary

“The service fee and execution capital are separate. Before payment, the order fixes Ethereum
mainnet, collection, contract, quantity one, recipient, refund address, mint-price ceiling,
total-cost ceiling, external ID, and expiry. A treasury-scoped nonce lease prevents two workers
from executing the same funds, and every receipt is reverified on-chain.”

## 80-90 seconds: show adoption

Open:

```text
https://github.com/Cyano88/pocket-concierge/blob/master/examples/nft-mint-buyer.mjs
```

“Another agent submits one JSON order, confirms the exact 1-USDT x402 service fee, funds the
returned one-order Ethereum address, and follows the machine-readable state through mint,
delivery, and automatic return of unused capital.”
