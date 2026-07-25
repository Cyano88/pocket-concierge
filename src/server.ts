import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { authenticate, parseAgentKeys } from './auth.js'
import { ConciergeError } from './errors.js'
import { ConciergeService, fetchJson } from './service.js'
import { MemoryMissionStore } from './store.js'

const PORT = Number(process.env.PORT || 4310)
const keys = parseAgentKeys(process.env.POCKET_CONCIERGE_AGENT_KEYS)
const service = new ConciergeService({
  store: new MemoryMissionStore(),
  now: () => Date.now(),
  fetchJson,
})

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new ConciergeError('BODY_TOO_LARGE', 'Request body exceeds 64 KiB.', 413)
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ConciergeError('JSON_INVALID', 'Request body must be valid JSON.')
  }
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || 'GET'
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'pocket-concierge' })
    if (method === 'GET' && url.pathname === '/v1/contract') {
      return json(res, 200, {
        ok: true,
        service: 'Pocket Concierge',
        role: 'buyer-agent-orchestrator',
        supportedActions: ['okx_bill'],
        lifecycle: ['planned', 'approved', 'executing', 'delivered', 'needs_review'],
        paymentCustody: false,
        privacy: {
          accepts: ['opaque privateInputRef', 'provider service identifiers', 'maximum USDT'],
          rejects: ['phone number', 'meter number', 'smartcard number', 'wallet key', 'Prava credential'],
        },
        plannedHackathonExtension: {
          action: 'prava_shop',
          status: 'not-implemented-before-event',
        },
      })
    }
    if (!keys.size) throw new ConciergeError('SERVICE_NOT_CONFIGURED', 'Pocket Concierge agent keys are not configured.', 503)
    const ownerId = authenticate(req.headers.authorization, keys)
    if (method === 'POST' && url.pathname === '/v1/missions/preview') return json(res, 200, { ok: true, mission: service.preview(ownerId, await body(req)) })
    if (method === 'POST' && url.pathname === '/v1/missions') return json(res, 201, { ok: true, ...(await service.create(ownerId, await body(req))) })

    const missionMatch = url.pathname.match(/^\/v1\/missions\/([^/]+)$/)
    if (method === 'GET' && missionMatch?.[1]) return json(res, 200, { ok: true, mission: await service.get(ownerId, decodeURIComponent(missionMatch[1])) })

    const actionMatch = url.pathname.match(/^\/v1\/missions\/([^/]+)\/actions\/([^/]+)\/(approve|start|verify)$/)
    if (method === 'POST' && actionMatch?.[1] && actionMatch[2] && actionMatch[3]) {
      const externalId = decodeURIComponent(actionMatch[1])
      const actionId = decodeURIComponent(actionMatch[2])
      const requestBody = await body(req)
      if (actionMatch[3] === 'approve') {
        const input = requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)
          ? requestBody as Record<string, unknown>
          : {}
        const manifestId = String(input.manifestId ?? '')
        return json(res, 200, { ok: true, mission: await service.approve(ownerId, externalId, actionId, manifestId) })
      }
      if (actionMatch[3] === 'start') return json(res, 200, { ok: true, execution: await service.start(ownerId, externalId, actionId) })
      return json(res, 200, { ok: true, mission: await service.verify(ownerId, externalId, actionId, requestBody) })
    }
    return json(res, 404, { ok: false, error: 'Route not found.' })
  } catch (error) {
    const known = error instanceof ConciergeError ? error : new ConciergeError('INTERNAL_ERROR', 'Unexpected server error.', 500)
    return json(res, known.status, { ok: false, error: known.code, message: known.message })
  }
})

server.listen(PORT, () => {
  console.log(`Pocket Concierge listening on ${PORT}`)
})
