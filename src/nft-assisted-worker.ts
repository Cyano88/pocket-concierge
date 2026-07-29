import {
  decodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { ConciergeError } from './errors.js'
import { SEADROP_1_0 } from './nft-chain.js'

const UINT = /^(0|[1-9][0-9]*)$/
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ZERO_ADDRESS = getAddress('0x0000000000000000000000000000000000000000')
const SEADROP_MINT_ABI = parseAbi([
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
])
const ERC721_TRANSFER_ABI = parseAbi([
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
])

export type AssistedNftAction = 'mint' | 'deliver' | 'refund'

export type AssistedTransaction = {
  chainId: 1
  from: Address
  to: Address
  data: Hex
  valueWei: string
  gasLimit: string
  maxFeePerGasWei: string
  maxPriorityFeePerGasWei: string
  nonce: string
  notBefore?: string
}

export type ValidatedAssistedPlan = {
  action: AssistedNftAction
  externalId: string
  orderId: string
  planId: string
  expiresAt: string
  notBefore?: string
  transaction: AssistedTransaction
}

export type AssistedPlanConstraints = {
  action: AssistedNftAction
  externalId: string
  treasuryAddress: string
  workerId: string
  maximumFeePerGasWei: string
  maximumMintGasLimit?: string
  maximumDeliveryGasLimit?: string
  maximumRefundGasLimit?: string
  minimumRemainingMs?: number
  maximumPlanLifetimeMs?: number
  now?: number
}

export function assistedWalletArguments(plan: ValidatedAssistedPlan) {
  if (plan.action === 'refund') {
    return [
      'wallet',
      'send',
      '--chain',
      'ethereum',
      '--from',
      plan.transaction.from,
      '--recipient',
      plan.transaction.to,
      '--amt',
      plan.transaction.valueWei,
    ]
  }
  return [
    'wallet',
    'contract-call',
    '--chain',
    'ethereum',
    '--from',
    plan.transaction.from,
    '--to',
    plan.transaction.to,
    '--amt',
    plan.transaction.valueWei,
    '--input-data',
    plan.transaction.data,
    '--gas-limit',
    plan.transaction.gasLimit,
    '--biz-type',
    'dapp',
    '--strategy',
    'pocket-nft-assisted-worker',
  ]
}

function fail(message: string): never {
  throw new ConciergeError('NFT_WORKER_PLAN_INVALID', message, 409)
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value) fail(`${name} must be a non-empty string.`)
  return value
}

function uint(value: unknown, name: string) {
  const parsed = text(value, name)
  if (!UINT.test(parsed)) fail(`${name} must be a decimal integer string.`)
  return BigInt(parsed)
}

function address(value: unknown, name: string) {
  const parsed = text(value, name)
  if (!isAddress(parsed, { strict: true })) fail(`${name} must be a valid Ethereum address.`)
  return getAddress(parsed)
}

function sameAddress(left: string, right: string) {
  return getAddress(left) === getAddress(right)
}

function planForAction(order: Record<string, unknown>, action: AssistedNftAction) {
  const field = action === 'mint' ? 'executionPlan' : action === 'deliver' ? 'deliveryPlan' : 'refundPlan'
  return object(order[field], `execution.order.${field}`)
}

function expectedState(action: AssistedNftAction) {
  return action === 'mint' ? 'minting' : action === 'deliver' ? 'delivering' : 'refunding'
}

function expectedPlanPrefix(action: AssistedNftAction) {
  return action === 'mint' ? 'nmp_' : action === 'deliver' ? 'ndp_' : 'nrp_'
}

function configuredGasCeiling(constraints: AssistedPlanConstraints) {
  if (constraints.action === 'mint') return constraints.maximumMintGasLimit ?? '1000000'
  if (constraints.action === 'deliver') return constraints.maximumDeliveryGasLimit ?? '120000'
  return constraints.maximumRefundGasLimit ?? '21000'
}

export function validateAssistedNftPlan(
  raw: unknown,
  constraints: AssistedPlanConstraints,
): ValidatedAssistedPlan {
  const response = object(raw, 'response')
  if (response.ok !== true) fail('Signer-worker response must have ok=true.')
  const execution = object(response.execution, 'execution')
  const order = object(execution.order, 'execution.order')
  const transaction = object(execution.transaction, 'execution.transaction')
  const plan = planForAction(order, constraints.action)
  const now = constraints.now ?? Date.now()

  if (order.externalId !== constraints.externalId) fail('Order externalId does not match the requested order.')
  const orderId = text(order.orderId, 'execution.order.orderId')
  if (order.chainId !== 1 || transaction.chainId !== 1) fail('Only Ethereum mainnet chainId 1 is allowed.')
  if (order.state !== expectedState(constraints.action)) fail('Order state does not match the requested worker action.')

  const treasury = address(constraints.treasuryAddress, 'treasuryAddress')
  const orderTreasury = address(order.treasuryAddress, 'execution.order.treasuryAddress')
  const from = address(transaction.from, 'execution.transaction.from')
  if (!sameAddress(treasury, orderTreasury) || !sameAddress(treasury, from)) {
    fail('Order and transaction sender must match the configured execution treasury.')
  }

  const planId = text(plan.planId, 'plan.planId')
  if (text(plan.orderId, 'plan.orderId') !== orderId) fail('Execution plan belongs to a different order.')
  if (!planId.startsWith(expectedPlanPrefix(constraints.action))) fail('Plan ID does not match the requested action.')
  const target = address(plan.target, 'plan.target')
  const to = address(transaction.to, 'execution.transaction.to')
  if (!sameAddress(target, to)) fail('Transaction target does not match the signed plan.')

  const data = text(transaction.data, 'execution.transaction.data')
  if (!HEX_DATA.test(data)) fail('Transaction calldata must be even-length hexadecimal data.')
  const calldataHash = text(plan.calldataHash, 'plan.calldataHash')
  if (!HASH.test(calldataHash) || keccak256(data as Hex).toLowerCase() !== calldataHash.toLowerCase()) {
    fail('Transaction calldata hash does not match the signed plan.')
  }

  const valueWei = uint(transaction.valueWei, 'execution.transaction.valueWei')
  const planValueWei = uint(plan.valueWei, 'plan.valueWei')
  const gasLimit = uint(transaction.gasLimit, 'execution.transaction.gasLimit')
  const planGasLimit = uint(plan.gasLimit, 'plan.gasLimit')
  const maxFeePerGasWei = uint(transaction.maxFeePerGasWei, 'execution.transaction.maxFeePerGasWei')
  const planMaxFeePerGasWei = uint(plan.maxFeePerGasWei, 'plan.maxFeePerGasWei')
  const maxPriorityFeePerGasWei = uint(
    transaction.maxPriorityFeePerGasWei ?? transaction.maxFeePerGasWei,
    'execution.transaction.maxPriorityFeePerGasWei',
  )
  const planMaxPriorityFeePerGasWei = uint(
    plan.maxPriorityFeePerGasWei ?? plan.maxFeePerGasWei,
    'plan.maxPriorityFeePerGasWei',
  )
  if (
    valueWei !== planValueWei
    || gasLimit !== planGasLimit
    || maxFeePerGasWei !== planMaxFeePerGasWei
    || maxPriorityFeePerGasWei !== planMaxPriorityFeePerGasWei
  ) {
    fail('Transaction value, gas limit, or EIP-1559 fee ceilings do not match the signed plan.')
  }
  if (maxPriorityFeePerGasWei > maxFeePerGasWei) {
    fail('Maximum priority fee per gas cannot exceed maximum fee per gas.')
  }
  if (gasLimit > uint(configuredGasCeiling(constraints), 'configured gas ceiling')) {
    fail('Transaction gas limit exceeds the operator ceiling.')
  }
  if (maxFeePerGasWei > uint(constraints.maximumFeePerGasWei, 'maximumFeePerGasWei')) {
    fail('Plan maximum fee per gas exceeds the operator ceiling.')
  }
  const nonce = uint(transaction.nonce, 'execution.transaction.nonce')
  const planNonce = uint(plan.transactionNonce, 'plan.transactionNonce')
  if (nonce !== planNonce) fail('Transaction nonce does not match the reserved execution nonce.')
  const leaseOwner = text(plan.leaseOwner, 'plan.leaseOwner')
  if (leaseOwner !== constraints.workerId) fail('Execution lease belongs to a different worker.')
  const executionAttempt = uint(String(plan.executionAttempt), 'plan.executionAttempt')
  if (executionAttempt < 1n) fail('Execution attempt must be positive.')
  const leaseExpiresAt = text(plan.leaseExpiresAt, 'plan.leaseExpiresAt')
  let notBefore: string | undefined
  if (plan.notBefore !== undefined || transaction.notBefore !== undefined) {
    if (constraints.action !== 'mint') fail('Only mint plans may declare notBefore.')
    notBefore = text(plan.notBefore, 'plan.notBefore')
    const transactionNotBefore = text(transaction.notBefore, 'execution.transaction.notBefore')
    const schedule = object(order.schedule, 'execution.order.schedule')
    const stageStartTime = text(schedule.stageStartTime, 'execution.order.schedule.stageStartTime')
    if (transactionNotBefore !== notBefore || stageStartTime !== notBefore) {
      fail('Plan, transaction, and immutable schedule notBefore values must match.')
    }
    const notBeforeMs = Date.parse(notBefore)
    if (!Number.isFinite(notBeforeMs)) fail('Plan notBefore timestamp is invalid.')
  }

  const createdAt = text(plan.createdAt, 'plan.createdAt')
  const expiresAt = text(plan.expiresAt, 'plan.expiresAt')
  const createdMs = Date.parse(createdAt)
  const expiresMs = Date.parse(expiresAt)
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs <= createdMs) {
    fail('Plan timestamps are invalid.')
  }
  if (createdMs > now + 5_000) fail('Plan creation time is unexpectedly in the future.')
  if (expiresMs - createdMs > (constraints.maximumPlanLifetimeMs ?? 600_000)) {
    fail('Plan lifetime exceeds the worker ceiling.')
  }
  if (expiresMs - now < (constraints.minimumRemainingMs ?? 5_000)) {
    fail('Plan is expired or too close to expiry for safe confirmation.')
  }
  if (leaseExpiresAt !== expiresAt) fail('Execution lease and plan expiry must match.')

  const nftContract = address(order.nftContract, 'execution.order.nftContract')
  const refundAddress = address(order.refundAddress, 'execution.order.refundAddress')
  const maxMintPriceWei = uint(order.maxMintPriceWei, 'execution.order.maxMintPriceWei')
  const maxTotalCostWei = uint(order.maxTotalCostWei, 'execution.order.maxTotalCostWei')

  if (constraints.action === 'mint') {
    if (!sameAddress(target, SEADROP_1_0)) fail('Mint target is not the supported SeaDrop 1.0 contract.')
    let decoded
    try {
      decoded = decodeFunctionData({ abi: SEADROP_MINT_ABI, data: data as Hex })
    } catch {
      fail('Mint calldata is not the supported SeaDrop mintPublic call.')
    }
    if (decoded.functionName !== 'mintPublic') fail('Only the SeaDrop mintPublic function is allowed.')
    const [decodedNft, feeRecipient, minterIfNotPayer, quantity] = decoded.args
    if (
      !sameAddress(decodedNft, nftContract)
      || sameAddress(feeRecipient, ZERO_ADDRESS)
      || quantity !== 1n
      || (
        !sameAddress(minterIfNotPayer, ZERO_ADDRESS)
        && !sameAddress(minterIfNotPayer, treasury)
      )
    ) {
      fail('SeaDrop mint calldata does not match the immutable one-NFT treasury order.')
    }
    if (valueWei > maxMintPriceWei) fail('Mint value exceeds the immutable mint-price ceiling.')
    const maximumExecutionCostWei = uint(plan.maximumExecutionCostWei, 'plan.maximumExecutionCostWei')
    if (maximumExecutionCostWei > maxTotalCostWei) fail('Execution cost exceeds the immutable order ceiling.')
  } else if (constraints.action === 'deliver') {
    if (!sameAddress(target, nftContract) || valueWei !== 0n) {
      fail('Delivery must call the immutable NFT contract with zero native value.')
    }
    const nftRecipient = address(order.nftRecipient, 'execution.order.nftRecipient')
    const mint = object(order.mint, 'execution.order.mint')
    const mintedTokenId = uint(mint.tokenId, 'execution.order.mint.tokenId')
    let decoded
    try {
      decoded = decodeFunctionData({ abi: ERC721_TRANSFER_ABI, data: data as Hex })
    } catch {
      fail('Delivery calldata is not the supported ERC721 safeTransferFrom call.')
    }
    if (decoded.functionName !== 'safeTransferFrom') {
      fail('Only the three-argument ERC721 safeTransferFrom function is allowed.')
    }
    const [decodedFrom, decodedRecipient, decodedTokenId] = decoded.args
    if (
      !sameAddress(decodedFrom, treasury)
      || !sameAddress(decodedRecipient, nftRecipient)
      || decodedTokenId !== mintedTokenId
    ) {
      fail('NFT delivery calldata does not match the immutable recipient and minted token.')
    }
  } else {
    const amountWei = uint(plan.amountWei, 'plan.amountWei')
    if (!sameAddress(target, refundAddress) || data !== '0x' || valueWei !== amountWei) {
      fail('Refund must be an exact empty-calldata transfer to the immutable refund address.')
    }
  }

  return {
    action: constraints.action,
    externalId: constraints.externalId,
    orderId,
    planId,
    expiresAt,
    ...(notBefore ? { notBefore } : {}),
    transaction: {
      chainId: 1,
      from,
      to,
      data: data as Hex,
      valueWei: valueWei.toString(),
      gasLimit: gasLimit.toString(),
      maxFeePerGasWei: maxFeePerGasWei.toString(),
      maxPriorityFeePerGasWei: maxPriorityFeePerGasWei.toString(),
      nonce: nonce.toString(),
      ...(notBefore ? { notBefore } : {}),
    },
  }
}
