import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindingMatches,
  bodyBinding,
  buildPaymentCommandArgs,
  buildQuoteCommandArgs,
  findStatusProof,
  openJson,
  parseCliJson,
  parseUsdt,
  sealJson,
  selectQuote,
} from '../examples/okx-client-lib.mjs'

const verifiedQuote = {
  needsConfirm: true,
  paymentId: 'pay_verified',
  walletError: 'balance_unavailable',
  candidates: [{
    acceptsIndex: 0,
    amount: '145265',
    amountHuman: '0.145265',
    chainId: '196',
    chainName: 'X Layer',
    recommended: true,
    tokenSymbol: 'USDT',
  }],
  decodedChallenge: {
    recipient: '0x988263a851afe17f8a827eda81269f9fb7553cbc',
  },
}

test('parses USDT without floating-point arithmetic', () => {
  assert.equal(parseUsdt('0.145265'), 145265n)
  assert.equal(parseUsdt('1'), 1_000_000n)
  assert.throws(() => parseUsdt('0.0000001'))
  assert.throws(() => parseUsdt('-1'))
})

test('selects the verified X Layer USDT candidate and enforces the ceiling', () => {
  const selected = selectQuote(verifiedQuote, '0.25')
  assert.equal(selected.paymentId, 'pay_verified')
  assert.equal(selected.acceptsIndex, 0)
  assert.equal(selected.amountAtomic, '145265')
  assert.throws(() => selectQuote(verifiedQuote, '0.10'), /exceeds/)
  assert.throws(() => selectQuote({
    ...verifiedQuote,
    candidates: [{ ...verifiedQuote.candidates[0], amount: '145266' }],
  }, '0.25'), /do not match/)
})

test('never auto-selects from multiple payment candidates', () => {
  const second = { ...verifiedQuote.candidates[0], acceptsIndex: 2, recommended: false }
  const multiple = { ...verifiedQuote, candidates: [verifiedQuote.candidates[0], second] }
  assert.throws(() => selectQuote(multiple, '0.25'), /explicitly select/)
  assert.equal(selectQuote(multiple, '0.25', 2).acceptsIndex, 2)
})

test('binds quote state to the exact private merchant body without storing it', () => {
  const key = 'local-binding-key-at-least-24-characters'
  const body = { category: 'data', customerReference: '08000000000' }
  const digest = bodyBinding(body, key)
  assert.equal(bindingMatches(body, key, digest), true)
  assert.equal(bindingMatches({ ...body, customerReference: '08111111111' }, key, digest), false)
  assert.equal(digest.includes(body.customerReference), false)
  assert.equal(bodyBinding({ kept: true, omitted: undefined }, key), bodyBinding({ kept: true }, key))
})

test('encrypts and authenticates the local recovery proof', () => {
  const key = 'local-binding-key-at-least-24-characters'
  const proof = { statusUrl: 'https://example.test/status', statusToken: 'private-token' }
  const sealed = sealJson(proof, key)
  assert.equal(JSON.stringify(sealed).includes('private-token'), false)
  assert.deepEqual(openJson(sealed, key), proof)
  assert.throws(() => openJson(sealed, `${key}-wrong`), /authenticated/)
})

test('finds a Pocket Bills status proof in a nested CLI receipt', () => {
  const receipt = {
    ok: true,
    data: {
      status: 'success',
      merchantResponse: JSON.stringify({
        settlementId: 'pst_abc',
        status: { url: 'https://bills.hashpaylink.com/v1/okx/settlements/pst_abc', token: 'secret' },
      }),
    },
  }
  assert.deepEqual(findStatusProof(receipt), {
    statusUrl: 'https://bills.hashpaylink.com/v1/okx/settlements/pst_abc',
    statusToken: 'secret',
  })
  assert.equal(findStatusProof({ data: { status: 'success' } }), null)
})

test('accepts only clean JSON from Onchain OS', () => {
  assert.deepEqual(parseCliJson('{"ok":true}'), { ok: true })
  assert.throws(() => parseCliJson('banner\n{"ok":true}'), /unreadable/)
})

test('binds the identical merchant parameters into quote and paid replay commands', () => {
  const merchantBody = {
    externalOrderId: 'concierge:mission:action:cycle',
    category: 'data',
    serviceId: 'mtn-data',
    variationCode: 'mtn-10mb-100',
    customerReference: '08000000000',
  }
  const quoteArgs = buildQuoteCommandArgs('https://bills.hashpaylink.com/v1/okx/bills', merchantBody)
  const paymentArgs = buildPaymentCommandArgs('pay_verified', 0, merchantBody)
  const expectedParams = Object.entries(merchantBody).flatMap(([key, value]) => ['--param', `${key}=${value}`])

  assert.deepEqual(quoteArgs.slice(-expectedParams.length), expectedParams)
  assert.deepEqual(
    paymentArgs.slice(paymentArgs.indexOf('--param'), paymentArgs.indexOf('--yes')),
    expectedParams,
  )
  assert.equal(paymentArgs.at(-1), '--yes')
  assert.throws(() => buildPaymentCommandArgs('invalid', 0, merchantBody), /paymentId/)
})
