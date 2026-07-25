import { ConciergeError } from './errors.js'
import { clean, digest, parseUsdtAtomic } from './validation.js'

export const OKX_AUTHORITY_CHECK_ROUTE = '/v1/okx/authority-check'
export const OKX_AUTHORITY_CHECK_FEE_USDT = '0.01'
export const OKX_AUTHORITY_CHECK_FEE_ATOMIC = '10000'

export const OKX_AUTHORITY_CHECK_OUTPUT_SCHEMA = {
  input: {
    type: 'http',
    method: 'POST',
    body: {
      externalId: 'string',
      cycleId: 'string',
      action: 'object',
      mandate: 'object',
    },
  },
  output: {
    decision: 'APPROVE | ESCALATE | BLOCK',
    decisionHash: 'sha256',
    nextAction: 'object | null',
  },
} as const

const SAFE_ID = /^[a-zA-Z0-9:_-]{3,128}$/
const OPAQUE_REF = /^(?=.*[a-zA-Z])[a-zA-Z0-9:_-]{3,80}$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/

function record(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', `${name} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function safe(value: unknown, name: string, max = 128) {
  const result = clean(value, max)
  if (!SAFE_ID.test(result)) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', `${name} must contain 3-128 safe characters.`)
  }
  return result
}

function amount(value: unknown, name: string) {
  const result = clean(value, 32)
  if (!DECIMAL.test(result) || parseUsdtAtomic(result) <= 0n) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', `${name} must be a positive USDT amount with at most 6 decimals.`)
  }
  return result
}

function timestamp(value: unknown, name: string) {
  const result = clean(value, 40)
  const parsed = Date.parse(result)
  if (!result || !Number.isFinite(parsed)) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', `${name} must be a valid ISO timestamp.`)
  }
  return new Date(parsed).toISOString()
}

function list(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', `${name} must contain 1-20 values.`)
  }
  const values = value.map(item => safe(item, name, 80))
  if (new Set(values).size !== values.length) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', `${name} must not contain duplicates.`)
  }
  return values
}

export function authorityCheckExample(now: number) {
  const validFrom = new Date(now - 60_000).toISOString()
  const expiresAt = new Date(now + 60 * 60_000).toISOString()
  return {
    externalId: 'demo-household-airtime',
    cycleId: new Date(now).toISOString().slice(0, 10),
    action: {
      category: 'airtime',
      serviceId: 'mtn-airtime',
      privateInputRef: 'family-mum-phone',
      amountUsdt: '0.20',
    },
    mandate: {
      validFrom,
      expiresAt,
      allowedCategories: ['airtime'],
      allowedServiceIds: ['mtn-airtime'],
      allowedPrivateInputRefs: ['family-mum-phone'],
      maximumPerActionUsdt: '0.25',
      approvalThresholdUsdt: '0.25',
    },
  }
}

export function evaluatePaidAuthorityCheck(raw: unknown, now: number) {
  const supplied = raw && typeof raw === 'object' && !Array.isArray(raw)
    && Object.keys(raw as Record<string, unknown>).length > 0
  const input = record(supplied ? raw : authorityCheckExample(now), 'request')
  const action = record(input.action, 'action')
  const mandate = record(input.mandate, 'mandate')
  const externalId = safe(input.externalId, 'externalId')
  const cycleId = safe(input.cycleId, 'cycleId', 80)
  const category = safe(action.category, 'action.category', 80)
  const serviceId = safe(action.serviceId, 'action.serviceId', 80)
  const privateInputRef = clean(action.privateInputRef, 80)
  if (!OPAQUE_REF.test(privateInputRef)) {
    throw new ConciergeError(
      'AUTHORITY_INPUT_INVALID',
      'action.privateInputRef must be opaque and must never contain a phone, meter, smartcard, email, or wallet credential.',
    )
  }
  const amountUsdt = amount(action.amountUsdt, 'action.amountUsdt')
  const validFrom = timestamp(mandate.validFrom, 'mandate.validFrom')
  const expiresAt = timestamp(mandate.expiresAt, 'mandate.expiresAt')
  const allowedCategories = list(mandate.allowedCategories, 'mandate.allowedCategories')
  const allowedServiceIds = list(mandate.allowedServiceIds, 'mandate.allowedServiceIds')
  const allowedPrivateInputRefs = list(mandate.allowedPrivateInputRefs, 'mandate.allowedPrivateInputRefs')
  const maximumPerActionUsdt = amount(mandate.maximumPerActionUsdt, 'mandate.maximumPerActionUsdt')
  const approvalThresholdUsdt = amount(mandate.approvalThresholdUsdt, 'mandate.approvalThresholdUsdt')
  if (Date.parse(expiresAt) <= Date.parse(validFrom)) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', 'mandate.expiresAt must be later than mandate.validFrom.')
  }
  if (parseUsdtAtomic(approvalThresholdUsdt) > parseUsdtAtomic(maximumPerActionUsdt)) {
    throw new ConciergeError('AUTHORITY_INPUT_INVALID', 'approvalThresholdUsdt cannot exceed maximumPerActionUsdt.')
  }

  const evaluatedAt = new Date(now).toISOString()
  const reasons: string[] = []
  if (now < Date.parse(validFrom)) reasons.push('MANDATE_NOT_YET_VALID')
  if (now >= Date.parse(expiresAt)) reasons.push('MANDATE_EXPIRED')
  if (!allowedCategories.includes(category)) reasons.push('CATEGORY_NOT_ALLOWED')
  if (!allowedServiceIds.includes(serviceId)) reasons.push('SERVICE_NOT_ALLOWED')
  if (!allowedPrivateInputRefs.includes(privateInputRef)) reasons.push('RECIPIENT_NOT_ALLOWED')
  if (parseUsdtAtomic(amountUsdt) > parseUsdtAtomic(maximumPerActionUsdt)) {
    reasons.push('AMOUNT_ABOVE_ACTION_LIMIT')
  }
  const hardBlocked = reasons.length > 0
  const decision = hardBlocked
    ? 'BLOCK'
    : parseUsdtAtomic(amountUsdt) > parseUsdtAtomic(approvalThresholdUsdt)
      ? 'ESCALATE'
      : 'APPROVE'
  if (!hardBlocked) reasons.push(decision === 'ESCALATE' ? 'HUMAN_APPROVAL_REQUIRED' : 'POLICY_APPROVED')
  const publicInput = {
    externalId,
    cycleId,
    action: { category, serviceId, privateInputRef, amountUsdt },
    mandate: {
      validFrom,
      expiresAt,
      allowedCategories,
      allowedServiceIds,
      allowedPrivateInputRefs,
      maximumPerActionUsdt,
      approvalThresholdUsdt,
    },
  }
  const decisionHash = digest({ publicInput, evaluatedAt, decision, reasons })
  return {
    ok: true,
    service: 'Pocket Concierge Purchase Authority Check',
    exampleUsed: !supplied,
    request: publicInput,
    decision,
    reasons,
    decisionId: `pad_${decisionHash.slice(0, 32)}`,
    decisionHash,
    evaluatedAt,
    nextAction: decision === 'APPROVE'
      ? { type: 'execute_within_mandate', maximumUsdt: amountUsdt, expiresAt }
      : decision === 'ESCALATE'
        ? { type: 'request_exact_human_approval', maximumUsdt: amountUsdt, expiresAt }
        : null,
    privacy: 'No raw phone, meter, smartcard, email, wallet key, or provider status token was accepted.',
  }
}
