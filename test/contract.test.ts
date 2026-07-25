import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import { parseMission } from '../src/validation.js'

test('OpenAPI publishes every implemented route and no Prava action', async () => {
  const source = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8')
  const document = parse(source) as {
    openapi?: string
    paths?: Record<string, Record<string, unknown>>
  }
  assert.equal(document.openapi, '3.1.0')
  assert.ok(document.paths?.['/v1/okx/authority-check']?.post)
  assert.ok(document.paths?.['/v1/capabilities']?.get)
  assert.ok(document.paths?.['/v1/errands']?.post)
  assert.ok(document.paths?.['/v1/errands/{errandId}']?.get)
  assert.ok(document.paths?.['/v1/errands/{errandId}/authorize']?.post)
  assert.ok(document.paths?.['/v1/errands/{errandId}/complete']?.post)
  assert.ok(document.paths?.['/v1/missions']?.post)
  assert.ok(document.paths?.['/v1/missions/{externalId}/actions/{actionId}/approve']?.post)
  assert.ok(document.paths?.['/v1/missions/{externalId}/actions/{actionId}/start']?.post)
  assert.ok(document.paths?.['/v1/missions/{externalId}/actions/{actionId}/verify']?.post)
  assert.ok(document.paths?.['/v1/authority/receipts/{receiptId}']?.get)
  assert.ok(document.paths?.['/v1/okx/authority-proof']?.get)
  assert.equal(source.includes('prava_shop'), false)
})

test('copy-paste errand example maps to one valid mission cycle', async () => {
  const source = await readFile(new URL('../examples/errand.json', import.meta.url), 'utf8')
  const { errandToMissionInput } = await import('../src/errands.js')
  const mission = parseMission(errandToMissionInput(JSON.parse(source)))
  assert.equal(mission.externalId, 'managerx-gig-123:cycle-2026-07-25')
  assert.equal(mission.actions[0]?.category, 'data')
})

test('copy-paste errand client is valid JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', 'examples/errand-quickstart.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})

test('copy-paste mission example matches the runtime validator', async () => {
  const source = await readFile(new URL('../examples/mission.json', import.meta.url), 'utf8')
  const mission = parseMission(JSON.parse(source))
  assert.equal(mission.actions[0]?.type, 'okx_bill')
  assert.equal(mission.actions[0]?.privateInputRef, 'family-mum-mobile')
})
