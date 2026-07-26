import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionData, getAddress, keccak256 } from 'viem'
import { SEADROP_1_0 } from '../src/nft-chain.js'
import {
  assistedWalletArguments,
  validateAssistedNftPlan,
  type AssistedNftAction,
} from '../src/nft-assisted-worker.js'

const NOW = Date.parse('2026-07-26T12:00:00.000Z')
const TREASURY = getAddress('0x1111111111111111111111111111111111111111')
const NFT = getAddress('0x2222222222222222222222222222222222222222')
const RECIPIENT = getAddress('0x3333333333333333333333333333333333333333')
const REFUND = getAddress('0x4444444444444444444444444444444444444444')
const calldata = encodeFunctionData({
  abi: [{
    type: 'function',
    name: 'mintPublic',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
  }],
  functionName: 'mintPublic',
  args: [NFT, TREASURY, TREASURY, 1n],
})

function response(action: AssistedNftAction = 'mint') {
  const planField = action === 'mint' ? 'executionPlan' : action === 'deliver' ? 'deliveryPlan' : 'refundPlan'
  const state = action === 'mint' ? 'minting' : action === 'deliver' ? 'delivering' : 'refunding'
  const target = action === 'mint' ? SEADROP_1_0 : action === 'deliver' ? NFT : REFUND
  const data = action === 'refund' ? '0x' : calldata
  const valueWei = action === 'mint' ? '10000000000000000' : action === 'refund' ? '5000000000000000' : '0'
  const gasLimit = action === 'mint' ? '180000' : action === 'deliver' ? '100000' : '21000'
  const plan = {
    planId: `${action === 'mint' ? 'nmp' : action === 'deliver' ? 'ndp' : 'nrp'}_123456`,
    orderId: 'nmo_worker_test_001',
    target,
    calldataHash: keccak256(data),
    valueWei,
    gasLimit,
    maxFeePerGasWei: '30000000000',
    transactionNonce: '17',
    leaseOwner: 'worker-test-1',
    leaseExpiresAt: new Date(NOW + 30_000).toISOString(),
    executionAttempt: 1,
    ...(action === 'mint' ? {
      maximumExecutionCostWei: '20000000000000000',
    } : {}),
    ...(action === 'refund' ? { amountWei: valueWei } : {}),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
  }
  return {
    ok: true,
    execution: {
      order: {
        orderId: 'nmo_worker_test_001',
        externalId: 'mint-demo-001',
        chainId: 1,
        state,
        treasuryAddress: TREASURY,
        nftContract: NFT,
        nftRecipient: RECIPIENT,
        refundAddress: REFUND,
        maxMintPriceWei: '10000000000000000',
        maxTotalCostWei: '30000000000000000',
        [planField]: plan,
      },
      transaction: {
        chainId: 1,
        from: TREASURY,
        to: target,
        data,
        valueWei,
        gasLimit,
        maxFeePerGasWei: '30000000000',
        nonce: '17',
      },
    },
  }
}

function validate(raw: unknown, action: AssistedNftAction = 'mint') {
  return validateAssistedNftPlan(raw, {
    action,
    externalId: 'mint-demo-001',
    treasuryAddress: TREASURY,
    workerId: 'worker-test-1',
    maximumFeePerGasWei: '40000000000',
    now: NOW,
  })
}

function fixturePlan(value: ReturnType<typeof response>, field: 'executionPlan' | 'deliveryPlan' | 'refundPlan') {
  const plan = (value.execution.order as Record<string, unknown>)[field]
  assert.ok(plan && typeof plan === 'object')
  return plan as {
    expiresAt: string
    valueWei: string
    calldataHash: `0x${string}`
  }
}

test('assisted worker validates bounded mint, delivery, and refund plans', () => {
  assert.equal(validate(response()).transaction.to, SEADROP_1_0)
  assert.equal(validate(response('deliver'), 'deliver').transaction.to, NFT)
  assert.equal(validate(response('refund'), 'refund').transaction.to, REFUND)
})

test('assisted worker rejects chain, treasury, target, calldata, fee, and expiry drift', () => {
  for (const mutate of [
    (value: ReturnType<typeof response>) => { value.execution.transaction.chainId = 196 as 1 },
    (value: ReturnType<typeof response>) => { value.execution.transaction.from = RECIPIENT },
    (value: ReturnType<typeof response>) => { value.execution.transaction.to = NFT },
    (value: ReturnType<typeof response>) => { value.execution.transaction.data = '0x00' },
    (value: ReturnType<typeof response>) => { value.execution.transaction.maxFeePerGasWei = '50000000000' },
    (value: ReturnType<typeof response>) => { value.execution.transaction.nonce = '18' },
    (value: ReturnType<typeof response>) => {
      const plan = fixturePlan(value, 'executionPlan') as ReturnType<typeof fixturePlan> & { leaseOwner: string }
      plan.leaseOwner = 'worker-test-2'
    },
    (value: ReturnType<typeof response>) => {
      fixturePlan(value, 'executionPlan').expiresAt = new Date(NOW + 1_000).toISOString()
    },
  ]) {
    const value = response()
    mutate(value)
    assert.throws(
      () => validate(value),
      (error: unknown) => (error as { code?: string }).code === 'NFT_WORKER_PLAN_INVALID',
    )
  }
})

test('assisted worker rejects delivery value and inexact refund transfers', () => {
  const delivery = response('deliver')
  delivery.execution.transaction.valueWei = '1'
  fixturePlan(delivery, 'deliveryPlan').valueWei = '1'
  assert.throws(() => validate(delivery, 'deliver'))

  const refund = response('refund')
  refund.execution.transaction.data = '0x00'
  fixturePlan(refund, 'refundPlan').calldataHash = keccak256('0x00')
  assert.throws(() => validate(refund, 'refund'))
})

test('refund uses one dedicated native transfer and never the generic contract-call path', () => {
  const plan = validate(response('refund'), 'refund')
  const args = assistedWalletArguments(plan)
  assert.deepEqual(args.slice(0, 4), ['wallet', 'send', '--chain', 'ethereum'])
  assert.equal(args.includes('contract-call'), false)
  assert.equal(args.includes('--input-data'), false)
  assert.equal(args.includes('--force'), false)
  assert.equal(args[args.indexOf('--recipient') + 1], REFUND)
  assert.equal(args[args.indexOf('--amt') + 1], plan.transaction.valueWei)
})
