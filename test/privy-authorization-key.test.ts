import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import {
  derivePrivyAuthorizationPublicKey,
  normalizePrivyPublicKey,
} from '../src/privy-authorization-key.js'

test('derives the registered SPKI public key from a Privy authorization key', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  assert.equal(
    derivePrivyAuthorizationPublicKey(`wallet-auth:${privateKey}`),
    normalizePrivyPublicKey(publicKey),
  )
})

test('rejects malformed or truncated Privy authorization keys', () => {
  assert.throws(
    () => derivePrivyAuthorizationPublicKey('wallet-auth:YWJjZA=='),
    /malformed or truncated/,
  )
  assert.throws(
    () => derivePrivyAuthorizationPublicKey('not-a-privy-key'),
    /wallet-auth prefix/,
  )
})
