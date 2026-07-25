import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const USDT_DECIMALS = 6

export function parseUsdt(value) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new Error(`Invalid USDT amount: ${text || '(empty)'}`)
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(USDT_DECIMALS, '0'))
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item === undefined ? null : item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

export function bodyBinding(body, key) {
  if (String(key).length < 24) throw new Error('The local binding key must be at least 24 characters.')
  return createHmac('sha256', key).update(canonical(body)).digest('hex')
}

export function bindingMatches(body, key, expected) {
  const actual = Buffer.from(bodyBinding(body, key))
  const wanted = Buffer.from(String(expected))
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function encryptionKey(key) {
  if (String(key).length < 24) throw new Error('The local binding key must be at least 24 characters.')
  return createHash('sha256').update(key).digest()
}

export function sealJson(value, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    ciphertext: encrypted.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

export function openJson(sealed, key) {
  if (
    !sealed
    || sealed.algorithm !== 'aes-256-gcm'
    || typeof sealed.iv !== 'string'
    || typeof sealed.ciphertext !== 'string'
    || typeof sealed.tag !== 'string'
  ) {
    throw new Error('The encrypted local proof is invalid.')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(sealed.iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
    return JSON.parse(plaintext)
  } catch {
    throw new Error('The encrypted local proof could not be authenticated.')
  }
}

export function parseCliJson(stdout) {
  const text = String(stdout ?? '').trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Onchain OS returned an unreadable response.')
  }
}

export function merchantParams(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('The merchant request body must be an object.')
  }
  return Object.entries(body).flatMap(([key, value]) => {
    if (!key || value === undefined || value === null) {
      throw new Error('Merchant request parameters must have a key and value.')
    }
    return ['--param', `${key}=${String(value)}`]
  })
}

export function buildQuoteCommandArgs(url, body) {
  if (!/^https:\/\//.test(String(url))) throw new Error('The payment endpoint must use HTTPS.')
  return ['payment', 'quote', String(url), '--method', 'POST', ...merchantParams(body)]
}

export function buildPaymentCommandArgs(paymentId, acceptsIndex, body) {
  if (!/^pay_[a-zA-Z0-9]+$/.test(String(paymentId))) {
    throw new Error('The confirmed paymentId is invalid.')
  }
  if (!Number.isInteger(acceptsIndex) || acceptsIndex < 0) {
    throw new Error('The confirmed acceptsIndex is invalid.')
  }
  return [
    'payment',
    'pay',
    '--payment-id',
    String(paymentId),
    '--selected-index',
    String(acceptsIndex),
    ...merchantParams(body),
    '--yes',
  ]
}

export function selectQuote(data, maximumUsdt, requestedIndex) {
  if (!data || typeof data !== 'object' || data.needsConfirm !== true || typeof data.paymentId !== 'string') {
    throw new Error('Onchain OS did not return a confirmable payment quote.')
  }
  if (!Array.isArray(data.candidates) || data.candidates.length < 1) {
    throw new Error('The quote has no payable candidates.')
  }
  const candidates = data.candidates.filter(candidate => candidate && typeof candidate === 'object')
  const selected = requestedIndex === undefined
    ? (candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.recommended === true))
    : candidates.find(candidate => candidate.acceptsIndex === requestedIndex)
  if (!selected) throw new Error('Select one candidate using its acceptsIndex.')
  if (requestedIndex === undefined && candidates.length > 1) {
    throw new Error('Multiple payment methods are available; the user must explicitly select an acceptsIndex.')
  }
  if (
    selected.tokenSymbol !== 'USDT'
    || String(selected.chainId) !== '196'
    || selected.chainName !== 'X Layer'
    || !Number.isInteger(selected.acceptsIndex)
  ) {
    throw new Error('The selected quote is not the expected X Layer USDT payment.')
  }
  const amountAtomic = BigInt(String(selected.amount))
  const amountFromHuman = parseUsdt(selected.amountHuman)
  if (amountAtomic <= 0n || amountAtomic !== amountFromHuman) {
    throw new Error('The quoted human and atomic amounts do not match.')
  }
  const maximumAtomic = parseUsdt(maximumUsdt)
  if (amountAtomic > maximumAtomic) {
    throw new Error(`Quoted amount ${selected.amountHuman} USDT exceeds the approved maximum ${maximumUsdt} USDT.`)
  }
  return {
    paymentId: data.paymentId,
    acceptsIndex: selected.acceptsIndex,
    amountAtomic: String(selected.amount),
    amountHuman: String(selected.amountHuman),
    network: selected.chainName,
    token: selected.tokenSymbol,
    recipient: String(data.decodedChallenge?.recipient || ''),
    walletWarning: typeof data.walletError === 'string' ? data.walletError : null,
  }
}

export function findStatusProof(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!(text.startsWith('{') || text.startsWith('['))) return null
    try {
      return findStatusProof(JSON.parse(text), depth + 1)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStatusProof(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const status = value.status
  if (
    status
    && typeof status === 'object'
    && typeof status.url === 'string'
    && typeof status.token === 'string'
  ) {
    return { statusUrl: status.url, statusToken: status.token }
  }
  for (const item of Object.values(value)) {
    const found = findStatusProof(item, depth + 1)
    if (found) return found
  }
  return null
}
