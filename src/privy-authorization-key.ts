import { createPrivateKey, createPublicKey } from 'node:crypto'

const PREFIXES = ['wallet-auth:', 'wallet-api:'] as const

export function normalizePrivyPublicKey(value: string) {
  return value.replace(/\s+/g, '')
}

export function derivePrivyAuthorizationPublicKey(privateKey: string) {
  const trimmed = privateKey.trim()
  const prefix = PREFIXES.find(candidate => trimmed.startsWith(candidate))
  if (!prefix) {
    throw new Error('Privy authorization key is missing the wallet-auth prefix.')
  }
  const encoded = trimmed.slice(prefix.length)
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Privy authorization key payload is not valid base64.')
  }
  try {
    const imported = createPrivateKey({
      key: Buffer.from(encoded, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    return normalizePrivyPublicKey(
      createPublicKey(imported).export({ format: 'der', type: 'spki' }).toString('base64'),
    )
  } catch {
    throw new Error('Privy authorization key is malformed or truncated.')
  }
}
