import { verifyAuthorityReceipt } from './authority.js'
import type { AuthorityReceipt } from './types.js'

export const OKX_AUTHORITY_PROOF_ROUTE = '/v1/okx/authority-proof'
export const OKX_AUTHORITY_PROOF_FEE_USDT = '0'
export const OKX_AUTHORITY_PROOF_FEE_ATOMIC = '0'
export const XLAYER_USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736'

export function buildOkxAuthorityProof(receipt: AuthorityReceipt, transaction: string, baseUrl: string) {
  return {
    ok: true,
    service: {
      name: 'Pocket Concierge',
      purpose: 'Deterministic authority and execution verification for autonomous household purchases.',
      listingFee: {
        amount: OKX_AUTHORITY_PROOF_FEE_USDT,
        token: 'USDT',
        asset: XLAYER_USDT0,
        network: 'eip155:196',
      },
    },
    integration: {
      contract: `${baseUrl}/v1/contract`,
      authenticatedFlow: [
        'POST /v1/missions/preview',
        'POST /v1/missions',
        'POST /v1/missions/{externalId}/actions/{actionId}/approve',
        'POST /v1/missions/{externalId}/actions/{actionId}/start',
        'POST /v1/missions/{externalId}/actions/{actionId}/verify',
      ],
      authorityOutcomes: ['APPROVE', 'ESCALATE', 'BLOCK'],
      rule: 'The deterministic policy engine—not an LLM—decides whether execution is authorized.',
      privacy: 'Keep phone, meter, smartcard, wallet credentials, and provider status tokens in the local buyer agent.',
    },
    proof: {
      transaction,
      settlementId: receipt.execution.settlementId,
      settlementState: receipt.execution.state,
      downstreamReceiptHash: receipt.execution.receiptHash,
      maximumAuthorizedUsdt: receipt.limit.maximumUsdt,
      decision: receipt.decision,
      authorityReceipt: receipt,
      receiptVerification: verifyAuthorityReceipt(receipt),
      publicReceiptUrl: `${baseUrl}/v1/authority/receipts/${receipt.receiptId}`,
    },
  }
}
