import assert from 'node:assert/strict'
import test from 'node:test'
import { ConciergeError } from '../src/errors.js'
import { requireSecret, secretsMatch } from '../src/secret-gate.js'

const expected = 'pilot-secret-that-is-at-least-32-characters'

test('secret gate accepts only the exact pilot secret', () => {
  assert.equal(secretsMatch(expected, expected), true)
  assert.equal(secretsMatch(undefined, expected), false)
  assert.equal(secretsMatch('', expected), false)
  assert.equal(secretsMatch(`${expected}-changed`, expected), false)
  assert.equal(secretsMatch(expected.slice(0, -1), expected), false)
})

test('secret gate rejects missing and incorrect credentials before paid access', () => {
  for (const supplied of [undefined, '', 'wrong-secret-with-the-same-length-000000']) {
    assert.throws(
      () => requireSecret(supplied, expected, 'NFT_PILOT_UNAUTHORIZED', 'Pilot key required.'),
      (error: unknown) => {
        assert.ok(error instanceof ConciergeError)
        assert.equal(error.code, 'NFT_PILOT_UNAUTHORIZED')
        assert.equal(error.status, 401)
        return true
      },
    )
  }
  assert.doesNotThrow(
    () => requireSecret(expected, expected, 'NFT_PILOT_UNAUTHORIZED', 'Pilot key required.'),
  )
})
