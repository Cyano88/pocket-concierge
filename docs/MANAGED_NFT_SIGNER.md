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

```bash
export POCKET_CONCIERGE_NFT_SIGNER_MODE='privy'
export POCKET_CONCIERGE_NFT_AUTO_EXECUTE='false'
export POCKET_CONCIERGE_NFT_PRIVY_APP_ID='<separate-pocket-app-id>'
export POCKET_CONCIERGE_NFT_PRIVY_APP_SECRET='<app-secret>'
export POCKET_CONCIERGE_NFT_PRIVY_WALLET_ID='<wallet-id>'
export POCKET_CONCIERGE_NFT_PRIVY_AUTHORIZATION_PRIVATE_KEY='<base64-pkcs8-key>'
export POCKET_CONCIERGE_NFT_PRIVY_POLICY_ID='<attached-owned-policy-id>'
export POCKET_CONCIERGE_NFT_PRIVY_ADMIN_OWNER_ID='<offline-admin-owner-id>'
export POCKET_CONCIERGE_NFT_PRIVY_POLICY_CONFIRMED='true'
export POCKET_CONCIERGE_NFT_TREASURY_ADDRESS='<new-managed-wallet-address>'
export POCKET_CONCIERGE_NFT_POLL_INTERVAL_MS='15000'
```

Keep the file owned by `pocketsigner` with mode `600`. Keep the existing Pocket API URL, operator
key, worker ID, signer database, fee ceiling and Ethereum RPC variables.

Before changing the API treasury, verify the live wallet ownership, signer override, policy denial
and sign-only path. This creates no broadcast and uses a deliberately unreachable nonce:

```bash
source /opt/pocket-signer/secrets/worker.env
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
   source /opt/pocket-signer/secrets/worker.env
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
