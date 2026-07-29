import assert from 'node:assert/strict'
import test from 'node:test'
import { FixedWindowRateLimiter } from '../src/rate-limit.js'

test('public NFT order limiter enforces per-caller and global windows', () => {
  let now = 1_000
  const limiter = new FixedWindowRateLimiter(2, 3, 60_000, () => now)

  assert.equal(limiter.consume('buyer-a').allowed, true)
  assert.equal(limiter.consume('buyer-a').allowed, true)
  assert.equal(limiter.consume('buyer-a').allowed, false)
  assert.equal(limiter.consume('buyer-b').allowed, true)
  assert.equal(limiter.consume('buyer-c').allowed, false)

  now += 60_000
  assert.equal(limiter.consume('buyer-a').allowed, true)
  assert.equal(limiter.consume('buyer-c').allowed, true)
})
