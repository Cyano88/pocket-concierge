import { PrivyClient } from '@privy-io/node'
import { getAddress } from 'viem'
import {
  derivePrivyAuthorizationPublicKey,
  normalizePrivyPublicKey,
} from '../src/privy-authorization-key.js'

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function optionalArg(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}

function assertWalletConfiguration(
  wallet: {
    address: string
    owner_id: string | null
    policy_ids: string[]
    additional_signers: Array<{
      signer_id: string
      override_policy_ids?: string[]
    }>
  },
  expected: {
    address: string
    ownerId: string
    policyId: string
    workerSignerId: string
  },
) {
  if (getAddress(wallet.address) !== expected.address) {
    throw new Error('Privy wallet address differs from the configured managed treasury.')
  }
  if (wallet.owner_id !== expected.ownerId) {
    throw new Error('Privy wallet owner differs from the configured policy administrator.')
  }
  if (
    wallet.policy_ids.length !== 1
    || wallet.policy_ids[0] !== expected.policyId
  ) {
    throw new Error('Privy wallet global policy differs from the configured execution policy.')
  }
  if (
    wallet.additional_signers.length !== 1
    || wallet.additional_signers[0]?.signer_id !== expected.workerSignerId
    || wallet.additional_signers[0]?.override_policy_ids?.length !== 1
    || wallet.additional_signers[0]?.override_policy_ids?.[0] !== expected.policyId
  ) {
    throw new Error('Privy wallet signer or signer policy differs from the expected rotation state.')
  }
}

async function main() {
  const appId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_ID')
  const appSecret = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_SECRET')
  const walletId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_WALLET_ID')
  const walletAddress = getAddress(requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS'))
  const policyId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_POLICY_ID')
  const adminOwnerId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_ADMIN_OWNER_ID')
  const oldWorkerSignerId = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_EXPECTED_OLD_WORKER_SIGNER_ID',
  )
  const newWorkerSignerId = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_NEW_WORKER_SIGNER_ID',
  )
  if (newWorkerSignerId === oldWorkerSignerId || newWorkerSignerId === adminOwnerId) {
    throw new Error('The new worker signer must be distinct from the old worker and policy owner.')
  }

  const apply = process.argv.includes('--apply')
  const confirmedWallet = optionalArg('--confirm-wallet')
  if (apply && (!confirmedWallet || getAddress(confirmedWallet) !== walletAddress)) {
    throw new Error(`Apply requires --confirm-wallet ${walletAddress}.`)
  }

  const client = new PrivyClient({
    appId,
    appSecret,
    requestExpiry: { defaultMs: 30_000 },
  })
  const before = await client.wallets().get(walletId)
  assertWalletConfiguration(before, {
    address: walletAddress,
    ownerId: adminOwnerId,
    policyId,
    workerSignerId: oldWorkerSignerId,
  })

  const plan = {
    walletId,
    walletAddress,
    ownerId: adminOwnerId,
    policyId,
    currentWorkerSignerId: oldWorkerSignerId,
    newWorkerSignerId,
  }
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      status: 'validated_not_applied',
      ...plan,
      next: `Re-run with --apply --confirm-wallet ${walletAddress}.`,
    }, null, 2))
    return
  }

  const adminAuthorizationKey = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_ADMIN_AUTHORIZATION_PRIVATE_KEY',
  )
  const derivedAdminPublicKey = derivePrivyAuthorizationPublicKey(adminAuthorizationKey)
  const ownerQuorum = await client.keyQuorums().get(adminOwnerId)
  if (
    ownerQuorum.authorization_keys.length !== 1
    || normalizePrivyPublicKey(ownerQuorum.authorization_keys[0]?.public_key || '')
      !== derivedAdminPublicKey
  ) {
    throw new Error(
      'The supplied Policy Admin key does not belong to the configured wallet owner; no update was sent.',
    )
  }
  const updated = await client.wallets().update(walletId, {
    additional_signers: [{
      signer_id: newWorkerSignerId,
      override_policy_ids: [policyId],
    }],
    authorization_context: {
      authorization_private_keys: [adminAuthorizationKey],
    },
    request_expiry: Date.now() + 30_000,
  })
  assertWalletConfiguration(updated, {
    address: walletAddress,
    ownerId: adminOwnerId,
    policyId,
    workerSignerId: newWorkerSignerId,
  })

  console.log(JSON.stringify({
    ok: true,
    status: 'worker_signer_rotated',
    ...plan,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
