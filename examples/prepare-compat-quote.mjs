import { readFile, writeFile } from 'node:fs/promises'
import { bodyBinding, parseUsdt } from './okx-client-lib.mjs'

const [missionPath, privatePath, statePath] = process.argv.slice(2)
if (!missionPath || !privatePath || !statePath) {
  throw new Error('Usage: node examples/prepare-compat-quote.mjs <mission.json> <private-inputs.json> <state.json>')
}
const baseUrl = String(process.env.CONCIERGE_BASE_URL || '').replace(/\/$/, '')
const agentKey = String(process.env.POCKET_CONCIERGE_AGENT_KEY || '')
const bindingKey = String(process.env.POCKET_CONCIERGE_LOCAL_BINDING_KEY || agentKey)
if (!baseUrl || !agentKey || bindingKey.length < 24) throw new Error('Concierge URL, agent key, and binding key are required.')

async function concierge(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${agentKey}` },
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Concierge request failed (${response.status}).`)
  return result
}

const missionInput = JSON.parse(await readFile(missionPath, 'utf8'))
const privateInputs = JSON.parse(await readFile(privatePath, 'utf8'))
const mission = (await concierge(`/v1/missions/${encodeURIComponent(missionInput.externalId)}`)).mission
const action = mission.actions[0]
if (!action || mission.actions.length !== 1 || action.state !== 'executing') {
  throw new Error('Exactly one executing mission action is required.')
}
const privateInput = privateInputs[action.privateInputRef]
if (!privateInput?.customerReference) throw new Error('The local private customer reference is missing.')
const merchantBody = {
  externalOrderId: action.downstreamExternalOrderId,
  category: action.category,
  serviceId: action.serviceId,
  variationCode: action.variationCode,
  customerReference: String(privateInput.customerReference),
  ...(privateInput.contactPhone ? { contactPhone: String(privateInput.contactPhone) } : {}),
  ...(privateInput.amountNgn ? { amountNgn: String(privateInput.amountNgn) } : {}),
}

const response = await fetch('https://bills.hashpaylink.com/v1/okx/bills', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(merchantBody),
})
if (response.status !== 402) {
  const errorBody = await response.json().catch(() => null)
  const code = typeof errorBody?.error === 'string'
    ? errorBody.error
    : typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'UNKNOWN'
  const message = typeof errorBody?.message === 'string'
    ? errorBody.message
    : typeof errorBody?.error?.message === 'string' ? errorBody.error.message : 'No safe error message returned.'
  throw new Error(`Expected HTTP 402, received ${response.status}: ${code} - ${message}`)
}
const unpaidBody = await response.json().catch(() => null)
const payload = response.headers.get('payment-required')
if (!payload) throw new Error('The HTTP 402 response omitted PAYMENT-REQUIRED.')
let challenge
try {
  challenge = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
} catch {
  challenge = JSON.parse(payload)
}
if (challenge.x402Version !== 2 || !Array.isArray(challenge.accepts) || challenge.accepts.length !== 1) {
  throw new Error('The fresh x402 challenge is not the expected single-candidate v2 form.')
}
const candidate = challenge.accepts[0]
if (
  candidate.scheme !== 'exact'
  || candidate.network !== 'eip155:196'
  || candidate.asset.toLowerCase() !== '0x779ded0c9e1022225f8e0630b35a9b54be713736'
  || candidate.payTo.toLowerCase() !== '0x988263a851afe17f8a827eda81269f9fb7553cbc'
  || BigInt(candidate.amount) <= 0n
  || BigInt(candidate.amount) > parseUsdt(action.maximumUsdt)
) {
  throw new Error('The fresh payment candidate violates the approved X Layer USDT policy.')
}
const amountHuman = `${BigInt(candidate.amount) / 1_000_000n}.${String(BigInt(candidate.amount) % 1_000_000n).padStart(6, '0')}`
const unsigned = {
  version: 1,
  mode: 'compat-sign-only',
  phase: 'quoted',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
  externalId: mission.externalId,
  manifestId: mission.manifestId,
  actionId: action.actionId,
  payload,
  acceptsIndex: 0,
  amountAtomic: String(candidate.amount),
  amountHuman,
  maximumUsdt: action.maximumUsdt,
  bodyBinding: bodyBinding(merchantBody, bindingKey),
  recipient: candidate.payTo,
}
await writeFile(statePath, `${JSON.stringify({
  ...unsigned,
  stateBinding: bodyBinding(unsigned, bindingKey),
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
console.log(JSON.stringify({
  requiresUserConfirmation: true,
  protocol: 'x402 exact via OKX Agentic Wallet',
  network: 'X Layer (eip155:196)',
  token: 'USDT',
  tokenAddress: candidate.asset,
  amount: `${amountHuman} USDT`,
  atomicAmount: String(candidate.amount),
  recipient: candidate.payTo,
  maximumUsdt: action.maximumUsdt,
  product: `${action.serviceId} / ${action.variationCode}`,
  mission: mission.externalId,
  quoteId: unpaidBody?.quote?.quoteId || null,
  quoteExpiresAt: unpaidBody?.quote?.expiresAt || null,
  expiresAt: unsigned.expiresAt,
}, null, 2))
