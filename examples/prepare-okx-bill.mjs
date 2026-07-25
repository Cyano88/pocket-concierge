import { readFile } from 'node:fs/promises'

const [missionPath, privatePath] = process.argv.slice(2).filter(value => !value.startsWith('--'))
const approve = process.argv.includes('--approve')
if (!missionPath || !privatePath) {
  console.error('Usage: node examples/prepare-okx-bill.mjs <mission.json> <private-inputs.json> [--approve]')
  process.exit(1)
}

const baseUrl = String(process.env.CONCIERGE_BASE_URL || 'http://127.0.0.1:4310').replace(/\/$/, '')
const agentKey = String(process.env.POCKET_CONCIERGE_AGENT_KEY || '')
if (!agentKey) throw new Error('Set POCKET_CONCIERGE_AGENT_KEY to your assigned bearer key.')

const missionInput = JSON.parse(await readFile(missionPath, 'utf8'))
const privateInputs = JSON.parse(await readFile(privatePath, 'utf8'))

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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

const created = await request('/v1/missions', missionInput)
const action = created.mission.actions[0]
if (!action || created.mission.actions.length !== 1) {
  throw new Error('This minimal client prepares exactly one action at a time.')
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

if (!approve) {
  console.log('Preview only. Re-run with --approve after the user approves this exact manifest and maximum.')
  process.exit(0)
}

await request(
  `/v1/missions/${encodeURIComponent(created.mission.externalId)}/actions/${encodeURIComponent(action.actionId)}/approve`,
  { manifestId: created.mission.manifestId },
)
const started = await request(
  `/v1/missions/${encodeURIComponent(created.mission.externalId)}/actions/${encodeURIComponent(action.actionId)}/start`,
  {},
)

const privateInput = privateInputs[action.privateInputRef]
if (!privateInput || typeof privateInput !== 'object' || Array.isArray(privateInput)) {
  throw new Error(`Private input ${action.privateInputRef} was not found in the local private-inputs file.`)
}
const body = {
  ...started.execution.request.publicBody,
  customerReference: String(privateInput.customerReference || ''),
  ...(privateInput.contactPhone ? { contactPhone: String(privateInput.contactPhone) } : {}),
  ...(privateInput.amountNgn ? { amountNgn: String(privateInput.amountNgn) } : {}),
}
if (!body.customerReference) throw new Error('customerReference is required.')
if (['electricity', 'tv'].includes(body.category) && !body.contactPhone) {
  throw new Error(`contactPhone is required for ${body.category}.`)
}
if (body.category === 'electricity' && !body.amountNgn) {
  throw new Error('amountNgn is required for electricity.')
}

const params = Object.entries(body).flatMap(([key, value]) => ['--param', `${key}=${value}`])
const renderedParams = Object.entries(body)
  .map(([key, value]) => `--param ${shellQuote(`${key}=${value}`)}`)
  .join(' ')
const quoteCommand = `onchainos payment quote ${shellQuote(started.execution.request.url)} --method POST ${renderedParams}`
const payTemplate = `onchainos payment pay --payment-id ${shellQuote('<PAYMENT_ID>')} --selected-index 0 ${renderedParams}`

console.log(JSON.stringify({
  next: 'quote',
  requiresUserConfirmation: true,
  maximumUsdt: started.execution.safety.maximumUsdt,
  exactArgumentVector: ['payment', 'quote', started.execution.request.url, '--method', 'POST', ...params],
  quoteCommand,
  afterQuote: [
    'Read the exact quoted USDT amount.',
    `Stop if it exceeds ${started.execution.safety.maximumUsdt} USDT.`,
    'Show the amount and recipient service to the user.',
    'Run the pay command without --yes first; Onchain OS will stop at its confirmation gate.',
    'Only add --yes after the user explicitly confirms.',
  ],
  payTemplate,
  verificationEndpoint: started.execution.verification.path,
}, null, 2))
