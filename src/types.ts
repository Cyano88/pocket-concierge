export type MissionState = 'planned' | 'active' | 'delivered' | 'needs_review'
export type ActionState = 'planned' | 'approved' | 'executing' | 'delivered' | 'needs_review'

export type BillCategory = 'data' | 'electricity' | 'tv'
export type AuthorityOutcome = 'APPROVE' | 'BLOCK' | 'ESCALATE'
export type AuthorityReason =
  | 'POLICY_APPROVED'
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'MANDATE_NOT_YET_VALID'
  | 'MANDATE_EXPIRED'
  | 'CATEGORY_NOT_ALLOWED'
  | 'SERVICE_NOT_ALLOWED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'ACTION_LIMIT_EXCEEDED'
  | 'AMOUNT_ABOVE_ACTION_LIMIT'
  | 'AMOUNT_ABOVE_MISSION_LIMIT'

export type MandateInput = {
  policyVersion: '1'
  validFrom: string
  expiresAt: string
  allowedCategories: BillCategory[]
  allowedServiceIds: string[]
  allowedPrivateInputRefs: string[]
  maximumPerActionUsdt: string
  maximumMissionUsdt: string
  approvalThresholdUsdt: string
  maximumActions: number
}

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
  mandate: MandateInput
  actions: BillActionInput[]
}

export type AuthorityDecision = {
  decisionId: string
  mandateId: string
  evaluatedAt: string
  outcome: AuthorityOutcome
  reasons: AuthorityReason[]
}

export type AuthorityException = {
  exceptionId: string
  decisionId: string
  nonceHash: string
  approvedMaximumUsdt: string
  approvedAt: string
  expiresAt: string
  consumedAt: string | null
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
  authorityDecision: AuthorityDecision
  authorityException: AuthorityException | null
  evidence: ActionEvidence | null
  authorityReceiptId: string | null
}

export type Mission = {
  revision: number
  missionId: string
  manifestId: string
  mandateId: string
  ownerId: string
  externalId: string
  title: string
  timezone: string
  mandate: MandateInput
  state: MissionState
  createdAt: string
  updatedAt: string
  actions: MissionAction[]
}

export type AuthorityReceipt = {
  receiptId: string
  receiptHash: string
  receiptVersion: '1'
  mandateId: string
  manifestId: string
  missionId: string
  actionId: string
  cycleIdHash: string
  decision: AuthorityDecision
  exception: Omit<AuthorityException, 'nonceHash'> | null
  target: {
    category: BillCategory
    serviceId: string
    variationCode: string
    privateInputRefHash: string
  }
  limit: {
    maximumUsdt: string
  }
  execution: ActionEvidence
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
