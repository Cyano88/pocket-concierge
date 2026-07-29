# Managed NFT signer

This is the production migration path from the interactive encrypted keystore to an unattended,
policy-enforced Privy server wallet. It is opt-in. The existing VPS keystore remains the active
pilot signer until a separate managed wallet completes a second controlled mainnet proof.

## Security boundary

```text
Pocket API -> bounded plan -> isolated VPS worker -> Privy eth_signTransaction
           -> decode and compare signed RLP -> Ethereum RPC broadcast -> receipt verification
```

Pocket still independently checks:

- Ethereum chain ID is exactly `1`
- signer address matches the order treasury
- action, external ID, plan ID and worker lease match
- target and calldata match the supported mint, delivery or refund action
- native value, gas limit, fee ceiling, nonce and expiry match
- a plan and Ethereum nonce are reserved only once
- the signed RLP envelope is equal to the validated plan before broadcast
- an already-broadcast transaction is recovered from the local signer ledger after a restart

Privy is used only for `eth_signTransaction`. Pocket broadcasts the returned RLP itself. Do not
enable `eth_sendTransaction`, private-key export or a general-purpose transaction endpoint.

## 1. Create isolated Privy resources

Create a new Privy application for Pocket Concierge. Do not reuse the PolyDesk application and do
not import the current VPS private key.

Create:

1. one server authorization key;
2. one Ethereum server wallet owned by that authorization key;
3. one owned wallet policy;
4. no additional signers and no private-key export workflow.

The new wallet address becomes the treasury only after the controlled migration proof succeeds.

## 2. Minimum wallet policy

Use an owned, default-deny Ethereum policy. Replace `MAX_ORDER_WEI_HEX` with Pocket's real
per-order capital ceiling encoded as a `0x`-prefixed hexadecimal wei quantity:

```json
{
  "version": "1.0",
  "name": "Pocket NFT execution",
  "chain_type": "ethereum",
  "rules": [
    {
      "name": "Ethereum mainnet bounded sign-only",
      "method": "eth_signTransaction",
      "action": "ALLOW",
      "conditions": [
        {
          "field_source": "ethereum_transaction",
          "field": "chain_id",
          "operator": "eq",
          "value": "1"
        },
        {
          "field_source": "ethereum_transaction",
          "field": "value",
          "operator": "lte",
          "value": "MAX_ORDER_WEI_HEX"
        }
      ]
    }
  ]
}
```

This managed policy is defense in depth. The isolated worker remains responsible for the exact
SeaDrop target, collection calldata, NFT recipient and refund recipient because those values differ
for each immutable customer order.

## 3. Configure the isolated worker

Add these values to `/opt/pocket-signer/secrets/worker.env`. The authorization private key is the
base64-encoded PKCS8 key Privy provides for request authorization; it is not the wallet private key.

```dotenv
POCKET_CONCIERGE_NFT_SIGNER_MODE=privy
POCKET_CONCIERGE_NFT_AUTO_EXECUTE=false
POCKET_CONCIERGE_NFT_PRIVY_APP_ID=<separate-pocket-app-id>
POCKET_CONCIERGE_NFT_PRIVY_APP_SECRET=<app-secret>
POCKET_CONCIERGE_NFT_PRIVY_WALLET_ID=<wallet-id>
POCKET_CONCIERGE_NFT_PRIVY_AUTHORIZATION_PRIVATE_KEY=<base64-pkcs8-key>
POCKET_CONCIERGE_NFT_PRIVY_POLICY_ID=<attached-owned-policy-id>
POCKET_CONCIERGE_NFT_PRIVY_ADMIN_OWNER_ID=<offline-admin-owner-id>
POCKET_CONCIERGE_NFT_PRIVY_POLICY_CONFIRMED=true
POCKET_CONCIERGE_NFT_TREASURY_ADDRESS=<new-managed-wallet-address>
POCKET_CONCIERGE_NFT_POLL_INTERVAL_MS=15000
```

Keep the file owned by `pocketsigner` with mode `600`. Keep the existing Pocket API URL, operator
key, worker ID, signer database, fee ceiling and Ethereum RPC variables. Do not prefix entries with
`export`: systemd's `EnvironmentFile` accepts `NAME=value` assignments and silently ignores shell
export statements.

### Rotate a worker signer

If a worker authorization key is exposed, disable the continuous worker and rotate the Privy app
secret before proceeding. Create a new constrained worker key, but keep the policy administrator
owner unchanged. The rotation command preserves the wallet address and global policy, requires the
policy administrator authorization key only for the signed update, and refuses unexpected signer
state.

First run the read-only plan:

```bash
export POCKET_CONCIERGE_NFT_PRIVY_EXPECTED_OLD_WORKER_SIGNER_ID='<old-worker-id>'
export POCKET_CONCIERGE_NFT_PRIVY_NEW_WORKER_SIGNER_ID='<new-worker-id>'
npm run nft:privy-rotate-worker
```

After reviewing the exact IDs, load the policy administrator key without echoing it or storing it
in shell history, then apply the same plan:

```bash
read -rsp 'Policy administrator authorization key: ' \
  POCKET_CONCIERGE_NFT_PRIVY_ADMIN_AUTHORIZATION_PRIVATE_KEY
echo
export POCKET_CONCIERGE_NFT_PRIVY_ADMIN_AUTHORIZATION_PRIVATE_KEY
npm run nft:privy-rotate-worker -- --apply --confirm-wallet '<treasury-address>'
unset POCKET_CONCIERGE_NFT_PRIVY_ADMIN_AUTHORIZATION_PRIVATE_KEY
```

Only after the wallet update succeeds should the worker environment be changed to the new worker
authorization private key and the old worker key be deleted in Privy.

If the dashboard does not expose key-quorum deletion, use the guarded deletion command. It scans
every wallet in the app and refuses deletion while the retired quorum is still an owner or signer:

```bash
export POCKET_CONCIERGE_NFT_PRIVY_RETIRED_WORKER_SIGNER_ID='<old-worker-id>'
export POCKET_CONCIERGE_NFT_PRIVY_CURRENT_WORKER_SIGNER_ID='<new-worker-id>'
read -rsp 'Retired worker authorization key: ' \
  POCKET_CONCIERGE_NFT_PRIVY_RETIRED_WORKER_AUTHORIZATION_PRIVATE_KEY
echo
export POCKET_CONCIERGE_NFT_PRIVY_RETIRED_WORKER_AUTHORIZATION_PRIVATE_KEY
npm run nft:privy-delete-retired-worker
```

Review the dry-run output before repeating it with `--apply --confirm-delete '<old-worker-id>'`.
Unset the retired authorization key immediately after either command.

Before changing the API treasury, verify the live wallet ownership, signer override, policy denial
and sign-only path. This creates no broadcast and uses a deliberately unreachable nonce:

```bash
set -a
source /opt/pocket-signer/secrets/worker.env
set +a
npm run nft:privy-policy-check
```

## 4. Controlled migration

1. Leave `POCKET_CONCIERGE_NFT_AUTO_EXECUTE=false`.
2. Deploy the API with the new treasury address while public access remains pilot-gated.
3. Create a fresh low-value test order and fund only its exact bounded deposit.
4. Run mint, delivery and refund interactively with the managed signer.
5. Verify the public proof reconciles service payment, deposit, mint, delivery, gas and refund.
6. Test one policy rejection by changing a non-production test request to the wrong chain.
7. Set `POCKET_CONCIERGE_NFT_AUTO_EXECUTE=true`.
8. Run one queue cycle:

   ```bash
   set -a
   source /opt/pocket-signer/secrets/worker.env
   set +a
   cd /opt/pocket-signer/app
   npm run nft:managed-daemon -- --once
   ```

9. Only after that succeeds, install the continuous service and consider removing the public pilot
   key.

## 5. Continuous service

Create `/etc/systemd/system/pocket-nft-worker.service`:

```ini
[Unit]
Description=Pocket Concierge managed NFT worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pocketsigner
Group=pocketsigner
WorkingDirectory=/opt/pocket-signer/app
EnvironmentFile=/opt/pocket-signer/secrets/worker.env
ExecStart=/usr/local/bin/npm run nft:managed-daemon
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/pocket-signer/data

[Install]
WantedBy=multi-user.target
```

Then validate and enable:

```bash
sudo systemd-analyze verify /etc/systemd/system/pocket-nft-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now pocket-nft-worker
sudo systemctl status pocket-nft-worker --no-pager
```

The daemon polls only Pocket's operator-authenticated, privacy-limited work queue. It executes one
treasury action at a time. It never polls a marketplace, accepts arbitrary transaction JSON or
stores a customer wallet key.

## Stop conditions

Keep the service pilot-gated and stop the worker if:

- the managed policy is missing or editable by the app secret alone;
- the wallet address differs from Pocket's configured treasury;
- the API returns an unknown order state;
- a broadcast outcome is unknown and the signer ledger has no transaction hash;
- an Ethereum nonce is already reserved by another plan;
- a signed transaction differs from the validated plan;
- the complete mint, delivery and refund accounting does not reconcile.
