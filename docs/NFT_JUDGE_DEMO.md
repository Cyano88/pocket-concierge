# Pocket NFT Mint & Deliver: 90-second judge demo

## 0–15 seconds: state the job

“An agent receives one bounded mandate: mint one supported public SeaDrop NFT, deliver that exact
token to the buyer’s wallet, and return unused ETH. The buyer pays a separate 1-USDT service fee on
X Layer.”

Open:

```text
https://pocket-concierge-docs-production.up.railway.app/#nft-proof
```

## 15–45 seconds: inspect the public proof

Open:

```text
https://pocket-concierge-production.up.railway.app/v1/public/nft-pilot
```

Point out:

- `status: verified_complete`;
- the immutable spending limits and manifest hash;
- Nakamapes token ID `2845`;
- the X Layer service-payment transaction;
- separate Ethereum funding, mint, delivery, and refund transactions;
- the exact refund amount;
- the recomputable `proofHash`;
- the privacy inclusion and exclusion lists.

## 45–65 seconds: verify delivery independently

Follow `explorers.nftOwner` from the proof. The NFT owner is the declared recipient:

```text
0xa2ae0a3b3ed7b30ab049685a934de587a0f51d66
```

No Pocket database claim is required to trust the delivery result.

## 65–80 seconds: explain the safety boundary

“The service fee and execution capital are separate. The order fixes chain ID 1, collection,
contract, quantity one, recipient, refund address, mint-price ceiling, total-cost ceiling, nonce-like
external ID, and expiry before payment. The worker cannot change those fields, and the server
re-verifies every Ethereum receipt.”

## 80–90 seconds: show adoption

Open:

```text
https://github.com/Cyano88/pocket-concierge/blob/master/examples/nft-mint-buyer.mjs
```

“Another agent supplies one JSON order, confirms the exact 1-USDT x402 fee, receives the ETH funding
instruction, and follows the returned state until delivery and refund. Public order creation remains
pilot-gated while failure recovery is hardened; the completed proof is public now.”
