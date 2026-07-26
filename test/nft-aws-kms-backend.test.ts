import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { bytesToHex, hexToBytes, keccak256, parseSignature, parseTransaction, type Hex } from 'viem'
import { AwsKmsNftSignerBackend, decodeKmsDerSignature } from '../src/nft-aws-kms-backend.js'
import type { ValidatedAssistedPlan } from '../src/nft-assisted-worker.js'

const PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex
const account = privateKeyToAccount(PRIVATE_KEY)

function base64url(hex: Hex) {
  return Buffer.from(hexToBytes(hex)).toString('base64url')
}

function spki() {
  const publicBytes = hexToBytes(account.publicKey)
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'secp256k1',
      d: base64url(PRIVATE_KEY),
      x: Buffer.from(publicBytes.slice(1, 33)).toString('base64url'),
      y: Buffer.from(publicBytes.slice(33, 65)).toString('base64url'),
    },
    format: 'jwk',
  })
  return new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }))
}

function derInteger(value: bigint) {
  let bytes = hexToBytes(`0x${value.toString(16).padStart(2, '0')}` as Hex)
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.slice(1)
  if ((bytes[0] ?? 0) & 0x80) bytes = Uint8Array.from([0, ...bytes])
  return Uint8Array.from([0x02, bytes.length, ...bytes])
}

function derSignature(r: bigint, s: bigint) {
  const left = derInteger(r)
  const right = derInteger(s)
  return Uint8Array.from([0x30, left.length + right.length, ...left, ...right])
}

function plan(): ValidatedAssistedPlan {
  return {
    action: 'refund',
    externalId: 'nft-kms-test-0001',
    orderId: 'nmo_test',
    planId: 'nrp_test',
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    transaction: {
      chainId: 1,
      from: account.address,
      to: '0x2222222222222222222222222222222222222222',
      data: '0x',
      valueWei: '12345',
      gasLimit: '21000',
      maxFeePerGasWei: '2000000000',
      nonce: '17',
    },
  }
}

test('AWS KMS backend signs and broadcasts the exact nonce-bound Ethereum envelope', async () => {
  let serialized: Hex | undefined
  const backend = new AwsKmsNftSignerBackend({
    keyId: 'alias/pocket-nft-test',
    kms: {
      async send(command: { input: Record<string, unknown> }) {
        if ('Message' in command.input) {
          assert.equal(command.input.MessageType, 'DIGEST')
          assert.equal(command.input.SigningAlgorithm, 'ECDSA_SHA_256')
          const digest = bytesToHex(command.input.Message as Uint8Array)
          const signature = parseSignature(await account.sign({ hash: digest }))
          return {
            Signature: derSignature(BigInt(signature.r), BigInt(signature.s)),
          }
        }
        return { PublicKey: spki() }
      },
    } as never,
    broadcaster: {
      async sendRawTransaction(input: { serializedTransaction: Hex }) {
        serialized = input.serializedTransaction
        return keccak256(input.serializedTransaction)
      },
    } as never,
  })

  assert.equal(await backend.address(), account.address)
  const result = await backend.signAndBroadcast(plan())
  assert.match(result.transactionHash, /^0x[0-9a-f]{64}$/)
  assert.ok(serialized)
  const parsed = parseTransaction(serialized)
  assert.equal(parsed.chainId, 1)
  assert.equal(parsed.type, 'legacy')
  assert.equal(parsed.nonce, 17)
  assert.equal(parsed.to, plan().transaction.to)
  assert.equal(parsed.value, 12345n)
  assert.equal(parsed.gas, 21000n)
  assert.equal(parsed.gasPrice, 2000000000n)
  assert.equal(parsed.data ?? '0x', '0x')
})

test('KMS DER parser rejects invalid and out-of-range signatures', () => {
  assert.throws(() => decodeKmsDerSignature(Uint8Array.from([0x01, 0x00])))
  assert.throws(() => decodeKmsDerSignature(derSignature(0n, 1n)))
})
