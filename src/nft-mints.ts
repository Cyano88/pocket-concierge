import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { ConciergeError } from './errors.js'
import { calldataDigest, type NftChainGateway } from './nft-chain.js'
import type { NftMintStore } from './nft-store.js'
import type { BuiltMintTransaction, CreateNftMintOrderInput, NftMintOrder } from './nft-types.js'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/
const COLLECTION_SLUG = /^[a-z0-9][a-z0-9-]{1,99}$/
const LEASE_OWNER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,79}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MIN_ASSISTED_REFUND_MAX_FEE_PER_GAS_WEI = 1_500_000_000n
const ASSISTED_REFUND_BALANCE_HEADROOM_PERCENT = 20n
const PREVIEW_FALLBACK_MINT_GAS_LIMIT = 350_000n
const CANCELLATION_REASONS = new Set(['customer_cancelled', 'mint_failed', 'order_expired'])

export const NFT_MINT_SERVICE_FEE_ATOMIC = '1000000'
export const NFT_MINT_ORDER_ROUTE = '/v1/okx/nft-mints/orders'
export const NFT_MINT_PREVIEW_ROUTE = '/v1/nft-mints/preview'
export const NFT_MINT_PUBLIC_PROOF_ROUTE = '/v1/public/nft-pilot'
export const NFT_MINT_ORDER_OUTPUT_SCHEMA = {
  input: {
    type: 'http',
    method: 'POST',
    bodyType: 'json',
    body: {
      type: 'object',
      additionalProperties: false,
      required: [
        'externalId',
        'collectionSlug',
        'nftContract',
        'nftRecipient',
        'refundAddress',
        'fundingAddress',
        'quantity',
        'maxMintPriceWei',
        'maxTotalCostWei',
        'expiresAt',
      ],
      properties: {
        externalId: { type: 'string', minLength: 8, maxLength: 128 },
        collectionSlug: { type: 'string', minLength: 2, maxLength: 100 },
        nftContract: { type: 'string', description: 'Expected Ethereum ERC-721 collection address.' },
        nftRecipient: { type: 'string', description: 'Ethereum address that will receive the NFT.' },
        refundAddress: { type: 'string', description: 'Ethereum address for unused or refunded execution capital.' },
        fundingAddress: { type: 'string', description: 'Ethereum address that will send the execution-capital deposit.' },
        quantity: { type: 'integer', const: 1 },
        maxMintPriceWei: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
        maxTotalCostWei: { type: 'string', pattern: '^[1-9][0-9]*$' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  },
  output: {
    deliverable: 'accepted bounded NFT mint execution order',
    orderAccessToken: 'secret capability used to read the order and confirm funding',
    next: 'exact Ethereum funding instruction',
    finalProof: 'authenticated status URL that accumulates mint, delivery, and refund evidence',
  },
} as const

type NftMintDependencies = {
  store: NftMintStore
  chain: NftChainGateway
  treasuryAddress: Address
  minimumConfirmations: number
  planTtlSeconds: number
  deliveryGasLimit: bigint
  refundGasLimit: bigint
  maximumOrderWei: bigint
  orderTokenSecret: string
  now: () => number
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function parseUint(value: unknown, name: string) {
  if (typeof value !== 'string' || !UINT.test(value)) {
    throw new ConciergeError('NFT_ORDER_INVALID', `${name} must be a non-negative decimal integer string.`)
  }
  return BigInt(value)
}

function address(value: unknown, name: string) {
  if (typeof value !== 'string' || !isAddress(value, { strict: true })) {
    throw new ConciergeError('NFT_ORDER_INVALID', `${name} must be a valid Ethereum address.`)
  }
  const normalized = getAddress(value)
  if (normalized === ZERO_ADDRESS) {
    throw new ConciergeError('NFT_ORDER_INVALID', `${name} cannot be the zero address.`)
  }
  return normalized
}

function validateInput(raw: unknown, now: number): CreateNftMintOrderInput & {
  nftContract: Address
  nftRecipient: Address
  refundAddress: Address
  fundingAddress: Address
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConciergeError('NFT_ORDER_INVALID', 'NFT mint order must be a JSON object.')
  }
  const input = raw as Record<string, unknown>
  if (typeof input.externalId !== 'string' || !SAFE_ID.test(input.externalId)) {
    throw new ConciergeError('NFT_ORDER_INVALID', 'externalId must be 8-128 safe characters.')
  }
  if (typeof input.collectionSlug !== 'string' || !COLLECTION_SLUG.test(input.collectionSlug)) {
    throw new ConciergeError('NFT_ORDER_INVALID', 'collectionSlug must be a lowercase collection slug.')
  }
  if (input.quantity !== 1) {
    throw new ConciergeError('NFT_QUANTITY_UNSUPPORTED', 'The pilot supports exactly one NFT per order.')
  }
  const maxMintPrice = parseUint(input.maxMintPriceWei, 'maxMintPriceWei')
  const maxTotalCost = parseUint(input.maxTotalCostWei, 'maxTotalCostWei')
  if (maxTotalCost === 0n || maxMintPrice > maxTotalCost) {
    throw new ConciergeError('NFT_ORDER_INVALID', 'maxTotalCostWei must be positive and cover maxMintPriceWei.')
  }
  if (typeof input.expiresAt !== 'string') {
    throw new ConciergeError('NFT_ORDER_INVALID', 'expiresAt must be an ISO-8601 timestamp.')
  }
  const expiresAt = Date.parse(input.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt < now + 120_000 || expiresAt > now + 30 * 24 * 60 * 60 * 1000) {
    throw new ConciergeError('NFT_ORDER_INVALID', 'expiresAt must be between 2 minutes and 30 days from now.')
  }
  return {
    externalId: input.externalId,
    collectionSlug: input.collectionSlug,
    nftContract: address(input.nftContract, 'nftContract'),
    nftRecipient: address(input.nftRecipient, 'nftRecipient'),
    refundAddress: address(input.refundAddress, 'refundAddress'),
    fundingAddress: address(input.fundingAddress, 'fundingAddress'),
    quantity: 1,
    maxMintPriceWei: maxMintPrice.toString(),
    maxTotalCostWei: maxTotalCost.toString(),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

function publicOrder(order: NftMintOrder) {
  const { ownerId: _ownerId, ...visible } = structuredClone(order)
  return visible
}

export class NftMintService {
  constructor(private readonly dependencies: NftMintDependencies) {}

  async preview(raw: unknown) {
    const input = validateInput(raw, this.dependencies.now())
    this.assertOrderLimit(input)
    const transaction = await this.dependencies.chain.buildMint(
      input.collectionSlug,
      input.nftContract,
      this.dependencies.treasuryAddress,
    )
    this.dependencies.chain.validateMint(
      transaction,
      input.nftContract,
      this.dependencies.treasuryAddress,
    )
    const mintPriceWei = BigInt(transaction.valueWei)
    if (mintPriceWei > BigInt(input.maxMintPriceWei)) {
      throw new ConciergeError('NFT_MINT_PRICE_LIMIT', 'Current mint price exceeds the customer mandate.', 409)
    }
    const { mintGasLimit, maxFeePerGas, estimationMode } = await this.estimateExecution(transaction, true)
    const maximumEstimatedTotalWei = mintPriceWei + maxFeePerGas * (
      mintGasLimit + this.dependencies.deliveryGasLimit + this.dependencies.refundGasLimit
    )
    if (maximumEstimatedTotalWei > BigInt(input.maxTotalCostWei)) {
      throw new ConciergeError(
        'NFT_TOTAL_COST_LIMIT',
        'Current mint, delivery, and refund reserve exceed the customer spending cap.',
        409,
      )
    }
    const manifest = {
      ...input,
      chainId: 1,
      treasuryAddress: this.dependencies.treasuryAddress,
      requiredDepositWei: input.maxTotalCostWei,
    }
    return {
      supported: true,
      checkedAt: new Date(this.dependencies.now()).toISOString(),
      scope: {
        network: 'ethereum-mainnet',
        mintMechanism: 'official-seadrop-1.0-public-drop',
        quantity: 1,
      },
      quote: {
        currentMintPriceWei: mintPriceWei.toString(),
        maxFeePerGasWei: maxFeePerGas.toString(),
        mintGasLimit: mintGasLimit.toString(),
        estimationMode,
        deliveryGasReserve: this.dependencies.deliveryGasLimit.toString(),
        refundGasReserve: this.dependencies.refundGasLimit.toString(),
        maximumEstimatedTotalWei: maximumEstimatedTotalWei.toString(),
        requiredDepositWei: input.maxTotalCostWei,
        serviceFee: {
          network: 'eip155:196',
          asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
          amountAtomic: NFT_MINT_SERVICE_FEE_ATOMIC,
          display: '1 USDT',
        },
      },
      mandate: {
        manifestHash: digest(manifest),
        expiresAt: input.expiresAt,
        withinLimits: true,
      },
      next: {
        action: 'create_paid_order',
        endpoint: NFT_MINT_ORDER_ROUTE,
        warning: 'Do not deposit ETH until the paid replay returns the exact treasury and order capability.',
      },
    }
  }

  async assertCreatable(ownerId: string, raw: unknown) {
    const input = validateInput(raw, this.dependencies.now())
    this.assertOrderLimit(input)
    const manifestHash = digest({
      ...input,
      chainId: 1,
      treasuryAddress: this.dependencies.treasuryAddress,
      requiredDepositWei: input.maxTotalCostWei,
    })
    const existing = await this.dependencies.store.get(ownerId, input.externalId)
    if (existing && existing.manifestHash !== manifestHash) {
      throw new ConciergeError('NFT_ORDER_CONFLICT', 'externalId already belongs to a different immutable NFT mint order.', 409)
    }
  }

  async create(ownerId: string, raw: unknown) {
    const now = this.dependencies.now()
    const input = validateInput(raw, now)
    this.assertOrderLimit(input)
    const immutable = {
      ...input,
      chainId: 1,
      treasuryAddress: this.dependencies.treasuryAddress,
      requiredDepositWei: input.maxTotalCostWei,
    }
    const manifestHash = digest(immutable)
    const createdAt = new Date(now).toISOString()
    const candidate: NftMintOrder = {
      ownerId,
      orderId: `nmo_${digest({ ownerId, externalId: input.externalId }).slice(0, 24)}`,
      externalId: input.externalId,
      manifestHash,
      revision: 0,
      state: 'awaiting_funding',
      chainId: 1,
      collectionSlug: input.collectionSlug,
      nftContract: input.nftContract,
      nftRecipient: input.nftRecipient,
      refundAddress: input.refundAddress,
      fundingAddress: input.fundingAddress,
      treasuryAddress: this.dependencies.treasuryAddress,
      quantity: 1,
      maxMintPriceWei: input.maxMintPriceWei,
      maxTotalCostWei: input.maxTotalCostWei,
      requiredDepositWei: input.maxTotalCostWei,
      expiresAt: input.expiresAt,
      createdAt,
      updatedAt: createdAt,
    }
    const result = await this.dependencies.store.putIfAbsent(candidate)
    if (result.order.manifestHash !== manifestHash) {
      throw new ConciergeError('NFT_ORDER_CONFLICT', 'externalId already belongs to a different immutable NFT mint order.', 409)
    }
    return {
      replayed: !result.inserted,
      order: publicOrder(result.order),
      orderAccessToken: this.accessToken(result.order),
    }
  }

  async get(ownerId: string, externalId: string) {
    return publicOrder(await this.requireOrder(ownerId, externalId))
  }

  async publicProof(ownerId: string, externalId: string, servicePaymentTransactionHash: string) {
    if (!TX_HASH.test(servicePaymentTransactionHash)) {
      throw new ConciergeError('NFT_PROOF_NOT_CONFIGURED', 'The NFT service-payment proof is not configured.', 503)
    }
    const order = await this.requireOrder(ownerId, externalId)
    if (
      order.state !== 'refunded'
      || !order.deposit
      || !order.mint
      || !order.delivery
      || !order.refund
    ) {
      throw new ConciergeError('NFT_PROOF_NOT_READY', 'The configured NFT pilot is not fully verified.', 503)
    }
    const totalExecutionGasWei = (
      BigInt(order.mint.gasCostWei)
      + BigInt(order.delivery.gasCostWei)
      + BigInt(order.refund.gasCostWei)
    ).toString()
    const proof = {
      proofVersion: '1',
      service: 'Pocket NFT Mint & Deliver',
      status: 'verified_complete',
      network: 'ethereum-mainnet',
      mandate: {
        manifestHash: order.manifestHash,
        quantity: order.quantity,
        maxMintPriceWei: order.maxMintPriceWei,
        maxTotalCostWei: order.maxTotalCostWei,
      },
      purchase: {
        collection: order.collectionSlug,
        nftContract: order.nftContract,
        tokenId: order.mint.tokenId,
        recipient: order.nftRecipient,
      },
      settlement: {
        servicePayment: {
          network: 'eip155:196',
          asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
          amountAtomic: NFT_MINT_SERVICE_FEE_ATOMIC,
          transactionHash: servicePaymentTransactionHash,
        },
        executionFunding: {
          amountWei: order.deposit.amountWei,
          transactionHash: order.deposit.transactionHash,
        },
        mint: {
          transactionHash: order.mint.transactionHash,
          gasCostWei: order.mint.gasCostWei,
          transactionNonce: order.mint.transactionNonce,
        },
        delivery: {
          transactionHash: order.delivery.transactionHash,
          gasCostWei: order.delivery.gasCostWei,
          transactionNonce: order.delivery.transactionNonce,
        },
        refund: {
          transactionHash: order.refund.transactionHash,
          amountWei: order.refund.amountWei,
          gasCostWei: order.refund.gasCostWei,
          transactionNonce: order.refund.transactionNonce,
        },
        totalExecutionGasWei,
      },
      verifiedAt: order.refund.confirmedAt,
    }
    const proofHash = digest(proof)
    return {
      proofId: `nfp_${proofHash.slice(0, 24)}`,
      proofHash,
      ...proof,
      privacy: {
        includes: ['public chain addresses', 'transaction hashes', 'amounts', 'NFT contract and token ID'],
        excludes: ['wallet credentials', 'order access token', 'operator key', 'customer account references'],
      },
      explorers: {
        xLayerServicePayment: `https://www.oklink.com/x-layer/tx/${servicePaymentTransactionHash}`,
        ethereumFunding: `https://eth.blockscout.com/tx/${order.deposit.transactionHash}`,
        ethereumMint: `https://eth.blockscout.com/tx/${order.mint.transactionHash}`,
        ethereumDelivery: `https://eth.blockscout.com/tx/${order.delivery.transactionHash}`,
        ethereumRefund: `https://eth.blockscout.com/tx/${order.refund.transactionHash}`,
        nftOwner: `https://eth.blockscout.com/token/${order.nftContract}/instance/${order.mint.tokenId}`,
      },
    }
  }

  async authenticateOrder(ownerId: string, externalId: string, suppliedToken: string | undefined) {
    const order = await this.requireOrder(ownerId, externalId)
    const expected = Buffer.from(this.accessToken(order))
    const supplied = Buffer.from(String(suppliedToken ?? ''))
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new ConciergeError('NFT_ORDER_UNAUTHORIZED', 'A valid NFT order access token is required.', 401)
    }
    return publicOrder(order)
  }

  async confirmFunding(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'armed' && order.deposit) return publicOrder(order)
    if (order.state !== 'awaiting_funding') {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', `Funding cannot be confirmed while order is ${order.state}.`, 409)
    }
    if (Date.parse(order.expiresAt) <= this.dependencies.now()) {
      await this.expire(order)
      throw new ConciergeError('NFT_ORDER_EXPIRED', 'NFT mint order expired before funding confirmation.', 409)
    }
    const transactionHash = (
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).depositTransactionHash
        : undefined
    )
    if (typeof transactionHash !== 'string' || !TX_HASH.test(transactionHash)) {
      throw new ConciergeError('NFT_DEPOSIT_INVALID', 'depositTransactionHash must be a full Ethereum transaction hash.')
    }
    const deposit = await this.dependencies.chain.verifyDeposit(transactionHash as Hex)
    if (deposit.from !== order.fundingAddress || deposit.to !== order.treasuryAddress) {
      throw new ConciergeError('NFT_DEPOSIT_MISMATCH', 'Deposit sender or treasury destination does not match the immutable order.', 409)
    }
    if (BigInt(deposit.valueWei) < BigInt(order.requiredDepositWei)) {
      throw new ConciergeError('NFT_DEPOSIT_INSUFFICIENT', 'Ethereum deposit is below the order funding requirement.', 409)
    }
    if (deposit.confirmations < this.dependencies.minimumConfirmations) {
      throw new ConciergeError(
        'NFT_DEPOSIT_CONFIRMING',
        `Ethereum deposit has ${deposit.confirmations} confirmation(s); ${this.dependencies.minimumConfirmations} required.`,
        409,
      )
    }
    const expectedRevision = order.revision
    order.state = 'armed'
    order.revision += 1
    order.updatedAt = new Date(this.dependencies.now()).toISOString()
    order.deposit = {
      transactionHash: deposit.transactionHash,
      amountWei: deposit.valueWei,
      blockNumber: deposit.blockNumber.toString(),
      confirmations: deposit.confirmations,
      confirmedAt: order.updatedAt,
    }
    await this.dependencies.store.claimDeposit(order, expectedRevision, deposit.transactionHash)
    return publicOrder(order)
  }

  async prepareExecution(ownerId: string, externalId: string, leaseOwnerRaw: string) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state !== 'armed' || !order.deposit) {
      throw new ConciergeError('NFT_ORDER_NOT_ARMED', 'A confirmed Ethereum deposit is required before mint preparation.', 409)
    }
    const now = this.dependencies.now()
    const leaseOwner = this.validateLeaseOwner(leaseOwnerRaw)
    if (Date.parse(order.expiresAt) <= now) {
      await this.expire(order)
      throw new ConciergeError('NFT_ORDER_EXPIRED', 'NFT mint order expired before execution.', 409)
    }
    const transaction = await this.dependencies.chain.buildMint(
      order.collectionSlug,
      order.nftContract,
      order.treasuryAddress,
    )
    this.dependencies.chain.validateMint(transaction, order.nftContract, order.treasuryAddress)
    const mintValue = BigInt(transaction.valueWei)
    if (mintValue > BigInt(order.maxMintPriceWei)) {
      throw new ConciergeError('NFT_MINT_PRICE_LIMIT', 'Current mint price exceeds the customer mandate.', 409)
    }
    const { mintGasLimit: gasLimit, maxFeePerGas } = await this.estimateExecution(transaction)
    const maximumExecutionCost = mintValue + maxFeePerGas * (
      gasLimit + this.dependencies.deliveryGasLimit + this.dependencies.refundGasLimit
    )
    if (
      maximumExecutionCost > BigInt(order.maxTotalCostWei)
      || maximumExecutionCost > BigInt(order.deposit.amountWei)
    ) {
      throw new ConciergeError('NFT_TOTAL_COST_LIMIT', 'Mint, delivery, and refund reserve exceed the funded spending cap.', 409)
    }
    const transactionNonce = await this.pendingNonce(order.treasuryAddress)
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(Math.min(
      now + this.dependencies.planTtlSeconds * 1000,
      Date.parse(order.expiresAt),
    )).toISOString()
    const planCore = {
      orderId: order.orderId,
      target: transaction.target,
      calldataHash: calldataDigest(transaction.calldata),
      valueWei: transaction.valueWei,
      gasLimit: gasLimit.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      transactionNonce: transactionNonce.toString(),
      leaseOwner,
      leaseExpiresAt: expiresAt,
      executionAttempt: 1,
      maximumExecutionCostWei: maximumExecutionCost.toString(),
      expiresAt,
    }
    const expectedRevision = order.revision
    order.state = 'minting'
    order.executionPlan = {
      planId: `nmp_${digest(planCore).slice(0, 32)}`,
      ...planCore,
      createdAt,
    }
    order.revision += 1
    order.updatedAt = createdAt
    await this.dependencies.store.claimExecutionLease(order, expectedRevision, createdAt, 'mint')
    return {
      order: publicOrder(order),
      transaction: {
        chainId: 1,
        from: order.treasuryAddress,
        to: transaction.target,
        data: transaction.calldata,
        valueWei: transaction.valueWei,
        gasLimit: gasLimit.toString(),
        maxFeePerGasWei: maxFeePerGas.toString(),
        nonce: transactionNonce.toString(),
      },
    }
  }

  async recordMint(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'delivering' && order.mint) return publicOrder(order)
    if (order.state !== 'minting' || !order.executionPlan) {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', 'A current execution plan is required before recording a mint.', 409)
    }
    const transactionHash = this.transactionHash(raw, 'mintTransactionHash')
    const mint = await this.dependencies.chain.verifyMint(
      transactionHash,
      order.nftContract,
      order.treasuryAddress,
    )
    if (
      mint.from !== order.treasuryAddress
      || mint.to !== order.executionPlan.target
      || calldataDigest(mint.calldata) !== order.executionPlan.calldataHash
      || mint.valueWei !== order.executionPlan.valueWei
      || mint.nonce.toString() !== order.executionPlan.transactionNonce
    ) {
      throw new ConciergeError('NFT_MINT_TRANSACTION_MISMATCH', 'Mint transaction does not match the approved execution plan.', 409)
    }
    if (mint.confirmations < this.dependencies.minimumConfirmations) {
      throw new ConciergeError('NFT_MINT_CONFIRMING', 'Mint transaction has insufficient confirmations.', 409)
    }
    const expectedRevision = order.revision
    order.state = 'delivering'
    order.mint = {
      transactionHash: mint.transactionHash,
      tokenId: mint.tokenId.toString(),
      blockNumber: mint.blockNumber.toString(),
      gasCostWei: mint.gasCostWei.toString(),
      transactionNonce: mint.nonce.toString(),
      confirmedAt: new Date(this.dependencies.now()).toISOString(),
    }
    order.revision += 1
    order.updatedAt = order.mint.confirmedAt
    await this.dependencies.store.completeExecutionLease(
      order,
      expectedRevision,
      'mint',
      order.mint.confirmedAt,
    )
    return publicOrder(order)
  }

  async recordFailedMint(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'failed' && order.failedMint) return publicOrder(order)
    if (order.state !== 'minting' || !order.executionPlan) {
      throw new ConciergeError(
        'NFT_ORDER_STATE_INVALID',
        'A claimed execution lease is required before recording a failed mint.',
        409,
      )
    }
    const transactionHash = this.transactionHash(raw, 'mintTransactionHash')
    const failed = await this.dependencies.chain.verifyFailedMint(
      transactionHash,
      order.treasuryAddress,
      order.executionPlan.target,
      order.executionPlan.calldataHash as Hex,
      BigInt(order.executionPlan.valueWei),
      Number(order.executionPlan.transactionNonce),
    )
    if (failed.confirmations < this.dependencies.minimumConfirmations) {
      throw new ConciergeError('NFT_MINT_CONFIRMING', 'Failed mint transaction has insufficient confirmations.', 409)
    }
    const expectedRevision = order.revision
    const recordedAt = new Date(this.dependencies.now()).toISOString()
    order.state = 'failed'
    order.failedMint = {
      transactionHash: failed.transactionHash,
      blockNumber: failed.blockNumber.toString(),
      gasCostWei: failed.gasCostWei.toString(),
      transactionNonce: failed.nonce.toString(),
      confirmedAt: recordedAt,
    }
    order.failure = {
      code: 'NFT_MINT_REVERTED',
      message: 'The reserved Ethereum mint transaction reverted; verified gas will be deducted before refund.',
      recordedAt,
    }
    order.revision += 1
    order.updatedAt = recordedAt
    await this.dependencies.store.completeExecutionLease(order, expectedRevision, 'mint', recordedAt)
    return publicOrder(order)
  }

  async cancel(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'cancelled' || order.state === 'refunding' || order.state === 'refunded') {
      return publicOrder(order)
    }
    const suppliedReason = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).reason
      : undefined
    const reason = typeof suppliedReason === 'string' && suppliedReason
      ? suppliedReason
      : 'customer_cancelled'
    if (!CANCELLATION_REASONS.has(reason)) {
      throw new ConciergeError(
        'NFT_CANCELLATION_INVALID',
        'reason must be customer_cancelled, mint_failed, or order_expired.',
      )
    }
    if (order.state === 'minting') {
      throw new ConciergeError(
        'NFT_EXECUTION_OUTCOME_REQUIRED',
        'The reserved mint nonce must be recovered as successful or failed before cancellation.',
        409,
      )
    }
    if (order.state !== 'awaiting_funding' && order.state !== 'armed' && order.state !== 'failed') {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', `Order cannot be cancelled while ${order.state}.`, 409)
    }
    const expectedRevision = order.revision
    const requestedAt = new Date(this.dependencies.now()).toISOString()
    order.cancellation = { requestedAt, reason }
    order.state = order.deposit ? 'cancelling' : 'cancelled'
    order.revision += 1
    order.updatedAt = requestedAt
    await this.dependencies.store.update(order, expectedRevision)
    return publicOrder(order)
  }

  async prepareDelivery(ownerId: string, externalId: string, leaseOwnerRaw: string) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state !== 'delivering' || !order.mint) {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', 'A verified mint is required before delivery preparation.', 409)
    }
    const now = this.dependencies.now()
    const leaseOwner = this.validateLeaseOwner(leaseOwnerRaw)
    const [transaction, maxFeePerGas] = await Promise.all([
      this.dependencies.chain.prepareDelivery(
        order.nftContract,
        order.treasuryAddress,
        order.nftRecipient,
        BigInt(order.mint.tokenId),
      ),
      this.dependencies.chain.maxFeePerGas(),
    ])
    const gasLimit = transaction.gasLimit * 120n / 100n
    if (gasLimit > this.dependencies.deliveryGasLimit) {
      throw new ConciergeError('NFT_DELIVERY_GAS_LIMIT', 'NFT delivery exceeds the reserved gas limit.', 409)
    }
    const transactionNonce = await this.pendingNonce(order.treasuryAddress)
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + this.dependencies.planTtlSeconds * 1000).toISOString()
    const planCore = {
      orderId: order.orderId,
      target: transaction.target,
      calldataHash: calldataDigest(transaction.calldata),
      valueWei: '0',
      gasLimit: gasLimit.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      transactionNonce: transactionNonce.toString(),
      leaseOwner,
      leaseExpiresAt: expiresAt,
      executionAttempt: (order.deliveryPlan?.executionAttempt ?? 0) + 1,
      expiresAt,
    }
    const expectedRevision = order.revision
    order.deliveryPlan = {
      planId: `ndp_${digest(planCore).slice(0, 32)}`,
      ...planCore,
      createdAt,
    }
    order.revision += 1
    order.updatedAt = createdAt
    await this.dependencies.store.claimExecutionLease(order, expectedRevision, createdAt, 'deliver')
    return {
      order: publicOrder(order),
      transaction: {
        chainId: 1,
        from: order.treasuryAddress,
        to: transaction.target,
        data: transaction.calldata,
        valueWei: '0',
        gasLimit: gasLimit.toString(),
        maxFeePerGasWei: maxFeePerGas.toString(),
        nonce: transactionNonce.toString(),
      },
    }
  }

  async recordDelivery(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'delivered' && order.delivery) return publicOrder(order)
    if (order.state !== 'delivering' || !order.mint || !order.deliveryPlan) {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', 'A current delivery plan is required before recording delivery.', 409)
    }
    const transactionHash = this.transactionHash(raw, 'deliveryTransactionHash')
    const delivery = await this.dependencies.chain.verifyDelivery(
      transactionHash,
      order.nftContract,
      order.treasuryAddress,
      order.nftRecipient,
      BigInt(order.mint.tokenId),
    )
    if (
      delivery.from !== order.treasuryAddress
      || delivery.to !== order.nftContract
      || calldataDigest(delivery.calldata) !== order.deliveryPlan.calldataHash
      || delivery.valueWei !== '0'
      || delivery.nonce.toString() !== order.deliveryPlan.transactionNonce
      || delivery.tokenId !== BigInt(order.mint.tokenId)
      || delivery.confirmations < this.dependencies.minimumConfirmations
    ) {
      throw new ConciergeError('NFT_DELIVERY_MISMATCH', 'NFT delivery is not a confirmed transfer from the Pocket treasury.', 409)
    }
    const expectedRevision = order.revision
    order.state = 'delivered'
    order.delivery = {
      transactionHash: delivery.transactionHash,
      blockNumber: delivery.blockNumber.toString(),
      gasCostWei: delivery.gasCostWei.toString(),
      transactionNonce: delivery.nonce.toString(),
      confirmedAt: new Date(this.dependencies.now()).toISOString(),
    }
    order.revision += 1
    order.updatedAt = order.delivery.confirmedAt
    await this.dependencies.store.completeExecutionLease(
      order,
      expectedRevision,
      'deliver',
      order.delivery.confirmedAt,
    )
    return publicOrder(order)
  }

  async prepareRefund(ownerId: string, externalId: string, leaseOwnerRaw: string) {
    const order = await this.requireOrder(ownerId, externalId)
    const now = this.dependencies.now()
    const leaseOwner = this.validateLeaseOwner(leaseOwnerRaw)
    const expiredRefundPlan = order.state === 'refunding'
      && order.refundPlan
      && Date.parse(order.refundPlan.expiresAt) <= now
    const deliveredOrder = order.state === 'delivered' && order.mint && order.delivery
    const cancelledBeforeMint = order.state === 'cancelling' && !order.mint && !order.delivery
    if ((!deliveredOrder && !cancelledBeforeMint && !expiredRefundPlan) || !order.deposit) {
      throw new ConciergeError(
        'NFT_ORDER_STATE_INVALID',
        'A delivered order or funded pre-mint cancellation is required before refund preparation.',
        409,
      )
    }
    const maxFeePerGas = await this.dependencies.chain.maxFeePerGas()
    const percentageBufferedFee = (maxFeePerGas * 120n + 99n) / 100n
    const bufferedMaxFeePerGas = percentageBufferedFee > MIN_ASSISTED_REFUND_MAX_FEE_PER_GAS_WEI
      ? percentageBufferedFee
      : MIN_ASSISTED_REFUND_MAX_FEE_PER_GAS_WEI
    const spentBeforeRefund = deliveredOrder
      ? BigInt(order.executionPlan?.valueWei ?? '0')
        + BigInt(order.mint!.gasCostWei)
        + BigInt(order.delivery!.gasCostWei)
      : BigInt(order.failedMint?.gasCostWei ?? '0')
    const refundGasReserve = bufferedMaxFeePerGas * this.dependencies.refundGasLimit
    // OKX's assisted-wallet preflight applies its own fee allowance and rejects
    // transactions that sweep the balance exactly, even when the explicit gas
    // reserve equals gasLimit * maxFeePerGas. Keep independent headroom so the
    // bounded refund remains executable without silently raising its fee cap.
    const walletBalanceHeadroom = (
      refundGasReserve * ASSISTED_REFUND_BALANCE_HEADROOM_PERCENT + 99n
    ) / 100n
    const totalRefundReserve = refundGasReserve + walletBalanceHeadroom
    const deposited = BigInt(order.deposit.amountWei)
    if (spentBeforeRefund + totalRefundReserve >= deposited) {
      throw new ConciergeError('NFT_REFUND_BALANCE_INSUFFICIENT', 'No safely refundable ETH remains after execution and refund gas.', 409)
    }
    const amountWei = deposited - spentBeforeRefund - totalRefundReserve
    const transactionNonce = expiredRefundPlan
      ? Number(order.refundPlan!.transactionNonce)
      : await this.pendingNonce(order.treasuryAddress)
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + this.dependencies.planTtlSeconds * 1000).toISOString()
    const planCore = {
      orderId: order.orderId,
      target: order.refundAddress,
      calldataHash: calldataDigest('0x'),
      valueWei: amountWei.toString(),
      gasLimit: this.dependencies.refundGasLimit.toString(),
      maxFeePerGasWei: bufferedMaxFeePerGas.toString(),
      transactionNonce: transactionNonce.toString(),
      leaseOwner,
      leaseExpiresAt: expiresAt,
      executionAttempt: (order.refundPlan?.executionAttempt ?? 0) + 1,
      amountWei: amountWei.toString(),
      expiresAt,
    }
    const expectedRevision = order.revision
    order.state = 'refunding'
    order.refundPlan = {
      planId: `nrp_${digest(planCore).slice(0, 32)}`,
      ...planCore,
      createdAt,
    }
    order.revision += 1
    order.updatedAt = createdAt
    await this.dependencies.store.claimExecutionLease(order, expectedRevision, createdAt, 'refund')
    return {
      order: publicOrder(order),
      transaction: {
        chainId: 1,
        from: order.treasuryAddress,
        to: order.refundAddress,
        data: '0x',
        valueWei: amountWei.toString(),
        gasLimit: this.dependencies.refundGasLimit.toString(),
        maxFeePerGasWei: bufferedMaxFeePerGas.toString(),
        nonce: transactionNonce.toString(),
      },
    }
  }

  async recordRefund(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'refunded' && order.refund) return publicOrder(order)
    if (order.state !== 'refunding' || !order.refundPlan?.amountWei) {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', 'A current refund plan is required before recording a refund.', 409)
    }
    const transactionHash = this.transactionHash(raw, 'refundTransactionHash')
    const refund = await this.dependencies.chain.verifyRefund(
      transactionHash,
      order.treasuryAddress,
      order.refundAddress,
      BigInt(order.refundPlan.amountWei),
    )
    if (
      refund.from !== order.treasuryAddress
      || refund.to !== order.refundAddress
      || refund.valueWei !== order.refundPlan.amountWei
      || refund.nonce.toString() !== order.refundPlan.transactionNonce
      || refund.confirmations < this.dependencies.minimumConfirmations
    ) {
      throw new ConciergeError('NFT_REFUND_MISMATCH', 'Refund is not a confirmed exact transfer to the declared refund address.', 409)
    }
    const expectedRevision = order.revision
    order.state = 'refunded'
    order.refund = {
      transactionHash: refund.transactionHash,
      amountWei: refund.valueWei,
      blockNumber: refund.blockNumber.toString(),
      gasCostWei: refund.gasCostWei.toString(),
      transactionNonce: refund.nonce.toString(),
      confirmedAt: new Date(this.dependencies.now()).toISOString(),
    }
    order.revision += 1
    order.updatedAt = order.refund.confirmedAt
    await this.dependencies.store.completeExecutionLease(
      order,
      expectedRevision,
      'refund',
      order.refund.confirmedAt,
    )
    return publicOrder(order)
  }

  private transactionHash(raw: unknown, field: string) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)[field]
      : undefined
    if (typeof value !== 'string' || !TX_HASH.test(value)) {
      throw new ConciergeError('NFT_TRANSACTION_INVALID', `${field} must be a full Ethereum transaction hash.`)
    }
    return value as Hex
  }

  private async requireOrder(ownerId: string, externalId: string) {
    const order = await this.dependencies.store.get(ownerId, externalId)
    if (!order) throw new ConciergeError('NFT_ORDER_NOT_FOUND', 'NFT mint order was not found.', 404)
    return order
  }

  private assertOrderLimit(input: CreateNftMintOrderInput) {
    if (BigInt(input.maxTotalCostWei) > this.dependencies.maximumOrderWei) {
      throw new ConciergeError('NFT_ORDER_LIMIT_EXCEEDED', 'maxTotalCostWei exceeds the configured pilot limit.', 409)
    }
  }

  private validateLeaseOwner(raw: string) {
    const leaseOwner = String(raw || '').trim()
    if (!LEASE_OWNER.test(leaseOwner)) {
      throw new ConciergeError(
        'NFT_EXECUTION_LEASE_INVALID',
        'X-Worker-Id must contain 3-80 safe characters.',
        400,
      )
    }
    return leaseOwner
  }

  private async pendingNonce(treasuryAddress: Address) {
    try {
      return await this.dependencies.chain.pendingNonce(treasuryAddress)
    } catch {
      throw new ConciergeError(
        'NFT_EXECUTION_NONCE_UNAVAILABLE',
        'Ethereum pending nonce is currently unavailable; no execution lease was claimed.',
        503,
      )
    }
  }

  private async estimateExecution(transaction: BuiltMintTransaction, allowGasFallback = false) {
    let maxFeePerGas: bigint
    try {
      maxFeePerGas = await this.dependencies.chain.maxFeePerGas()
    } catch {
      throw new ConciergeError(
        'NFT_EXECUTION_ESTIMATE_UNAVAILABLE',
        'Ethereum fee data is currently unavailable. No order or deposit was accepted.',
        503,
      )
    }
    try {
      const estimatedMintGas = await this.dependencies.chain.estimateMintGas(
        transaction,
        this.dependencies.treasuryAddress,
      )
      return {
        mintGasLimit: estimatedMintGas * 120n / 100n,
        maxFeePerGas,
        estimationMode: 'live-simulation' as const,
      }
    } catch {
      if (allowGasFallback) {
        return {
          mintGasLimit: PREVIEW_FALLBACK_MINT_GAS_LIMIT,
          maxFeePerGas,
          estimationMode: 'conservative-fallback' as const,
        }
      }
      throw new ConciergeError(
        'NFT_EXECUTION_ESTIMATE_UNAVAILABLE',
        'Ethereum could not currently simulate the bounded mint from the execution treasury. No order or deposit was accepted.',
        503,
      )
    }
  }

  private accessToken(order: NftMintOrder) {
    const signature = createHmac('sha256', this.dependencies.orderTokenSecret)
      .update(`${order.ownerId}:${order.externalId}:${order.manifestHash}`)
      .digest('base64url')
    return `nmt_${signature}`
  }

  private async expire(order: NftMintOrder) {
    const expectedRevision = order.revision
    order.state = 'expired'
    order.revision += 1
    order.updatedAt = new Date(this.dependencies.now()).toISOString()
    await this.dependencies.store.update(order, expectedRevision)
  }
}
