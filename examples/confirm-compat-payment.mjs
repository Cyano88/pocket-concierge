import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  bindingMatches,
  bodyBinding,
  findStatusProof,
  parseCliJson,
  parseUsdt,
  sealJson,
} from './okx-client-lib.mjs'

const [missionPath, privatePath, statePath] = process.argv.slice(2)
if (!missionPath || !privatePath || !statePath) {
  throw new Error('Usage: node examples/confirm-compat-payment.mjs <mission.json> <private-inputs.json> <state.json>')
}

const baseUrl = String(process.env.CONCIERGE_BASE_URL || '').replace(/\/$/, '')
const agentKey = String(process.env.POCKET_CONCIERGE_AGENT_KEY || '')
const bindingKey = String(process.env.POCKET_CONCIERGE_LOCAL_BINDING_KEY || agentKey)
if (!baseUrl || !agentKey) throw new Error('Concierge URL and agent key are required.')
if (bindingKey.length < 24) throw new Error('The local binding key must be at least 24 characters.')

function unsignedState(state) {
  const { stateBinding, ...unsigned } = state
  return unsigned
}

async function saveState(state) {
  const unsigned = unsignedState(state)
  const signed = { ...unsigned, stateBinding: bodyBinding(unsigned, bindingKey) }
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(signed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w',
  })
  return signed
}

async function loadState() {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  if (!bindingMatches(unsignedState(state), bindingKey, state.stateBinding)) {
    throw new Error('The local compatibility state failed authentication.')
  }
  return state
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${agentKey}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(`${path} failed (${response.status})`)
    error.status = response.status
    error.result = result
    throw error
  }
  return result
}

function decodePaymentResponse(value) {
  if (!value) return null
  for (const encoding of ['base64url', 'base64']) {
    try {
      return JSON.parse(Buffer.from(value, encoding).toString('utf8'))
    } catch {}
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function findTxHash(value, depth = 0) {
  if (!value || depth > 8) return null
  if (typeof value === 'string') return /^0x[a-fA-F0-9]{64}$/.test(value) ? value : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTxHash(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:txHash|transactionHash|transaction)$/i.test(key) && typeof item === 'string' && /^0x[a-fA-F0-9]{64}$/.test(item)) {
      return item
    }
    const found = findTxHash(item, depth + 1)
    if (found) return found
  }
  return null
}

async function replay(url, headerName, authorizationHeader, merchantBody) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [headerName]: authorizationHeader,
        },
        body: JSON.stringify(merchantBody),
      })
    } catch (error) {
      lastError = error
      if (attempt === 0) continue
    }
  }
  throw lastError
}

const state = await loadState()
if (state.mode !== 'compat-sign-only' || state.phase !== 'quoted') {
  throw new Error(`Compatibility state is ${state.phase}; never sign or pay it again.`)
}
if (!Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) <= Date.now()) {
  throw new Error('The confirmed compatibility challenge expired. Obtain and confirm a fresh challenge.')
}

const missionInput = JSON.parse(await readFile(missionPath, 'utf8'))
const privateInputs = JSON.parse(await readFile(privatePath, 'utf8'))
const loaded = await request(`/v1/missions/${encodeURIComponent(state.externalId)}`)
const mission = loaded.mission
const action = mission?.actions?.find(item => item.actionId === state.actionId)
if (!mission || !action) throw new Error('The bound Concierge mission action was not found.')
const privateInput = privateInputs[action.privateInputRef]
if (!privateInput || typeof privateInput !== 'object' || Array.isArray(privateInput)) {
  throw new Error('The bound private input was not found.')
}
const merchantBody = {
  externalOrderId: action.downstreamExternalOrderId,
  category: action.category,
  serviceId: action.serviceId,
  variationCode: action.variationCode,
  customerReference: String(privateInput.customerReference || ''),
  ...(privateInput.contactPhone ? { contactPhone: String(privateInput.contactPhone) } : {}),
  ...(privateInput.amountNgn ? { amountNgn: String(privateInput.amountNgn) } : {}),
}
if (
  mission.externalId !== missionInput.externalId
  || mission.manifestId !== state.manifestId
  || action.state !== 'executing'
  || !merchantBody.customerReference
  || !bindingMatches(merchantBody, bindingKey, state.bodyBinding)
  || parseUsdt(state.amountHuman) !== BigInt(String(state.amountAtomic))
  || parseUsdt(state.amountHuman) > parseUsdt(state.maximumUsdt)
) {
  throw new Error('The confirmed compatibility challenge no longer matches the approved action.')
}

const inProgress = await saveState({
  ...unsignedState(state),
  phase: 'payment_in_progress',
  confirmationRecordedAt: new Date().toISOString(),
})

const executable = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos'
let signedResult
for (let attempt = 0; attempt < 6; attempt += 1) {
  signedResult = spawnSync(executable, [
    'payment',
    'pay',
    '--payload',
    state.payload,
    '--selected-index',
    String(state.acceptsIndex),
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (signedResult.status === 0) break
  const preSignError = String(signedResult.stderr || signedResult.stdout || '')
  const retryablePreSignTransportFailure = (
    preSignError.includes('BadRecordMac')
    || preSignError.includes('error sending request')
  ) && (
    preSignError.includes('gen-msg-hash')
    || preSignError.includes('/auth/refresh')
  )
  if (!retryablePreSignTransportFailure) break
}
if (!signedResult || signedResult.status !== 0) {
  const rawFailure = String(signedResult?.stderr || signedResult?.stdout || 'unknown signing failure')
  const safeFailure = rawFailure
    .replaceAll(state.payload, '[PAYMENT-REQUIRED]')
    .replaceAll(merchantBody.customerReference, '[PRIVATE]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
  await saveState({
    ...unsignedState(inProgress),
    phase: 'payment_failed',
    failedAt: new Date().toISOString(),
    paymentError: safeFailure || 'Onchain OS did not create a signed authorization.',
  })
  throw new Error('Onchain OS did not create a signed authorization. Never reuse this state.')
}
const signed = parseCliJson(signedResult.stdout)
const signedData = signed?.data || signed
const authorizationHeader = signedData?.authorization_header
const headerName = signedData?.header_name
if (signed?.ok === false || typeof authorizationHeader !== 'string' || typeof headerName !== 'string') {
  await saveState({
    ...unsignedState(inProgress),
    phase: 'payment_failed',
    failedAt: new Date().toISOString(),
    paymentError: 'Onchain OS returned no usable signed authorization.',
  })
  throw new Error('Onchain OS returned no usable signed authorization. Never reuse this state.')
}

let response
try {
  response = await replay('https://bills.hashpaylink.com/v1/okx/bills', headerName, authorizationHeader, merchantBody)
} catch {
  await saveState({
    ...unsignedState(inProgress),
    phase: 'payment_ambiguous',
    failedAt: new Date().toISOString(),
    paymentError: 'No HTTP response after one transport-only replay retry.',
  })
  throw new Error('The signed replay returned no HTTP response. Payment state is ambiguous; do not pay again.')
}
const responseBody = await response.json().catch(() => null)
const paymentResponse = decodePaymentResponse(response.headers.get('payment-response'))
const txHash = findTxHash(responseBody) || findTxHash(paymentResponse)
if (response.status !== 200 && response.status !== 202) {
  await saveState({
    ...unsignedState(inProgress),
    phase: 'payment_failed',
    failedAt: new Date().toISOString(),
    paymentHttpStatus: response.status,
    paymentError: String(responseBody?.message || responseBody?.error || 'Paid replay was rejected.').slice(0, 300),
    txHash,
  })
  throw new Error(`Paid replay was rejected with HTTP ${response.status}. Do not replay or pay again.`)
}

const proof = findStatusProof(responseBody)
if (!proof) {
  await saveState({
    ...unsignedState(inProgress),
    phase: 'paid_response_missing_proof',
    paidAt: new Date().toISOString(),
    txHash,
  })
  throw new Error('The paid replay succeeded but returned no status proof. Do not pay again.')
}
const pending = await saveState({
  ...unsignedState(inProgress),
  phase: 'paid_pending_verification',
  paidAt: new Date().toISOString(),
  txHash,
  encryptedStatusProof: sealJson(proof, bindingKey),
})

let verified
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    verified = await request(
      `/v1/missions/${encodeURIComponent(mission.externalId)}/actions/${encodeURIComponent(action.actionId)}/verify`,
      { method: 'POST', body: proof },
    )
    break
  } catch (error) {
    if (error.status !== 409 || attempt === 2) throw error
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

const finalMission = verified.mission
const finalAction = finalMission.actions.find(item => item.actionId === action.actionId)
const finalPhase = finalMission.state === 'delivered' ? 'delivered' : 'needs_review'
await saveState({
  ...unsignedState(pending),
  phase: finalPhase,
  completedAt: new Date().toISOString(),
  encryptedStatusProof: undefined,
})
if (!finalAction?.authorityReceiptId) throw new Error('Verification returned no authority receipt.')
const publicReceiptResponse = await fetch(
  `${baseUrl}/v1/authority/receipts/${encodeURIComponent(finalAction.authorityReceiptId)}`,
)
const publicReceipt = await publicReceiptResponse.json().catch(() => null)
if (!publicReceiptResponse.ok || publicReceipt?.receipt?.verification?.valid !== true) {
  throw new Error('The public authority receipt could not be recomputed as valid.')
}
const leaked = JSON.stringify(publicReceipt).includes(merchantBody.customerReference)
  || JSON.stringify(publicReceipt).includes(proof.statusToken)
if (leaked) throw new Error('Private payment data leaked into the public authority receipt.')

console.log(JSON.stringify({
  ok: finalMission.state === 'delivered',
  missionState: finalMission.state,
  actionState: finalAction.state,
  settlementId: finalAction.evidence?.settlementId || null,
  downstreamReceiptHash: finalAction.evidence?.receiptHash || null,
  txHash,
  authorityReceiptId: finalAction.authorityReceiptId,
  authorityReceiptHash: publicReceipt.receipt.receiptHash,
  authorityReceiptValid: true,
  authorityReceiptPrivateDataCheck: 'passed',
  authorityReceiptUrl: `${baseUrl}/v1/authority/receipts/${finalAction.authorityReceiptId}`,
}, null, 2))
