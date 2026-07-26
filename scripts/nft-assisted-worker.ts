import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  validateAssistedNftPlan,
  type AssistedNftAction,
  type ValidatedAssistedPlan,
} from '../src/nft-assisted-worker.js'

const ACTIONS = new Set<AssistedNftAction>(['mint', 'deliver', 'refund'])

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function parseJsonOutput(stdout: string) {
  const candidates = stdout.trim().split(/\r?\n/).reverse()
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as Record<string, unknown>
    } catch {}
  }
  throw new Error('Onchain OS did not return parseable JSON.')
}

function dataOf(payload: Record<string, unknown>) {
  return payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : payload
}

function readableError(result: ReturnType<typeof spawnSync>) {
  try {
    const payload = dataOf(parseJsonOutput(String(result.stdout || '')))
    for (const field of ['message', 'error', 'reason']) {
      if (typeof payload[field] === 'string' && payload[field]) return payload[field]
    }
  } catch {}
  return `Onchain OS exited with status ${result.status ?? 'unknown'}.`
}

function transactionHash(value: unknown): string | undefined {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = transactionHash(item)
      if (found) return found
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const field of ['txHash', 'transactionHash', 'hash']) {
      const found = transactionHash(record[field])
      if (found) return found
    }
    for (const item of Object.values(record)) {
      const found = transactionHash(item)
      if (found) return found
    }
  }
  return undefined
}

function printSafeWalletResult(payload: Record<string, unknown>) {
  const data = dataOf(payload)
  const hash = transactionHash(data)
  console.log(JSON.stringify({
    status: typeof data.status === 'string' ? data.status : 'submitted',
    ...(hash ? { transactionHash: hash } : {}),
  }, null, 2))
}

function onchainos(args: string[]) {
  const executable = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos'
  return spawnSync(executable, args, { encoding: 'utf8', windowsHide: true })
}

function endpoint(action: AssistedNftAction) {
  return action === 'mint' ? 'prepare' : action === 'deliver' ? 'delivery-plan' : 'refund'
}

function summarize(plan: ValidatedAssistedPlan, securityAction: string) {
  return {
    status: 'validated_not_broadcast',
    action: plan.action,
    externalId: plan.externalId,
    planId: plan.planId,
    chainId: plan.transaction.chainId,
    from: plan.transaction.from,
    to: plan.transaction.to,
    valueWei: plan.transaction.valueWei,
    gasLimit: plan.transaction.gasLimit,
    maxFeePerGasWei: plan.transaction.maxFeePerGasWei,
    expiresAt: plan.expiresAt,
    securityAction: securityAction || 'safe',
  }
}

async function fetchPlan(
  baseUrl: string,
  externalId: string,
  action: AssistedNftAction,
  operatorKey: string,
) {
  const response = await fetch(
    `${baseUrl}/v1/nft-mints/orders/${encodeURIComponent(externalId)}/${endpoint(action)}`,
    { method: 'POST', headers: { 'X-Operator-Key': operatorKey } },
  )
  const payload = await response.json().catch(() => ({ error: 'non_json_response' }))
  if (!response.ok) throw new Error(`Pocket rejected plan preparation (HTTP ${response.status}): ${JSON.stringify(payload)}`)
  return payload
}

function scan(plan: ValidatedAssistedPlan) {
  const result = onchainos([
    'security',
    'tx-scan',
    '--chain',
    'ethereum',
    '--from',
    plan.transaction.from,
    '--to',
    plan.transaction.to,
    '--data',
    plan.transaction.data,
    '--value',
    plan.transaction.valueWei,
    '--gas',
    plan.transaction.gasLimit,
    '--gas-price',
    plan.transaction.maxFeePerGasWei,
  ])
  if (result.status !== 0) {
    throw new Error(`Security scan failed closed: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
  const payload = dataOf(parseJsonOutput(result.stdout))
  const action = typeof payload.action === 'string' ? payload.action : ''
  if (action === 'block') throw new Error(`Security scan blocked the transaction: ${JSON.stringify(payload.riskItemDetail ?? [])}`)
  if (action !== '' && action !== 'warn') throw new Error(`Security scan returned an unknown action: ${action}`)
  return action
}

function contractArguments(plan: ValidatedAssistedPlan) {
  return [
    'wallet',
    'contract-call',
    '--chain',
    'ethereum',
    '--from',
    plan.transaction.from,
    '--to',
    plan.transaction.to,
    '--amt',
    plan.transaction.valueWei,
    '--input-data',
    plan.transaction.data,
    '--gas-limit',
    plan.transaction.gasLimit,
    '--biz-type',
    'dapp',
    '--strategy',
    'pocket-nft-assisted-worker',
  ]
}

async function main() {
  const action = process.argv[2] as AssistedNftAction | undefined
  const externalId = process.argv[3]
  const execute = process.argv.includes('--execute')
  if (!action || !ACTIONS.has(action) || !externalId) {
    throw new Error('Usage: npm run nft:worker -- <mint|deliver|refund> <externalId> [--execute]')
  }

  const baseUrl = requiredEnv('POCKET_CONCIERGE_URL').replace(/\/$/, '')
  const operatorKey = requiredEnv('POCKET_CONCIERGE_NFT_OPERATOR_KEY')
  const treasuryAddress = requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS')
  const maximumFeePerGasWei = requiredEnv('POCKET_CONCIERGE_NFT_WORKER_MAX_FEE_PER_GAS_WEI')
  const raw = await fetchPlan(baseUrl, externalId, action, operatorKey)
  const plan = validateAssistedNftPlan(raw, {
    action,
    externalId,
    treasuryAddress,
    maximumFeePerGasWei,
  })
  const securityAction = scan(plan)
  console.log(JSON.stringify(summarize(plan, securityAction), null, 2))
  if (!execute) return

  const prompt = createInterface({ input, output })
  try {
    const approval = await prompt.question(`Type ${plan.planId} to request wallet confirmation: `)
    if (approval !== plan.planId) throw new Error('Execution cancelled: plan ID was not confirmed exactly.')
    if (Date.parse(plan.expiresAt) - Date.now() < 5_000) throw new Error('Execution cancelled: plan expired before wallet confirmation.')

    const args = contractArguments(plan)
    const first = onchainos(args)
    if (first.status === 0) {
      printSafeWalletResult(parseJsonOutput(first.stdout))
      return
    }
    if (first.status !== 2) throw new Error(`Wallet rejected the transaction request: ${readableError(first)}`)

    const confirmationPayload = parseJsonOutput(first.stdout)
    const confirmation = dataOf(confirmationPayload)
    if (confirmation.confirming !== true) throw new Error('Wallet did not return a recognized confirmation request.')
    if (typeof confirmation.message === 'string' && confirmation.message) {
      console.log(confirmation.message)
    }
    const finalApproval = await prompt.question(`Type CONFIRM ${plan.planId} to broadcast this exact plan: `)
    if (finalApproval !== `CONFIRM ${plan.planId}`) throw new Error('Execution cancelled before broadcast.')
    if (Date.parse(plan.expiresAt) - Date.now() < 2_000) throw new Error('Execution cancelled: plan expired before broadcast.')

    const forced = onchainos([...args, '--force'])
    if (forced.status !== 0) throw new Error(`Wallet broadcast failed: ${readableError(forced)}`)
    printSafeWalletResult(parseJsonOutput(forced.stdout))
  } finally {
    prompt.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
