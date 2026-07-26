import { AwsKmsNftSignerBackend } from '../src/nft-aws-kms-backend.js'
import { NftHardenedSigner } from '../src/nft-hardened-signer.js'
import type { AssistedNftAction } from '../src/nft-assisted-worker.js'

const ACTIONS = new Set<AssistedNftAction>(['mint', 'deliver', 'refund'])

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function planEndpoint(action: AssistedNftAction) {
  return action === 'mint' ? 'prepare' : action === 'deliver' ? 'delivery-plan' : 'refund'
}

function verificationTarget(action: AssistedNftAction) {
  if (action === 'mint') return { endpoint: 'minted', field: 'mintTransactionHash' }
  if (action === 'deliver') return { endpoint: 'delivered', field: 'deliveryTransactionHash' }
  return { endpoint: 'refunded', field: 'refundTransactionHash' }
}

async function postJson(url: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => ({ error: 'non_json_response' }))
  if (!response.ok) throw new Error(`Pocket request failed (HTTP ${response.status}): ${JSON.stringify(payload)}`)
  return payload
}

async function submitForVerification(
  baseUrl: string,
  externalId: string,
  action: AssistedNftAction,
  operatorKey: string,
  transactionHash: string,
) {
  const target = verificationTarget(action)
  let lastError = 'verification pending'
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await postJson(
        `${baseUrl}/v1/nft-mints/orders/${encodeURIComponent(externalId)}/${target.endpoint}`,
        { 'X-Operator-Key': operatorKey },
        { [target.field]: transactionHash },
      )
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < 6) await new Promise(resolve => setTimeout(resolve, 5_000))
    }
  }
  throw new Error(
    `Transaction was broadcast but Pocket verification is incomplete: ${lastError}. `
    + 'Recover this hash; do not prepare or sign another plan.',
  )
}

async function main() {
  const action = process.argv[2] as AssistedNftAction | undefined
  const externalId = process.argv[3]
  if (!action || !ACTIONS.has(action) || !externalId) {
    throw new Error('Usage: npm run nft:kms-worker -- <mint|deliver|refund> <externalId>')
  }
  const baseUrl = requiredEnv('POCKET_CONCIERGE_URL').replace(/\/$/, '')
  const operatorKey = requiredEnv('POCKET_CONCIERGE_NFT_OPERATOR_KEY')
  const workerId = requiredEnv('POCKET_CONCIERGE_NFT_WORKER_ID')
  const treasuryAddress = requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS')
  const maximumFeePerGasWei = requiredEnv('POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI')
  const signer = new NftHardenedSigner(
    requiredEnv('POCKET_CONCIERGE_NFT_SIGNER_DB_PATH'),
    new AwsKmsNftSignerBackend({
      keyId: requiredEnv('POCKET_CONCIERGE_NFT_KMS_KEY_ID'),
      rpcUrl: requiredEnv('ETHEREUM_RPC_URL'),
      region: requiredEnv('AWS_REGION'),
    }),
  )
  try {
    const raw = await postJson(
      `${baseUrl}/v1/nft-mints/orders/${encodeURIComponent(externalId)}/${planEndpoint(action)}`,
      { 'X-Operator-Key': operatorKey, 'X-Worker-Id': workerId },
    )
    const result = await signer.execute(raw, {
      action,
      externalId,
      treasuryAddress,
      workerId,
      maximumFeePerGasWei,
    })
    const verified = await submitForVerification(
      baseUrl,
      externalId,
      action,
      operatorKey,
      result.transactionHash,
    )
    console.log(JSON.stringify({
      status: 'broadcast_and_submitted_for_verification',
      action,
      externalId,
      planId: result.planId,
      transactionHash: result.transactionHash,
      orderState: verified?.order?.state,
    }, null, 2))
  } finally {
    signer.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
