import { timingSafeEqual } from 'node:crypto'
import { ConciergeError } from './errors.js'

export function parseAgentKeys(raw: string | undefined) {
  const keys = new Map<string, string>()
  for (const entry of String(raw ?? '').split(',')) {
    const separator = entry.indexOf(':')
    if (separator < 1) continue
    const ownerId = entry.slice(0, separator).trim()
    const secret = entry.slice(separator + 1).trim()
    if (/^[a-zA-Z0-9_-]{3,64}$/.test(ownerId) && secret.length >= 24) keys.set(ownerId, secret)
  }
  return keys
}

export function authenticate(authorization: string | undefined, keys: Map<string, string>) {
  const supplied = String(authorization ?? '').replace(/^Bearer\s+/i, '')
  for (const [ownerId, expected] of keys) {
    const left = Buffer.from(supplied)
    const right = Buffer.from(expected)
    if (left.length === right.length && timingSafeEqual(left, right)) return ownerId
  }
  throw new ConciergeError('UNAUTHORIZED', 'A valid Pocket Concierge agent bearer key is required.', 401)
}
