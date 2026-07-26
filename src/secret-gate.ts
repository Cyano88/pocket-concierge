import { timingSafeEqual } from 'node:crypto'
import { ConciergeError } from './errors.js'

export function secretsMatch(supplied: string | undefined, expected: string) {
  const suppliedBuffer = Buffer.from(String(supplied ?? ''))
  const expectedBuffer = Buffer.from(expected)
  return Boolean(
    expectedBuffer.length
    && suppliedBuffer.length === expectedBuffer.length
    && timingSafeEqual(suppliedBuffer, expectedBuffer)
  )
}

export function requireSecret(
  supplied: string | undefined,
  expected: string,
  code: string,
  message: string,
) {
  if (!secretsMatch(supplied, expected)) {
    throw new ConciergeError(code, message, 401)
  }
}
