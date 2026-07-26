import { createPublicKey } from 'node:crypto'
import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  type KMSClientConfig,
} from '@aws-sdk/client-kms'
import {
  bytesToHex,
  createPublicClient,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  recoverAddress,
  serializeTransaction,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { ConciergeError } from './errors.js'
import type { NftHardenedSignerBackend } from './nft-hardened-signer.js'
import type { ValidatedAssistedPlan } from './nft-assisted-worker.js'

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n

type KmsLike = Pick<KMSClient, 'send'>
type Broadcaster = Pick<PublicClient, 'sendRawTransaction'>

export type AwsKmsNftSignerOptions = {
  keyId: string
  rpcUrl?: string
  region?: string
  kms?: KmsLike
  broadcaster?: Broadcaster
}

function signerFailure(code: string, message: string): never {
  throw new ConciergeError(code, message, 503)
}

function readDerLength(bytes: Uint8Array, offset: number) {
  const first = bytes[offset]
  if (first === undefined) signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS returned a truncated DER signature.')
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 }
  const count = first & 0x7f
  if (count < 1 || count > 2) signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS returned an unsupported DER length.')
  let length = 0
  for (let index = 0; index < count; index += 1) {
    const value = bytes[offset + 1 + index]
    if (value === undefined) signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS returned a truncated DER signature.')
    length = (length << 8) | value
  }
  return { length, next: offset + 1 + count }
}

function readDerInteger(bytes: Uint8Array, offset: number) {
  if (bytes[offset] !== 0x02) signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS signature is not DER ECDSA.')
  const size = readDerLength(bytes, offset + 1)
  const end = size.next + size.length
  if (size.length < 1 || end > bytes.length) {
    signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS returned a malformed DER integer.')
  }
  let value = 0n
  for (const byte of bytes.slice(size.next, end)) value = (value << 8n) | BigInt(byte)
  return { value, next: end }
}

export function decodeKmsDerSignature(bytes: Uint8Array) {
  if (bytes[0] !== 0x30) signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS signature is not a DER sequence.')
  const sequence = readDerLength(bytes, 1)
  if (sequence.next + sequence.length !== bytes.length) {
    signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS DER signature length is invalid.')
  }
  const r = readDerInteger(bytes, sequence.next)
  const s = readDerInteger(bytes, r.next)
  if (s.next !== bytes.length || r.value <= 0n || r.value >= SECP256K1_ORDER || s.value <= 0n || s.value >= SECP256K1_ORDER) {
    signerFailure('NFT_KMS_SIGNATURE_INVALID', 'KMS signature values are outside secp256k1.')
  }
  return {
    r: r.value,
    s: s.value > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - s.value : s.value,
  }
}

export function ethereumAddressFromSpki(publicKey: Uint8Array) {
  let jwk: JsonWebKey
  try {
    jwk = createPublicKey({
      key: Buffer.from(publicKey),
      format: 'der',
      type: 'spki',
    }).export({ format: 'jwk' })
  } catch {
    signerFailure('NFT_KMS_PUBLIC_KEY_INVALID', 'KMS public key is not valid secp256k1 SPKI.')
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || !jwk.x || !jwk.y) {
    signerFailure('NFT_KMS_PUBLIC_KEY_INVALID', 'KMS key must be ECC_SECG_P256K1.')
  }
  const coordinates = Buffer.concat([
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ])
  if (coordinates.length !== 64) {
    signerFailure('NFT_KMS_PUBLIC_KEY_INVALID', 'KMS secp256k1 public key coordinates are invalid.')
  }
  const digest = keccak256(bytesToHex(coordinates))
  return getAddress(`0x${digest.slice(-40)}`)
}

function unsignedTransaction(plan: ValidatedAssistedPlan) {
  const nonce = BigInt(plan.transaction.nonce)
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    signerFailure('NFT_KMS_NONCE_INVALID', 'Ethereum nonce exceeds the safe serializer range.')
  }
  return {
    chainId: 1,
    type: 'legacy' as const,
    nonce: Number(nonce),
    to: plan.transaction.to,
    data: plan.transaction.data,
    value: BigInt(plan.transaction.valueWei),
    gas: BigInt(plan.transaction.gasLimit),
    gasPrice: BigInt(plan.transaction.maxFeePerGasWei),
  }
}

export class AwsKmsNftSignerBackend implements NftHardenedSignerBackend {
  private readonly kms: KmsLike
  private readonly broadcaster: Broadcaster
  private cachedAddress?: Address

  constructor(private readonly options: AwsKmsNftSignerOptions) {
    if (!options.keyId.trim()) throw new Error('AWS KMS key ID is required.')
    const kmsConfig: KMSClientConfig = {}
    if (options.region) kmsConfig.region = options.region
    this.kms = options.kms ?? new KMSClient(kmsConfig)
    if (options.broadcaster) {
      this.broadcaster = options.broadcaster
    } else {
      if (!options.rpcUrl) throw new Error('Ethereum RPC URL is required.')
      this.broadcaster = createPublicClient({ transport: http(options.rpcUrl) })
    }
  }

  async address() {
    if (this.cachedAddress) return this.cachedAddress
    const result = await this.kms.send(new GetPublicKeyCommand({ KeyId: this.options.keyId }))
    if (!result.PublicKey) signerFailure('NFT_KMS_PUBLIC_KEY_MISSING', 'KMS returned no public key.')
    this.cachedAddress = ethereumAddressFromSpki(result.PublicKey)
    return this.cachedAddress
  }

  async signAndBroadcast(plan: ValidatedAssistedPlan) {
    const transaction = unsignedTransaction(plan)
    const unsignedSerialized = serializeTransaction(transaction)
    const digest = keccak256(unsignedSerialized)
    const result = await this.kms.send(new SignCommand({
      KeyId: this.options.keyId,
      Message: hexToBytes(digest),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    }))
    if (!result.Signature) signerFailure('NFT_KMS_SIGNATURE_MISSING', 'KMS returned no signature.')
    const decoded = decodeKmsDerSignature(result.Signature)
    const expectedAddress = await this.address()
    const r = toHex(decoded.r, { size: 32 })
    const s = toHex(decoded.s, { size: 32 })

    let serializedTransaction: Hex | undefined
    for (const yParity of [0, 1] as const) {
      const signature = { r, s, yParity, v: yParity === 0 ? 27n : 28n }
      const recovered = await recoverAddress({ hash: digest, signature })
      if (getAddress(recovered) === expectedAddress) {
        serializedTransaction = serializeTransaction(transaction, signature)
        break
      }
    }
    if (!serializedTransaction) {
      signerFailure('NFT_KMS_SIGNATURE_RECOVERY_FAILED', 'KMS signature does not recover to the configured treasury.')
    }
    const transactionHash = await this.broadcaster.sendRawTransaction({ serializedTransaction })
    return { transactionHash }
  }
}
