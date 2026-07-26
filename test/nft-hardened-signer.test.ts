import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
