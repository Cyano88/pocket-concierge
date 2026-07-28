import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { NftChainGateway } from '../src/nft-chain.js'
import { EthereumNftChainGateway, SEADROP_1_0 } from '../src/nft-chain.js'
import { NftMintService } from '../src/nft-mints.js'
import { MemoryNftMintStore, SqliteNftMintStore } from '../src/nft-store.js'
import type { NftMintStore } from '../src/nft-store.js'
import type {
  BuiltMintTransaction,
  VerifiedDelivery,
  VerifiedDeposit,
  VerifiedFailedMint,
  VerifiedMint,
  VerifiedRefund,
} from '../src/nft-types.js'

const TREASURY = getAddress('0x1111111111111111111111111111111111111111')
const NFT = getAddress('0x2222222222222222222222222222222222222222')
const RECIPIENT = getAddress('0x3333333333333333333333333333333333333333')
const REFUND = getAddress('0x4444444444444444444444444444444444444444')
const FUNDER = getAddress('0x5555555555555555555555555555555555555555')
const CREATOR = getAddress('0x6666666666666666666666666666666666666666')
const FEE_RECIPIENT = getAddress('0x7777777777777777777777777777777777777777')
const DEPOSIT_HASH = `0x${'a'.repeat(64)}` as Hex
const DEPOSIT_HASH_2 = `0x${'e'.repeat(64)}` as Hex
const MINT_HASH = `0x${'b'.repeat(64)}` as Hex
const DELIVERY_HASH = `0x${'c'.repeat(64)}` as Hex
const REFUND_HASH = `0x${'d'.repeat(64)}` as Hex
const NOW = Date.parse('2026-07-26T10:00:00.000Z')

const mintCalldata = encodeFunctionData({
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
const deliveryCalldata = encodeFunctionData({
  abi: [{
    type: 'function',
    name: 'safeTransferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  }],
  functionName: 'safeTransferFrom',
  args: [TREASURY, RECIPIENT, 77n],
})

class FakeChain implements NftChainGateway {
  feePerGas = 30_000_000_000n
  pendingNonceValue = 17

  transaction: BuiltMintTransaction = {
    target: SEADROP_1_0,
    calldata: mintCalldata,
    valueWei: '10000000000000000',
  }

  deposit: VerifiedDeposit = {
    transactionHash: DEPOSIT_HASH,
    from: FUNDER,
    to: TREASURY,
    valueWei: '30000000000000000',
    blockNumber: 100n,
    confirmations: 2,
  }

  mint: VerifiedMint = {
    transactionHash: MINT_HASH,
    from: TREASURY,
    to: SEADROP_1_0,
    calldata: mintCalldata,
    valueWei: '10000000000000000',
    nonce: 17,
    tokenId: 77n,
    blockNumber: 101n,
    gasCostWei: 2_000_000_000_000_000n,
    confirmations: 2,
  }

  failedMint: VerifiedFailedMint = {
    transactionHash: MINT_HASH,
    from: TREASURY,
    to: SEADROP_1_0,
    calldata: mintCalldata,
    valueWei: '10000000000000000',
    nonce: 17,
    blockNumber: 101n,
    gasCostWei: 800_000_000_000_000n,
    confirmations: 2,
  }

  delivery: VerifiedDelivery = {
    transactionHash: DELIVERY_HASH,
    from: TREASURY,
    to: NFT,
    calldata: deliveryCalldata,
    valueWei: '0',
    nonce: 18,
    tokenId: 77n,
    blockNumber: 102n,
    gasCostWei: 500_000_000_000_000n,
    confirmations: 2,
  }

  refund: VerifiedRefund = {
    transactionHash: REFUND_HASH,
    from: TREASURY,
    to: REFUND,
    valueWei: '16592800000000000',
    nonce: 19,
    blockNumber: 103n,
    gasCostWei: 600_000_000_000_000n,
    confirmations: 2,
  }

  async buildMint() { return structuredClone(this.transaction) }
  validateMint(transaction: BuiltMintTransaction, nftContract: Address, treasuryAddress: Address) {
    assert.equal(transaction.target, SEADROP_1_0)
    assert.equal(nftContract, NFT)
    assert.equal(treasuryAddress, TREASURY)
  }
  async estimateMintGas() { return 150_000n }
  async maxFeePerGas() { return this.feePerGas }
  async pendingNonce() { return this.pendingNonceValue++ }
  async verifyDeposit() { return structuredClone(this.deposit) }
  async verifyMint() { return structuredClone(this.mint) }
  async verifyFailedMint() { return structuredClone(this.failedMint) }
  async prepareDelivery() {
    return { target: NFT, calldata: deliveryCalldata, valueWei: '0' as const, gasLimit: 70_000n }
  }
  async verifyDelivery() { return structuredClone(this.delivery) }
  async verifyRefund() { return structuredClone(this.refund) }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'opensea-drop-0001',
    collectionSlug: 'example-public-drop',
    nftContract: NFT,
    nftRecipient: RECIPIENT,
    refundAddress: REFUND,
    fundingAddress: FUNDER,
    quantity: 1,
    maxMintPriceWei: '20000000000000000',
    maxTotalCostWei: '30000000000000000',
    expiresAt: '2026-07-26T11:00:00.000Z',
    ...overrides,
  }
}

function service(
  store: NftMintStore = new MemoryNftMintStore(),
  chain = new FakeChain(),
  now: () => number = () => NOW,
) {
  return {
    app: new NftMintService({
      store,
      chain,
      treasuryAddress: TREASURY,
      minimumConfirmations: 2,
      planTtlSeconds: 30,
      deliveryGasLimit: 120_000n,
      refundGasLimit: 21_000n,
      maximumOrderWei: 100_000_000_000_000_000n,
      orderTokenSecret: 'test-only-order-token-secret-at-least-32-bytes',
      now,
    }),
    store,
    chain,
  }
}

test('previews a supported public mint without creating an order or accepting funds', async () => {
  const { app, store } = service()
  const preview = await app.preview(input())

  assert.equal(preview.supported, true)
  assert.equal(preview.scope.network, 'ethereum-mainnet')
  assert.equal(preview.scope.mintMechanism, 'official-seadrop-1.0-public-drop')
  assert.equal(preview.quote.currentMintPriceWei, '10000000000000000')
  assert.equal(preview.quote.maximumEstimatedTotalWei, '19630000000000000')
  assert.equal(preview.quote.estimationMode, 'live-simulation')
  assert.equal(preview.quote.requiredDepositWei, '30000000000000000')
  assert.equal(preview.quote.serviceFee.amountAtomic, '1000000')
  assert.equal(preview.mandate.withinLimits, true)
  assert.equal((await store.get('agent-one', 'opensea-drop-0001')), null)
})

test('preview rejects a live total-cost estimate outside the customer mandate', async () => {
  const { app } = service()
  await assert.rejects(
    app.preview(input({
      maxMintPriceWei: '15000000000000000',
      maxTotalCostWei: '19000000000000000',
    })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_TOTAL_COST_LIMIT',
  )
})

test('preview uses a disclosed conservative gas reserve when an unfunded treasury cannot simulate', async () => {
  const chain = new FakeChain()
  chain.estimateMintGas = async () => {
    throw new Error('rpc simulation failed')
  }
  const { app } = service(undefined, chain)
  const preview = await app.preview(input())
  assert.equal(preview.quote.estimationMode, 'conservative-fallback')
  assert.equal(preview.quote.mintGasLimit, '350000')
  assert.equal(preview.quote.maximumEstimatedTotalWei, '24730000000000000')
})

test('creates an immutable customer-funded order and replays idempotently', async () => {
  const { app } = service()
  const created = await app.create('agent-one', input())
  assert.equal(created.replayed, false)
  assert.equal(created.order.state, 'awaiting_funding')
  assert.equal(created.order.requiredDepositWei, created.order.maxTotalCostWei)
  assert.equal(created.order.treasuryAddress, TREASURY)
  assert.equal('ownerId' in created.order, false)
  assert.match(created.orderAccessToken, /^nmt_[A-Za-z0-9_-]+$/)
  const authorized = await app.authenticateOrder('agent-one', 'opensea-drop-0001', created.orderAccessToken)
  assert.equal(authorized.orderId, created.order.orderId)
  await assert.rejects(
    app.authenticateOrder('agent-one', 'opensea-drop-0001', 'nmt_wrong'),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_UNAUTHORIZED',
  )

  const replay = await app.create('agent-one', input())
  assert.equal(replay.replayed, true)
  assert.equal(replay.order.orderId, created.order.orderId)

  await assert.rejects(
    app.create('agent-one', input({ nftRecipient: REFUND })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_CONFLICT',
  )
})

test('rejects unsafe order shapes before accepting execution capital', async () => {
  const { app } = service()
  await assert.rejects(
    app.create('agent-one', input({ quantity: 2 })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_QUANTITY_UNSUPPORTED',
  )
  await assert.rejects(
    app.create('agent-one', input({ maxMintPriceWei: '30000000000000001' })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_INVALID',
  )
  await assert.rejects(
    app.create('agent-one', input({ nftRecipient: '0x1234' })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_INVALID',
  )
  await assert.rejects(
    app.create('agent-one', input({ nftRecipient: '0x0000000000000000000000000000000000000000' })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_INVALID',
  )
  await assert.rejects(
    app.create('agent-one', input({ maxTotalCostWei: '100000000000000001' })),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_LIMIT_EXCEEDED',
  )
})

test('SeaDrop validator rejects target, collection, recipient, and quantity mutations', () => {
  const gateway = new EthereumNftChainGateway('http://127.0.0.1:8545')
  assert.doesNotThrow(() => gateway.validateMint(
    { target: SEADROP_1_0, calldata: mintCalldata, valueWei: '0' },
    NFT,
    TREASURY,
  ))
  assert.throws(
    () => gateway.validateMint(
      { target: NFT, calldata: mintCalldata, valueWei: '0' },
      NFT,
      TREASURY,
    ),
    (error: unknown) => (error as { code?: string }).code === 'NFT_MINT_TARGET_UNSUPPORTED',
  )
  const wrongCollection = encodeFunctionData({
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
    args: [REFUND, TREASURY, TREASURY, 1n],
  })
  assert.throws(
    () => gateway.validateMint(
      { target: SEADROP_1_0, calldata: wrongCollection, valueWei: '0' },
      NFT,
      TREASURY,
    ),
    (error: unknown) => (error as { code?: string }).code === 'NFT_MINT_CALL_MISMATCH',
  )
  const wrongRecipient = encodeFunctionData({
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
    args: [NFT, TREASURY, RECIPIENT, 1n],
  })
  assert.throws(
    () => gateway.validateMint(
      { target: SEADROP_1_0, calldata: wrongRecipient, valueWei: '0' },
      NFT,
      TREASURY,
    ),
    (error: unknown) => (error as { code?: string }).code === 'NFT_MINT_RECIPIENT_MISMATCH',
  )
})

function directMintClient(options?: {
  startTime?: bigint
  endTime?: bigint
  maxPerWallet?: bigint
  mintedByWallet?: bigint
  totalSupply?: bigint
  maxSupply?: bigint
  restricted?: boolean
  allowedFeeRecipients?: Address[]
  creatorPayout?: Address
}) {
  const nowSeconds = BigInt(Math.floor(NOW / 1000))
  return {
    async readContract(args: { functionName: string }) {
      if (args.functionName === 'getPublicDrop') {
        return [
          10_000_000_000_000_000n,
          options?.startTime ?? nowSeconds - 60n,
          options?.endTime ?? nowSeconds + 60n,
          options?.maxPerWallet ?? 2n,
          500n,
          options?.restricted ?? true,
        ] as const
      }
      if (args.functionName === 'getMintStats') {
        return [
          options?.mintedByWallet ?? 0n,
          options?.totalSupply ?? 10n,
          options?.maxSupply ?? 100n,
        ] as const
      }
      if (args.functionName === 'getAllowedFeeRecipients') {
        return options?.allowedFeeRecipients ?? [FEE_RECIPIENT]
      }
      if (args.functionName === 'getCreatorPayoutAddress') {
        return options?.creatorPayout ?? CREATOR
      }
      throw new Error(`Unexpected read: ${args.functionName}`)
    },
    async getBlock() {
      return { timestamp: nowSeconds }
    },
  } as unknown as PublicClient
}

test('direct SeaDrop builder uses only onchain public-stage data', async () => {
  const restricted = new EthereumNftChainGateway('https://rpc.example', directMintClient())
  const transaction = await restricted.buildMint('ignored-slug', NFT, TREASURY)
  assert.equal(transaction.target, SEADROP_1_0)
  assert.equal(transaction.valueWei, '10000000000000000')
  const decoded = decodeFunctionData({
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
    data: transaction.calldata,
  })
  assert.deepEqual(decoded.args, [
    NFT,
    FEE_RECIPIENT,
    '0x0000000000000000000000000000000000000000',
    1n,
  ])

  const unrestricted = new EthereumNftChainGateway(
    'https://rpc.example',
    directMintClient({ restricted: false, allowedFeeRecipients: [] }),
  )
  const creatorTransaction = await unrestricted.buildMint('ignored-slug', NFT, TREASURY)
  const creatorDecoded = decodeFunctionData({
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
    data: creatorTransaction.calldata,
  })
  assert.equal(creatorDecoded.args[1], CREATOR)
})

test('direct SeaDrop builder rejects inactive, capped, sold-out, and unpayable stages', async () => {
  const nowSeconds = BigInt(Math.floor(NOW / 1000))
  for (const [client, code] of [
    [directMintClient({ startTime: nowSeconds + 1n }), 'NFT_PUBLIC_DROP_INACTIVE'],
    [directMintClient({ mintedByWallet: 2n }), 'NFT_PUBLIC_DROP_WALLET_LIMIT'],
    [directMintClient({ totalSupply: 100n }), 'NFT_PUBLIC_DROP_SOLD_OUT'],
    [directMintClient({ allowedFeeRecipients: [] }), 'NFT_PUBLIC_DROP_FEE_RECIPIENT_MISSING'],
  ] as const) {
    const gateway = new EthereumNftChainGateway('https://rpc.example', client)
    await assert.rejects(
      gateway.buildMint('ignored-slug', NFT, TREASURY),
      (error: unknown) => (error as { code?: string }).code === code,
    )
  }
})

test('refund verifier canonicalizes lowercase RPC addresses', async () => {
  const client = {
    async getTransaction() {
      return {
        from: TREASURY.toLowerCase(),
        to: REFUND.toLowerCase(),
        value: 123n,
        input: '0x',
      }
    },
    async getTransactionReceipt() {
      return {
        status: 'success',
        blockNumber: 100n,
        gasUsed: 21_000n,
        effectiveGasPrice: 1n,
      }
    },
    async getBlockNumber() {
      return 101n
    },
  } as unknown as PublicClient
  const gateway = new EthereumNftChainGateway('https://rpc.example', client)
  const refund = await gateway.verifyRefund(REFUND_HASH, TREASURY, REFUND, 123n)
  assert.equal(refund.from, TREASURY)
  assert.equal(refund.to, REFUND)
  assert.equal(refund.confirmations, 2)
})

test('arms only after a matching, sufficiently confirmed Ethereum deposit', async () => {
  const { app, chain } = service()
  await app.create('agent-one', input())

  chain.deposit.confirmations = 1
  await assert.rejects(
    app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH }),
    (error: unknown) => (error as { code?: string }).code === 'NFT_DEPOSIT_CONFIRMING',
  )

  chain.deposit.confirmations = 2
  chain.deposit.from = REFUND
  await assert.rejects(
    app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH }),
    (error: unknown) => (error as { code?: string }).code === 'NFT_DEPOSIT_MISMATCH',
  )

  chain.deposit.from = FUNDER
  const armed = await app.confirmFunding(
    'agent-one',
    'opensea-drop-0001',
    { depositTransactionHash: DEPOSIT_HASH },
  )
  assert.equal(armed.state, 'armed')
  assert.equal(armed.deposit?.transactionHash, DEPOSIT_HASH)
})

test('one deposit transaction cannot arm two orders', async () => {
  const { app } = service()
  await app.create('agent-one', input())
  await app.create('agent-one', input({ externalId: 'opensea-drop-0002' }))
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  await assert.rejects(
    app.confirmFunding('agent-one', 'opensea-drop-0002', { depositTransactionHash: DEPOSIT_HASH }),
    (error: unknown) => (error as { code?: string }).code === 'NFT_DEPOSIT_ALREADY_CLAIMED',
  )
})

test('simultaneous funding confirmations still claim a deposit only once', async () => {
  const { app } = service()
  await app.create('agent-one', input())
  await app.create('agent-one', input({ externalId: 'opensea-drop-0002' }))
  const results = await Promise.allSettled([
    app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH }),
    app.confirmFunding('agent-one', 'opensea-drop-0002', { depositTransactionHash: DEPOSIT_HASH }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
})

test('atomic execution lease allows only one active treasury mint worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-nft-lease-'))
  const store = new SqliteNftMintStore(join(directory, 'orders.sqlite'))
  const chain = new FakeChain()
  const { app } = service(store, chain)
  await app.create('agent-one', input())
  await app.create('agent-one', input({ externalId: 'opensea-drop-0002' }))
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  chain.deposit.transactionHash = DEPOSIT_HASH_2
  await app.confirmFunding('agent-one', 'opensea-drop-0002', { depositTransactionHash: DEPOSIT_HASH_2 })

  const results = await Promise.allSettled([
    app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1'),
    app.prepareExecution('agent-one', 'opensea-drop-0002', 'worker-test-2'),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(
    rejected?.status === 'rejected'
      ? (rejected.reason as { code?: string }).code
      : undefined,
    'NFT_EXECUTION_LEASE_BUSY',
  )
  store.close()
})

test('execution plan respects mint and total-cost caps', async () => {
  const { app, chain } = service()
  await app.create('agent-one', input())
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  chain.transaction.valueWei = '20000000000000001'
  await assert.rejects(
    app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1'),
    (error: unknown) => (error as { code?: string }).code === 'NFT_MINT_PRICE_LIMIT',
  )

  chain.transaction.valueWei = '10000000000000000'
  const prepared = await app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.equal(prepared.transaction.to, SEADROP_1_0)
  assert.equal(prepared.transaction.from, TREASURY)
  assert.equal(prepared.transaction.nonce, '17')
  assert.equal(prepared.order.state, 'minting')
  assert.equal(prepared.order.executionPlan?.leaseOwner, 'worker-test-1')
  assert.equal(prepared.order.executionPlan?.calldataHash, keccak256(mintCalldata))
})

test('unfunded cancellation is terminal and accepts no refund transaction', async () => {
  const { app } = service()
  const created = await app.create('agent-one', input())
  const cancelled = await app.cancel(
    'agent-one',
    created.order.externalId,
    { reason: 'customer_cancelled' },
  )
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.cancellation?.reason, 'customer_cancelled')
  await assert.rejects(
    app.prepareRefund('agent-one', created.order.externalId, 'worker-test-1'),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_STATE_INVALID',
  )
})

test('funded pre-mint cancellation refunds execution capital without charging mint value', async () => {
  const { app } = service()
  await app.create('agent-one', input())
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  const cancelling = await app.cancel(
    'agent-one',
    'opensea-drop-0001',
    { reason: 'customer_cancelled' },
  )
  assert.equal(cancelling.state, 'cancelling')
  const refund = await app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.equal(refund.transaction.valueWei, '29092800000000000')
  assert.equal(refund.transaction.to, REFUND)
})

test('verified failed mint gas is deducted before the immutable refund', async () => {
  const { app } = service()
  await app.create('agent-one', input())
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  await app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1')
  const failed = await app.recordFailedMint(
    'agent-one',
    'opensea-drop-0001',
    { mintTransactionHash: MINT_HASH },
  )
  assert.equal(failed.state, 'failed')
  assert.equal(failed.failedMint?.transactionNonce, '17')
  await app.cancel('agent-one', 'opensea-drop-0001', { reason: 'mint_failed' })
  const refund = await app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.equal(refund.transaction.valueWei, '28292800000000000')
})

test('records only a mint matching the immutable plan and exact NFT delivery', async () => {
  const { app, chain } = service()
  await app.create('agent-one', input())
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  await app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1')

  chain.mint.calldata = `${mintCalldata.slice(0, -2)}00` as Hex
  await assert.rejects(
    app.recordMint('agent-one', 'opensea-drop-0001', { mintTransactionHash: MINT_HASH }),
    (error: unknown) => (error as { code?: string }).code === 'NFT_MINT_TRANSACTION_MISMATCH',
  )

  chain.mint.calldata = mintCalldata
  const minted = await app.recordMint('agent-one', 'opensea-drop-0001', { mintTransactionHash: MINT_HASH })
  assert.equal(minted.state, 'delivering')
  assert.equal(minted.mint?.tokenId, '77')
  const deliveryPlan = await app.prepareDelivery('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.equal(deliveryPlan.transaction.to, NFT)
  assert.equal(deliveryPlan.transaction.valueWei, '0')

  chain.delivery.tokenId = 78n
  await assert.rejects(
    app.recordDelivery('agent-one', 'opensea-drop-0001', { deliveryTransactionHash: DELIVERY_HASH }),
    (error: unknown) => (error as { code?: string }).code === 'NFT_DELIVERY_MISMATCH',
  )

  chain.delivery.tokenId = 77n
  chain.delivery.confirmations = 1
  await assert.rejects(
    app.recordDelivery(
      'agent-one',
      'opensea-drop-0001',
      { deliveryTransactionHash: DELIVERY_HASH },
    ),
    (error: unknown) => (error as { code?: string }).code === 'NFT_DELIVERY_CONFIRMING',
  )
  chain.delivery.confirmations = 2
  const delivered = await app.recordDelivery(
    'agent-one',
    'opensea-drop-0001',
    { deliveryTransactionHash: DELIVERY_HASH },
  )
  assert.equal(delivered.state, 'delivered')
  assert.equal(delivered.delivery?.transactionHash, DELIVERY_HASH)

  const refundPlan = await app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.equal(refundPlan.order.state, 'refunding')
  assert.equal(refundPlan.transaction.to, REFUND)
  assert.equal(refundPlan.transaction.valueWei, '16592800000000000')
  assert.equal(refundPlan.transaction.maxFeePerGasWei, '36000000000')
  chain.refund.confirmations = 1
  await assert.rejects(
    app.recordRefund(
      'agent-one',
      'opensea-drop-0001',
      { refundTransactionHash: REFUND_HASH },
    ),
    (error: unknown) => (error as { code?: string }).code === 'NFT_REFUND_CONFIRMING',
  )
  chain.refund.confirmations = 2
  const refunded = await app.recordRefund(
    'agent-one',
    'opensea-drop-0001',
    { refundTransactionHash: REFUND_HASH },
  )
  assert.equal(refunded.state, 'refunded')
  assert.equal(refunded.refund?.amountWei, '16592800000000000')
  const proof = await app.publicProof('agent-one', 'opensea-drop-0001', DEPOSIT_HASH)
  assert.equal(proof.status, 'verified_complete')
  assert.equal(proof.purchase.tokenId, '77')
  assert.equal(proof.settlement.refund.transactionHash, REFUND_HASH)
  assert.equal(proof.settlement.mint.priceWei, '10000000000000000')
  assert.equal(proof.settlement.retainedSafetyHeadroomWei, '307200000000000')
  assert.deepEqual(proof.settlement.executionAccounting, {
    fundingWei: '30000000000000000',
    mintPriceWei: '10000000000000000',
    totalExecutionGasWei: '3100000000000000',
    refundedWei: '16592800000000000',
    retainedSafetyHeadroomWei: '307200000000000',
    accountedWei: '30000000000000000',
    balanced: true,
  })
  assert.match(proof.proofId, /^nfp_[a-f0-9]{24}$/)
  assert.match(proof.proofHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(proof).includes('agent-one'), false)
})

test('refund can be replanned only after an unbroadcast plan expires', async () => {
  let now = NOW
  const { app, chain } = service(new MemoryNftMintStore(), new FakeChain(), () => now)
  await app.create('agent-one', input())
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  await app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1')
  await app.recordMint('agent-one', 'opensea-drop-0001', { mintTransactionHash: MINT_HASH })
  await app.prepareDelivery('agent-one', 'opensea-drop-0001', 'worker-test-1')
  await app.recordDelivery('agent-one', 'opensea-drop-0001', { deliveryTransactionHash: DELIVERY_HASH })

  const first = await app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1')
  await assert.rejects(
    app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1'),
    (error: unknown) => (error as { code?: string }).code === 'NFT_ORDER_STATE_INVALID',
  )

  now = Date.parse(first.order.refundPlan!.expiresAt) + 1
  chain.refund.valueWei = '16592800000000000'
  const replacement = await app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.notEqual(replacement.order.refundPlan?.planId, first.order.refundPlan?.planId)
  assert.equal(replacement.transaction.nonce, first.transaction.nonce)
  assert.equal(replacement.order.state, 'refunding')
})

test('refund reserves the assisted-wallet fee floor when RPC fees are unrealistically low', async () => {
  const chain = new FakeChain()
  chain.feePerGas = 70_000_000n
  const { app } = service(new MemoryNftMintStore(), chain)
  await app.create('agent-one', input())
  await app.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  await app.prepareExecution('agent-one', 'opensea-drop-0001', 'worker-test-1')
  await app.recordMint('agent-one', 'opensea-drop-0001', { mintTransactionHash: MINT_HASH })
  await app.prepareDelivery('agent-one', 'opensea-drop-0001', 'worker-test-1')
  await app.recordDelivery('agent-one', 'opensea-drop-0001', { deliveryTransactionHash: DELIVERY_HASH })

  const refundPlan = await app.prepareRefund('agent-one', 'opensea-drop-0001', 'worker-test-1')
  assert.equal(refundPlan.transaction.maxFeePerGasWei, '1500000000')
  assert.equal(refundPlan.transaction.valueWei, '17462200000000000')
})

test('SQLite persistence preserves orders and globally unique deposit claims', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-nft-'))
  const path = join(directory, 'orders.sqlite')
  const first = new SqliteNftMintStore(path)
  const chain = new FakeChain()
  const firstApp = service(first, chain).app
  await firstApp.create('agent-one', input())
  await firstApp.confirmFunding('agent-one', 'opensea-drop-0001', { depositTransactionHash: DEPOSIT_HASH })
  first.close()

  const reopened = new SqliteNftMintStore(path)
  const reopenedApp = service(reopened, chain).app
  const order = await reopenedApp.get('agent-one', 'opensea-drop-0001')
  assert.equal(order.state, 'armed')
  assert.equal(order.deposit?.transactionHash, DEPOSIT_HASH)
  reopened.close()
})
