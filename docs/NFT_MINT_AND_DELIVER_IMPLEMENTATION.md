# Pocket NFT Mint & Deliver

Status: core order, funding, execution-plan, delivery-proof, and unused-ETH refund state machine implemented behind a disabled production flag.

## Customer promise

The customer pays Pocket's 1-USDT service fee on X Layer, pre-funds a strict spending cap in native
Ethereum ETH, and declares the wallet that must receive the NFT. Pocket mints one supported public
SeaDrop NFT to its execution treasury, transfers that exact token to the declared recipient, and
returns verifiable transaction evidence.

This is not a guaranteed allocation. Pocket guarantees only that execution stays inside the immutable
mandate and that every claimed result is recomputed from Ethereum receipts.

## Payment separation

Two payments have different purposes and must never be presented as one:

1. The 1-USDT X Layer payment is the non-refundable API service fee after a valid paid replay.
2. Native Ethereum ETH is customer execution capital. It is held against one order and its unused
   remainder must be returned to the immutable refund address.

The service validates the order body before issuing the payment challenge. Invalid addresses, unsafe
quantities, expired mandates, malformed limits, and conflicting external IDs therefore fail before the
service fee is accepted.

## Immutable order

An order binds:

- caller external ID;
- collection slug used as a human-readable order label;
- expected ERC-721 contract;
- one NFT;
- NFT recipient;
- ETH refund address;
- ETH funding sender;
- maximum mint price;
- maximum total execution cost;
- expiry;
- Ethereum chain ID 1;
- Pocket execution treasury.

The complete immutable input is hashed. Reusing the same external ID with different fields returns a
conflict.

## Funding verification

The caller sends the full `maxTotalCostWei` in native ETH before the order can execute and submits the
deposit transaction hash. Pocket verifies through its Ethereum mainnet RPC:

- successful receipt;
- exact declared sender;
- exact configured treasury destination;
- sufficient value;
- minimum confirmation count;
- order expiry;
- global transaction-hash uniqueness.

A deposit transaction can arm exactly one order. Screenshots, block IDs, transaction descriptions, and
amount-only matching are never accepted.

## Mint preparation

At execution time Pocket reads the public drop configuration directly from SeaDrop 1.0 and checks:

- current block time is inside the public stage;
- the treasury remains inside its per-wallet mint limit;
- the collection has remaining supply;
- restricted stages expose an allowed fee recipient;
- unrestricted stages have a creator payout address;
- target equals the supported official SeaDrop 1.0 deployment;
- calldata decodes as `mintPublic`;
- decoded NFT contract equals the immutable order;
- decoded quantity equals one;
- initial minter is Pocket's treasury;
- native mint value is within `maxMintPriceWei`;
- mint gas plus reserved delivery and refund gas remain within the funded total cap.

The resulting execution plan expires after 30 seconds and stores the calldata hash, target, value, gas
limit, maximum fee, and plan ID. A later mint transaction is accepted only when its onchain input
matches the plan.

## Delivery and refund proof

Pocket extracts the token ID from the collection's ERC-721 `Transfer` event from the zero address to
the treasury. It then prepares `safeTransferFrom(treasury, recipient, tokenId)` and verifies the exact
treasury-to-recipient event.

After delivery, Pocket calculates the unused ETH from:

`deposit - mint value - actual mint gas - actual delivery gas - reserved refund gas`

The refund transaction must be a plain native-ETH transfer from the treasury to the immutable refund
address for the exact planned amount. The order is final only after the refund receipt reaches the
required confirmation count.

## Implemented protections

- Feature disabled unless every chain, treasury, token-secret, operator-key, and payment
  setting is present.
- No raw treasury key in application configuration or source.
- Separate order capability token and execution-operator key.
- SQLite WAL persistence and optimistic revision checks.
- Atomic global deposit-transaction claim.
- 64-KiB request limit and strict input allowlists.
- EIP-3009 1-USDT X Layer challenge; no Permit2 advertising.
- Exact calldata, value, sender, target, recipient, token ID, and transaction receipt verification.
- No floating-point arithmetic for ETH or USDT amounts.

## Not yet production-ready

These gates remain mandatory:

1. Connect a hardened signer worker. The HTTP service must never receive a raw private key.
2. Add failed-mint and pre-mint cancellation refund paths, including exact failed-transaction gas.
3. Add an automatic scheduler with a transactional execution lease so two workers cannot mint twice.
4. Verify recipient contract compatibility before using `safeTransferFrom`.
5. Run direct SeaDrop RPC mocks, an Ethereum mainnet fork, and a controlled low-value live mint.
6. Independently reproduce the 1-USDT payment challenge and paid replay with OKX buyer tooling.
7. Run incident tests for RPC disagreement, public-stage changes, replacement transactions, reorgs, gas
   spikes, sold-out stages, stuck delivery, and stuck refunds.
8. Replace single-instance SQLite before horizontal scaling.

Until all eight gates pass, keep `POCKET_CONCIERGE_NFT_MINT_ENABLED=false` and do not list the service.

## Assisted OKX worker

`npm run nft:worker -- <mint|deliver|refund> <externalId>` provides the first signer boundary without
placing a raw key in the API or Railway. It validates the short-lived server plan and runs the OKX
transaction security scan. The command is dry-run by default.

Adding `--execute` still requires two interactive confirmations. The second confirmation occurs only
after the initial OKX contract-call returns its confirmation response; only then is the exact command
replayed with `--force`.

The worker intentionally fails closed on scan errors, blocked scans, unknown scan actions, address or
chain drift, calldata/value/gas mismatches, expired plans, and configured fee-ceiling violations.
Because the current OKX contract-call interface does not expose transaction nonce or a caller-selected
maximum fee per gas, this is suitable only for an assisted pilot. It does not satisfy the hardened
unattended-signer gate.

`npm run nft:preflight` is a read-only mainnet check. It verifies chain ID 1, deployed SeaDrop
bytecode, the treasury balance, and current fee estimates without signing or broadcasting or printing
the private RPC URL.
