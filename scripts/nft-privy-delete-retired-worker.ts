import { PrivyClient } from '@privy-io/node'
import {
  derivePrivyAuthorizationPublicKey,
  normalizePrivyPublicKey,
} from '../src/privy-authorization-key.js'

// Key-quorum deletion can take longer than ordinary wallet requests inside Privy.
// This expiry applies only to the exact, confirmed deletion request below.
const DELETION_REQUEST_EXPIRY_MS = 180_000

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function optionalArg(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}

async function main() {
  const appId = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_ID')
  const appSecret = requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_SECRET')
  const retiredSignerId = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_RETIRED_WORKER_SIGNER_ID',
  )
  const currentSignerId = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_CURRENT_WORKER_SIGNER_ID',
  )
  const retiredAuthorizationKey = requiredEnv(
    'POCKET_CONCIERGE_NFT_PRIVY_RETIRED_WORKER_AUTHORIZATION_PRIVATE_KEY',
  )
  if (retiredSignerId === currentSignerId) {
    throw new Error('The retired and current worker signer IDs must be different.')
  }

  const client = new PrivyClient({
    appId,
    appSecret,
    requestExpiry: { defaultMs: DELETION_REQUEST_EXPIRY_MS },
  })
  const targetQuorum = await client.keyQuorums().get(retiredSignerId)
  const derivedPublicKey = derivePrivyAuthorizationPublicKey(retiredAuthorizationKey)
  if (
    targetQuorum.authorization_keys.length !== 1
    || normalizePrivyPublicKey(targetQuorum.authorization_keys[0]?.public_key || '')
      !== derivedPublicKey
  ) {
    throw new Error(
      'The supplied retired worker key does not belong to the target quorum; no deletion was sent.',
    )
  }

  const references: Array<{ walletId: string; relationship: 'owner' | 'signer' }> = []
  let currentSignerReferences = 0
  for await (const wallet of client.wallets().list()) {
    if (wallet.owner_id === retiredSignerId) {
      references.push({ walletId: wallet.id, relationship: 'owner' })
    }
    for (const signer of wallet.additional_signers || []) {
      if (signer.signer_id === retiredSignerId) {
        references.push({ walletId: wallet.id, relationship: 'signer' })
      }
      if (signer.signer_id === currentSignerId) currentSignerReferences += 1
    }
  }
  if (references.length) {
    throw new Error(
      `Retired worker is still referenced by ${references.length} wallet relationship(s); no deletion was sent.`,
    )
  }
  if (currentSignerReferences < 1) {
    throw new Error('The replacement worker is not attached to any wallet; no deletion was sent.')
  }

  const apply = process.argv.includes('--apply')
  const confirmedSigner = optionalArg('--confirm-delete')
  const plan = {
    retiredSignerId,
    retiredSignerName: targetQuorum.display_name,
    currentSignerId,
    attachedWalletReferences: 0,
    replacementWalletReferences: currentSignerReferences,
  }
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      status: 'retired_worker_validated_not_deleted',
      ...plan,
      next: `Re-run with --apply --confirm-delete ${retiredSignerId}.`,
    }, null, 2))
    return
  }
  if (confirmedSigner !== retiredSignerId) {
    throw new Error(`Apply requires --confirm-delete ${retiredSignerId}.`)
  }

  await client.keyQuorums().delete(retiredSignerId, {
    authorization_context: {
      authorization_private_keys: [retiredAuthorizationKey],
    },
    request_expiry: Date.now() + DELETION_REQUEST_EXPIRY_MS,
  })
  console.log(JSON.stringify({
    ok: true,
    status: 'retired_worker_deleted',
    ...plan,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
