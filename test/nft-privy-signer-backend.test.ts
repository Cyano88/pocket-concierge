import assert from 'node:assert/strict'
import test from 'node:test'
import { Wallet } from 'ethers'
import { keccak256, type Address, type Hex } from 'viem'
import {
  PrivyNftSignerBackend,
  type PrivyTransactionSigner,
} from '../src/nft-privy-signer-backend.js'
import type { ValidatedAssistedPlan } from '../src/nft-assisted-worker.js'

const wallet = new Wallet(`0x${'33'.repeat(32)}`)

function plan(): ValidatedAssistedPlan {
  return {
    action: 'mint',
    externalId: 'nft-privy-test-0001',
    orderId: 'nmo_privy_test',
    planId: 'nmp_privy_test',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    transaction: {
      chainId: 1,
      from: wallet.address as Address,
      to: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
      data: '0x12345678',
      valueWei: '1000000000000000',
      gasLimit: '155996',
      maxFeePerGasWei: '2000000000',
      nonce: '7',
    },
  }
}

async function signedEnvelope(
  input: Parameters<PrivyTransactionSigner['signTransaction']>[1],
  to = input.params.transaction.to,
) {
  const transaction = input.params.transaction
  return wallet.signTransaction({
    type: 0,
    chainId: transaction.chain_id,
    nonce: Number(BigInt(transaction.nonce)),
    to,
    data: transaction.data,
    value: BigInt(transaction.value),
    gasLimit: BigInt(transaction.gas_limit),
    gasPrice: BigInt(transaction.gas_price),
  })
}

test('Privy signer requests, verifies, and broadcasts one exact legacy envelope', async () => {
  let request: Parameters<PrivyTransactionSigner['signTransaction']>[1] | undefined
  let broadcast: Hex | undefined
  const backend = new PrivyNftSignerBackend({
    walletId: 'wallet_test',
    walletAddress: wallet.address,
    authorizationPrivateKey: 'test-authorization-private-key',
    now: () => 1_700_000_000_000,
    signerClient: {
      async signTransaction(walletId, input) {
        assert.equal(walletId, 'wallet_test')
        request = input
        return {
          signed_transaction: await signedEnvelope(input),
          encoding: 'rlp',
        }
      },
    },
    broadcaster: {
      async sendRawTransaction(input: { serializedTransaction: Hex }) {
        broadcast = input.serializedTransaction
        return keccak256(input.serializedTransaction)
      },
    } as never,
  })

  const result = await backend.signAndBroadcast(plan())
  assert.match(result.transactionHash, /^0x[0-9a-f]{64}$/)
  assert.ok(request)
  assert.equal(request.params.transaction.chain_id, 1)
  assert.equal(request.params.transaction.type, 0)
  assert.equal(request.params.transaction.nonce, '0x7')
  assert.equal(request.params.transaction.value, '0x38d7ea4c68000')
  assert.equal(request.request_expiry, 1_700_000_030_000)
  assert.ok(broadcast)
})

test('Privy signer refuses to broadcast a remotely signed envelope that drifts from the plan', async () => {
  let broadcasts = 0
  const backend = new PrivyNftSignerBackend({
    walletId: 'wallet_test',
    walletAddress: wallet.address,
    authorizationPrivateKey: 'test-authorization-private-key',
    signerClient: {
      async signTransaction(_walletId, input) {
        return {
          signed_transaction: await signedEnvelope(
            input,
            '0x4444444444444444444444444444444444444444',
          ),
          encoding: 'rlp',
        }
      },
    },
    broadcaster: {
      async sendRawTransaction() {
        broadcasts += 1
        return `0x${'55'.repeat(32)}` as Hex
      },
    } as never,
  })

  await assert.rejects(
    () => backend.signAndBroadcast(plan()),
    (error: unknown) => (
      (error as { code?: string }).code === 'NFT_VPS_SIGNER_ENVELOPE_INVALID'
    ),
  )
  assert.equal(broadcasts, 0)
})
