import { ConciergeError } from './errors.js'
import type { Mission, MissionInput } from './types.js'
import { clean } from './validation.js'

const SAFE_ID = /^[a-zA-Z0-9:_-]{3,128}$/

function record(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConciergeError('ERRAND_INVALID', `${name} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function safe(value: unknown, name: string, max = 128) {
  const result = clean(value, max)
  if (!SAFE_ID.test(result)) throw new ConciergeError('ERRAND_INVALID', `${name} contains unsupported characters.`)
  return result
}

export function errandToMissionInput(raw: unknown): MissionInput {
  const input = record(raw, 'request')
  const errand = record(input.errand, 'errand')
  const mandate = record(input.mandate, 'mandate')
  const externalId = safe(input.externalId, 'externalId')
  const cycleId = safe(input.cycleId, 'cycleId', 80)
  const missionExternalId = `${externalId}:${cycleId}`
  if (missionExternalId.length > 128) {
    throw new ConciergeError('ERRAND_INVALID', 'externalId and cycleId together must be at most 127 characters.')
  }
  const category = clean(errand.category, 20)
  const serviceId = safe(errand.serviceId, 'errand.serviceId', 80)
  const variationCode = safe(errand.variationCode, 'errand.variationCode', 100)
  const privateInputRef = safe(errand.privateInputRef, 'errand.privateInputRef', 80)
  const maximumUsdt = clean(errand.maximumUsdt, 32)
  const title = clean(input.title || `Household ${category} errand`, 160)
  return {
    externalId: missionExternalId,
    title,
    timezone: clean(input.timezone || 'UTC', 80),
    mandate: {
      policyVersion: '1',
      validFrom: clean(mandate.validFrom, 40),
      expiresAt: clean(mandate.expiresAt, 40),
      allowedCategories: [category] as MissionInput['mandate']['allowedCategories'],
      allowedServiceIds: [serviceId],
      allowedPrivateInputRefs: [privateInputRef],
      maximumPerActionUsdt: clean(mandate.maximumPerActionUsdt || maximumUsdt, 32),
      maximumMissionUsdt: clean(mandate.maximumCycleUsdt || maximumUsdt, 32),
      approvalThresholdUsdt: clean(mandate.approvalThresholdUsdt || maximumUsdt, 32),
      maximumActions: 1,
    },
    actions: [{
      type: 'okx_bill',
      reference: cycleId,
      description: clean(errand.description || title, 160),
      dueAt: clean(input.dueAt, 40),
      category: category as MissionInput['actions'][number]['category'],
      serviceId,
      variationCode,
      privateInputRef,
      maximumUsdt,
    }],
  }
}

export function errandView(mission: Mission, execution?: unknown, receipt?: unknown) {
  const action = mission.actions[0]
  if (!action) throw new ConciergeError('ERRAND_INVALID', 'Errand mission has no action.', 500)
  const state = action.state === 'planned' && action.authorityDecision.outcome === 'BLOCK'
    ? 'blocked'
    : action.state === 'planned' && action.authorityDecision.outcome === 'ESCALATE'
      ? 'awaiting_human_approval'
      : action.state === 'planned'
        ? 'awaiting_authorization'
        : action.state === 'executing'
          ? 'awaiting_provider_completion'
          : action.state
  const authorizePath = `/v1/errands/${encodeURIComponent(mission.externalId)}/authorize`
  const completePath = `/v1/errands/${encodeURIComponent(mission.externalId)}/complete`
  const nextAction = state === 'blocked' || state === 'delivered' || state === 'needs_review'
    ? null
    : state === 'awaiting_provider_completion'
      ? { type: 'pay_provider_then_complete', path: completePath }
      : {
          type: state === 'awaiting_human_approval' ? 'approve_exact_exception' : 'authorize_manifest',
          path: authorizePath,
          manifestId: mission.manifestId,
          requiresException: state === 'awaiting_human_approval',
        }
  return {
    errandId: mission.externalId,
    cycleId: action.reference,
    state,
    decision: action.authorityDecision,
    maximumUsdt: action.maximumUsdt,
    nextAction,
    ...(execution ? { execution } : {}),
    ...(receipt ? { receipt } : {}),
  }
}
