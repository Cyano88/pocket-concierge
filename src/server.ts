import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { getAddress, isAddress } from 'viem'
import { authenticate, parseAgentKeys } from './auth.js'
import {
  evaluatePaidAuthorityCheck,
  OKX_AUTHORITY_CHECK_FEE_ATOMIC,
  OKX_AUTHORITY_CHECK_OUTPUT_SCHEMA,
  OKX_AUTHORITY_CHECK_ROUTE,
} from './authority-check.js'
import { errandToMissionInput, errandView } from './errands.js'
import { ConciergeError } from './errors.js'
import { buildOkxAuthorityProof, OKX_AUTHORITY_PROOF_ROUTE } from './okx-proof.js'
import { ConciergeService, fetchJson } from './service.js'
import { MemoryMissionStore, SqliteMissionStore } from './store.js'
import { OkxAuthorityProofProtector, OkxPaidRouteProtector } from './x402-proof.js'
import { EthereumNftChainGateway } from './nft-chain.js'
import {
  NFT_MINT_ORDER_OUTPUT_SCHEMA,
  NFT_MINT_ORDER_ROUTE,
  NFT_MINT_SERVICE_FEE_ATOMIC,
  NftMintService,
} from './nft-mints.js'
import { MemoryNftMintStore, SqliteNftMintStore } from './nft-store.js'

const PORT = Number(process.env.PORT || 4310)
const keys = parseAgentKeys(process.env.POCKET_CONCIERGE_AGENT_KEYS)
const databasePath = String(process.env.POCKET_CONCIERGE_DB_PATH || '').trim()
const publicUrl = String(
  process.env.POCKET_CONCIERGE_PUBLIC_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`),
).replace(/\/$/, '')
const proofReceiptId = String(process.env.POCKET_CONCIERGE_DEMO_RECEIPT_ID || '').trim()
const proofTransaction = String(process.env.POCKET_CONCIERGE_DEMO_TX_HASH || '').trim()
const proofPayTo = String(process.env.POCKET_CONCIERGE_OKX_PAY_TO || '').trim()
const paidRouteConfig = (
  process.env.OKX_API_KEY
  && process.env.OKX_SECRET_KEY
  && process.env.OKX_PASSPHRASE
  && proofPayTo
)
  ? {
      apiKey: process.env.OKX_API_KEY,
      secretKey: process.env.OKX_SECRET_KEY,
      passphrase: process.env.OKX_PASSPHRASE,
      payTo: proofPayTo,
      publicUrl,
    }
  : null
const proofProtector = paidRouteConfig ? new OkxAuthorityProofProtector(paidRouteConfig) : null
const authorityCheckProtector = paidRouteConfig
  ? new OkxPaidRouteProtector(paidRouteConfig, {
      method: 'POST',
      path: OKX_AUTHORITY_CHECK_ROUTE,
      amountAtomic: OKX_AUTHORITY_CHECK_FEE_ATOMIC,
      description: 'Deterministic APPROVE, ESCALATE, or BLOCK decision for one privacy-safe proposed purchase.',
      serviceName: 'Purchase Authority Check',
      tags: ['authority', 'spending', 'commerce', 'policy', 'xlayer'],
      outputSchema: OKX_AUTHORITY_CHECK_OUTPUT_SCHEMA,
    })
  : null
function configuredInteger(raw: string | undefined, fallback: number, name: string, minimum: number, maximum: number) {
  const value = Number(raw ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConciergeError('NFT_CONFIG_INVALID', `${name} is outside its safe integer range.`, 500)
  }
  return value
}

function configuredBigInt(raw: string | undefined, fallback: string, name: string, minimum: bigint) {
  const source = String(raw ?? fallback)
  if (!/^[1-9][0-9]*$/.test(source)) {
    throw new ConciergeError('NFT_CONFIG_INVALID', `${name} must be a positive decimal integer.`, 500)
  }
  const value = BigInt(source)
  if (value < minimum) throw new ConciergeError('NFT_CONFIG_INVALID', `${name} is below its safe minimum.`, 500)
  return value
}

function validEthereumRpcUrl(raw: string) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
  } catch {
    return false
  }
}

const nftEnabled = String(process.env.POCKET_CONCIERGE_NFT_MINT_ENABLED || '').toLowerCase() === 'true'
const nftRpcUrl = String(process.env.ETHEREUM_RPC_URL || '').trim()
const nftTreasuryRaw = String(process.env.POCKET_CONCIERGE_NFT_TREASURY_ADDRESS || '').trim()
const nftOrderTokenSecret = String(process.env.POCKET_CONCIERGE_NFT_ORDER_TOKEN_SECRET || '').trim()
const nftOperatorKey = String(process.env.POCKET_CONCIERGE_NFT_OPERATOR_KEY || '').trim()
const nftConfigComplete = Boolean(
  nftEnabled
  && paidRouteConfig
  && databasePath
  && nftRpcUrl
  && validEthereumRpcUrl(nftRpcUrl)
  && isAddress(nftTreasuryRaw, { strict: true })
  && nftTreasuryRaw.toLowerCase() !== '0x0000000000000000000000000000000000000000'
  && nftOrderTokenSecret.length >= 32
  && nftOperatorKey.length >= 32
  && nftOrderTokenSecret !== nftOperatorKey
)
const nftService = nftConfigComplete
  ? new NftMintService({
      store: databasePath ? new SqliteNftMintStore(databasePath) : new MemoryNftMintStore(),
      chain: new EthereumNftChainGateway(nftRpcUrl),
      treasuryAddress: getAddress(nftTreasuryRaw),
      minimumConfirmations: configuredInteger(
        process.env.POCKET_CONCIERGE_NFT_MIN_CONFIRMATIONS,
        2,
        'POCKET_CONCIERGE_NFT_MIN_CONFIRMATIONS',
        1,
        64,
      ),
      planTtlSeconds: configuredInteger(
        process.env.POCKET_CONCIERGE_NFT_PLAN_TTL_SECONDS,
        30,
        'POCKET_CONCIERGE_NFT_PLAN_TTL_SECONDS',
        10,
        120,
      ),
      deliveryGasLimit: configuredBigInt(
        process.env.POCKET_CONCIERGE_NFT_DELIVERY_GAS_LIMIT,
        '120000',
        'POCKET_CONCIERGE_NFT_DELIVERY_GAS_LIMIT',
        50_000n,
      ),
      refundGasLimit: configuredBigInt(
        process.env.POCKET_CONCIERGE_NFT_REFUND_GAS_LIMIT,
        '21000',
        'POCKET_CONCIERGE_NFT_REFUND_GAS_LIMIT',
        21_000n,
      ),
      maximumOrderWei: configuredBigInt(
        process.env.POCKET_CONCIERGE_NFT_MAX_ORDER_WEI,
        '100000000000000000',
        'POCKET_CONCIERGE_NFT_MAX_ORDER_WEI',
        1n,
      ),
      orderTokenSecret: nftOrderTokenSecret,
      now: () => Date.now(),
    })
  : null
const nftOrderProtector = nftConfigComplete && paidRouteConfig
  ? new OkxPaidRouteProtector(paidRouteConfig, {
      method: 'POST',
      path: NFT_MINT_ORDER_ROUTE,
      amountAtomic: NFT_MINT_SERVICE_FEE_ATOMIC,
      description: 'Create one bounded Ethereum public-mint errand with verified funding and NFT delivery.',
      serviceName: 'Pocket NFT Mint & Deliver',
      tags: ['nft', 'mint', 'opensea', 'seadrop', 'ethereum', 'delivery'],
      outputSchema: NFT_MINT_ORDER_OUTPUT_SCHEMA,
    })
  : null
const service = new ConciergeService({
  store: databasePath ? new SqliteMissionStore(databasePath) : new MemoryMissionStore(),
  now: () => Date.now(),
  fetchJson,
})

function json(res: ServerResponse, status: number, responseBody: unknown, headers?: Headers) {
  res.statusCode = status
  headers?.forEach((value, name) => res.setHeader(name, value))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(responseBody))
}

async function sendResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

function fetchHeaders(req: IncomingMessage) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item))
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
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

function bearer(value: string | undefined) {
  return String(value ?? '').replace(/^Bearer\s+/i, '')
}

function requireNftOperator(value: string | undefined) {
  const supplied = Buffer.from(String(value ?? ''))
  const expected = Buffer.from(nftOperatorKey)
  if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ConciergeError('NFT_OPERATOR_UNAUTHORIZED', 'A valid NFT execution-operator key is required.', 401)
  }
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || 'GET'
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: 'pocket-concierge' })
    if (method === 'GET' && url.pathname === OKX_AUTHORITY_PROOF_ROUTE) {
      if (!proofProtector || !proofReceiptId || !proofTransaction) {
        throw new ConciergeError('OKX_PROOF_NOT_CONFIGURED', 'The OKX authority proof is not configured.', 503)
      }
      const payment = await proofProtector.protect(new Request(`${publicUrl}${url.pathname}${url.search}`, {
        method: 'GET',
        headers: fetchHeaders(req),
      }))
      if (payment.status === 'challenge') return sendResponse(res, payment.response)
      const receipt = await service.getReceipt(proofReceiptId)
      if (!receipt) throw new ConciergeError('OKX_PROOF_NOT_FOUND', 'The verified authority receipt is unavailable.', 503)
      return json(res, 200, buildOkxAuthorityProof(receipt, proofTransaction, publicUrl), payment.headers)
    }
    if (method === 'POST' && url.pathname === OKX_AUTHORITY_CHECK_ROUTE) {
      if (!authorityCheckProtector) {
        throw new ConciergeError('OKX_AUTHORITY_CHECK_NOT_CONFIGURED', 'The paid authority check is not configured.', 503)
      }
      const requestBody = await body(req)
      const payment = await authorityCheckProtector.protect(new Request(`${publicUrl}${url.pathname}${url.search}`, {
        method: 'POST',
        headers: fetchHeaders(req),
      }), requestBody)
      if (payment.status === 'challenge') return sendResponse(res, payment.response)
      return json(res, 200, evaluatePaidAuthorityCheck(requestBody, Date.now()), payment.headers)
    }
    if (method === 'POST' && url.pathname === NFT_MINT_ORDER_ROUTE) {
      if (!nftService || !nftOrderProtector) {
        throw new ConciergeError(
          'NFT_MINT_NOT_CONFIGURED',
          'Pocket NFT Mint & Deliver is disabled until its Ethereum gateway and hardened signer operator are configured.',
          503,
        )
      }
      const requestBody = await body(req)
      await nftService.assertCreatable('okx-marketplace', requestBody)
      const payment = await nftOrderProtector.protect(new Request(`${publicUrl}${url.pathname}${url.search}`, {
        method: 'POST',
        headers: fetchHeaders(req),
      }), requestBody)
      if (payment.status === 'challenge') return sendResponse(res, payment.response)
      const created = await nftService.create('okx-marketplace', requestBody)
      return json(res, created.replayed ? 200 : 201, {
        ok: true,
        ...created,
        next: {
          action: 'deposit_ethereum',
          chainId: 1,
          amountWei: created.order.requiredDepositWei,
          to: created.order.treasuryAddress,
          then: `POST /v1/nft-mints/orders/${encodeURIComponent(created.order.externalId)}/funding`,
        },
      }, payment.headers)
    }
    const receiptMatch = url.pathname.match(/^\/v1\/authority\/receipts\/(pr_[a-f0-9]{32})$/)
    if (method === 'GET' && receiptMatch?.[1]) {
      return json(res, 200, { ok: true, receipt: await service.getReceipt(receiptMatch[1]) })
    }
    if (method === 'GET' && url.pathname === '/v1/contract') {
      return json(res, 200, {
        ok: true,
        service: 'Pocket Concierge',
        role: 'buyer-agent-orchestrator',
        supportedActions: ['okx_bill', ...(nftConfigComplete ? ['ethereum_nft_mint'] : [])],
        lifecycle: ['planned', 'approved', 'executing', 'delivered', 'needs_review'],
        authority: {
          policyVersion: '1',
          outcomes: ['APPROVE', 'ESCALATE', 'BLOCK'],
          escalation: 'Exact amount, action, decision, nonce, and expiry; consumed once when execution starts.',
          receipts: '/v1/authority/receipts/{receiptId}',
          marketplaceProof: OKX_AUTHORITY_PROOF_ROUTE,
          reusableAuthorityCheck: OKX_AUTHORITY_CHECK_ROUTE,
        },
        paymentCustody: false,
        privacy: {
          accepts: ['opaque privateInputRef', 'provider service identifiers', 'maximum USDT'],
          rejects: ['phone number', 'meter number', 'smartcard number', 'wallet key', 'Prava credential'],
        },
        plannedHackathonExtension: {
          action: 'prava_shop',
          status: 'not-implemented-before-event',
        },
        nftMint: {
          status: nftConfigComplete ? 'pilot-enabled' : 'disabled-until-signer-and-chain-configured',
          serviceFee: '1 USDT on X Layer',
          executionCapital: 'Customer deposits native ETH on Ethereum before the order is armed.',
          custody: 'Pocket temporarily holds execution ETH and the minted NFT until delivery.',
        },
      })
    }
    if (method === 'GET' && url.pathname === '/v1/capabilities') {
      return json(res, 200, {
        ok: true,
        service: 'Pocket Concierge',
        entrypoint: 'POST /v1/errands',
        authorityCheck: OKX_AUTHORITY_CHECK_ROUTE,
        supportedExecution: {
          provider: 'Pocket Bills',
          categories: ['data', 'electricity', 'tv'],
          verifiedPilot: { category: 'data', serviceId: 'mtn-data' },
        },
        unavailableUntilAdapterVerification: ['airtime', 'paid_brief', 'shopping'],
        nftMint: {
          enabled: nftConfigComplete,
          paidEntrypoint: NFT_MINT_ORDER_ROUTE,
          supported: ['ethereum-mainnet', 'opensea-seadrop', 'public-fcfs', 'quantity-1'],
        },
        idempotency: 'externalId + cycleId',
        privacy: 'Send only opaque privateInputRef values; the buyer executor keeps customer references locally.',
      })
    }
    const nftOrderMatch = url.pathname.match(/^\/v1\/nft-mints\/orders\/([^/]+)$/)
    if (method === 'GET' && nftOrderMatch?.[1]) {
      if (!nftService) throw new ConciergeError('NFT_MINT_NOT_CONFIGURED', 'Pocket NFT Mint & Deliver is disabled.', 503)
      const externalId = decodeURIComponent(nftOrderMatch[1])
      const order = await nftService.authenticateOrder(
        'okx-marketplace',
        externalId,
        req.headers['x-order-token'] as string | undefined ?? bearer(req.headers.authorization),
      )
      return json(res, 200, { ok: true, order })
    }
    const nftActionMatch = url.pathname.match(
      /^\/v1\/nft-mints\/orders\/([^/]+)\/(funding|prepare|minted|delivery-plan|delivered|refund|refunded)$/,
    )
    if (method === 'POST' && nftActionMatch?.[1] && nftActionMatch[2]) {
      if (!nftService) throw new ConciergeError('NFT_MINT_NOT_CONFIGURED', 'Pocket NFT Mint & Deliver is disabled.', 503)
      const externalId = decodeURIComponent(nftActionMatch[1])
      if (nftActionMatch[2] === 'funding') {
        await nftService.authenticateOrder(
          'okx-marketplace',
          externalId,
          req.headers['x-order-token'] as string | undefined ?? bearer(req.headers.authorization),
        )
        const order = await nftService.confirmFunding('okx-marketplace', externalId, await body(req))
        return json(res, 200, { ok: true, order })
      }
      requireNftOperator(req.headers['x-operator-key'] as string | undefined)
      if (nftActionMatch[2] === 'prepare') {
        return json(res, 200, {
          ok: true,
          execution: await nftService.prepareExecution('okx-marketplace', externalId),
        })
      }
      if (nftActionMatch[2] === 'delivery-plan') {
        return json(res, 200, {
          ok: true,
          execution: await nftService.prepareDelivery('okx-marketplace', externalId),
        })
      }
      if (nftActionMatch[2] === 'refund') {
        return json(res, 200, {
          ok: true,
          execution: await nftService.prepareRefund('okx-marketplace', externalId),
        })
      }
      const requestBody = await body(req)
      const order = nftActionMatch[2] === 'minted'
        ? await nftService.recordMint('okx-marketplace', externalId, requestBody)
        : nftActionMatch[2] === 'delivered'
          ? await nftService.recordDelivery('okx-marketplace', externalId, requestBody)
          : await nftService.recordRefund('okx-marketplace', externalId, requestBody)
      return json(res, 200, { ok: true, order })
    }
    if (!keys.size) throw new ConciergeError('SERVICE_NOT_CONFIGURED', 'Pocket Concierge agent keys are not configured.', 503)
    const ownerId = authenticate(req.headers.authorization, keys)
    if (method === 'POST' && url.pathname === '/v1/errands') {
      const created = await service.create(ownerId, errandToMissionInput(await body(req)))
      return json(res, created.replayed ? 200 : 201, {
        ok: true,
        replayed: created.replayed,
        errand: errandView(created.mission),
      })
    }
    const errandMatch = url.pathname.match(/^\/v1\/errands\/([^/]+)$/)
    if (method === 'GET' && errandMatch?.[1]) {
      const mission = await service.get(ownerId, decodeURIComponent(errandMatch[1]))
      return json(res, 200, { ok: true, errand: errandView(mission) })
    }
    const errandActionMatch = url.pathname.match(/^\/v1\/errands\/([^/]+)\/(authorize|complete)$/)
    if (method === 'POST' && errandActionMatch?.[1] && errandActionMatch[2]) {
      const errandId = decodeURIComponent(errandActionMatch[1])
      const requestBody = await body(req)
      const current = await service.get(ownerId, errandId)
      const action = current.actions[0]
      if (!action) throw new ConciergeError('ERRAND_INVALID', 'Errand has no action.', 500)
      if (errandActionMatch[2] === 'authorize') {
        if (action.state === 'planned' || action.state === 'approved') {
          await service.approve(ownerId, errandId, action.actionId, requestBody)
        }
        const execution = await service.start(ownerId, errandId, action.actionId)
        const updated = await service.get(ownerId, errandId)
        return json(res, 200, { ok: true, errand: errandView(updated, execution) })
      }
      const updated = await service.verify(ownerId, errandId, action.actionId, requestBody)
      const updatedAction = updated.actions[0]
      const receipt = updatedAction?.authorityReceiptId
        ? await service.getReceipt(updatedAction.authorityReceiptId)
        : undefined
      return json(res, 200, { ok: true, errand: errandView(updated, undefined, receipt) })
    }
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
        return json(res, 200, { ok: true, mission: await service.approve(ownerId, externalId, actionId, requestBody) })
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
