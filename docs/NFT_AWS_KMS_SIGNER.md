# Isolated NFT signer: AWS KMS

Pocket's public API does not contain a treasury private key and must not receive AWS credentials.
The unattended worker runs separately with an IAM role and an asymmetric AWS KMS key. AWS KMS keeps
the secp256k1 private key non-exportable.

## Boundary

```text
Pocket API on Railway
  -> short-lived, nonce-bound plan
  -> isolated worker validates the entire plan
  -> AWS KMS signs the exact legacy Ethereum transaction digest
  -> worker recovers and checks the KMS address
  -> worker broadcasts through Ethereum RPC
  -> Pocket independently verifies the receipt
```

The worker permits only chain ID 1 and the action already enforced by Pocket:

- `mint`: official SeaDrop 1.0, exact calldata, value, gas ceiling, nonce, expiry and one-use lease.
- `deliver`: exact NFT contract transfer to the declared recipient with zero ETH value.
- `refund`: empty-calldata ETH transfer to the immutable refund address.

The transaction is serialized as a legacy Ethereum transaction with `gasPrice` equal to the
plan's bounded `maxFeePerGasWei`. This avoids a hidden priority-fee field: every signed transaction
field is present in the plan and protected by its plan ID.

## One-time AWS setup

1. In AWS KMS, create an asymmetric key:
   - Key type: asymmetric
   - Key usage: sign and verify
   - Key spec: `ECC_SECG_P256K1`
   - Alias: for example `alias/pocket-nft-executor`
2. Create a dedicated compute identity for the isolated worker. Prefer an IAM role attached to the
   worker runtime; do not create a long-lived access key for Railway.
3. Grant that role only:
   - `kms:GetPublicKey`
   - `kms:Sign`
   on the single KMS key ARN.
4. Deny or omit KMS administration, key deletion, export, wallet withdrawal APIs and access to the
   Pocket API service's unrelated secrets.
5. Fund the address derived by `npm run nft:kms-worker` only with the customer execution deposit
   required for the active order. Do not use it as a general treasury.

Minimal IAM permission statement:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignPocketNftPlansOnly",
      "Effect": "Allow",
      "Action": ["kms:GetPublicKey", "kms:Sign"],
      "Resource": "arn:aws:kms:REGION:ACCOUNT_ID:key/KEY_ID"
    }
  ]
}
```

KMS cannot inspect Ethereum calldata. Pocket's independent plan validator and one-use SQLite ledger
are therefore mandatory controls around the narrow IAM permission.

## Worker environment

Set these only in the isolated worker runtime:

```text
AWS_REGION=<KMS region>
POCKET_CONCIERGE_NFT_KMS_KEY_ID=<KMS key ARN, id, or alias>
POCKET_CONCIERGE_NFT_SIGNER_DB_PATH=<durable path>/nft-signer.sqlite
POCKET_CONCIERGE_URL=https://pocket-concierge-production.up.railway.app
POCKET_CONCIERGE_NFT_OPERATOR_KEY=<operator capability>
POCKET_CONCIERGE_NFT_WORKER_ID=<stable worker id>
POCKET_CONCIERGE_NFT_TREASURY_ADDRESS=<address derived from the KMS public key>
POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI=<hard fee ceiling>
ETHEREUM_RPC_URL=<private Ethereum mainnet RPC>
```

Use the runtime's IAM role or workload identity for AWS authentication. Do not set
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, a mnemonic, or an Ethereum private key in Railway.

## Controlled execution

Run only one worker and one active treasury transaction:

```powershell
npm run nft:kms-worker -- mint <externalId>
npm run nft:kms-worker -- deliver <externalId>
npm run nft:kms-worker -- refund <externalId>
```

Before the first mainnet execution:

1. Confirm the KMS-derived address exactly equals the configured Pocket treasury.
2. Run `npm run nft:preflight`.
3. Create a private pilot order and fund only its displayed maximum ETH deposit.
4. Execute mint, confirm Pocket records the exact token, execute delivery, then refund.
5. Confirm the public proof contains the service payment, deposit, mint, delivery and refund hashes.
6. Keep `POCKET_CONCIERGE_NFT_PILOT_KEY` enabled until this controlled flow passes.

If the worker reports that broadcast status is unknown, do not retry. Recover the reserved nonce
from the Ethereum RPC and the local signer ledger first.
