import { createPublicClient, getAddress, http, isAddress, parseEther } from 'viem'
import { mainnet } from 'viem/chains'
import { calldataDigest, EthereumNftChainGateway } from '../src/nft-chain.js'

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function main() {
  const rpcUrl = requiredEnv('ETHEREUM_RPC_URL')
  const treasuryRaw = requiredEnv('POCKET_CONCIERGE_NFT_TREASURY_ADDRESS')
  const nftContractRaw = requiredEnv('NFT_PREFLIGHT_CONTRACT')
  if (!isAddress(treasuryRaw, { strict: true }) || !isAddress(nftContractRaw, { strict: true })) {
    throw new Error('Treasury and preflight collection must be valid Ethereum addresses.')
  }

  const treasury = getAddress(treasuryRaw)
  const nftContract = getAddress(nftContractRaw)
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  const gateway = new EthereumNftChainGateway(rpcUrl, client)
  const transaction = await gateway.buildMint('read-only-smoke', nftContract, treasury)
  gateway.validateMint(transaction, nftContract, treasury)
  const estimatedGas = await client.estimateGas({
    account: treasury,
    to: transaction.target,
    data: transaction.calldata,
    value: BigInt(transaction.valueWei),
    stateOverride: [{
      address: treasury,
      balance: parseEther('1'),
    }],
  })

  console.log(JSON.stringify({
    ok: true,
    broadcast: false,
    source: 'direct-seadrop-onchain',
    quantity: 1,
    valueWei: transaction.valueWei,
    estimatedGas: estimatedGas.toString(),
    calldataHash: calldataDigest(transaction.calldata),
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
