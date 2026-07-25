import assert from 'node:assert/strict'
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
  assert.ok(document.paths?.['/v1/missions']?.post)
  assert.ok(document.paths?.['/v1/missions/{externalId}/actions/{actionId}/approve']?.post)
  assert.ok(document.paths?.['/v1/missions/{externalId}/actions/{actionId}/start']?.post)
  assert.ok(document.paths?.['/v1/missions/{externalId}/actions/{actionId}/verify']?.post)
  assert.ok(document.paths?.['/v1/authority/receipts/{receiptId}']?.get)
  assert.equal(source.includes('prava_shop'), false)
})

test('copy-paste mission example matches the runtime validator', async () => {
  const source = await readFile(new URL('../examples/mission.json', import.meta.url), 'utf8')
  const mission = parseMission(JSON.parse(source))
  assert.equal(mission.actions[0]?.type, 'okx_bill')
  assert.equal(mission.actions[0]?.privateInputRef, 'family-mum-mobile')
})
