import { getAddress } from 'viem'

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function main() {
  const baseUrl = requiredEnv('POCKET_CONCIERGE_URL').replace(/\/$/, '')
  const operatorKey = requiredEnv('POCKET_CONCIERGE_NFT_OPERATOR_KEY')
  const expectedTreasury = getAddress(requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS'))
  const response = await fetch(`${baseUrl}/v1/nft-mints/signer-config`, {
    headers: { 'X-Operator-Key': operatorKey },
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => ({ error: 'non_json_response' }))
  if (!response.ok) {
    throw new Error(`Pocket signer-config check failed (HTTP ${response.status}): ${JSON.stringify(payload)}`)
  }
  const config = payload?.signerConfig
  if (
    payload?.ok !== true
    || config?.chainId !== 1
    || getAddress(String(config?.treasuryAddress || '')) !== expectedTreasury
    || config?.access !== 'private-pilot'
  ) {
    throw new Error('Pocket API signer configuration does not match the isolated VPS worker.')
  }
  console.log(JSON.stringify({
    ok: true,
    authenticated: true,
    broadcast: false,
    chainId: config.chainId,
    treasuryAddress: config.treasuryAddress,
    access: config.access,
    supportedActions: config.supportedActions,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
