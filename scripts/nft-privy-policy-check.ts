import { PrivyClient } from '@privy-io/node'
import { Transaction } from 'ethers'
import { getAddress } from 'viem'

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function hasPolicyViolation(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { message?: unknown; error?: unknown; status?: unknown }
  const details = `${String(candidate.message ?? '')} ${JSON.stringify(candidate.error ?? {})}`
  return (
    details.toLowerCase().includes('policy_violation')
    || details.toLowerCase().includes('policy violation')
  )
}

async function main() {
  const appId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_ID')
  const appSecret = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_SECRET')
  const walletId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_WALLET_ID')
  const walletAddress = getAddress(requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS'))
  const workerAuthorizationKey = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_AUTHORIZATION_PRIVATE_KEY',
  )
  const policyId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_POLICY_ID')
  const adminOwnerId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_ADMIN_OWNER_ID')
  const authorization_context = {
    authorization_private_keys: [workerAuthorizationKey],
  }
  const client = new PrivyClient({
    appId,
    appSecret,
    requestExpiry: { defaultMs: 30_000 },
  })

  const wallet = await client.wallets().get(walletId)
  if (getAddress(wallet.address) !== walletAddress) {
    throw new Error('Privy wallet address differs from the configured managed treasury.')
  }
  if (wallet.owner_id !== adminOwnerId) {
    throw new Error('Privy wallet is not owned by the configured offline policy administrator.')
  }
  if (!wallet.policy_ids.includes(policyId)) {
    throw new Error('Privy wallet does not enforce the configured global execution policy.')
  }
  if (
    wallet.additional_signers.length !== 1
    || wallet.additional_signers[0]?.signer_id === adminOwnerId
    || !wallet.additional_signers[0]?.override_policy_ids?.includes(policyId)
  ) {
    throw new Error('Privy wallet must have exactly one distinct worker signer with the policy override.')
  }

  const ethereum = client.wallets().ethereum()
  const common = {
    type: 0 as const,
    from: walletAddress,
    to: walletAddress,
    data: '0x' as const,
    value: '0x0',
    gas_limit: '0x5208',
    gas_price: '0x1',
    // A deliberately unreachable nonce makes the discarded preflight signature non-broadcastable.
    nonce: '0x1fffffffffffff',
  }

  let wrongChainRejected = false
  try {
    await ethereum.signTransaction(walletId, {
      params: { transaction: { ...common, chain_id: 8453 } },
      authorization_context,
      request_expiry: Date.now() + 30_000,
    })
  } catch (error) {
    if (!hasPolicyViolation(error)) throw error
    wrongChainRejected = true
  }
  if (!wrongChainRejected) {
    throw new Error('Privy policy unexpectedly signed a transaction for the wrong chain.')
  }

  const signed = await ethereum.signTransaction(walletId, {
    params: { transaction: { ...common, chain_id: 1 } },
    authorization_context,
    request_expiry: Date.now() + 30_000,
  })
  const decoded = Transaction.from(signed.signed_transaction)
  if (
    signed.encoding !== 'rlp'
    || decoded.chainId !== 1n
    || !decoded.from
    || getAddress(decoded.from) !== walletAddress
    || decoded.nonce !== Number.MAX_SAFE_INTEGER
    || decoded.value !== 0n
  ) {
    throw new Error('Privy returned an unexpected sign-only preflight envelope.')
  }

  console.log(JSON.stringify({
    ok: true,
    walletId,
    walletAddress,
    ownerId: wallet.owner_id,
    workerSignerId: wallet.additional_signers[0].signer_id,
    policyId,
    wrongChainRejected: true,
    allowedMainnetSignOnly: true,
    broadcast: false,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
