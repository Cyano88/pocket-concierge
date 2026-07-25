import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@okxweb3/x402-core/http'
import {
  buildOkxAuthorityProof,
  OKX_AUTHORITY_PROOF_FEE_ATOMIC,
  XLAYER_USDT0,
} from '../src/okx-proof.js'
import type { AuthorityReceipt } from '../src/types.js'
import {
  OKX_AUTHORITY_PROOF_OUTPUT_SCHEMA,
  OkxAuthorityProofProtector,
} from '../src/x402-proof.js'
import { digest } from '../src/validation.js'

const payTo = '0x988263a851afe17f8a827eda81269f9fb7553cbc'
const transaction = '0x1c6ca55a889644bc2d96c3888c0a0a8963484f9992e18003be6dc2648612d5f7'

function fakeFacilitator() {
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:196', extra: {} }], extensions: [], signers: {} }
    },
    async verify() {
      return { isValid: true, payer: payTo }
    },
    async settle() {
      return {
        success: true,
        transaction,
        network: 'eip155:196',
        amount: OKX_AUTHORITY_PROOF_FEE_ATOMIC,
        payer: payTo,
      }
    },
    async getSettleStatus() { throw new Error('not called') },
  }
}

const receiptCore: Omit<AuthorityReceipt, 'receiptId' | 'receiptHash'> = {
  receiptVersion: '1',
  mandateId: 'pmnd_test',
  manifestId: 'manifest-test',
  missionId: 'pm_test',
  actionId: 'pa_test',
  cycleIdHash: 'cycle-hash',
  decision: {
    decisionId: 'pd_test',
    mandateId: 'pmnd_test',
    evaluatedAt: '2026-07-25T07:00:00.000Z',
    outcome: 'APPROVE',
    reasons: ['POLICY_APPROVED'],
  },
  exception: null,
  target: {
    category: 'data',
    serviceId: 'mtn-data',
    variationCode: 'mtn-10mb-100',
    privateInputRefHash: 'private-reference-hash',
  },
  limit: { maximumUsdt: '0.25' },
  execution: {
    settlementId: 'pst_test',
    externalOrderId: 'okx:concierge:test',
    state: 'delivered',
    receiptHash: 'downstream-receipt',
    verifiedAt: '2026-07-25T07:40:00.000Z',
  },
}
const receiptHash = digest(receiptCore)
const receipt: AuthorityReceipt = {
  receiptId: `pr_${receiptHash.slice(0, 32)}`,
  receiptHash,
  ...receiptCore,
}

test('authority proof endpoint advertises the required zero-fee EIP-3009 USDT acceptance', async () => {
  const protector = new OkxAuthorityProofProtector({
    apiKey: 'api-key',
    secretKey: 'secret-key',
    passphrase: 'passphrase',
    payTo,
    publicUrl: 'https://concierge.example.com',
  }, () => fakeFacilitator() as never)
  const challenged = await protector.protect(new Request('https://concierge.example.com/v1/okx/authority-proof'))
  assert.equal(challenged.status, 'challenge')
  if (challenged.status !== 'challenge') return
  assert.equal(challenged.response.status, 402)
  const encoded = challenged.response.headers.get('payment-required')
  assert.ok(encoded)
  const challenge = decodePaymentRequiredHeader(encoded)
  assert.deepEqual(challenge.accepts, [{
    scheme: 'exact',
    network: 'eip155:196',
    amount: '0',
    asset: XLAYER_USDT0,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { tokenSymbol: 'USDT', decimals: 6, name: 'USD₮0', version: '1' },
  }])
  assert.deepEqual(
    (challenge.extensions as { outputSchema?: unknown } | undefined)?.outputSchema,
    OKX_AUTHORITY_PROOF_OUTPUT_SCHEMA,
  )
  const signature = encodePaymentSignatureHeader({
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0] as never,
    payload: { authorization: { from: payTo } },
  })
  const paid = await protector.protect(new Request('https://concierge.example.com/v1/okx/authority-proof', {
    headers: { 'payment-signature': signature },
  }))
  assert.equal(paid.status, 'paid')
})

test('paid replay proof is recomputable and privacy-limited', () => {
  const decoratedReceipt = {
    ...receipt,
    verification: { valid: true, expectedHash: receipt.receiptHash },
  }
  const proof = buildOkxAuthorityProof(decoratedReceipt, transaction, 'https://concierge.example.com')
  assert.equal(proof.proof.transaction, transaction)
  assert.equal(proof.proof.settlementId, 'pst_test')
  assert.equal(proof.proof.receiptVerification.valid, true)
  assert.equal('verification' in proof.proof.authorityReceipt, false)
  assert.deepEqual(proof.integration.authorityOutcomes, ['APPROVE', 'ESCALATE', 'BLOCK'])
  const serialized = JSON.stringify(proof)
  assert.equal(serialized.includes('phone'), true)
  assert.equal(serialized.includes('08130914282'), false)
  assert.equal(serialized.includes('statusToken'), false)
})
