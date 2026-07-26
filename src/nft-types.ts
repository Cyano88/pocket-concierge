export type NftMintState =
  | 'awaiting_funding'
  | 'armed'
  | 'minting'
  | 'delivering'
  | 'delivered'
  | 'refunding'
  | 'refunded'
  | 'expired'
  | 'needs_review'

export type MintExecutionPlan = {
  planId: string
  target: `0x${string}`
  calldataHash: string
  valueWei: string
  gasLimit: string
  maxFeePerGasWei: string
  maximumExecutionCostWei: string
  createdAt: string
  expiresAt: string
}

export type TransferExecutionPlan = {
  planId: string
  target: `0x${string}`
  calldataHash: string
  valueWei: string
  gasLimit: string
  maxFeePerGasWei: string
  amountWei?: string
  createdAt: string
  expiresAt: string
}

export type NftMintOrder = {
  ownerId: string
  orderId: string
  externalId: string
  manifestHash: string
  revision: number
  state: NftMintState
  chainId: 1
  collectionSlug: string
  nftContract: `0x${string}`
  nftRecipient: `0x${string}`
  refundAddress: `0x${string}`
  fundingAddress: `0x${string}`
  treasuryAddress: `0x${string}`
  quantity: 1
  maxMintPriceWei: string
  maxTotalCostWei: string
  requiredDepositWei: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  deposit?: {
    transactionHash: `0x${string}`
    amountWei: string
    blockNumber: string
    confirmations: number
    confirmedAt: string
  }
  executionPlan?: MintExecutionPlan
  deliveryPlan?: TransferExecutionPlan
  refundPlan?: TransferExecutionPlan
  mint?: {
    transactionHash: `0x${string}`
    tokenId: string
    blockNumber: string
    gasCostWei: string
    confirmedAt: string
  }
  delivery?: {
    transactionHash: `0x${string}`
    blockNumber: string
    gasCostWei: string
    confirmedAt: string
  }
  refund?: {
    transactionHash: `0x${string}`
    amountWei: string
    blockNumber: string
    gasCostWei: string
    confirmedAt: string
  }
  failure?: {
    code: string
    message: string
    recordedAt: string
  }
}

export type CreateNftMintOrderInput = {
  externalId: string
  collectionSlug: string
  nftContract: string
  nftRecipient: string
  refundAddress: string
  fundingAddress: string
  quantity: number
  maxMintPriceWei: string
  maxTotalCostWei: string
  expiresAt: string
}

export type BuiltMintTransaction = {
  target: `0x${string}`
  calldata: `0x${string}`
  valueWei: string
}

export type VerifiedDeposit = {
  transactionHash: `0x${string}`
  from: `0x${string}`
  to: `0x${string}`
  valueWei: string
  blockNumber: bigint
  confirmations: number
}

export type VerifiedMint = {
  transactionHash: `0x${string}`
  from: `0x${string}`
  to: `0x${string}`
  calldata: `0x${string}`
  valueWei: string
  tokenId: bigint
  blockNumber: bigint
  gasCostWei: bigint
  confirmations: number
}

export type VerifiedDelivery = {
  transactionHash: `0x${string}`
  from: `0x${string}`
  to: `0x${string}`
  calldata: `0x${string}`
  valueWei: string
  tokenId: bigint
  blockNumber: bigint
  gasCostWei: bigint
  confirmations: number
}

export type VerifiedRefund = {
  transactionHash: `0x${string}`
  from: `0x${string}`
  to: `0x${string}`
  valueWei: string
  blockNumber: bigint
  gasCostWei: bigint
  confirmations: number
}
