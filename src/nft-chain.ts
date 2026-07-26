import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { ConciergeError } from './errors.js'
import type {
  BuiltMintTransaction,
  VerifiedDelivery,
  VerifiedDeposit,
  VerifiedFailedMint,
  VerifiedMint,
  VerifiedRefund,
} from './nft-types.js'

export const SEADROP_1_0 = getAddress('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5')
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
const SEADROP_ABI = parseAbi([
  'function mintPublic(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity) payable',
])
const SEADROP_READ_ABI = [{
  type: 'function',
  name: 'getPublicDrop',
  stateMutability: 'view',
  inputs: [{ type: 'address' }],
  outputs: [{
    type: 'tuple',
    components: [
      { type: 'uint80' },
      { type: 'uint48' },
      { type: 'uint48' },
      { type: 'uint16' },
      { type: 'uint16' },
      { type: 'bool' },
    ],
  }],
}, {
  type: 'function',
  name: 'getAllowedFeeRecipients',
  stateMutability: 'view',
  inputs: [{ type: 'address' }],
  outputs: [{ type: 'address[]' }],
}, {
  type: 'function',
  name: 'getCreatorPayoutAddress',
  stateMutability: 'view',
  inputs: [{ type: 'address' }],
  outputs: [{ type: 'address' }],
}] as const
const SEADROP_TOKEN_READ_ABI = [{
  type: 'function',
  name: 'getMintStats',
  stateMutability: 'view',
  inputs: [{ type: 'address' }],
  outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
}] as const
const ERC721_EVENTS = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
])
const ERC721_TRANSFER_ABI = parseAbi([
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
])

function transactionCost(receipt: { gasUsed: bigint; effectiveGasPrice: bigint }) {
  return receipt.gasUsed * receipt.effectiveGasPrice
}

export interface NftChainGateway {
  buildMint(collectionSlug: string, nftContract: Address, treasuryAddress: Address): Promise<BuiltMintTransaction>
  validateMint(transaction: BuiltMintTransaction, nftContract: Address, treasuryAddress: Address): void
  estimateMintGas(transaction: BuiltMintTransaction, treasuryAddress: Address): Promise<bigint>
  maxFeePerGas(): Promise<bigint>
  pendingNonce(address: Address): Promise<number>
  verifyDeposit(transactionHash: Hex): Promise<VerifiedDeposit>
  verifyMint(transactionHash: Hex, nftContract: Address, treasuryAddress: Address): Promise<VerifiedMint>
  verifyFailedMint(
    transactionHash: Hex,
    treasuryAddress: Address,
    target: Address,
    expectedCalldataHash: Hex,
    expectedValueWei: bigint,
    expectedNonce: number,
  ): Promise<VerifiedFailedMint>
  prepareDelivery(
    nftContract: Address,
    treasuryAddress: Address,
    recipient: Address,
    tokenId: bigint,
  ): Promise<{ target: Address; calldata: Hex; valueWei: '0'; gasLimit: bigint }>
  verifyDelivery(
    transactionHash: Hex,
    nftContract: Address,
    treasuryAddress: Address,
    recipient: Address,
    tokenId: bigint,
  ): Promise<VerifiedDelivery>
  verifyRefund(
    transactionHash: Hex,
    treasuryAddress: Address,
    refundAddress: Address,
    amountWei: bigint,
  ): Promise<VerifiedRefund>
}

export class EthereumNftChainGateway implements NftChainGateway {
  private readonly client: PublicClient

  constructor(rpcUrl: string, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  }

  async buildMint(
    _collectionSlug: string,
    nftContract: Address,
    treasuryAddress: Address,
  ): Promise<BuiltMintTransaction> {
    let publicDrop
    let mintStats
    let allowedFeeRecipients
    let creatorPayoutAddress
    let block
    try {
      [publicDrop, mintStats, allowedFeeRecipients, creatorPayoutAddress, block] = await Promise.all([
        this.client.readContract({
          address: SEADROP_1_0,
          abi: SEADROP_READ_ABI,
          functionName: 'getPublicDrop',
          args: [nftContract],
        }),
        this.client.readContract({
          address: nftContract,
          abi: SEADROP_TOKEN_READ_ABI,
          functionName: 'getMintStats',
          args: [treasuryAddress],
        }),
        this.client.readContract({
          address: SEADROP_1_0,
          abi: SEADROP_READ_ABI,
          functionName: 'getAllowedFeeRecipients',
          args: [nftContract],
        }),
        this.client.readContract({
          address: SEADROP_1_0,
          abi: SEADROP_READ_ABI,
          functionName: 'getCreatorPayoutAddress',
          args: [nftContract],
        }),
        this.client.getBlock({ blockTag: 'latest' }),
      ])
    } catch {
      throw new ConciergeError(
        'NFT_PUBLIC_DROP_READ_FAILED',
        'The collection does not expose a readable SeaDrop 1.0 public mint configuration.',
        422,
      )
    }

    const [
      mintPrice,
      startTime,
      endTime,
      maxTotalMintableByWallet,
      ,
      restrictFeeRecipients,
    ] = publicDrop
    const [minterNumMinted, currentTotalSupply, maxSupply] = mintStats
    if (block.timestamp < startTime || block.timestamp > endTime) {
      throw new ConciergeError('NFT_PUBLIC_DROP_INACTIVE', 'The SeaDrop public mint stage is not active.', 409)
    }
    if (minterNumMinted + 1n > maxTotalMintableByWallet) {
      throw new ConciergeError('NFT_PUBLIC_DROP_WALLET_LIMIT', 'The execution treasury has reached this public mint wallet limit.', 409)
    }
    if (currentTotalSupply + 1n > maxSupply) {
      throw new ConciergeError('NFT_PUBLIC_DROP_SOLD_OUT', 'The collection has insufficient remaining mint supply.', 409)
    }

    let feeRecipient: Address
    if (restrictFeeRecipients) {
      const firstAllowed = allowedFeeRecipients.find(candidate => getAddress(candidate) !== ZERO_ADDRESS)
      if (!firstAllowed) {
        throw new ConciergeError(
          'NFT_PUBLIC_DROP_FEE_RECIPIENT_MISSING',
          'The restricted public drop has no allowed fee recipient.',
          409,
        )
      }
      feeRecipient = getAddress(firstAllowed)
    } else {
      feeRecipient = getAddress(creatorPayoutAddress)
      if (feeRecipient === ZERO_ADDRESS) {
        throw new ConciergeError(
          'NFT_PUBLIC_DROP_PAYOUT_MISSING',
          'The public drop has no creator payout address.',
          409,
        )
      }
    }

    const calldata = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintPublic',
      args: [nftContract, feeRecipient, ZERO_ADDRESS, 1n],
    })
    return { target: SEADROP_1_0, calldata, valueWei: mintPrice.toString() }
  }

  validateMint(transaction: BuiltMintTransaction, nftContract: Address, treasuryAddress: Address) {
    if (getAddress(transaction.target) !== SEADROP_1_0) {
      throw new ConciergeError('NFT_MINT_TARGET_UNSUPPORTED', 'Mint target is not the supported official SeaDrop deployment.', 422)
    }
    let decoded
    try {
      decoded = decodeFunctionData({ abi: SEADROP_ABI, data: transaction.calldata })
    } catch {
      throw new ConciergeError('NFT_MINT_CALL_INVALID', 'Mint calldata is not the supported SeaDrop public mint call.', 422)
    }
    if (decoded.functionName !== 'mintPublic') {
      throw new ConciergeError('NFT_MINT_CALL_INVALID', 'Only SeaDrop public mints are supported.', 422)
    }
    const [decodedNft, feeRecipient, minterIfNotPayer, quantity] = decoded.args
    if (
      getAddress(decodedNft) !== nftContract
      || getAddress(feeRecipient) === ZERO_ADDRESS
      || quantity !== 1n
    ) {
      throw new ConciergeError('NFT_MINT_CALL_MISMATCH', 'Mint calldata does not match the immutable order.', 409)
    }
    const recipient = getAddress(minterIfNotPayer)
    if (recipient !== ZERO_ADDRESS && recipient !== treasuryAddress) {
      throw new ConciergeError('NFT_MINT_RECIPIENT_MISMATCH', 'SeaDrop mint recipient must be the Pocket treasury.', 409)
    }
  }

  async estimateMintGas(transaction: BuiltMintTransaction, treasuryAddress: Address) {
    return this.client.estimateGas({
      account: treasuryAddress,
      to: transaction.target,
      data: transaction.calldata,
      value: BigInt(transaction.valueWei),
    })
  }

  async pendingNonce(address: Address) {
    return this.client.getTransactionCount({ address, blockTag: 'pending' })
  }

  async maxFeePerGas() {
    const fees = await this.client.estimateFeesPerGas()
    if (fees.maxFeePerGas) return fees.maxFeePerGas
    return this.client.getGasPrice()
  }

  async verifyDeposit(transactionHash: Hex): Promise<VerifiedDeposit> {
    const [transaction, receipt, blockNumber] = await Promise.all([
      this.client.getTransaction({ hash: transactionHash }),
      this.client.getTransactionReceipt({ hash: transactionHash }),
      this.client.getBlockNumber(),
    ])
    if (receipt.status !== 'success' || transaction.to === null) {
      throw new ConciergeError('NFT_DEPOSIT_FAILED', 'The Ethereum deposit transaction did not succeed.', 409)
    }
    const confirmations = Number(blockNumber - receipt.blockNumber + 1n)
    return {
      transactionHash,
      from: getAddress(transaction.from),
      to: getAddress(transaction.to),
      valueWei: transaction.value.toString(),
      blockNumber: receipt.blockNumber,
      confirmations,
    }
  }

  async verifyMint(transactionHash: Hex, nftContract: Address, treasuryAddress: Address): Promise<VerifiedMint> {
    const [transaction, receipt, blockNumber] = await Promise.all([
      this.client.getTransaction({ hash: transactionHash }),
      this.client.getTransactionReceipt({ hash: transactionHash }),
      this.client.getBlockNumber(),
    ])
    if (receipt.status !== 'success' || !transaction.to) {
      throw new ConciergeError('NFT_MINT_TRANSACTION_FAILED', 'The mint transaction did not succeed.', 409)
    }
    let tokenId: bigint | undefined
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== nftContract) continue
      try {
        const decoded = decodeEventLog({ abi: ERC721_EVENTS, data: log.data, topics: log.topics })
        if (
          decoded.eventName === 'Transfer'
          && getAddress(decoded.args.from) === ZERO_ADDRESS
          && getAddress(decoded.args.to) === treasuryAddress
        ) {
          tokenId = decoded.args.tokenId
          break
        }
      } catch {
        // Ignore unrelated events emitted by the collection.
      }
    }
    if (tokenId === undefined) {
      throw new ConciergeError('NFT_MINT_DELIVERABLE_MISSING', 'Mint receipt contains no matching NFT minted to the treasury.', 409)
    }
    return {
      transactionHash,
      from: getAddress(transaction.from),
      to: getAddress(transaction.to),
      calldata: transaction.input,
      valueWei: transaction.value.toString(),
      nonce: transaction.nonce,
      tokenId,
      blockNumber: receipt.blockNumber,
      gasCostWei: transactionCost(receipt),
      confirmations: Number(blockNumber - receipt.blockNumber + 1n),
    }
  }

  async verifyFailedMint(
    transactionHash: Hex,
    treasuryAddress: Address,
    target: Address,
    expectedCalldataHash: Hex,
    expectedValueWei: bigint,
    expectedNonce: number,
  ): Promise<VerifiedFailedMint> {
    const [transaction, receipt, blockNumber] = await Promise.all([
      this.client.getTransaction({ hash: transactionHash }),
      this.client.getTransactionReceipt({ hash: transactionHash }),
      this.client.getBlockNumber(),
    ])
    if (
      receipt.status !== 'reverted'
      || !transaction.to
      || getAddress(transaction.from) !== treasuryAddress
      || getAddress(transaction.to) !== target
      || keccak256(transaction.input).toLowerCase() !== expectedCalldataHash.toLowerCase()
      || transaction.value !== expectedValueWei
      || transaction.nonce !== expectedNonce
    ) {
      throw new ConciergeError(
        'NFT_FAILED_MINT_MISMATCH',
        'Failed transaction does not match the reserved mint plan and nonce.',
        409,
      )
    }
    return {
      transactionHash,
      from: getAddress(transaction.from),
      to: getAddress(transaction.to),
      calldata: transaction.input,
      valueWei: transaction.value.toString(),
      nonce: transaction.nonce,
      blockNumber: receipt.blockNumber,
      gasCostWei: transactionCost(receipt),
      confirmations: Number(blockNumber - receipt.blockNumber + 1n),
    }
  }

  async verifyDelivery(
    transactionHash: Hex,
    nftContract: Address,
    treasuryAddress: Address,
    recipient: Address,
    tokenId: bigint,
  ): Promise<VerifiedDelivery> {
    const [transaction, receipt, blockNumber] = await Promise.all([
      this.client.getTransaction({ hash: transactionHash }),
      this.client.getTransactionReceipt({ hash: transactionHash }),
      this.client.getBlockNumber(),
    ])
    if (receipt.status !== 'success' || !transaction.to || getAddress(transaction.to) !== nftContract) {
      throw new ConciergeError('NFT_DELIVERY_TRANSACTION_FAILED', 'The NFT delivery transaction did not succeed on the expected contract.', 409)
    }
    const delivered = receipt.logs.some(log => {
      if (getAddress(log.address) !== nftContract) return false
      try {
        const decoded = decodeEventLog({ abi: ERC721_EVENTS, data: log.data, topics: log.topics })
        return decoded.eventName === 'Transfer'
          && getAddress(decoded.args.from) === treasuryAddress
          && getAddress(decoded.args.to) === recipient
          && decoded.args.tokenId === tokenId
      } catch {
        return false
      }
    })
    if (!delivered) {
      throw new ConciergeError('NFT_DELIVERY_MISMATCH', 'Delivery receipt does not transfer the minted token to the declared recipient.', 409)
    }
    return {
      transactionHash,
      from: getAddress(transaction.from),
      to: getAddress(transaction.to),
      calldata: transaction.input,
      valueWei: transaction.value.toString(),
      nonce: transaction.nonce,
      tokenId,
      blockNumber: receipt.blockNumber,
      gasCostWei: transactionCost(receipt),
      confirmations: Number(blockNumber - receipt.blockNumber + 1n),
    }
  }

  async prepareDelivery(
    nftContract: Address,
    treasuryAddress: Address,
    recipient: Address,
    tokenId: bigint,
  ) {
    const calldata = encodeFunctionData({
      abi: ERC721_TRANSFER_ABI,
      functionName: 'safeTransferFrom',
      args: [treasuryAddress, recipient, tokenId],
    })
    const gasLimit = await this.client.estimateGas({
      account: treasuryAddress,
      to: nftContract,
      data: calldata,
      value: 0n,
    })
    return { target: nftContract, calldata, valueWei: '0' as const, gasLimit }
  }

  async verifyRefund(
    transactionHash: Hex,
    treasuryAddress: Address,
    refundAddress: Address,
    amountWei: bigint,
  ): Promise<VerifiedRefund> {
    const [transaction, receipt, blockNumber] = await Promise.all([
      this.client.getTransaction({ hash: transactionHash }),
      this.client.getTransactionReceipt({ hash: transactionHash }),
      this.client.getBlockNumber(),
    ])
    if (
      receipt.status !== 'success'
      || getAddress(transaction.from) !== treasuryAddress
      || transaction.to === null
      || getAddress(transaction.to) !== refundAddress
      || transaction.value !== amountWei
      || transaction.input !== '0x'
    ) {
      throw new ConciergeError('NFT_REFUND_MISMATCH', 'Refund transaction does not match the immutable refund plan.', 409)
    }
    return {
      transactionHash,
      from: getAddress(transaction.from),
      to: getAddress(transaction.to),
      valueWei: transaction.value.toString(),
      nonce: transaction.nonce,
      blockNumber: receipt.blockNumber,
      gasCostWei: transactionCost(receipt),
      confirmations: Number(blockNumber - receipt.blockNumber + 1n),
    }
  }
}

export function calldataDigest(calldata: Hex) {
  return keccak256(calldata)
}
