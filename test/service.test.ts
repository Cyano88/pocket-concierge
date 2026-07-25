import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConciergeService, type ConciergeDependencies } from '../src/service.js'
import { MemoryMissionStore, SqliteMissionStore } from '../src/store.js'

const ownerId = 'agent-one'
const now = Date.parse('2026-07-25T04:00:00.000Z')

function mission(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'home-week-0001',
    title: 'Keep the home connected',
    timezone: 'Africa/Lagos',
    actions: [{
      type: 'okx_bill',
      reference: 'mtn-data',
      description: 'Renew MTN data',
      dueAt: '2026-07-25T03:00:00.000Z',
      category: 'data',
      serviceId: 'mtn-data',
      variationCode: 'mtn-100mb',
      privateInputRef: 'home-mobile',
      maximumUsdt: '0.25',
    }],
    ...overrides,
  }
}

function service(fetchResult?: unknown) {
  const store = new MemoryMissionStore()
  const dependencies: ConciergeDependencies = {
    store,
    now: () => now,
    fetchJson: async () => fetchResult ?? {},
  }
  return { app: new ConciergeService(dependencies), store }
}

test('previews and creates one deterministic privacy-limited mission', async () => {
  const { app } = service()
  const preview = app.preview(ownerId, mission())
  const created = await app.create(ownerId, mission())
  const replay = await app.create(ownerId, mission())
  assert.equal(created.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(created.mission.manifestId, preview.manifestId)
  assert.equal(created.mission.actions[0]?.privateInputRef, 'home-mobile')
  assert.equal('customerReference' in created.mission.actions[0]!, false)
})

test('rejects external ID drift and private customer identifiers', async () => {
  const { app } = service()
  await app.create(ownerId, mission())
  await assert.rejects(
    app.create(ownerId, mission({ title: 'Changed mission' })),
    (error: any) => error.code === 'MISSION_CONFLICT' && error.status === 409,
  )
  assert.throws(
    () => app.preview(ownerId, mission({
      actions: [{
        type: 'okx_bill',
        reference: 'mtn-data',
        description: 'Renew MTN data',
        dueAt: '2026-07-25T03:00:00.000Z',
        category: 'data',
        serviceId: 'mtn-data',
        variationCode: 'mtn-100mb',
        privateInputRef: '08130914282',
        maximumUsdt: '0.25',
      }],
    })),
    (error: any) => error.code === 'PRIVATE_INPUT_REF_INVALID',
  )
})

test('requires manifest approval before returning a buyer-side OKX instruction', async () => {
  const { app } = service()
  const created = await app.create(ownerId, mission())
  const action = created.mission.actions[0]!
  await assert.rejects(
    app.start(ownerId, 'home-week-0001', action.actionId),
    (error: any) => error.code === 'ACTION_NOT_APPROVED',
  )
  await assert.rejects(
    app.approve(ownerId, 'home-week-0001', action.actionId, 'wrong-manifest'),
    (error: any) => error.code === 'MANIFEST_MISMATCH',
  )
  await app.approve(ownerId, 'home-week-0001', action.actionId, created.mission.manifestId)
  const execution = await app.start(ownerId, 'home-week-0001', action.actionId)
  assert.equal(execution.requiresUserConfirmation, true)
  assert.equal(execution.request.url, 'https://bills.hashpaylink.com/v1/okx/bills')
  assert.match(execution.request.privateBodyPlaceholders.customerReference, /^\$private\./)
  assert.equal('customerReference' in execution.request.publicBody, false)
})

test('verifies delivered Pocket Bills evidence and discards the status token', async () => {
  let seenUrl = ''
  let seenToken = ''
  const store = new MemoryMissionStore()
  const app = new ConciergeService({
    store,
    now: () => now,
    fetchJson: async (url, init) => {
      seenUrl = url
      seenToken = String((init?.headers as Record<string, string>)['X-Status-Token'])
      const current = await store.get(ownerId, 'home-week-0001')
      return {
        ok: true,
        settlement: {
          settlementId: 'pst_abc123',
          externalOrderId: current?.actions[0]?.downstreamExternalOrderId,
          state: 'delivered',
          receiptHash: 'receipt-hash-1',
        },
      }
    },
  })
  const created = await app.create(ownerId, mission())
  const action = created.mission.actions[0]!
  await app.approve(ownerId, created.mission.externalId, action.actionId, created.mission.manifestId)
  await app.start(ownerId, created.mission.externalId, action.actionId)
  const verified = await app.verify(ownerId, created.mission.externalId, action.actionId, {
    statusUrl: 'https://bills.hashpaylink.com/v1/okx/settlements/pst_abc123',
    statusToken: 'one-time-status-secret',
  })
  assert.match(seenUrl, /refresh=true/)
  assert.equal(seenToken, 'one-time-status-secret')
  assert.equal(verified.state, 'delivered')
  assert.equal(verified.actions[0]?.evidence?.receiptHash, 'receipt-hash-1')
  assert.equal(JSON.stringify(verified).includes('one-time-status-secret'), false)
})

test('rejects status URL SSRF, mismatched orders, and non-terminal evidence', async () => {
  const build = async (fetchResult: unknown) => {
    const { app, store } = service(fetchResult)
    const created = await app.create(ownerId, mission())
    const action = created.mission.actions[0]!
    await app.approve(ownerId, created.mission.externalId, action.actionId, created.mission.manifestId)
    await app.start(ownerId, created.mission.externalId, action.actionId)
    return { app, store, created, action }
  }
  const badUrl = await build({})
  await assert.rejects(
    badUrl.app.verify(ownerId, badUrl.created.mission.externalId, badUrl.action.actionId, {
      statusUrl: 'https://evil.example/v1/okx/settlements/pst_abc123',
      statusToken: 'secret',
    }),
    (error: any) => error.code === 'STATUS_URL_INVALID',
  )
  const mismatch = await build({
    ok: true,
    settlement: { settlementId: 'pst_abc123', externalOrderId: 'someone-else', state: 'delivered', receiptHash: 'hash' },
  })
  await assert.rejects(
    mismatch.app.verify(ownerId, mismatch.created.mission.externalId, mismatch.action.actionId, {
      statusUrl: 'https://bills.hashpaylink.com/v1/okx/settlements/pst_abc123',
      statusToken: 'secret',
    }),
    (error: any) => error.code === 'DOWNSTREAM_EVIDENCE_INVALID',
  )
  const pendingBase = await build({})
  const pending = new ConciergeService({
    store: pendingBase.store,
    now: () => now,
    fetchJson: async () => ({
      ok: true,
      settlement: {
        settlementId: 'pst_abc123',
        externalOrderId: pendingBase.action.downstreamExternalOrderId,
        state: 'provider_pending',
        receiptHash: '',
      },
    }),
  })
  await assert.rejects(
    pending.verify(ownerId, pendingBase.created.mission.externalId, pendingBase.action.actionId, {
      statusUrl: 'https://bills.hashpaylink.com/v1/okx/settlements/pst_abc123',
      statusToken: 'secret',
    }),
    (error: any) => error.code === 'DOWNSTREAM_NOT_TERMINAL',
  )
})

test('SQLite persists missions and rejects stale concurrent writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-concierge-'))
  const path = join(directory, 'missions.sqlite')
  const first = new SqliteMissionStore(path)
  try {
    const app = new ConciergeService({ store: first, now: () => now, fetchJson: async () => ({}) })
    const created = await app.create(ownerId, mission())
    first.close()

    const reopened = new SqliteMissionStore(path)
    try {
      const persisted = await reopened.get(ownerId, created.mission.externalId)
      assert.equal(persisted?.manifestId, created.mission.manifestId)
      const stale = structuredClone(persisted!)
      const current = structuredClone(persisted!)
      current.revision += 1
      current.title = 'First atomic writer'
      await reopened.update(current, persisted!.revision)
      stale.revision += 1
      stale.title = 'Stale writer'
      await assert.rejects(
        reopened.update(stale, persisted!.revision),
        (error: any) => error.code === 'MISSION_WRITE_CONFLICT',
      )
    } finally {
      reopened.close()
    }
  } finally {
    try {
      first.close()
    } catch {
      // The first handle is already closed after the persistence check.
    }
    await rm(directory, { recursive: true, force: true })
  }
})
