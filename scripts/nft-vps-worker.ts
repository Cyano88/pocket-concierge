import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { getAddress } from 'viem'
import { NftHardenedSigner } from '../src/nft-hardened-signer.js'
import {
  validateAssistedNftPlan,
  type AssistedNftAction,
} from '../src/nft-assisted-worker.js'
import type { NftHardenedSignerBackend } from '../src/nft-hardened-signer.js'
import { PrivyNftSignerBackend } from '../src/nft-privy-signer-backend.js'
import { VpsNftSignerBackend } from '../src/nft-vps-signer-backend.js'

const ACTIONS = new Set<AssistedNftAction>(['mint', 'deliver', 'refund'])
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/
const VERIFICATION_ATTEMPTS = 60
const VERIFICATION_DELAY_MS = 5_000
const CONFIRMING_ERRORS = new Set([
  'NFT_MINT_CONFIRMING',
  'NFT_DELIVERY_CONFIRMING',
  'NFT_REFUND_CONFIRMING',
])
const WAIT_CHUNK_MS = 30_000

class PocketRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(`Pocket request failed (HTTP ${status}): ${JSON.stringify(payload)}`)
  }
}

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function enabledEnv(name: string) {
  return String(process.env[name] || '').trim().toLowerCase() === 'true'
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
  const payload = await response.json().catch(() => ({ error: 'non_json_response' })) as Record<string, unknown>
  if (!response.ok) throw new PocketRequestError(response.status, payload)
  return payload
}

async function hidden(prompt: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('An interactive terminal is required to unlock the keystore.')
  }
  stdout.write(prompt)
  stdin.setEncoding('utf8')
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onEnd = () => {
      cleanup()
      reject(new Error('Terminal closed before password entry.'))
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new Error('Cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }
        value = character === '\u007f' || character === '\b'
          ? value.slice(0, -1)
          : value + character
      }
    }
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.setRawMode(true)
    stdin.resume()
  })
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
  for (let attempt = 1; attempt <= VERIFICATION_ATTEMPTS; attempt += 1) {
    try {
      return await postJson(
        `${baseUrl}/v1/nft-mints/orders/${encodeURIComponent(externalId)}/${target.endpoint}`,
        { 'X-Operator-Key': operatorKey },
        { [target.field]: transactionHash },
      )
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      const retryable = error instanceof PocketRequestError
        && (
          error.status >= 500
          || (
            error.status === 409
            && CONFIRMING_ERRORS.has(String(error.payload.error ?? ''))
          )
        )
      if (!retryable) throw error
      if (attempt % 6 === 0) {
        console.log(JSON.stringify({
          status: 'verification_pending',
          action,
          externalId,
          transactionHash,
          attempt,
        }))
      }
      if (attempt < VERIFICATION_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, VERIFICATION_DELAY_MS))
      }
    }
  }
  throw new Error(
    `Transaction was broadcast but Pocket verification is incomplete: ${lastError}. `
    + `Recover transaction ${transactionHash}; never prepare or sign a replacement blindly.`,
  )
}

async function waitForExecutionWindow(notBefore: string | undefined, expiresAt: string) {
  if (!notBefore) return
  const executeAt = Date.parse(notBefore)
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(executeAt) || !Number.isFinite(expiresAtMs) || executeAt >= expiresAtMs) {
    throw new Error('Scheduled execution window is invalid.')
  }
  while (Date.now() < executeAt) {
    const remainingMs = executeAt - Date.now()
    console.log(JSON.stringify({
      status: 'waiting_for_bound_stage_start',
      executeAt: notBefore,
      remainingMs,
    }))
    await new Promise(resolve => setTimeout(resolve, Math.min(remainingMs, WAIT_CHUNK_MS)))
  }
  if (expiresAtMs - Date.now() < 5_000) {
    throw new Error('Scheduled plan expired before its safe execution window opened.')
  }
}

async function main() {
  const action = process.argv[2] as AssistedNftAction | undefined
  const externalId = process.argv[3]
  const recoveryFlagIndex = process.argv.indexOf('--transaction-hash')
  const unbroadcastRecovery = process.argv.includes('--recover-unbroadcast')
  const recoveryTransactionHash = recoveryFlagIndex >= 0
    ? process.argv[recoveryFlagIndex + 1]
    : undefined
  if (!action || !ACTIONS.has(action) || !externalId) {
    throw new Error(
      'Usage: npm run nft:vps-worker -- <mint|deliver|refund> <externalId> '
      + '[--transaction-hash 0x... | --recover-unbroadcast]',
    )
  }
  if (unbroadcastRecovery && (action !== 'mint' || recoveryFlagIndex >= 0)) {
    throw new Error('--recover-unbroadcast is supported only for mint and cannot be combined with a transaction hash.')
  }
  const baseUrl = requiredEnv('POCKET_CONCIERGE_URL').replace(/\/$/, '')
  const operatorKey = requiredEnv('POCKET_CONCIERGE_NFT_OPERATOR_KEY')
  if (recoveryFlagIndex >= 0) {
    if (!recoveryTransactionHash || !TRANSACTION_HASH.test(recoveryTransactionHash)) {
      throw new Error('--transaction-hash must be a full Ethereum transaction hash.')
    }
    const verified = await submitForVerification(
      baseUrl,
      externalId,
      action,
      operatorKey,
      recoveryTransactionHash,
    )
    console.log(JSON.stringify({
      status: 'recovered_and_verified',
      action,
      externalId,
      transactionHash: recoveryTransactionHash,
      orderState: verified?.order && typeof verified.order === 'object'
        ? (verified.order as Record<string, unknown>).state
        : undefined,
    }, null, 2))
    return
  }
  const workerId = requiredEnv('POCKET_CONCIERGE_NFT_WORKER_ID')
  const treasuryAddress = requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS')
  const maximumFeePerGasWei = requiredEnv('POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI')
  const constraints = { action, externalId, treasuryAddress, workerId, maximumFeePerGasWei }
  const signerMode = String(process.env.POCKET_CONCIERGE_NFT_SIGNER_MODE || 'keystore')
    .trim()
    .toLowerCase()
  const automaticExecution = enabledEnv('POCKET_CONCIERGE_NFT_AUTO_EXECUTE')

  let backend: NftHardenedSignerBackend
  if (signerMode === 'keystore') {
    if (automaticExecution) {
      throw new Error('Automatic execution is forbidden with the interactive encrypted-keystore signer.')
    }
    const password = await hidden('Keystore password: ')
    backend = await VpsNftSignerBackend.fromEncryptedKeystore(
      readFileSync(requiredEnv('POCKET_CONCIERGE_NFT_KEYSTORE_PATH'), 'utf8'),
      password,
      { rpcUrl: requiredEnv('ETHEREUM_RPC_URL') },
    )
  } else if (signerMode === 'privy') {
    if (
      automaticExecution
      && (
        !requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_POLICY_ID')
        || !enabledEnv('POCKET_CONCIERGE_NFT_PRIVY_POLICY_CONFIRMED')
      )
    ) {
      throw new Error('Automatic Privy execution requires an attached, confirmed wallet policy.')
    }
    backend = new PrivyNftSignerBackend({
      appId: requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_ID'),
      appSecret: requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_APP_SECRET'),
      walletId: requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_WALLET_ID'),
      walletAddress: treasuryAddress,
      authorizationPrivateKey: requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_AUTHORIZATION_PRIVATE_KEY'),
      rpcUrl: requiredEnv('ETHEREUM_RPC_URL'),
    })
  } else {
    throw new Error('POCKET_CONCIERGE_NFT_SIGNER_MODE must be keystore or privy.')
  }
  if (getAddress(await backend.address()) !== getAddress(treasuryAddress)) {
    throw new Error('Signer address does not match the configured Pocket treasury.')
  }
  const signer = new NftHardenedSigner(
    requiredEnv('POCKET_CONCIERGE_NFT_SIGNER_DB_PATH'),
    backend,
  )
  const priorBroadcast = signer.findBroadcast(externalId, action)
  if (priorBroadcast) {
    try {
      const verified = await submitForVerification(
        baseUrl,
        externalId,
        action,
        operatorKey,
        priorBroadcast.transactionHash,
      )
      console.log(JSON.stringify({
        status: 'ledger_recovered_and_verified',
        action,
        externalId,
        planId: priorBroadcast.planId,
        transactionHash: priorBroadcast.transactionHash,
        orderState: verified?.order && typeof verified.order === 'object'
          ? (verified.order as Record<string, unknown>).state
          : undefined,
      }, null, 2))
      return
    } finally {
      signer.close()
    }
  }
  if (unbroadcastRecovery) {
    const authorization = signer.findAuthorization(externalId, action)
    if (authorization) {
      signer.close()
      throw new Error(
        `Signer ledger contains ${authorization.state} authorization ${authorization.planId}; `
        + 'recover its transaction outcome instead of releasing the API lease.',
      )
    }
    try {
      const recovered = await postJson(
        `${baseUrl}/v1/nft-mints/orders/${encodeURIComponent(externalId)}/recover-unbroadcast-mint`,
        { 'X-Operator-Key': operatorKey, 'X-Worker-Id': workerId },
      )
      console.log(JSON.stringify({
        status: 'unbroadcast_plan_recovered',
        action,
        externalId,
        recovery: recovered.recovery,
      }, null, 2))
      return
    } finally {
      signer.close()
    }
  }

  const raw = await postJson(
    `${baseUrl}/v1/nft-mints/orders/${encodeURIComponent(externalId)}/${planEndpoint(action)}`,
    { 'X-Operator-Key': operatorKey, 'X-Worker-Id': workerId },
  )
  const plan = validateAssistedNftPlan(raw, constraints)
  console.log(JSON.stringify({
    status: 'validated_not_signed',
    action,
    externalId,
    planId: plan.planId,
    chainId: plan.transaction.chainId,
    from: plan.transaction.from,
    to: plan.transaction.to,
    valueWei: plan.transaction.valueWei,
    gasLimit: plan.transaction.gasLimit,
    gasPriceCeilingWei: plan.transaction.maxFeePerGasWei,
    priorityFeeCeilingWei: plan.transaction.maxPriorityFeePerGasWei,
    nonce: plan.transaction.nonce,
    ...(plan.notBefore ? { notBefore: plan.notBefore } : {}),
    expiresAt: plan.expiresAt,
  }, null, 2))

  if (automaticExecution) {
    console.log(JSON.stringify({
      status: 'managed_policy_authorized',
      signerMode,
      policyId: requiredEnv('POCKET_CONCIERGE_NFT_PRIVY_POLICY_ID'),
      planId: plan.planId,
    }))
  } else {
    const prompt = createInterface({ input: stdin, output: stdout })
    try {
      const confirmation = await prompt.question(`Type ${plan.planId} to sign and broadcast: `)
      if (confirmation !== plan.planId) {
        throw new Error('Execution cancelled: plan ID was not confirmed exactly.')
      }
    } finally {
      prompt.close()
    }
  }

  try {
    await waitForExecutionWindow(plan.notBefore, plan.expiresAt)
    const result = await signer.execute(raw, constraints)
    const verified = await submitForVerification(
      baseUrl,
      externalId,
      action,
      operatorKey,
      result.transactionHash,
    )
    console.log(JSON.stringify({
      status: 'broadcast_and_verified',
      action,
      externalId,
      planId: result.planId,
      transactionHash: result.transactionHash,
      orderState: verified?.order && typeof verified.order === 'object'
        ? (verified.order as Record<string, unknown>).state
        : undefined,
    }, null, 2))
  } finally {
    signer.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
