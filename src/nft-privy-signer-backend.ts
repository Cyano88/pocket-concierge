import { PrivyClient } from '@privy-io/node'
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { ConciergeError } from './errors.js'
import type { NftHardenedSignerBackend } from './nft-hardened-signer.js'
import type { ValidatedAssistedPlan } from './nft-assisted-worker.js'
import { assertSignedPlanEnvelope } from './nft-vps-signer-backend.js'

type Broadcaster = Pick<PublicClient, 'sendRawTransaction'>

export type PrivyTransactionSigner = {
  signTransaction(
    walletId: string,
    input: {
      params: {
        transaction: {
          type: 0
          chain_id: number
          from: Address
          to: Address
          data: Hex
          value: string
          gas_limit: string
          gas_price: string
          nonce: string
        }
      }
      authorization_context: {
        authorization_private_keys: string[]
      }
      request_expiry: number
    },
  ): Promise<{ signed_transaction: string; encoding: 'rlp' }>
}

export type PrivyNftSignerOptions = {
  walletId: string
  walletAddress: string
  authorizationPrivateKey: string
  appId?: string
  appSecret?: string
  rpcUrl?: string
  signerClient?: PrivyTransactionSigner
  broadcaster?: Broadcaster
  now?: () => number
}

function configurationError(message: string): never {
  throw new ConciergeError('NFT_PRIVY_SIGNER_CONFIGURATION_INVALID', message, 503)
}

function quantity(value: string) {
  const parsed = BigInt(value)
  if (parsed < 0n) configurationError('Ethereum quantities cannot be negative.')
  return `0x${parsed.toString(16)}`
}

export class PrivyNftSignerBackend implements NftHardenedSignerBackend {
  private readonly signerClient: PrivyTransactionSigner
  private readonly broadcaster: Broadcaster
  private readonly walletAddress: Address
  private readonly now: () => number

  constructor(private readonly options: PrivyNftSignerOptions) {
    if (!options.walletId.trim()) configurationError('Privy wallet ID is required.')
    if (!options.authorizationPrivateKey.trim()) {
      configurationError('Privy authorization private key is required.')
    }
    this.walletAddress = getAddress(options.walletAddress)
    this.now = options.now ?? (() => Date.now())

    if (options.signerClient) {
      this.signerClient = options.signerClient
    } else {
      if (!options.appId?.trim() || !options.appSecret?.trim()) {
        configurationError('Privy app ID and app secret are required.')
      }
      const client = new PrivyClient({
        appId: options.appId,
        appSecret: options.appSecret,
        requestExpiry: { defaultMs: 30_000 },
      })
      this.signerClient = client.wallets().ethereum()
    }

    if (options.broadcaster) {
      this.broadcaster = options.broadcaster
    } else {
      if (!options.rpcUrl) configurationError('Ethereum RPC URL is required.')
      this.broadcaster = createPublicClient({ transport: http(options.rpcUrl) })
    }
  }

  async address() {
    return this.walletAddress
  }

  async signAndBroadcast(plan: ValidatedAssistedPlan) {
    const signed = await this.signerClient.signTransaction(this.options.walletId, {
      params: {
        transaction: {
          type: 0,
          chain_id: 1,
          from: this.walletAddress,
          to: plan.transaction.to,
          data: plan.transaction.data,
          value: quantity(plan.transaction.valueWei),
          gas_limit: quantity(plan.transaction.gasLimit),
          gas_price: quantity(plan.transaction.maxFeePerGasWei),
          nonce: quantity(plan.transaction.nonce),
        },
      },
      authorization_context: {
        authorization_private_keys: [this.options.authorizationPrivateKey],
      },
      request_expiry: this.now() + 30_000,
    })
    if (signed.encoding !== 'rlp' || !signed.signed_transaction.startsWith('0x')) {
      throw new ConciergeError(
        'NFT_PRIVY_SIGNER_RESPONSE_INVALID',
        'Privy returned no RLP-encoded signed Ethereum transaction.',
        503,
      )
    }
    assertSignedPlanEnvelope(signed.signed_transaction, this.walletAddress, plan)
    const transactionHash = await this.broadcaster.sendRawTransaction({
      serializedTransaction: signed.signed_transaction as Hex,
    })
    return { transactionHash }
  }
}
