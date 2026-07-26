import assert from 'node:assert/strict'
import test from 'node:test'
import { Transaction, Wallet } from 'ethers'
import { keccak256, type Address, type Hex } from 'viem'
import { VpsNftSignerBackend } from '../src/nft-vps-signer-backend.js'
import type { ValidatedAssistedPlan } from '../src/nft-assisted-worker.js'

const wallet = new Wallet(`0x${'11'.repeat(32)}`)

function plan(): ValidatedAssistedPlan {
  return {
    action: 'refund',
    externalId: 'nft-vps-test-0001',
    orderId: 'nmo_test',
    planId: 'nrp_test',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    transaction: {
      chainId: 1,
      from: wallet.address as Address,
      to: '0x2222222222222222222222222222222222222222',
      data: '0x',
      valueWei: '12345',
      gasLimit: '21000',
      maxFeePerGasWei: '2000000000',
      nonce: '17',
    },
  }
}

test('VPS signer broadcasts only the exact nonce-bound Ethereum envelope', async () => {
  let serialized: Hex | undefined
  const backend = new VpsNftSignerBackend({
    signer: wallet,
    broadcaster: {
      async sendRawTransaction(input: { serializedTransaction: Hex }) {
        serialized = input.serializedTransaction
        return keccak256(input.serializedTransaction)
      },
    } as never,
  })
  assert.equal(await backend.address(), wallet.address)
  const result = await backend.signAndBroadcast(plan())
  assert.match(result.transactionHash, /^0x[0-9a-f]{64}$/)
  assert.ok(serialized)

  const transaction = Transaction.from(serialized)
  assert.equal(transaction.from, wallet.address)
  assert.equal(transaction.type, 0)
  assert.equal(transaction.chainId, 1n)
  assert.equal(transaction.nonce, 17)
  assert.equal(transaction.to, plan().transaction.to)
  assert.equal(transaction.value, 12345n)
  assert.equal(transaction.gasLimit, 21000n)
  assert.equal(transaction.gasPrice, 2000000000n)
  assert.equal(transaction.data, '0x')
})

test('encrypted keystore unlock derives the same execution address', async () => {
  const password = 'correct horse battery staple'
  const encrypted = await wallet.encrypt(password)
  const backend = await VpsNftSignerBackend.fromEncryptedKeystore(
    encrypted,
    password,
    {
      broadcaster: {
        async sendRawTransaction() {
          throw new Error('must not broadcast during address check')
        },
      } as never,
    },
  )
  assert.equal(await backend.address(), wallet.address)
})
