export type MissionState = 'planned' | 'active' | 'delivered' | 'needs_review'
export type ActionState = 'planned' | 'approved' | 'executing' | 'delivered' | 'needs_review'

export type BillCategory = 'data' | 'electricity' | 'tv'

export type BillActionInput = {
  type: 'okx_bill'
  reference: string
  description: string
  dueAt: string
  category: BillCategory
  serviceId: string
  variationCode: string
  privateInputRef: string
  maximumUsdt: string
}

export type MissionInput = {
  externalId: string
  title: string
  timezone: string
  actions: BillActionInput[]
}

export type ActionEvidence = {
  settlementId: string
  externalOrderId: string
  state: string
  receiptHash: string | null
  verifiedAt: string
}

export type MissionAction = BillActionInput & {
  actionId: string
  cycleId: string
  downstreamExternalOrderId: string
  state: ActionState
  approvedAt: string | null
  startedAt: string | null
  evidence: ActionEvidence | null
}

export type Mission = {
  revision: number
  missionId: string
  manifestId: string
  ownerId: string
  externalId: string
  title: string
  timezone: string
  state: MissionState
  createdAt: string
  updatedAt: string
  actions: MissionAction[]
}

export type BillsStatusResponse = {
  ok?: unknown
  settlement?: {
    settlementId?: unknown
    externalOrderId?: unknown
    state?: unknown
    receiptHash?: unknown
  }
}
