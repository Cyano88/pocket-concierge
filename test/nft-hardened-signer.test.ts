import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { encodeFunctionData, getAddress, keccak256, type Hex } from 'viem'
import { SEADROP_1_0 } from '../src/nft-chain.js'
import {
  NftHardenedSigner,
  type NftHardenedSignerBackend,
} from '../src/nft-hardened-signer.js'

const NOW = Date.parse('2026-07-26T12:00:00.000Z')
const TREASURY = getAddress('0x1111111111111111111111111111111111111111')
const NFT = getAddress('0x2222222222222222222222222222222222222222')
const TRANSACTION_HASH = `0x${'a'.repeat(64)}` as Hex
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

function response(planId = 'nmp_signer_guard_001') {
  const expiresAt = new Date(NOW + 30_000).toISOString()
  return {
    ok: true,
    execution: {
      order: {
        orderId: 'nmo_signer_guard_001',
        externalId: 'mint-demo-001',
        chainId: 1,
        state: 'minting',
        treasuryAddress: TREASURY,
        nftContract: NFT,
        nftRecipient: TREASURY,
        refundAddress: TREASURY,
        maxMintPriceWei: '10000000000000000',
        maxTotalCostWei: '30000000000000000',
        executionPlan: {
          planId,
          orderId: 'nmo_signer_guard_001',
          target: SEADROP_1_0,
          calldataHash: keccak256(calldata),
          valueWei: '10000000000000000',
          gasLimit: '180000',
          maxFeePerGasWei: '30000000000',
          transactionNonce: '17',
          leaseOwner: 'hsm-worker-1',
          leaseExpiresAt: expiresAt,
          executionAttempt: 1,
          maximumExecutionCostWei: '20000000000000000',
          createdAt: new Date(NOW).toISOString(),
          expiresAt,
        },
      },
      transaction: {
        chainId: 1,
        from: TREASURY,
        to: SEADROP_1_0,
        data: calldata,
        valueWei: '10000000000000000',
        gasLimit: '180000',
        maxFeePerGasWei: '30000000000',
        nonce: '17',
      },
    },
  }
}

function constraints() {
  return {
    action: 'mint' as const,
    externalId: 'mint-demo-001',
    treasuryAddress: TREASURY,
    workerId: 'hsm-worker-1',
    maximumFeePerGasWei: '40000000000',
    now: NOW,
  }
}

test('isolated signer ledger broadcasts one validated plan only once', async () => {
  let broadcasts = 0
  const backend: NftHardenedSignerBackend = {
    async address() { return TREASURY },
    async signAndBroadcast() {
      broadcasts += 1
      return { transactionHash: TRANSACTION_HASH }
    },
  }
  const directory = mkdtempSync(join(tmpdir(), 'pocket-nft-signer-'))
  const signer = new NftHardenedSigner(join(directory, 'signer.sqlite'), backend, () => NOW)
  const first = await signer.execute(response(), constraints())
  assert.equal(first.transactionHash, TRANSACTION_HASH)
  assert.deepEqual(signer.findBroadcast('mint-demo-001', 'mint'), {
    planId: 'nmp_signer_guard_001',
    transactionHash: TRANSACTION_HASH,
  })
  assert.equal(signer.findBroadcast('mint-demo-001', 'refund'), null)
  await assert.rejects(
    signer.execute(response(), constraints()),
    (error: unknown) => (error as { code?: string }).code === 'NFT_SIGNER_AUTHORIZATION_REUSED',
  )
  assert.equal(broadcasts, 1)
  signer.close()
})

test('isolated signer refuses a different plan that reuses the reserved nonce', async () => {
  const backend: NftHardenedSignerBackend = {
    async address() { return TREASURY },
    async signAndBroadcast() { return { transactionHash: TRANSACTION_HASH } },
  }
  const directory = mkdtempSync(join(tmpdir(), 'pocket-nft-signer-'))
  const signer = new NftHardenedSigner(join(directory, 'signer.sqlite'), backend, () => NOW)
  await signer.execute(response(), constraints())
  await assert.rejects(
    signer.execute(response('nmp_signer_guard_002'), constraints()),
    (error: unknown) => (error as { code?: string }).code === 'NFT_SIGNER_AUTHORIZATION_REUSED',
  )
  signer.close()
})

test('isolated signer migrates legacy global nonce reservations to signer-scoped reservations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-nft-signer-migration-'))
  const databasePath = join(directory, 'signer.sqlite')
  const oldTreasury = getAddress('0x3333333333333333333333333333333333333333')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE nft_signer_authorizations (
      plan_id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL,
      action TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      signer_address TEXT NOT NULL,
      transaction_nonce TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL,
      calldata_hash TEXT NOT NULL,
      value_wei TEXT NOT NULL,
      gas_limit TEXT NOT NULL,
      max_fee_per_gas_wei TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL,
      transaction_hash TEXT,
      reserved_at TEXT NOT NULL,
      broadcast_at TEXT
    );
  `)
  database.prepare(`
    INSERT INTO nft_signer_authorizations (
      plan_id, external_id, action, chain_id, signer_address, transaction_nonce,
      target, calldata_hash, value_wei, gas_limit, max_fee_per_gas_wei,
      expires_at, state, transaction_hash, reserved_at, broadcast_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'nmp_legacy_signer_001',
    'legacy-mint-001',
    'mint',
    1,
    oldTreasury,
    '17',
    SEADROP_1_0,
    keccak256(calldata),
    '10000000000000000',
    '180000',
    '30000000000',
    new Date(NOW + 30_000).toISOString(),
    'broadcast',
    TRANSACTION_HASH,
    new Date(NOW - 1_000).toISOString(),
    new Date(NOW).toISOString(),
  )
  database.close()

  let broadcasts = 0
  const backend: NftHardenedSignerBackend = {
    async address() { return TREASURY },
    async signAndBroadcast() {
      broadcasts += 1
      return { transactionHash: TRANSACTION_HASH }
    },
  }
  const signer = new NftHardenedSigner(databasePath, backend, () => NOW)
  const result = await signer.execute(response(), constraints())
  assert.equal(result.transactionHash, TRANSACTION_HASH)
  assert.equal(broadcasts, 1)
  signer.close()

  const migrated = new DatabaseSync(databasePath)
  const rows = migrated.prepare(`
    SELECT signer_address, transaction_nonce
    FROM nft_signer_authorizations
    ORDER BY signer_address
  `).all().map(row => ({ ...row })) as Array<{
    signer_address: string
    transaction_nonce: string
  }>
  assert.deepEqual(rows, [
    { signer_address: TREASURY, transaction_nonce: '17' },
    { signer_address: oldTreasury, transaction_nonce: '17' },
  ].sort((left, right) => left.signer_address.localeCompare(right.signer_address)))
  migrated.close()
})
