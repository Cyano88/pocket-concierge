import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getAddress, keccak256, type Address, type Hex } from 'viem'
import { ConciergeError } from './errors.js'
import {
  validateAssistedNftPlan,
  type AssistedPlanConstraints,
  type ValidatedAssistedPlan,
} from './nft-assisted-worker.js'

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/

export interface NftHardenedSignerBackend {
  address(): Promise<Address>
  signAndBroadcast(plan: ValidatedAssistedPlan): Promise<{ transactionHash: Hex }>
}

export class NftHardenedSigner {
  private readonly database: DatabaseSync

  constructor(
    databasePath: string,
    private readonly backend: NftHardenedSignerBackend,
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS nft_signer_authorizations (
        plan_id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL,
        action TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        signer_address TEXT NOT NULL,
        transaction_nonce TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        calldata_hash TEXT NOT NULL,
        value_wei TEXT NOT NULL,
        gas_limit TEXT NOT NULL,
        max_fee_per_gas_wei TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        transaction_hash TEXT,
        reserved_at TEXT NOT NULL,
        broadcast_at TEXT
      );
    `)
  }

  async execute(raw: unknown, constraints: AssistedPlanConstraints) {
    const plan = validateAssistedNftPlan(raw, { ...constraints, now: this.now() })
    const signerAddress = getAddress(await this.backend.address())
    if (signerAddress !== plan.transaction.from) {
      throw new ConciergeError(
        'NFT_SIGNER_ADDRESS_MISMATCH',
        'Isolated signer address does not match the leased treasury.',
        409,
      )
    }
    const reservedAt = new Date(this.now()).toISOString()
    this.reserve(plan, signerAddress, reservedAt)

    let result: { transactionHash: Hex }
    try {
      result = await this.backend.signAndBroadcast(plan)
    } catch {
      throw new ConciergeError(
        'NFT_SIGNER_BROADCAST_UNKNOWN',
        'Signer reserved the nonce but broadcast outcome is unknown; recover the transaction before retrying.',
        503,
      )
    }
    if (!TRANSACTION_HASH.test(result.transactionHash)) {
      throw new ConciergeError(
        'NFT_SIGNER_RESULT_INVALID',
        'Signer returned no valid Ethereum transaction hash; the reserved nonce must not be reused.',
        503,
      )
    }
    const broadcastAt = new Date(this.now()).toISOString()
    const updated = this.database.prepare(`
      UPDATE nft_signer_authorizations
      SET state = 'broadcast', transaction_hash = ?, broadcast_at = ?
      WHERE plan_id = ? AND state = 'reserved'
    `).run(result.transactionHash.toLowerCase(), broadcastAt, plan.planId)
    if (updated.changes !== 1) {
      throw new ConciergeError(
        'NFT_SIGNER_LEDGER_CONFLICT',
        'Signer authorization changed unexpectedly after broadcast.',
        409,
      )
    }
    return {
      action: plan.action,
      externalId: plan.externalId,
      planId: plan.planId,
      nonce: plan.transaction.nonce,
      transactionHash: result.transactionHash,
      broadcastAt,
    }
  }

  findBroadcast(externalId: string, action: string) {
    const row = this.database.prepare(`
      SELECT plan_id, transaction_hash
      FROM nft_signer_authorizations
      WHERE external_id = ? AND action = ? AND state = 'broadcast' AND transaction_hash IS NOT NULL
      ORDER BY broadcast_at DESC
      LIMIT 1
    `).get(externalId, action) as {
      plan_id: string
      transaction_hash: string
    } | undefined
    if (!row || !TRANSACTION_HASH.test(row.transaction_hash)) return null
    return {
      planId: row.plan_id,
      transactionHash: row.transaction_hash as Hex,
    }
  }

  private reserve(plan: ValidatedAssistedPlan, signerAddress: Address, reservedAt: string) {
    try {
      this.database.prepare(`
        INSERT INTO nft_signer_authorizations (
          plan_id, external_id, action, chain_id, signer_address, transaction_nonce,
          target, calldata_hash, value_wei, gas_limit, max_fee_per_gas_wei,
          expires_at, state, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
      `).run(
        plan.planId,
        plan.externalId,
        plan.action,
        plan.transaction.chainId,
        signerAddress,
        plan.transaction.nonce,
        plan.transaction.to,
        keccak256(plan.transaction.data),
        plan.transaction.valueWei,
        plan.transaction.gasLimit,
        plan.transaction.maxFeePerGasWei,
        plan.expiresAt,
        reservedAt,
      )
    } catch {
      throw new ConciergeError(
        'NFT_SIGNER_AUTHORIZATION_REUSED',
        'Signer already reserved this plan or Ethereum nonce; it will not sign twice.',
        409,
      )
    }
  }

  close() {
    this.database.close()
  }
}
