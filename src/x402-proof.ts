import { OKXFacilitatorClient } from '@okxweb3/x402-core'
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type HTTPAdapter,
  type HTTPRequestContext,
  type RoutesConfig,
} from '@okxweb3/x402-core/server'
import { registerExactEvmScheme } from '@okxweb3/x402-evm/exact/server'
import { ConciergeError } from './errors.js'
import {
  OKX_AUTHORITY_PROOF_FEE_ATOMIC,
  OKX_AUTHORITY_PROOF_ROUTE,
  XLAYER_USDT0,
} from './okx-proof.js'

const NETWORK = 'eip155:196' as const

export const OKX_AUTHORITY_PROOF_OUTPUT_SCHEMA = {
  input: { type: 'http', method: 'GET' },
} as const

export type ProofPaymentResult =
  | { status: 'challenge'; response: Response }
  | { status: 'paid'; headers: Headers }

type ProofPaymentConfig = {
  apiKey: string
  secretKey: string
  passphrase: string
  payTo: string
  publicUrl: string
}

type X402Server = Pick<x402HTTPResourceServer, 'processHTTPRequest' | 'processSettlement'>

function normalizeSupportedResponse(value: unknown) {
  const raw = value as { kinds?: unknown; extensions?: unknown; signers?: unknown } | unknown[]
  if (Array.isArray(raw)) return { kinds: raw, extensions: [], signers: {} }
  return {
    kinds: Array.isArray(raw?.kinds) ? raw.kinds : [],
    extensions: Array.isArray(raw?.extensions) ? raw.extensions : [],
    signers: raw?.signers && typeof raw?.signers === 'object'
      ? raw.signers as Record<string, string[]>
      : {},
  }
}

function sdkResponse(response: { status: number; headers: Record<string, string>; body?: unknown }) {
  const headers = new Headers(response.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  const body = typeof response.body === 'string'
    ? response.body
    : response.body instanceof Uint8Array
      ? Buffer.from(response.body)
      : JSON.stringify(response.body ?? {})
  return new Response(body, { status: response.status, headers })
}

export class OkxAuthorityProofProtector {
  private serverPromise: Promise<X402Server> | undefined

  constructor(
    private readonly config: ProofPaymentConfig,
    private readonly facilitatorFactory: () => OKXFacilitatorClient = () => new OKXFacilitatorClient({
      apiKey: config.apiKey,
      secretKey: config.secretKey,
      passphrase: config.passphrase,
      syncSettle: true,
    }),
  ) {}

  async protect(request: Request): Promise<ProofPaymentResult> {
    const server = await this.httpServer()
    const context = this.context(request)
    const payment = await server.processHTTPRequest(context)
    if (payment.type === 'payment-error') {
      return { status: 'challenge', response: sdkResponse(payment.response) }
    }
    if (payment.type === 'no-payment-required') {
      throw new ConciergeError('OKX_ROUTE_UNPROTECTED', 'The OKX proof endpoint is not payment protected.', 500)
    }
    const settled = await server.processSettlement(
      payment.paymentPayload,
      payment.paymentRequirements,
      payment.declaredExtensions,
      { request: context },
    )
    if (!settled.success) return { status: 'challenge', response: sdkResponse(settled.response) }
    if (
      payment.paymentRequirements.network !== NETWORK
      || payment.paymentRequirements.asset.toLowerCase() !== XLAYER_USDT0
      || payment.paymentRequirements.amount !== OKX_AUTHORITY_PROOF_FEE_ATOMIC
      || (settled.amount && settled.amount !== OKX_AUTHORITY_PROOF_FEE_ATOMIC)
    ) {
      throw new ConciergeError('OKX_PAYMENT_MISMATCH', 'The signed replay does not match the proof listing.', 409)
    }
    return { status: 'paid', headers: new Headers(settled.headers) }
  }

  private context(request: Request): HTTPRequestContext {
    const url = new URL(request.url)
    const adapter: HTTPAdapter = {
      getHeader: name => request.headers.get(name) ?? undefined,
      getMethod: () => 'GET',
      getPath: () => url.pathname,
      getUrl: () => url.toString(),
      getAcceptHeader: () => request.headers.get('accept') ?? '',
      getUserAgent: () => request.headers.get('user-agent') ?? '',
      getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
      getQueryParam: name => url.searchParams.get(name) ?? undefined,
      getBody: () => undefined,
    }
    return { adapter, path: OKX_AUTHORITY_PROOF_ROUTE, method: 'GET' }
  }

  private httpServer() {
    this.serverPromise ??= this.createHttpServer().catch(error => {
      this.serverPromise = undefined
      throw error
    })
    return this.serverPromise
  }

  private async createHttpServer(): Promise<X402Server> {
    const facilitator = this.facilitatorFactory()
    const supported = normalizeSupportedResponse(await facilitator.getSupported())
    if (!supported.kinds.length) {
      throw new ConciergeError('OKX_FACILITATOR_UNAVAILABLE', 'The OKX facilitator returned no supported payment methods.', 503)
    }
    const resourceServer = new x402ResourceServer({
      verify: facilitator.verify.bind(facilitator),
      settle: facilitator.settle.bind(facilitator),
      getSettleStatus: facilitator.getSettleStatus.bind(facilitator),
      getSupported: async () => supported,
    })
    registerExactEvmScheme(resourceServer)
    const route = {
      accepts: {
        scheme: 'exact',
        network: NETWORK,
        payTo: this.config.payTo,
        price: {
          amount: OKX_AUTHORITY_PROOF_FEE_ATOMIC,
          asset: XLAYER_USDT0,
          extra: { tokenSymbol: 'USDT', decimals: 6, name: 'USD₮0', version: '1' },
        },
        maxTimeoutSeconds: 300,
        extra: { tokenSymbol: 'USDT', decimals: 6, name: 'USD₮0', version: '1' },
      },
      resource: `${this.config.publicUrl}${OKX_AUTHORITY_PROOF_ROUTE}`,
      description: 'Verified Pocket Concierge authority decision, settlement evidence, and integration contract.',
      mimeType: 'application/json',
      extensions: {
        serviceName: 'Governed Purchase Proof',
        tags: ['authority', 'commerce', 'household', 'xlayer', 'proof'],
        outputSchema: OKX_AUTHORITY_PROOF_OUTPUT_SCHEMA,
      },
    } as const
    const routes: RoutesConfig = {
      [`GET ${OKX_AUTHORITY_PROOF_ROUTE}`]: route,
    }
    const server = new x402HTTPResourceServer(resourceServer, routes)
    await server.initialize()
    return server
  }
}
