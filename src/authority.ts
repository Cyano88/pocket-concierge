import type {
  AuthorityDecision,
  AuthorityReceipt,
  Mission,
  MissionAction,
} from './types.js'
import { digest, parseUsdtAtomic } from './validation.js'

type AuthorityMissionContext = Pick<Mission, 'mandate' | 'mandateId' | 'manifestId'> & {
  actions: Array<Pick<MissionAction, 'maximumUsdt'>>
}

type AuthorityActionContext = Pick<
  MissionAction,
  'actionId' | 'category' | 'serviceId' | 'privateInputRef' | 'maximumUsdt'
>

export function evaluateAuthority(
  mission: AuthorityMissionContext,
  action: AuthorityActionContext,
  evaluatedAt: string,
): AuthorityDecision {
  const mandate = mission.mandate
  const reasons: AuthorityDecision['reasons'] = []
  const evaluated = Date.parse(evaluatedAt)
  if (evaluated < Date.parse(mandate.validFrom)) reasons.push('MANDATE_NOT_YET_VALID')
  if (evaluated >= Date.parse(mandate.expiresAt)) reasons.push('MANDATE_EXPIRED')
  if (!mandate.allowedCategories.includes(action.category)) reasons.push('CATEGORY_NOT_ALLOWED')
  if (!mandate.allowedServiceIds.includes(action.serviceId)) reasons.push('SERVICE_NOT_ALLOWED')
  if (!mandate.allowedPrivateInputRefs.includes(action.privateInputRef)) reasons.push('RECIPIENT_NOT_ALLOWED')
  if (mission.actions.length > mandate.maximumActions) reasons.push('ACTION_LIMIT_EXCEEDED')
  if (parseUsdtAtomic(action.maximumUsdt) > parseUsdtAtomic(mandate.maximumPerActionUsdt)) {
    reasons.push('AMOUNT_ABOVE_ACTION_LIMIT')
  }
  const missionTotal = mission.actions.reduce((total, item) => total + parseUsdtAtomic(item.maximumUsdt), 0n)
  if (missionTotal > parseUsdtAtomic(mandate.maximumMissionUsdt)) reasons.push('AMOUNT_ABOVE_MISSION_LIMIT')

  const hardBlocked = reasons.length > 0
  const outcome: AuthorityDecision['outcome'] = hardBlocked
    ? 'BLOCK'
    : parseUsdtAtomic(action.maximumUsdt) > parseUsdtAtomic(mandate.approvalThresholdUsdt)
      ? 'ESCALATE'
      : 'APPROVE'
  if (!hardBlocked) reasons.push(outcome === 'ESCALATE' ? 'HUMAN_APPROVAL_REQUIRED' : 'POLICY_APPROVED')
  const core = {
    mandateId: mission.mandateId,
    manifestId: mission.manifestId,
    actionId: action.actionId,
    evaluatedAt,
    outcome,
    reasons,
  }
  return {
    decisionId: `pd_${digest(core).slice(0, 32)}`,
    ...core,
  }
}

export function buildAuthorityReceipt(mission: Mission, action: MissionAction): AuthorityReceipt {
  if (!action.evidence) throw new Error('Authority receipt requires execution evidence.')
  const exception = action.authorityException
    ? {
        exceptionId: action.authorityException.exceptionId,
        decisionId: action.authorityException.decisionId,
        approvedMaximumUsdt: action.authorityException.approvedMaximumUsdt,
        approvedAt: action.authorityException.approvedAt,
        expiresAt: action.authorityException.expiresAt,
        consumedAt: action.authorityException.consumedAt,
      }
    : null
  const core = {
    receiptVersion: '1' as const,
    mandateId: mission.mandateId,
    manifestId: mission.manifestId,
    missionId: mission.missionId,
    actionId: action.actionId,
    cycleIdHash: digest(action.cycleId),
    decision: action.authorityDecision,
    exception,
    target: {
      category: action.category,
      serviceId: action.serviceId,
      variationCode: action.variationCode,
      privateInputRefHash: digest(action.privateInputRef),
    },
    limit: {
      maximumUsdt: action.maximumUsdt,
    },
    execution: action.evidence,
  }
  const receiptHash = digest(core)
  return {
    receiptId: `pr_${receiptHash.slice(0, 32)}`,
    receiptHash,
    ...core,
  }
}

export function verifyAuthorityReceipt(receipt: AuthorityReceipt) {
  const { receiptId, receiptHash, ...core } = receipt
  const expectedHash = digest(core)
  return {
    valid: receiptHash === expectedHash && receiptId === `pr_${expectedHash.slice(0, 32)}`,
    expectedHash,
  }
}
