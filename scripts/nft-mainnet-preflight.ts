import { createPublicClient, getAddress, http, isAddress, keccak256 } from 'viem'
import { mainnet } from 'viem/chains'
import { SEADROP_1_0 } from '../src/nft-chain.js'

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function httpsUrl(value: string, name: string) {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS.`)
  return parsed.toString()
}

async function main() {
  const rpcUrl = httpsUrl(requiredEnv('ETHEREUM_RPC_URL'), 'ETHEREUM_RPC_URL')
  const treasuryRaw = requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS')
  if (!isAddress(treasuryRaw, { strict: true })) {
    throw new Error('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS must be a valid Ethereum address.')
  }
  const treasury = getAddress(treasuryRaw)
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl, { timeout: 15_000 }) })

  const [chainId, blockNumber, seaDropCode, treasuryBalance, fees] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getBytecode({ address: SEADROP_1_0 }),
    client.getBalance({ address: treasury }),
    client.estimateFeesPerGas(),
  ])
  if (chainId !== 1) throw new Error(`RPC returned chainId ${chainId}; Ethereum mainnet chainId 1 is required.`)
  if (!seaDropCode || seaDropCode === '0x') throw new Error('Official SeaDrop 1.0 has no deployed bytecode on this RPC.')

  console.log(JSON.stringify({
    ok: true,
    broadcast: false,
    chainId,
    blockNumber: blockNumber.toString(),
    seaDrop: {
      deployed: true,
      runtimeCodeHash: keccak256(seaDropCode),
    },
    treasury: {
      balanceWei: treasuryBalance.toString(),
    },
    fees: {
      maxFeePerGasWei: fees.maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas?.toString() ?? null,
    },
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
