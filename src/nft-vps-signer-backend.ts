import {
  Transaction,
  Wallet,
  getAddress as ethersAddress,
  type Signer,
} from 'ethers'
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

type Broadcaster = Pick<PublicClient, 'sendRawTransaction'>

export type VpsNftSignerOptions = {
  signer: Signer
  rpcUrl?: string
  broadcaster?: Broadcaster
}

function invalid(message: string): never {
  throw new ConciergeError('NFT_VPS_SIGNER_ENVELOPE_INVALID', message, 503)
}

function safeNonce(value: string) {
  const nonce = BigInt(value)
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) invalid('Ethereum nonce exceeds the safe serializer range.')
  return Number(nonce)
}

export class VpsNftSignerBackend implements NftHardenedSignerBackend {
  private readonly broadcaster: Broadcaster
  private cachedAddress?: Address

  constructor(private readonly options: VpsNftSignerOptions) {
    if (options.broadcaster) {
      this.broadcaster = options.broadcaster
    } else {
      if (!options.rpcUrl) throw new Error('Ethereum RPC URL is required.')
      this.broadcaster = createPublicClient({ transport: http(options.rpcUrl) })
    }
  }

  static async fromEncryptedKeystore(
    keystoreJson: string,
    password: string,
    options: Omit<VpsNftSignerOptions, 'signer'>,
  ) {
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, password)
    return new VpsNftSignerBackend({ ...options, signer: wallet })
  }

  async address() {
    if (!this.cachedAddress) {
      this.cachedAddress = getAddress(await this.options.signer.getAddress())
    }
    return this.cachedAddress
  }

  async signAndBroadcast(plan: ValidatedAssistedPlan) {
    const expectedAddress = await this.address()
    const serialized = await this.options.signer.signTransaction({
      type: 0,
      chainId: 1,
      nonce: safeNonce(plan.transaction.nonce),
      to: plan.transaction.to,
      data: plan.transaction.data,
      value: BigInt(plan.transaction.valueWei),
      gasLimit: BigInt(plan.transaction.gasLimit),
      gasPrice: BigInt(plan.transaction.maxFeePerGasWei),
    })
    const decoded = Transaction.from(serialized)
    if (
      decoded.type !== 0
      || decoded.chainId !== 1n
      || decoded.nonce !== safeNonce(plan.transaction.nonce)
      || !decoded.from
      || getAddress(decoded.from) !== expectedAddress
      || !decoded.to
      || ethersAddress(decoded.to) !== ethersAddress(plan.transaction.to)
      || decoded.data.toLowerCase() !== plan.transaction.data.toLowerCase()
      || decoded.value !== BigInt(plan.transaction.valueWei)
      || decoded.gasLimit !== BigInt(plan.transaction.gasLimit)
      || decoded.gasPrice !== BigInt(plan.transaction.maxFeePerGasWei)
    ) {
      invalid('Signed transaction differs from the validated Pocket execution plan.')
    }
    const transactionHash = await this.broadcaster.sendRawTransaction({
      serializedTransaction: serialized as Hex,
    })
    return { transactionHash }
  }
}
