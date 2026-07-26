import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const API = 'https://pocket-concierge-production.up.railway.app'
const ENDPOINT = `${API}/v1/okx/nft-mints/orders`
const XLAYER_USDT = '0x779ded0c9e1022225f8e0630b35a9b54be713736'
const SERVICE_FEE_ATOMIC = '1000000'
const sourcePath = process.argv[2]
const outputPath = process.argv[3] || 'pocket-nft-order.private.json'

if (!sourcePath) {
  throw new Error('Usage: node examples/nft-mint-buyer.mjs <order.json> [private-output.json]')
}

const order = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const pilotKey = String(process.env.POCKET_CONCIERGE_NFT_PILOT_KEY || '').trim()
const headers = {
  'content-type': 'application/json',
  ...(pilotKey ? { 'x-pocket-pilot-key': pilotKey } : {}),
}
const body = JSON.stringify(order)

const challengeResponse = await fetch(ENDPOINT, { method: 'POST', headers, body })
if (challengeResponse.status === 401 && !pilotKey) {
  throw new Error('This controlled pilot currently requires POCKET_CONCIERGE_NFT_PILOT_KEY.')
}
if (challengeResponse.status !== 402) {
  const detail = await challengeResponse.json().catch(() => ({}))
  throw new Error(`Expected HTTP 402, received ${challengeResponse.status}: ${detail.message || detail.error || 'unknown error'}`)
}

const challenge = challengeResponse.headers.get('payment-required')
if (!challenge) throw new Error('The server returned HTTP 402 without PAYMENT-REQUIRED.')
const decoded = JSON.parse(Buffer.from(challenge, 'base64url').toString('utf8'))
const acceptance = Array.isArray(decoded.accepts)
  ? decoded.accepts.find(candidate => (
      candidate?.scheme === 'exact'
      && candidate?.network === 'eip155:196'
      && String(candidate?.asset || '').toLowerCase() === XLAYER_USDT
      && String(candidate?.amount) === SERVICE_FEE_ATOMIC
    ))
  : undefined
if (!acceptance) throw new Error('The x402 challenge does not contain the expected 1-USDT X Layer exact payment.')

const prompt = createInterface({ input, output })
try {
  console.log(JSON.stringify({
    action: 'confirm_service_fee',
    amount: '1 USDT',
    network: 'X Layer',
    purpose: 'Create one bounded Ethereum NFT mint-and-deliver order',
  }, null, 2))
  const confirmation = await prompt.question('Type PAY 1 USDT ON XLAYER to continue: ')
  if (confirmation !== 'PAY 1 USDT ON XLAYER') throw new Error('Payment cancelled.')
} finally {
  prompt.close()
}

const executable = process.platform === 'win32' ? 'onchainos.exe' : 'onchainos'
const signed = spawnSync(
  executable,
  ['payment', 'pay', '--payload', challenge, '--yes'],
  { encoding: 'utf8', windowsHide: true },
)
if (signed.status !== 0) {
  throw new Error(`Onchain OS payment signing failed with exit ${signed.status ?? 'unknown'}.`)
}
const signedPayload = JSON.parse(signed.stdout)
const paymentHeader = signedPayload?.data?.header_name
const paymentAuthorization = signedPayload?.data?.authorization_header
if (typeof paymentHeader !== 'string' || typeof paymentAuthorization !== 'string') {
  throw new Error('Onchain OS returned no payment authorization header.')
}

const paidResponse = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { ...headers, [paymentHeader]: paymentAuthorization },
  body,
})
const paid = await paidResponse.json().catch(() => ({}))
if (!paidResponse.ok || paid?.ok !== true || typeof paid?.orderAccessToken !== 'string') {
  throw new Error(`Paid replay failed with HTTP ${paidResponse.status}: ${paid.message || paid.error || 'unknown error'}`)
}

fs.writeFileSync(outputPath, `${JSON.stringify(paid, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
})
console.log(JSON.stringify({
  ok: true,
  externalId: paid.order?.externalId,
  state: paid.order?.state,
  nextAction: paid.next?.action,
  depositChainId: paid.next?.chainId,
  depositAmountWei: paid.next?.amountWei,
  depositTo: paid.next?.to,
  privateOrderFile: outputPath,
  warning: 'Keep the output file private; it contains the order capability token.',
}, null, 2))
