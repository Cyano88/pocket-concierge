import { ConciergeError } from './errors.js'
import { buildAuthorityReceipt, evaluateAuthority, verifyAuthorityReceipt } from './authority.js'
import type { MissionStore } from './store.js'
import type { AuthorityException, BillsStatusResponse, Mission, MissionAction } from './types.js'
import { clean, digest, parseMission } from './validation.js'

const BILLS_ORIGIN = 'https://bills.hashpaylink.com'
const BILLS_ENDPOINT = `${BILLS_ORIGIN}/v1/okx/bills`
const TERMINAL_DELIVERED = new Set(['delivered'])
const NEEDS_REVIEW = new Set(['refund_required', 'refunding', 'refunded', 'provider_failed_unverified', 'needs_review'])

export type ConciergeDependencies = {
  store: MissionStore
  now: () => number
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>
}

function iso(now: number) {
  return new Date(now).toISOString()
}

function publicMission(mission: Mission) {
  return {
    ...mission,
    actions: mission.actions.map(({ privateInputRef, ...action }) => ({
      ...action,
      privateInputRequired: true,
      privateInputRef,
    })),
  }
}

export class ConciergeService {
  constructor(private readonly dependencies: ConciergeDependencies) {}

  preview(ownerId: string, raw: unknown) {
    const input = parseMission(raw)
    const plan = this.buildMission(ownerId, input)
    return publicMission(plan)
  }

  async create(ownerId: string, raw: unknown) {
    const input = parseMission(raw)
    const candidate = this.buildMission(ownerId, input)
    const result = await this.dependencies.store.putIfAbsent(candidate)
    if (!result.inserted && result.mission.manifestId !== candidate.manifestId) {
      throw new ConciergeError('MISSION_CONFLICT', 'externalId already belongs to a different immutable mission.', 409)
    }
    return { replayed: !result.inserted, mission: publicMission(result.mission) }
  }

  async get(ownerId: string, externalId: string) {
    return publicMission(await this.requireMission(ownerId, externalId))
  }

  async getReceipt(receiptId: string) {
    const receipt = await this.dependencies.store.getReceipt(receiptId)
    if (!receipt) throw new ConciergeError('RECEIPT_NOT_FOUND', 'Authority receipt was not found.', 404)
    return { ...receipt, verification: verifyAuthorityReceipt(receipt) }
  }

  async approve(ownerId: string, externalId: string, actionId: string, raw: unknown) {
    const mission = await this.requireMission(ownerId, externalId)
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const manifestId = clean(input.manifestId, 128)
    if (mission.manifestId !== manifestId) throw new ConciergeError('MANIFEST_MISMATCH', 'Approval does not match the immutable mission manifest.', 409)
    const action = this.requireAction(mission, actionId)
    if (action.state === 'delivered') return publicMission(mission)
    if (action.state !== 'planned' && action.state !== 'approved') {
      throw new ConciergeError('ACTION_NOT_APPROVABLE', `Action in ${action.state} state cannot be approved.`, 409)
    }
    this.assertMandateActive(mission)
    if (action.authorityDecision.outcome === 'BLOCK') {
      throw new ConciergeError('AUTHORITY_BLOCKED', `Mandate blocked this action: ${action.authorityDecision.reasons.join(', ')}.`, 409)
    }
    if (action.authorityDecision.outcome === 'ESCALATE') {
      const needsException = !action.authorityException
        || (action.authorityException.consumedAt === null && Date.parse(action.authorityException.expiresAt) <= this.dependencies.now())
      if (needsException) {
        if (!input.exception) {
          throw new ConciergeError('AUTHORITY_EXCEPTION_REQUIRED', 'This action exceeds the automatic approval threshold and needs a current exact one-use exception.', 409)
        }
        action.authorityException = this.parseException(mission, action, input.exception)
      }
    }
    if (action.state === 'planned') {
      const expectedRevision = mission.revision
      action.state = 'approved'
      action.approvedAt = iso(this.dependencies.now())
      mission.state = 'active'
      mission.updatedAt = action.approvedAt
      mission.revision += 1
      await this.dependencies.store.update(mission, expectedRevision)
    }
    return publicMission(mission)
  }

  async start(ownerId: string, externalId: string, actionId: string) {
    const mission = await this.requireMission(ownerId, externalId)
    const action = this.requireAction(mission, actionId)
    if (action.state !== 'approved' && action.state !== 'executing') {
      throw new ConciergeError('ACTION_NOT_APPROVED', 'Action must be approved before execution starts.', 409)
    }
    if (Date.parse(action.dueAt) > this.dependencies.now()) {
      throw new ConciergeError('ACTION_NOT_DUE', 'Action is approved but not due yet.', 409)
    }
    if (action.state === 'approved') {
      this.assertMandateActive(mission)
      if (action.authorityDecision.outcome === 'BLOCK') {
        throw new ConciergeError('AUTHORITY_BLOCKED', 'The mandate blocks this action.', 409)
      }
      if (action.authorityDecision.outcome === 'ESCALATE') {
        const exception = action.authorityException
        if (!exception) throw new ConciergeError('AUTHORITY_EXCEPTION_REQUIRED', 'This action requires an exact human exception.', 409)
        if (Date.parse(exception.expiresAt) <= this.dependencies.now()) {
          throw new ConciergeError('AUTHORITY_EXCEPTION_EXPIRED', 'The one-use authority exception has expired.', 409)
        }
      }
      const expectedRevision = mission.revision
      action.state = 'executing'
      action.startedAt = iso(this.dependencies.now())
      if (action.authorityException) action.authorityException.consumedAt = action.startedAt
      mission.updatedAt = action.startedAt
      mission.revision += 1
      await this.dependencies.store.update(mission, expectedRevision)
    }
    return {
      missionId: mission.missionId,
      manifestId: mission.manifestId,
      actionId: action.actionId,
      cycleId: action.cycleId,
      requiresUserConfirmation: true,
      protocol: 'OKX Agent Payments Protocol',
      request: {
        method: 'POST',
        url: BILLS_ENDPOINT,
        publicBody: {
          externalOrderId: action.downstreamExternalOrderId,
          category: action.category,
          serviceId: action.serviceId,
          variationCode: action.variationCode,
        },
        privateBodyPlaceholders: {
          customerReference: `$private.${action.privateInputRef}.customerReference`,
          contactPhone: `$private.${action.privateInputRef}.contactPhone`,
          amountNgn: `$private.${action.privateInputRef}.amountNgn`,
        },
      },
      safety: {
        maximumUsdt: action.maximumUsdt,
        authorityDecisionId: action.authorityDecision.decisionId,
        authorityOutcome: action.authorityDecision.outcome,
        exceptionId: action.authorityException?.exceptionId ?? null,
        instruction: 'Obtain a fresh quote, show the exact charge to the user, and stop unless the user confirms.',
      },
      verification: {
        method: 'POST',
        path: `/v1/missions/${encodeURIComponent(externalId)}/actions/${encodeURIComponent(actionId)}/verify`,
        required: ['statusUrl', 'statusToken'],
      },
    }
  }

  async verify(ownerId: string, externalId: string, actionId: string, raw: unknown) {
    const mission = await this.requireMission(ownerId, externalId)
    const action = this.requireAction(mission, actionId)
    if (action.state === 'delivered') return publicMission(mission)
    if (action.state !== 'executing' && action.state !== 'needs_review') {
      throw new ConciergeError('ACTION_NOT_EXECUTING', 'Only an executing action can be verified.', 409)
    }
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const statusUrl = clean(input.statusUrl, 500)
    const statusToken = clean(input.statusToken, 2_000)
    const verifiedUrl = this.verifyBillsStatusUrl(statusUrl)
    if (!statusToken) throw new ConciergeError('STATUS_TOKEN_REQUIRED', 'Pocket Bills statusToken is required for one verification request.')
    verifiedUrl.searchParams.set('refresh', 'true')
    let response: unknown
    try {
      response = await this.dependencies.fetchJson(verifiedUrl.toString(), {
        headers: { Accept: 'application/json', 'X-Status-Token': statusToken },
      })
    } catch (error) {
      throw new ConciergeError('DOWNSTREAM_STATUS_FAILED', `Pocket Bills status verification failed: ${error instanceof Error ? error.message : 'unknown error'}`, 502)
    }
    const status = response as BillsStatusResponse
    const settlement = status?.settlement
    const settlementId = clean(settlement?.settlementId, 100)
    const downstreamExternalId = clean(settlement?.externalOrderId, 128)
    const state = clean(settlement?.state, 80)
    const receiptHash = clean(settlement?.receiptHash, 160)
    if (status?.ok !== true || !settlementId || downstreamExternalId !== action.downstreamExternalOrderId || !state) {
      throw new ConciergeError('DOWNSTREAM_EVIDENCE_INVALID', 'Pocket Bills returned evidence that does not match this mission action.', 502)
    }
    if (TERMINAL_DELIVERED.has(state) && !receiptHash) {
      throw new ConciergeError('DOWNSTREAM_RECEIPT_MISSING', 'Delivered Pocket Bills evidence is missing its receipt hash.', 502)
    }
    if (!TERMINAL_DELIVERED.has(state) && !NEEDS_REVIEW.has(state)) {
      throw new ConciergeError('DOWNSTREAM_NOT_TERMINAL', `Pocket Bills settlement is ${state}; retry verification later with the original status token.`, 409)
    }
    const expectedRevision = mission.revision
    action.state = TERMINAL_DELIVERED.has(state) ? 'delivered' : 'needs_review'
    action.evidence = {
      settlementId,
      externalOrderId: downstreamExternalId,
      state,
      receiptHash: receiptHash || null,
      verifiedAt: iso(this.dependencies.now()),
    }
    const receipt = buildAuthorityReceipt(mission, action)
    action.authorityReceiptId = receipt.receiptId
    mission.state = mission.actions.every(item => item.state === 'delivered')
      ? 'delivered'
      : mission.actions.some(item => item.state === 'needs_review') ? 'needs_review' : 'active'
    mission.updatedAt = action.evidence.verifiedAt
    mission.revision += 1
    await this.dependencies.store.update(mission, expectedRevision, receipt)
    return publicMission(mission)
  }

  private buildMission(ownerId: string, input: ReturnType<typeof parseMission>): Mission {
    const core = { ownerId, ...input }
    const manifestId = digest(core)
    const now = iso(this.dependencies.now())
    const missionId = `pm_${digest({ ownerId, externalId: input.externalId }).slice(0, 24)}`
    const mandateId = `pmnd_${digest(input.mandate).slice(0, 32)}`
    const actionPlans = input.actions.map(action => {
      const actionId = `pa_${digest({ missionId, reference: action.reference }).slice(0, 20)}`
      const cycleDate = action.dueAt.slice(0, 10)
      return {
        ...action,
        actionId,
        cycleId: `${input.externalId}:${action.reference}:${cycleDate}`,
        downstreamExternalOrderId: `concierge:${missionId}:${actionId}:${cycleDate}`,
        state: 'planned',
        approvedAt: null,
        startedAt: null,
        authorityException: null,
        evidence: null,
        authorityReceiptId: null,
      }
    })
    const authorityContext = {
      mandate: input.mandate,
      mandateId,
      manifestId,
      actions: actionPlans,
    }
    const actions: MissionAction[] = actionPlans.map(action => ({
      ...action,
      state: 'planned',
      authorityException: null,
      authorityDecision: evaluateAuthority(authorityContext, action, action.dueAt),
    }))
    const mission: Mission = {
      revision: 0,
      missionId,
      manifestId,
      mandateId,
      ownerId,
      externalId: input.externalId,
      title: input.title,
      timezone: input.timezone,
      mandate: input.mandate,
      state: 'planned',
      createdAt: now,
      updatedAt: now,
      actions,
    }
    return mission
  }

  private async requireMission(ownerId: string, externalId: string) {
    const mission = await this.dependencies.store.get(ownerId, externalId)
    if (!mission) throw new ConciergeError('MISSION_NOT_FOUND', 'Mission was not found.', 404)
    return mission
  }

  private requireAction(mission: Mission, actionId: string) {
    const action = mission.actions.find(item => item.actionId === actionId)
    if (!action) throw new ConciergeError('ACTION_NOT_FOUND', 'Mission action was not found.', 404)
    return action
  }

  private assertMandateActive(mission: Mission) {
    const now = this.dependencies.now()
    if (now < Date.parse(mission.mandate.validFrom)) {
      throw new ConciergeError('MANDATE_NOT_YET_VALID', 'The mandate is not active yet.', 409)
    }
    if (now >= Date.parse(mission.mandate.expiresAt)) {
      throw new ConciergeError('MANDATE_EXPIRED', 'The mandate has expired.', 409)
    }
  }

  private parseException(mission: Mission, action: MissionAction, raw: unknown): AuthorityException {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const decisionId = clean(input.decisionId, 128)
    const nonce = clean(input.nonce, 128)
    const approvedMaximumUsdt = clean(input.approvedMaximumUsdt, 32)
    const expiresAtInput = clean(input.expiresAt, 40)
    const expiresAtMs = Date.parse(expiresAtInput)
    if (decisionId !== action.authorityDecision.decisionId) {
      throw new ConciergeError('AUTHORITY_DECISION_MISMATCH', 'Exception does not match the action authority decision.', 409)
    }
    if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(nonce)) {
      throw new ConciergeError('AUTHORITY_NONCE_INVALID', 'Exception nonce must be 8-128 safe characters.')
    }
    if (approvedMaximumUsdt !== action.maximumUsdt) {
      throw new ConciergeError('AUTHORITY_AMOUNT_MISMATCH', 'Exception must approve the action exact maximumUsdt.', 409)
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.dependencies.now() || expiresAtMs > Date.parse(mission.mandate.expiresAt)) {
      throw new ConciergeError('AUTHORITY_EXPIRY_INVALID', 'Exception expiry must be in the future and no later than the mandate expiry.')
    }
    const approvedAt = iso(this.dependencies.now())
    const expiresAt = new Date(expiresAtMs).toISOString()
    const nonceHash = digest(nonce)
    if (mission.actions.some(item => item.actionId !== action.actionId && item.authorityException?.nonceHash === nonceHash)) {
      throw new ConciergeError('AUTHORITY_NONCE_REUSED', 'Exception nonce has already been used in this mission.', 409)
    }
    const exceptionId = `pe_${digest({
      decisionId,
      actionId: action.actionId,
      approvedMaximumUsdt,
      nonceHash,
      expiresAt,
    }).slice(0, 32)}`
    return {
      exceptionId,
      decisionId,
      nonceHash,
      approvedMaximumUsdt,
      approvedAt,
      expiresAt,
      consumedAt: null,
    }
  }

  private verifyBillsStatusUrl(value: string) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new ConciergeError('STATUS_URL_INVALID', 'Pocket Bills statusUrl must be a valid URL.')
    }
    if (
      url.origin !== BILLS_ORIGIN
      || !/^\/v1\/okx\/settlements\/pst_[a-zA-Z0-9]+$/.test(url.pathname)
      || url.username
      || url.password
      || url.hash
    ) {
      throw new ConciergeError('STATUS_URL_INVALID', 'statusUrl must be a token-scoped Pocket Bills settlement URL.')
    }
    return url
  }
}

export async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return data
}
