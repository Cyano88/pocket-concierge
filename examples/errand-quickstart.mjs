const baseUrl = String(
  process.env.POCKET_CONCIERGE_URL
  || 'https://pocket-concierge-production.up.railway.app',
).replace(/\/$/, '')
const apiKey = String(process.env.POCKET_CONCIERGE_AGENT_KEY || '').trim()

if (!apiKey) {
  throw new Error('Set POCKET_CONCIERGE_AGENT_KEY to your agent API key.')
}

const now = Date.now()
const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14)
const input = {
  externalId: `quickstart-${stamp}`,
  cycleId: `cycle-${stamp}`,
  title: 'Renew Mum MTN data',
  timezone: 'Africa/Lagos',
  dueAt: new Date(now + 30 * 60_000).toISOString(),
  errand: {
    category: 'data',
    serviceId: 'mtn-data',
    variationCode: 'mtn-10mb-100',
    privateInputRef: 'family-mum-mobile',
    maximumUsdt: '0.25',
  },
  mandate: {
    validFrom: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    approvalThresholdUsdt: '0.25',
  },
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`)
  return result
}

const created = await post('/v1/errands', input)
const next = created.errand?.nextAction
if (next?.type !== 'authorize_manifest' || !next.path || !next.manifestId) {
  throw new Error(`Unexpected create result: ${JSON.stringify(created)}`)
}

const authorized = await post(next.path, { manifestId: next.manifestId })
console.log(JSON.stringify({
  message: 'Errand authorized. Resolve privateInputRef locally, quote, confirm, and pay the returned provider request.',
  errand: authorized.errand,
}, null, 2))
