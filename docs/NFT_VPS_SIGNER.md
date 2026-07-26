# Pocket NFT signer on a private VPS

This is the pilot deployment for customer-funded Ethereum SeaDrop execution. The Pocket API remains
on Railway, but the Ethereum signing key exists only as an encrypted keystore on a separate VPS.
The signer has no HTTP server and no general transfer or arbitrary contract-call interface.

## Architecture

```text
Buyer -> Pocket API on Railway -> short-lived execution plan
                                      |
Operator SSH -> private VPS worker -> validate -> confirm plan ID -> sign -> Ethereum
                                      |
                                      -> submit transaction hash -> Pocket verifies receipt
```

The worker independently enforces chain ID 1, treasury address, official SeaDrop target, order and
plan IDs, calldata hash, exact native value, gas ceiling, expiry, lease owner and reserved nonce.
Its second SQLite ledger refuses a reused plan or Ethereum nonce before signing.

## 1. Create the VPS

Use a current Ubuntu LTS VPS with at least 1 vCPU, 1 GB RAM and persistent disk. Select SSH-key
authentication. Do not enable password SSH login. The VPS requires outbound HTTPS access; inbound
access should be SSH only from your own IP when the provider supports an IP firewall.

## 2. Create a restricted Linux user

Run as the provider's initial administrative user:

```bash
sudo adduser --disabled-password --gecos "" pocketsigner
sudo install -d -m 700 -o pocketsigner -g pocketsigner /home/pocketsigner/.ssh
sudo cp ~/.ssh/authorized_keys /home/pocketsigner/.ssh/authorized_keys
sudo chown pocketsigner:pocketsigner /home/pocketsigner/.ssh/authorized_keys
sudo chmod 600 /home/pocketsigner/.ssh/authorized_keys
sudo apt-get update
sudo apt-get install -y git ca-certificates curl ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable
```

After confirming a second SSH session works as `pocketsigner`, disable root and password SSH login
according to the VPS provider's Ubuntu hardening instructions. Do not close the original session
until the restricted login is verified.

## 3. Install Node.js 24

Install the current Node.js 24 LTS build using the provider's supported image/package method or the
official Node.js distribution. Verify:

```bash
node --version
npm --version
```

Pocket requires Node 22.13 or newer; Node 24 is recommended.

## 4. Install Pocket Concierge

```bash
sudo install -d -m 750 -o pocketsigner -g pocketsigner /opt/pocket-signer
sudo -u pocketsigner git clone https://github.com/Cyano88/pocket-concierge.git /opt/pocket-signer/app
cd /opt/pocket-signer/app
sudo -u pocketsigner npm ci
sudo -u pocketsigner npm run typecheck
sudo -u pocketsigner npm test
sudo -u pocketsigner install -d -m 700 /opt/pocket-signer/secrets /opt/pocket-signer/data
```

## 5. Generate the dedicated encrypted wallet

Run this from an interactive `pocketsigner` SSH session:

```bash
cd /opt/pocket-signer/app
npm run nft:vps-keystore -- /opt/pocket-signer/secrets/executor.json
```

Enter a unique password of at least 16 characters. The command:

- generates the wallet inside the process;
- writes only an encrypted Ethereum V3 keystore with mode `0600`;
- refuses to overwrite an existing file;
- prints the public address but never the private key or mnemonic.

Store the password in an offline password manager. Back up `executor.json` separately. Neither item
alone can sign. Do not upload either to Railway, GitHub, chat or email.

## 6. Configure the worker

Create `/opt/pocket-signer/secrets/worker.env` as `pocketsigner`:

```bash
umask 077
nano /opt/pocket-signer/secrets/worker.env
```

Contents:

```bash
export POCKET_CONCIERGE_URL='https://pocket-concierge-production.up.railway.app'
export POCKET_CONCIERGE_NFT_OPERATOR_KEY='<existing separate operator key>'
export POCKET_CONCIERGE_NFT_WORKER_ID='pocket-nft-vps-1'
export POCKET_CONCIERGE_NFT_TREASURY_ADDRESS='<address printed by keystore command>'
export POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI='<approved hard ceiling>'
export POCKET_CONCIERGE_NFT_KEYSTORE_PATH='/opt/pocket-signer/secrets/executor.json'
export POCKET_CONCIERGE_NFT_SIGNER_DB_PATH='/opt/pocket-signer/data/signer.sqlite'
export ETHEREUM_RPC_URL='<private Ethereum mainnet HTTPS RPC>'
```

Then:

```bash
chmod 600 /opt/pocket-signer/secrets/worker.env
```

The file contains capabilities but no keystore password, raw key or mnemonic.

## 7. Match Pocket to the new treasury

Before accepting any new order:

1. Update `POCKET_CONCIERGE_NFT_TREASURY_ADDRESS` on the Railway API to the generated address.
2. Keep `POCKET_CONCIERGE_NFT_PILOT_KEY` enabled.
3. Restart the API and confirm `/health` returns HTTP 200.
4. Run the read-only preflight from the VPS:

```bash
cd /opt/pocket-signer/app
source /opt/pocket-signer/secrets/worker.env
npm run nft:preflight
```

Do not fund the wallet before its address matches both the VPS environment and Pocket API.

## 8. Execute one controlled order

After the buyer pays the 1-USDT service fee and sends the exact displayed ETH deposit:

```bash
cd /opt/pocket-signer/app
source /opt/pocket-signer/secrets/worker.env
npm run nft:vps-worker -- mint <externalId>
```

The worker asks for the hidden keystore password, prints the validated transaction summary, and
requires the exact short-lived plan ID before signing. Then:

```bash
npm run nft:vps-worker -- deliver <externalId>
npm run nft:vps-worker -- refund <externalId>
```

Each command broadcasts once and submits the hash to Pocket for independent receipt verification.
If broadcast status becomes uncertain, do not rerun the action. Recover the reserved nonce and
transaction hash from Ethereum and `/opt/pocket-signer/data/signer.sqlite` first.

## 9. Pilot exit criteria

Keep public order creation gated until one fresh run proves:

- 1-USDT OKX x402 payment and replay;
- exact Ethereum deposit verification;
- SeaDrop mint from the configured VPS signer;
- exact token delivery to the declared recipient;
- unused ETH refund;
- final public proof containing all transaction hashes;
- duplicate plan and duplicate nonce rejection.

For production-scale unattended sniping, replace the encrypted VPS keystore with HSM/MPC while
retaining the same validated-plan and one-use-ledger interface.
