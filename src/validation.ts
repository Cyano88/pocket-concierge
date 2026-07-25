import { createHash } from 'node:crypto'
import { ConciergeError } from './errors.js'
import type { BillActionInput, BillCategory, MissionInput } from './types.js'

const SAFE_ID = /^[a-zA-Z0-9:_-]{8,128}$/
const SAFE_REF = /^[a-zA-Z0-9:_-]{3,80}$/
const OPAQUE_REF = /^(?=.*[a-zA-Z])[a-zA-Z0-9:_-]{3,80}$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/
const CATEGORIES = new Set<BillCategory>(['data', 'electricity', 'tv'])

export function clean(value: unknown, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConciergeError('MISSION_INVALID', 'Mission request must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function parseDueAt(value: unknown) {
  const dueAt = clean(value, 40)
  const parsed = Date.parse(dueAt)
  if (!dueAt || !Number.isFinite(parsed)) {
    throw new ConciergeError('DUE_AT_INVALID', 'Every action requires a valid ISO dueAt timestamp.')
  }
  return new Date(parsed).toISOString()
}

function parseAction(value: unknown): BillActionInput {
  const action = record(value)
  if (clean(action.type, 30) !== 'okx_bill') {
    throw new ConciergeError('ACTION_TYPE_UNSUPPORTED', 'The pre-hackathon baseline supports only okx_bill actions.')
  }
  const reference = clean(action.reference, 80)
  const description = clean(action.description, 160)
  const category = clean(action.category, 20) as BillCategory
  const serviceId = clean(action.serviceId, 80)
  const variationCode = clean(action.variationCode, 100)
  const privateInputRef = clean(action.privateInputRef, 80)
  const maximumUsdt = clean(action.maximumUsdt, 32)
  if (!SAFE_REF.test(reference)) throw new ConciergeError('ACTION_REFERENCE_INVALID', 'Action reference must be 3-80 safe characters.')
  if (!description) throw new ConciergeError('ACTION_DESCRIPTION_REQUIRED', 'Action description is required.')
  if (!CATEGORIES.has(category)) throw new ConciergeError('BILL_CATEGORY_INVALID', 'Bill category must be data, electricity, or tv.')
  if (!SAFE_REF.test(serviceId)) throw new ConciergeError('SERVICE_ID_INVALID', 'A provider serviceId is required.')
  if (!SAFE_REF.test(variationCode)) throw new ConciergeError('VARIATION_CODE_INVALID', 'A provider variationCode is required.')
  if (!OPAQUE_REF.test(privateInputRef)) {
    throw new ConciergeError('PRIVATE_INPUT_REF_INVALID', 'Use an opaque privateInputRef; never send a phone, meter, or smartcard number to Concierge.')
  }
  if (!DECIMAL.test(maximumUsdt) || Number(maximumUsdt) <= 0) {
    throw new ConciergeError('MAXIMUM_INVALID', 'maximumUsdt must be a positive amount with at most 6 decimals.')
  }
  return {
    type: 'okx_bill',
    reference,
    description,
    dueAt: parseDueAt(action.dueAt),
    category,
    serviceId,
    variationCode,
    privateInputRef,
    maximumUsdt,
  }
}

export function parseMission(value: unknown): MissionInput {
  const input = record(value)
  const externalId = clean(input.externalId, 128)
  const title = clean(input.title, 160)
  const timezone = clean(input.timezone || 'UTC', 80)
  if (!SAFE_ID.test(externalId)) throw new ConciergeError('EXTERNAL_ID_INVALID', 'externalId must be 8-128 safe characters.')
  if (!title) throw new ConciergeError('MISSION_TITLE_REQUIRED', 'Mission title is required.')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    throw new ConciergeError('TIMEZONE_INVALID', 'timezone must be a valid IANA timezone.')
  }
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 10) {
    throw new ConciergeError('ACTIONS_INVALID', 'Mission must contain 1-10 actions.')
  }
  const actions = input.actions.map(parseAction)
  if (new Set(actions.map(action => action.reference)).size !== actions.length) {
    throw new ConciergeError('ACTION_REFERENCE_DUPLICATE', 'Action references must be unique inside a mission.')
  }
  return { externalId, title, timezone, actions }
}
