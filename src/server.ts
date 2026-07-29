import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
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
import { FixedWindowRateLimiter } from './rate-limit.js'
import { buildOkxAuthorityProof, OKX_AUTHORITY_PROOF_ROUTE } from './okx-proof.js'
import { ConciergeService, fetchJson } from './service.js'
import { MemoryMissionStore, SqliteMissionStore } from './store.js'
import { OkxAuthorityProofProtector, OkxPaidRouteProtector } from './x402-proof.js'
import { EthereumNftChainGateway } from './nft-chain.js'
import {
  NFT_MINT_ORDER_OUTPUT_SCHEMA,
  NFT_MINT_ORDER_ROUTE,
  NFT_MINT_PREVIEW_ROUTE,
  NFT_MINT_PUBLIC_PROOF_ROUTE,
  NFT_MINT_SERVICE_FEE_ATOMIC,
  NftMintService,
} from './nft-mints.js'
import { MemoryNftMintStore, SqliteNftMintStore } from './nft-store.js'
import { requireSecret } from './secret-gate.js'
import {
  WALLPAPER_PURCHASE_FEE_ATOMIC,
  WALLPAPER_PURCHASE_OUTPUT_SCHEMA,
  WALLPAPER_PURCHASE_ROUTE,
  WallpaperService,
} from './wallpapers.js'

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
const nftPilotKey = String(process.env.POCKET_CONCIERGE_NFT_PILOT_KEY || '').trim()
const nftPublicOrderLimiter = new FixedWindowRateLimiter(20, 100, 60_000)
const nftDemoExternalId = String(process.env.POCKET_CONCIERGE_NFT_DEMO_EXTERNAL_ID || '').trim()
const nftDemoServicePaymentTx = String(
  process.env.POCKET_CONCIERGE_NFT_DEMO_SERVICE_PAYMENT_TX || '',
).trim()
if (nftPilotKey && nftPilotKey.length < 32) {
  throw new ConciergeError(
    'NFT_CONFIG_INVALID',
    'POCKET_CONCIERGE_NFT_PILOT_KEY must contain at least 32 characters.',
    500,
  )
}
if (nftPilotKey && (nftPilotKey === nftOperatorKey || nftPilotKey === nftOrderTokenSecret)) {
  throw new ConciergeError(
    'NFT_CONFIG_INVALID',
    'The NFT pilot key must be distinct from the operator and order-token secrets.',
    500,
  )
}
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
        300,
        'POCKET_CONCIERGE_NFT_PLAN_TTL_SECONDS',
        10,
        600,
      ),
      schedulePrepareLeadSeconds: configuredInteger(
        process.env.POCKET_CONCIERGE_NFT_SCHEDULE_PREPARE_LEAD_SECONDS,
        30,
        'POCKET_CONCIERGE_NFT_SCHEDULE_PREPARE_LEAD_SECONDS',
        5,
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
const wallpaperDownloadSecret = String(
  process.env.POCKET_CONCIERGE_WALLPAPER_DOWNLOAD_SECRET || nftOrderTokenSecret,
).trim()
const wallpaperService = nftConfigComplete && wallpaperDownloadSecret.length >= 32
  ? new WallpaperService(
      databasePath,
      nftRpcUrl,
      String(
        process.env.POCKET_CONCIERGE_WALLPAPER_DIRECTORY
        || join(dirname(databasePath), 'wallpapers'),
      ),
      wallpaperDownloadSecret,
    )
  : null
const wallpaperPurchaseProtector = wallpaperService && paidRouteConfig
  ? new OkxPaidRouteProtector(paidRouteConfig, {
      method: 'POST',
      path: WALLPAPER_PURCHASE_ROUTE,
      amountAtomic: WALLPAPER_PURCHASE_FEE_ATOMIC,
      description: 'Purchase one rights-reviewed NFT wallpaper bundle with provenance, license receipt, and file hashes.',
      serviceName: 'Pocket NFT Wallpaper',
      tags: ['nft', 'wallpaper', 'provenance', 'license', 'download'],
      outputSchema: WALLPAPER_PURCHASE_OUTPUT_SCHEMA,
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

function png(res: ServerResponse, value: Buffer) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Content-Length', value.length)
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(value)
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
  requireSecret(
    value,
    nftOperatorKey,
    'NFT_OPERATOR_UNAUTHORIZED',
    'A valid NFT execution-operator key is required.',
  )
}

function requireNftPilot(value: string | undefined) {
  if (!nftPilotKey) return
  requireSecret(
    value,
    nftPilotKey,
    'NFT_PILOT_UNAUTHORIZED',
    'A valid Pocket NFT pilot key is required before payment.',
  )
}

function nftOrderRequestKey(req: IncomingMessage) {
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded
  const forwardedAddress = raw?.split(',').at(-1)?.trim()
  return forwardedAddress || req.socket.remoteAddress || 'unknown'
}

function requireNftOrderRateLimit(req: IncomingMessage, res: ServerResponse) {
  const result = nftPublicOrderLimiter.consume(nftOrderRequestKey(req))
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds))
    throw new ConciergeError(
      'NFT_ORDER_RATE_LIMITED',
      'Too many NFT order requests. Retry after the disclosed delay.',
      429,
    )
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
    if (method === 'POST' && url.pathname === NFT_MINT_PREVIEW_ROUTE) {
      if (!nftService) {
        throw new ConciergeError(
          'NFT_MINT_NOT_CONFIGURED',
          'Pocket NFT Mint & Deliver is disabled until its Ethereum gateway and signer operator are configured.',
          503,
        )
      }
      return json(res, 200, {
        ok: true,
        preview: await nftService.preview(await body(req)),
      })
    }
    if (method === 'POST' && url.pathname === NFT_MINT_ORDER_ROUTE) {
      if (!nftService || !nftOrderProtector) {
        throw new ConciergeError(
          'NFT_MINT_NOT_CONFIGURED',
          'Pocket NFT Mint & Deliver is disabled until its Ethereum gateway and hardened signer operator are configured.',
          503,
      )
      }
      requireNftOrderRateLimit(req, res)
      requireNftPilot(req.headers['x-pocket-pilot-key'] as string | undefined)
      const requestBody = await body(req)
      await nftService.assertCreatable('okx-marketplace', requestBody)
      const payment = await nftOrderProtector.protect(new Request(`${publicUrl}${url.pathname}${url.search}`, {
        method: 'POST',
        headers: fetchHeaders(req),
      }), requestBody)
      if (payment.status === 'challenge') return sendResponse(res, payment.response)
      const created = await nftService.create('okx-marketplace', requestBody)
      const statusPath = `/v1/nft-mints/orders/${encodeURIComponent(created.order.externalId)}`
      return json(res, created.replayed ? 200 : 201, {
        ok: true,
        ...created,
        deliverable: {
          type: 'bounded_nft_mint_execution_order',
          status: 'accepted',
          orderId: created.order.orderId,
          manifestHash: created.order.manifestHash,
          state: created.order.state,
          servicePayment: 'settled',
          executionFunding: 'awaiting_customer_deposit',
          finalProof: `${publicUrl}${statusPath}`,
        },
        next: {
          action: 'deposit_ethereum',
          chainId: 1,
          amountWei: created.order.requiredDepositWei,
          to: created.order.treasuryAddress,
          then: `POST /v1/nft-mints/orders/${encodeURIComponent(created.order.externalId)}/funding`,
          status: statusPath,
          orderTokenHeader: 'X-Order-Token',
          warning: 'Send only the exact order amount from the immutable fundingAddress. Never share a wallet key.',
        },
      }, payment.headers)
    }
    if (method === 'GET' && url.pathname === '/v1/nft-mints/signer-config') {
      if (!nftService) {
        throw new ConciergeError('NFT_MINT_NOT_CONFIGURED', 'Pocket NFT Mint & Deliver is disabled.', 503)
      }
      requireNftOperator(req.headers['x-operator-key'] as string | undefined)
      return json(res, 200, {
        ok: true,
        signerConfig: {
          chainId: 1,
          treasuryAddress: getAddress(nftTreasuryRaw),
          access: nftPilotKey ? 'private-pilot' : 'public',
          supportedActions: ['mint', 'deliver', 'refund'],
        },
      })
    }
    if (method === 'GET' && url.pathname === '/v1/nft-mints/work-queue') {
      if (!nftService) {
        throw new ConciergeError('NFT_MINT_NOT_CONFIGURED', 'Pocket NFT Mint & Deliver is disabled.', 503)
      }
      requireNftOperator(req.headers['x-operator-key'] as string | undefined)
      return json(res, 200, {
        ok: true,
        work: await nftService.workQueue('okx-marketplace'),
      })
    }
    if (method === 'GET' && url.pathname === NFT_MINT_PUBLIC_PROOF_ROUTE) {
      if (!nftService || !nftDemoExternalId || !nftDemoServicePaymentTx) {
        throw new ConciergeError('NFT_PROOF_NOT_CONFIGURED', 'The verified NFT pilot proof is not configured.', 503)
      }
      return json(res, 200, {
        ok: true,
        proof: await nftService.publicProof(
          'okx-marketplace',
          nftDemoExternalId,
          nftDemoServicePaymentTx,
        ),
      })
    }
    if (method === 'GET' && url.pathname === '/v1/wallpapers') {
      if (!wallpaperService) throw new ConciergeError('WALLPAPER_NOT_CONFIGURED', 'NFT wallpaper service is disabled.', 503)
      return json(res, 200, { ok: true, assets: wallpaperService.listPublic() })
    }
    const wallpaperItemMatch = url.pathname.match(/^\/v1\/wallpapers\/(nwa_[a-f0-9]{24})$/)
    if (method === 'GET' && wallpaperItemMatch?.[1]) {
      if (!wallpaperService) throw new ConciergeError('WALLPAPER_NOT_CONFIGURED', 'NFT wallpaper service is disabled.', 503)
      const asset = wallpaperService.getPublic(wallpaperItemMatch[1])
      if (!asset) throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Public wallpaper asset was not found.', 404)
      return json(res, 200, { ok: true, asset })
    }
    const wallpaperDownloadMatch = url.pathname.match(
      /^\/v1\/wallpapers\/(nwa_[a-f0-9]{24})\/download\/(preview|desktop|mobile)$/,
    )
    if (method === 'GET' && wallpaperDownloadMatch?.[1] && wallpaperDownloadMatch[2]) {
      if (!wallpaperService) throw new ConciergeError('WALLPAPER_NOT_CONFIGURED', 'NFT wallpaper service is disabled.', 503)
      return png(
        res,
        await wallpaperService.download(
          wallpaperDownloadMatch[1],
          wallpaperDownloadMatch[2] as 'preview' | 'desktop' | 'mobile',
          url.searchParams.get('token') ?? undefined,
        ),
      )
    }
    if (method === 'POST' && url.pathname === WALLPAPER_PURCHASE_ROUTE) {
      if (!wallpaperService || !wallpaperPurchaseProtector) {
        throw new ConciergeError('WALLPAPER_NOT_CONFIGURED', 'Paid NFT wallpaper service is disabled.', 503)
      }
      const requestBody = await body(req)
      const assetId = (
        requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)
          ? (requestBody as Record<string, unknown>).assetId
          : undefined
      )
      if (typeof assetId !== 'string' || !wallpaperService.getPublic(assetId)) {
        throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Public wallpaper asset was not found.', 404)
      }
      const payment = await wallpaperPurchaseProtector.protect(new Request(`${publicUrl}${url.pathname}`, {
        method: 'POST',
        headers: fetchHeaders(req),
      }), requestBody)
      if (payment.status === 'challenge') return sendResponse(res, payment.response)
      return json(res, 200, wallpaperService.purchase(assetId), payment.headers)
    }
    const wallpaperCreateMatch = url.pathname.match(
      /^\/v1\/nft-mints\/orders\/([^/]+)\/wallpaper$/,
    )
    if (method === 'POST' && wallpaperCreateMatch?.[1]) {
      if (!nftService || !wallpaperService) {
        throw new ConciergeError('WALLPAPER_NOT_CONFIGURED', 'NFT wallpaper service is disabled.', 503)
      }
      const externalId = decodeURIComponent(wallpaperCreateMatch[1])
      const order = await nftService.authenticateOrder(
        'okx-marketplace',
        externalId,
        req.headers['x-order-token'] as string | undefined ?? bearer(req.headers.authorization),
      )
      if (!order.mint || !order.delivery || !['delivered', 'refunding', 'refunded'].includes(order.state)) {
        throw new ConciergeError('WALLPAPER_NFT_NOT_DELIVERED', 'A verified delivered NFT is required before wallpaper creation.', 409)
      }
      const created = await wallpaperService.create(
        externalId,
        order.nftContract,
        order.mint.tokenId,
        { rights: 'private-use' },
      )
      return json(res, created.replayed ? 200 : 201, {
        ok: true,
        replayed: created.replayed,
        asset: created.asset,
        downloads: wallpaperService.grant(created.asset.assetId),
        rightsBoundary: 'Private-use pack only. NFT ownership does not grant public resale rights.',
      })
    }
    if (method === 'POST' && url.pathname === '/v1/wallpapers/catalog/from-order') {
      if (!nftService || !wallpaperService) {
        throw new ConciergeError('WALLPAPER_NOT_CONFIGURED', 'NFT wallpaper service is disabled.', 503)
      }
      requireNftOperator(req.headers['x-operator-key'] as string | undefined)
      const requestBody = await body(req)
      const input = requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)
        ? requestBody as Record<string, unknown>
        : {}
      if (typeof input.externalId !== 'string') {
        throw new ConciergeError('WALLPAPER_INPUT_INVALID', 'externalId is required.')
      }
      const order = await nftService.get('okx-marketplace', input.externalId)
      if (!order.mint || !order.delivery || !['delivered', 'refunding', 'refunded'].includes(order.state)) {
        throw new ConciergeError('WALLPAPER_NFT_NOT_DELIVERED', 'A verified delivered NFT is required before catalog review.', 409)
      }
      const created = await wallpaperService.create(
        input.externalId,
        order.nftContract,
        order.mint.tokenId,
        { rights: 'private-use' },
      )
      const asset = wallpaperService.promote(input.externalId, {
        rights: input.rights,
        rightsReference: input.rightsReference,
      })
      return json(res, created.replayed ? 200 : 201, {
        ok: true,
        replayed: created.replayed,
        asset,
      })
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
          access: nftConfigComplete ? (nftPilotKey ? 'private-pilot' : 'public') : 'disabled',
          serviceFee: '1 USDT on X Layer',
          executionCapital: 'Customer deposits native ETH on Ethereum before the order is armed.',
          custody: 'Pocket temporarily holds execution ETH and the minted NFT until delivery.',
          execution: 'Immediate or launch-scheduled public SeaDrop mint with bounded EIP-1559 fees; no guaranteed snipe.',
        },
        nftWallpaper: {
          status: wallpaperService ? 'enabled' : 'disabled',
          privatePack: 'Verified delivered NFTs can become private desktop and mobile wallpaper packs.',
          publicCatalog: 'Only operator-reviewed commercial rights enter the paid catalog.',
          catalog: '/v1/wallpapers',
          paidPurchase: WALLPAPER_PURCHASE_ROUTE,
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
          access: nftConfigComplete ? (nftPilotKey ? 'private-pilot' : 'public') : 'disabled',
          preview: NFT_MINT_PREVIEW_ROUTE,
          paidEntrypoint: NFT_MINT_ORDER_ROUTE,
          verifiedPilotProof: nftDemoExternalId && nftDemoServicePaymentTx
            ? NFT_MINT_PUBLIC_PROOF_ROUTE
            : null,
          supported: [
            'ethereum-mainnet',
            'opensea-seadrop',
            'public-fcfs',
            'launch-scheduled',
            'eip-1559-bounded',
            'quantity-1',
          ],
          unsupported: ['allowlist', 'presale-signature', 'arbitrary-calldata', 'replacement-transaction'],
        },
        nftWallpaper: {
          enabled: Boolean(wallpaperService),
          privatePack: '/v1/nft-mints/orders/{externalId}/wallpaper',
          publicCatalog: '/v1/wallpapers',
          paidPurchase: WALLPAPER_PURCHASE_ROUTE,
          rightsBoundary: 'Public catalog requires reviewed CC0, public-domain, commercial-license, or creator opt-in evidence.',
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
      /^\/v1\/nft-mints\/orders\/([^/]+)\/(funding|cancel|prepare|recover-unbroadcast-mint|minted|failed|delivery-plan|delivered|refund|refunded)$/,
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
      if (nftActionMatch[2] === 'cancel') {
        await nftService.authenticateOrder(
          'okx-marketplace',
          externalId,
          req.headers['x-order-token'] as string | undefined ?? bearer(req.headers.authorization),
        )
        return json(res, 200, {
          ok: true,
          order: await nftService.cancel('okx-marketplace', externalId, await body(req)),
        })
      }
      requireNftOperator(req.headers['x-operator-key'] as string | undefined)
      if (nftActionMatch[2] === 'prepare') {
        return json(res, 200, {
          ok: true,
          execution: await nftService.prepareExecution(
            'okx-marketplace',
            externalId,
            req.headers['x-worker-id'] as string | undefined ?? '',
          ),
        })
      }
      if (nftActionMatch[2] === 'recover-unbroadcast-mint') {
        return json(res, 200, {
          ok: true,
          recovery: await nftService.recoverExpiredUnbroadcastMint(
            'okx-marketplace',
            externalId,
            req.headers['x-worker-id'] as string | undefined ?? '',
          ),
        })
      }
      if (nftActionMatch[2] === 'delivery-plan') {
        return json(res, 200, {
          ok: true,
          execution: await nftService.prepareDelivery(
            'okx-marketplace',
            externalId,
            req.headers['x-worker-id'] as string | undefined ?? '',
          ),
        })
      }
      if (nftActionMatch[2] === 'refund') {
        return json(res, 200, {
          ok: true,
          execution: await nftService.prepareRefund(
            'okx-marketplace',
            externalId,
            req.headers['x-worker-id'] as string | undefined ?? '',
          ),
        })
      }
      const requestBody = await body(req)
      const order = nftActionMatch[2] === 'minted'
        ? await nftService.recordMint('okx-marketplace', externalId, requestBody)
        : nftActionMatch[2] === 'failed'
          ? await nftService.recordFailedMint('okx-marketplace', externalId, requestBody)
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
