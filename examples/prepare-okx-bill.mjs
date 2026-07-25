import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  bindingMatches,
  bodyBinding,
  buildPaymentCommandArgs,
  buildQuoteCommandArgs,
  findStatusProof,
  openJson,
  parseCliJson,
  parseUsdt,
  sealJson,
  selectQuote,
} from './okx-client-lib.mjs'

function argumentsFrom(argv) {
  const options = { approve: false, quote: false, confirmPayment: false, resumeVerification: false }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--approve') options.approve = true
    else if (value === '--quote') options.quote = true
    else if (value === '--confirm-payment') options.confirmPayment = true
    else if (value === '--resume-verification') options.resumeVerification = true
    else if (value === '--state') options.statePath = argv[++index]
    else if (value === '--selected-index') options.selectedIndex = Number(argv[++index])
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`)
    else positional.push(value)
  }
  options.missionPath = positional[0]
  options.privatePath = positional[1]
  return options
}

const options = argumentsFrom(process.argv.slice(2))
if (!options.missionPath || !options.privatePath) {
  console.error('Usage: node examples/prepare-okx-bill.mjs <mission.json> <private-inputs.json> [--approve] [--quote|--confirm-payment|--resume-verification --state <quote-state.json>]')
  process.exit(1)
}
if ([options.quote, options.confirmPayment, options.resumeVerification].filter(Boolean).length > 1) {
  throw new Error('Quote, payment confirmation, and verification recovery must be separate runs.')
}
if ((options.quote || options.confirmPayment || options.resumeVerification) && (!options.approve || !options.statePath)) {
  throw new Error('The selected operation requires --approve and --state.')
}

const baseUrl = String(process.env.CONCIERGE_BASE_URL || 'http://127.0.0.1:4310').replace(/\/$/, '')
const agentKey = String(process.env.POCKET_CONCIERGE_AGENT_KEY || '')
const bindingKey = String(process.env.POCKET_CONCIERGE_LOCAL_BINDING_KEY || agentKey)
if (!agentKey) throw new Error('Set POCKET_CONCIERGE_AGENT_KEY to your assigned bearer key.')
if (bindingKey.length < 24) throw new Error('Set POCKET_CONCIERGE_LOCAL_BINDING_KEY to a private value of at least 24 characters.')

const missionInput = JSON.parse(await readFile(options.missionPath, 'utf8'))
const privateInputs = JSON.parse(await readFile(options.privatePath, 'utf8'))

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agentKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(result)}`)
  return result
}

function onchainos(args, privateValues = []) {
  const executable = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos'
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.status !== 0) {
    let explanation = String(result.stderr || result.stdout || `exit ${result.status}`)
    for (const value of privateValues.filter(Boolean)) explanation = explanation.replaceAll(String(value), '[PRIVATE]')
    throw new Error(`Onchain OS failed: ${explanation.trim().slice(0, 800)}`)
  }
  return parseCliJson(result.stdout)
}

function unsignedState(state) {
  const { stateBinding, ...unsigned } = state
  return unsigned
}

async function saveState(path, state, exclusive = false) {
  const unsigned = unsignedState(state)
  const signed = { ...unsigned, stateBinding: bodyBinding(unsigned, bindingKey) }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(signed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: exclusive ? 'wx' : 'w',
  })
  return signed
}

async function loadState(path) {
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (!bindingMatches(unsignedState(state), bindingKey, state.stateBinding)) {
    throw new Error('The local quote state was modified or belongs to another binding key.')
  }
  return state
}

const created = await request('/v1/missions', missionInput)
const action = created.mission.actions[0]
if (!action || created.mission.actions.length !== 1) {
  throw new Error('This minimal client handles exactly one action per invocation.')
}
console.log(JSON.stringify({
  externalId: created.mission.externalId,
  manifestId: created.mission.manifestId,
  actionId: action.actionId,
  description: action.description,
  dueAt: action.dueAt,
  maximumUsdt: action.maximumUsdt,
  replayed: created.replayed,
}, null, 2))

if (!options.approve) {
  console.log('Preview only. Re-run with --approve after the user approves this exact manifest and maximum.')
  process.exit(0)
}

if (action.state === 'planned') {
  await request(
    `/v1/missions/${encodeURIComponent(created.mission.externalId)}/actions/${encodeURIComponent(action.actionId)}/approve`,
    { manifestId: created.mission.manifestId },
  )
} else if (action.state !== 'approved' && action.state !== 'executing') {
  throw new Error(`Action in ${action.state} state cannot prepare or resume payment.`)
}
const started = await request(
  `/v1/missions/${encodeURIComponent(created.mission.externalId)}/actions/${encodeURIComponent(action.actionId)}/start`,
  {},
)

const privateInput = privateInputs[action.privateInputRef]
if (!privateInput || typeof privateInput !== 'object' || Array.isArray(privateInput)) {
  throw new Error(`Private input ${action.privateInputRef} was not found in the local private-inputs file.`)
}
const merchantBody = {
  ...started.execution.request.publicBody,
  customerReference: String(privateInput.customerReference || ''),
  ...(privateInput.contactPhone ? { contactPhone: String(privateInput.contactPhone) } : {}),
  ...(privateInput.amountNgn ? { amountNgn: String(privateInput.amountNgn) } : {}),
}
if (!merchantBody.customerReference) throw new Error('customerReference is required.')
if (['electricity', 'tv'].includes(merchantBody.category) && !merchantBody.contactPhone) {
  throw new Error(`contactPhone is required for ${merchantBody.category}.`)
}
if (merchantBody.category === 'electricity' && !merchantBody.amountNgn) {
  throw new Error('amountNgn is required for electricity.')
}

const privateValues = [
  merchantBody.customerReference,
  merchantBody.contactPhone,
  merchantBody.amountNgn,
]

if (options.quote) {
  try {
    await readFile(options.statePath)
    throw new Error('The quote state path already exists. Use a new path; never overwrite payment state.')
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error
  }
  const quoteResult = onchainos(
    buildQuoteCommandArgs(started.execution.request.url, merchantBody),
    privateValues,
  )
  if (quoteResult?.ok !== true) throw new Error('Onchain OS did not return a successful quote response.')
  const quote = selectQuote(quoteResult.data, started.execution.safety.maximumUsdt, options.selectedIndex)
  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    conciergeBaseUrl: baseUrl,
    externalId: created.mission.externalId,
    manifestId: created.mission.manifestId,
    actionId: action.actionId,
    paymentId: quote.paymentId,
    acceptsIndex: quote.acceptsIndex,
    amountAtomic: quote.amountAtomic,
    amountHuman: quote.amountHuman,
    maximumUsdt: started.execution.safety.maximumUsdt,
    bodyBinding: bodyBinding(merchantBody, bindingKey),
    phase: 'quoted',
  }
  await saveState(options.statePath, state, true)
  console.log(JSON.stringify({
    protocol: 'OKX Agent Payments Protocol',
    requiresUserConfirmation: true,
    network: quote.network,
    token: quote.token,
    amount: `${quote.amountHuman} USDT`,
    atomicAmount: quote.amountAtomic,
    recipient: quote.recipient,
    maximumUsdt: started.execution.safety.maximumUsdt,
    walletWarning: quote.walletWarning,
    statePath: options.statePath,
    next: 'Review these exact details. If approved, run this client again with --approve --confirm-payment and the same --state file.',
  }, null, 2))
  process.exit(0)
}

if (options.confirmPayment) {
  const state = await loadState(options.statePath)
  if (
    state.version !== 1
    || state.conciergeBaseUrl !== baseUrl
    || state.externalId !== created.mission.externalId
    || state.manifestId !== created.mission.manifestId
    || state.actionId !== action.actionId
    || !bindingMatches(merchantBody, bindingKey, state.bodyBinding)
  ) {
    throw new Error('The confirmed quote state does not match this mission and private request.')
  }
  if (state.phase !== 'quoted') {
    throw new Error(`This payment is already in ${state.phase} state. Never pay it again; use --resume-verification if needed.`)
  }
  if (!Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) <= Date.now()) {
    throw new Error('The confirmed quote expired. Obtain a fresh quote; never reuse or repay the old paymentId.')
  }
  if (
    parseUsdt(state.amountHuman) !== BigInt(String(state.amountAtomic))
    || parseUsdt(state.amountHuman) > parseUsdt(started.execution.safety.maximumUsdt)
  ) {
    throw new Error('The bound quote amount is inconsistent with the approved maximum.')
  }
  const inProgressState = await saveState(options.statePath, {
    ...unsignedState(state),
    phase: 'payment_in_progress',
    confirmationRecordedAt: new Date().toISOString(),
  })
  const paid = onchainos(
    buildPaymentCommandArgs(state.paymentId, state.acceptsIndex, merchantBody),
    privateValues,
  )
  if (paid?.ok !== true || paid?.data?.status !== 'success') {
    const status = String(paid?.data?.status || 'unknown')
    let paymentError = String(paid?.data?.error || paid?.error || 'No payment error was returned.')
    for (const value of privateValues.filter(Boolean)) paymentError = paymentError.replaceAll(String(value), '[PRIVATE]')
    paymentError = paymentError.replace(/\s+/g, ' ').trim().slice(0, 500)
    await saveState(options.statePath, {
      ...unsignedState(inProgressState),
      phase: 'payment_failed',
      failedAt: new Date().toISOString(),
      paymentStatus: status,
      paymentError,
      txHash: paid?.data?.txHash || null,
    })
    throw new Error(`Payment did not complete successfully (status: ${status}): ${paymentError}. Do not retry this paymentId.`)
  }
  const receiptState = await saveState(options.statePath, {
    ...unsignedState(inProgressState),
    phase: 'paid_response_received',
    paidAt: new Date().toISOString(),
    txHash: paid.data.txHash || null,
  })
  const proof = findStatusProof(paid)
  if (!proof) throw new Error('Payment succeeded, but the Pocket Bills status proof was not found. Do not pay again.')
  const paidState = await saveState(options.statePath, {
    ...unsignedState(receiptState),
    phase: 'paid_pending_verification',
    encryptedStatusProof: sealJson(proof, bindingKey),
  })
  const mission = await request(started.execution.verification.path, proof)
  await saveState(options.statePath, {
    ...unsignedState(paidState),
    phase: mission.mission.state === 'delivered' ? 'delivered' : 'needs_review',
    completedAt: new Date().toISOString(),
    encryptedStatusProof: undefined,
  })
  console.log(JSON.stringify({
    ok: true,
    state: mission.mission.state,
    actionState: mission.mission.actions[0]?.state,
    evidence: mission.mission.actions[0]?.evidence,
    txHash: paid.data.txHash || null,
  }, null, 2))
  process.exit(0)
}

if (options.resumeVerification) {
  const state = await loadState(options.statePath)
  if (
    state.version !== 1
    || state.conciergeBaseUrl !== baseUrl
    || state.externalId !== created.mission.externalId
    || state.manifestId !== created.mission.manifestId
    || state.actionId !== action.actionId
    || !bindingMatches(merchantBody, bindingKey, state.bodyBinding)
    || state.phase !== 'paid_pending_verification'
  ) {
    throw new Error('No matching paid verification recovery is available. Never create a second payment.')
  }
  const proof = openJson(state.encryptedStatusProof, bindingKey)
  const mission = await request(started.execution.verification.path, proof)
  await saveState(options.statePath, {
    ...unsignedState(state),
    phase: mission.mission.state === 'delivered' ? 'delivered' : 'needs_review',
    completedAt: new Date().toISOString(),
    encryptedStatusProof: undefined,
  })
  console.log(JSON.stringify({
    ok: true,
    state: mission.mission.state,
    actionState: mission.mission.actions[0]?.state,
    evidence: mission.mission.actions[0]?.evidence,
    txHash: state.txHash || null,
  }, null, 2))
  process.exit(0)
}

console.log('Mission approved and execution prepared. Add --quote --state <path> to obtain the payment details.')
