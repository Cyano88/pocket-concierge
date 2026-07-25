import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePaidAuthorityCheck } from '../src/authority-check.js'
import { errandToMissionInput, errandView } from '../src/errands.js'
import { ConciergeService } from '../src/service.js'
import { MemoryMissionStore } from '../src/store.js'

const now = Date.parse('2026-07-25T10:00:00.000Z')

function authorityInput(amountUsdt = '0.20', approvalThresholdUsdt = '0.25') {
  return {
    externalId: 'agent-purchase-123',
    cycleId: '2026-07-25',
    action: {
      category: 'airtime',
      serviceId: 'mtn-airtime',
      privateInputRef: 'family-mum-phone',
      amountUsdt,
    },
    mandate: {
      validFrom: '2026-07-25T09:00:00.000Z',
      expiresAt: '2026-07-25T11:00:00.000Z',
      allowedCategories: ['airtime'],
      allowedServiceIds: ['mtn-airtime'],
      allowedPrivateInputRefs: ['family-mum-phone'],
      maximumPerActionUsdt: '0.25',
      approvalThresholdUsdt,
    },
  }
}

test('paid authority check is reusable and deterministic for approve, escalate, and block', () => {
  const approved = evaluatePaidAuthorityCheck(authorityInput(), now)
  assert.equal(approved.decision, 'APPROVE')
  assert.equal(approved.nextAction?.type, 'execute_within_mandate')
  assert.equal(approved.exampleUsed, false)

  const escalated = evaluatePaidAuthorityCheck(authorityInput('0.20', '0.10'), now)
  assert.equal(escalated.decision, 'ESCALATE')
  assert.deepEqual(escalated.reasons, ['HUMAN_APPROVAL_REQUIRED'])

  const blocked = evaluatePaidAuthorityCheck(authorityInput('0.30'), now)
  assert.equal(blocked.decision, 'BLOCK')
  assert.deepEqual(blocked.reasons, ['AMOUNT_ABOVE_ACTION_LIMIT'])
  assert.equal(blocked.nextAction, null)
})

test('empty paid authority check returns a safe reviewer example', () => {
  const result = evaluatePaidAuthorityCheck({}, now)
  assert.equal(result.exampleUsed, true)
  assert.equal(result.decision, 'APPROVE')
  assert.equal(JSON.stringify(result).includes('08130914282'), false)
})

test('simple errand facade connects creation, authorization, provider verification, and receipt', async () => {
  let expectedOrder = ''
  const service = new ConciergeService({
    store: new MemoryMissionStore(),
    now: () => now,
    fetchJson: async () => ({
      ok: true,
      settlement: {
        settlementId: 'pst_facade',
        externalOrderId: expectedOrder,
        state: 'delivered',
        receiptHash: 'provider-receipt-hash',
      },
    }),
  })
  const input = errandToMissionInput({
    externalId: 'managerx-gig-123',
    cycleId: 'cycle-2026-07-25',
    title: 'Renew Mum MTN data',
    timezone: 'Africa/Lagos',
    dueAt: '2026-07-25T09:30:00.000Z',
    errand: {
      category: 'data',
      serviceId: 'mtn-data',
      variationCode: 'mtn-10mb-100',
      privateInputRef: 'family-mum-mobile',
      maximumUsdt: '0.25',
    },
    mandate: {
      validFrom: '2026-07-25T09:00:00.000Z',
      expiresAt: '2026-07-25T11:00:00.000Z',
      approvalThresholdUsdt: '0.25',
    },
  })
  assert.equal(input.externalId, 'managerx-gig-123:cycle-2026-07-25')
  assert.equal(input.actions.length, 1)
  const created = await service.create('agent-owner', input)
  const firstView = errandView(created.mission)
  assert.equal(firstView.state, 'awaiting_authorization')
  assert.equal(firstView.cycleId, 'cycle-2026-07-25')
  assert.equal(firstView.nextAction?.type, 'authorize_manifest')

  const action = created.mission.actions[0]!
  await service.approve('agent-owner', created.mission.externalId, action.actionId, {
    manifestId: created.mission.manifestId,
  })
  const execution = await service.start('agent-owner', created.mission.externalId, action.actionId)
  expectedOrder = execution.request.publicBody.externalOrderId
  const verifying = await service.verify('agent-owner', created.mission.externalId, action.actionId, {
    statusUrl: 'https://bills.hashpaylink.com/v1/okx/settlements/pst_facade',
    statusToken: 'private-status-token',
  })
  const receiptId = verifying.actions[0]?.authorityReceiptId
  assert.ok(receiptId)
  const receipt = await service.getReceipt(receiptId)
  const finalView = errandView(verifying, undefined, receipt)
  assert.equal(finalView.state, 'delivered')
  assert.equal((finalView.receipt as { verification?: { valid?: boolean } }).verification?.valid, true)
  assert.equal(JSON.stringify(finalView).includes('private-status-token'), false)
})
