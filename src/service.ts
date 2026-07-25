import { ConciergeError } from './errors.js'
import type { MissionStore } from './store.js'
import type { BillsStatusResponse, Mission, MissionAction } from './types.js'
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

  async approve(ownerId: string, externalId: string, actionId: string, manifestId: string) {
    const mission = await this.requireMission(ownerId, externalId)
    if (mission.manifestId !== manifestId) throw new ConciergeError('MANIFEST_MISMATCH', 'Approval does not match the immutable mission manifest.', 409)
    const action = this.requireAction(mission, actionId)
    if (action.state === 'delivered') return publicMission(mission)
    if (action.state !== 'planned' && action.state !== 'approved') {
      throw new ConciergeError('ACTION_NOT_APPROVABLE', `Action in ${action.state} state cannot be approved.`, 409)
    }
    if (action.state === 'planned') {
      action.state = 'approved'
      action.approvedAt = iso(this.dependencies.now())
      mission.state = 'active'
      mission.updatedAt = action.approvedAt
      await this.dependencies.store.update(mission)
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
      action.state = 'executing'
      action.startedAt = iso(this.dependencies.now())
      mission.updatedAt = action.startedAt
      await this.dependencies.store.update(mission)
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
    action.state = TERMINAL_DELIVERED.has(state) ? 'delivered' : 'needs_review'
    action.evidence = {
      settlementId,
      externalOrderId: downstreamExternalId,
      state,
      receiptHash: receiptHash || null,
      verifiedAt: iso(this.dependencies.now()),
    }
    mission.state = mission.actions.every(item => item.state === 'delivered')
      ? 'delivered'
      : mission.actions.some(item => item.state === 'needs_review') ? 'needs_review' : 'active'
    mission.updatedAt = action.evidence.verifiedAt
    await this.dependencies.store.update(mission)
    return publicMission(mission)
  }

  private buildMission(ownerId: string, input: ReturnType<typeof parseMission>): Mission {
    const core = { ownerId, ...input }
    const manifestId = digest(core)
    const now = iso(this.dependencies.now())
    const missionId = `pm_${digest({ ownerId, externalId: input.externalId }).slice(0, 24)}`
    const actions: MissionAction[] = input.actions.map((action, index) => {
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
        evidence: null,
      }
    })
    return {
      missionId,
      manifestId,
      ownerId,
      externalId: input.externalId,
      title: input.title,
      timezone: input.timezone,
      state: 'planned',
      createdAt: now,
      updatedAt: now,
      actions,
    }
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
