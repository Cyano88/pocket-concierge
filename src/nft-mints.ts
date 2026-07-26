import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { ConciergeError } from './errors.js'
import { calldataDigest, type NftChainGateway } from './nft-chain.js'
import type { NftMintStore } from './nft-store.js'
import type { CreateNftMintOrderInput, NftMintOrder } from './nft-types.js'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/
const COLLECTION_SLUG = /^[a-z0-9][a-z0-9-]{1,99}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const MIN_ASSISTED_REFUND_MAX_FEE_PER_GAS_WEI = 1_500_000_000n

export const NFT_MINT_SERVICE_FEE_ATOMIC = '1000000'
export const NFT_MINT_ORDER_ROUTE = '/v1/okx/nft-mints/orders'
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

  async prepareExecution(ownerId: string, externalId: string) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state !== 'armed' || !order.deposit) {
      throw new ConciergeError('NFT_ORDER_NOT_ARMED', 'A confirmed Ethereum deposit is required before mint preparation.', 409)
    }
    const now = this.dependencies.now()
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
    const [estimatedMintGas, maxFeePerGas] = await Promise.all([
      this.dependencies.chain.estimateMintGas(transaction, order.treasuryAddress),
      this.dependencies.chain.maxFeePerGas(),
    ])
    const gasLimit = estimatedMintGas * 120n / 100n
    const maximumExecutionCost = mintValue + maxFeePerGas * (
      gasLimit + this.dependencies.deliveryGasLimit + this.dependencies.refundGasLimit
    )
    if (
      maximumExecutionCost > BigInt(order.maxTotalCostWei)
      || maximumExecutionCost > BigInt(order.deposit.amountWei)
    ) {
      throw new ConciergeError('NFT_TOTAL_COST_LIMIT', 'Mint, delivery, and refund reserve exceed the funded spending cap.', 409)
    }
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
      maximumExecutionCostWei: maximumExecutionCost.toString(),
      expiresAt,
    }
    const expectedRevision = order.revision
    order.executionPlan = {
      planId: `nmp_${digest(planCore).slice(0, 32)}`,
      ...planCore,
      createdAt,
    }
    order.revision += 1
    order.updatedAt = createdAt
    await this.dependencies.store.update(order, expectedRevision)
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
      },
    }
  }

  async recordMint(ownerId: string, externalId: string, raw: unknown) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state === 'delivering' && order.mint) return publicOrder(order)
    if (order.state !== 'armed' || !order.executionPlan) {
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
      confirmedAt: new Date(this.dependencies.now()).toISOString(),
    }
    order.revision += 1
    order.updatedAt = order.mint.confirmedAt
    await this.dependencies.store.update(order, expectedRevision)
    return publicOrder(order)
  }

  async prepareDelivery(ownerId: string, externalId: string) {
    const order = await this.requireOrder(ownerId, externalId)
    if (order.state !== 'delivering' || !order.mint) {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', 'A verified mint is required before delivery preparation.', 409)
    }
    const now = this.dependencies.now()
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
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + this.dependencies.planTtlSeconds * 1000).toISOString()
    const planCore = {
      orderId: order.orderId,
      target: transaction.target,
      calldataHash: calldataDigest(transaction.calldata),
      valueWei: '0',
      gasLimit: gasLimit.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
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
    await this.dependencies.store.update(order, expectedRevision)
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
      confirmedAt: new Date(this.dependencies.now()).toISOString(),
    }
    order.revision += 1
    order.updatedAt = order.delivery.confirmedAt
    await this.dependencies.store.update(order, expectedRevision)
    return publicOrder(order)
  }

  async prepareRefund(ownerId: string, externalId: string) {
    const order = await this.requireOrder(ownerId, externalId)
    const now = this.dependencies.now()
    const expiredRefundPlan = order.state === 'refunding'
      && order.refundPlan
      && Date.parse(order.refundPlan.expiresAt) <= now
    if (
      (order.state !== 'delivered' && !expiredRefundPlan)
      || !order.deposit
      || !order.mint
      || !order.delivery
    ) {
      throw new ConciergeError('NFT_ORDER_STATE_INVALID', 'A delivered order with verified costs is required before refund preparation.', 409)
    }
    const maxFeePerGas = await this.dependencies.chain.maxFeePerGas()
    const percentageBufferedFee = (maxFeePerGas * 120n + 99n) / 100n
    const bufferedMaxFeePerGas = percentageBufferedFee > MIN_ASSISTED_REFUND_MAX_FEE_PER_GAS_WEI
      ? percentageBufferedFee
      : MIN_ASSISTED_REFUND_MAX_FEE_PER_GAS_WEI
    const spentBeforeRefund = BigInt(order.executionPlan?.valueWei ?? '0')
      + BigInt(order.mint.gasCostWei)
      + BigInt(order.delivery.gasCostWei)
    const refundGasReserve = bufferedMaxFeePerGas * this.dependencies.refundGasLimit
    const deposited = BigInt(order.deposit.amountWei)
    if (spentBeforeRefund + refundGasReserve >= deposited) {
      throw new ConciergeError('NFT_REFUND_BALANCE_INSUFFICIENT', 'No safely refundable ETH remains after execution and refund gas.', 409)
    }
    const amountWei = deposited - spentBeforeRefund - refundGasReserve
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + this.dependencies.planTtlSeconds * 1000).toISOString()
    const planCore = {
      orderId: order.orderId,
      target: order.refundAddress,
      calldataHash: calldataDigest('0x'),
      valueWei: amountWei.toString(),
      gasLimit: this.dependencies.refundGasLimit.toString(),
      maxFeePerGasWei: bufferedMaxFeePerGas.toString(),
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
    await this.dependencies.store.update(order, expectedRevision)
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
      confirmedAt: new Date(this.dependencies.now()).toISOString(),
    }
    order.revision += 1
    order.updatedAt = order.refund.confirmedAt
    await this.dependencies.store.update(order, expectedRevision)
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
