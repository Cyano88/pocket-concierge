import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConciergeError } from './errors.js'
import type { NftMintOrder, NftMintState } from './nft-types.js'

export interface NftMintStore {
  get(ownerId: string, externalId: string): Promise<NftMintOrder | null>
  putIfAbsent(order: NftMintOrder): Promise<{ order: NftMintOrder; inserted: boolean }>
  update(order: NftMintOrder, expectedRevision: number): Promise<void>
  claimDeposit(order: NftMintOrder, expectedRevision: number, transactionHash: string): Promise<void>
  claimExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    claimedAt: string,
    action: 'mint' | 'deliver' | 'refund',
  ): Promise<void>
  completeExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    action: 'mint' | 'deliver' | 'refund',
    completedAt: string,
  ): Promise<void>
  releaseExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    action: 'mint' | 'deliver' | 'refund',
  ): Promise<void>
  list(states: NftMintState[]): Promise<NftMintOrder[]>
}

export class MemoryNftMintStore implements NftMintStore {
  private readonly orders = new Map<string, NftMintOrder>()
  private readonly deposits = new Map<string, string>()
  private readonly executionLeases = new Map<string, {
    treasuryAddress: string
    leaseOwner: string
    leaseExpiresAt: string
    executionAttempt: number
    transactionNonce: string
    completedAt?: string
  }>()

  private key(ownerId: string, externalId: string) {
    return `${ownerId}:${externalId}`
  }

  async get(ownerId: string, externalId: string) {
    return structuredClone(this.orders.get(this.key(ownerId, externalId)) ?? null)
  }

  async putIfAbsent(order: NftMintOrder) {
    const key = this.key(order.ownerId, order.externalId)
    const existing = this.orders.get(key)
    if (existing) return { order: structuredClone(existing), inserted: false }
    this.orders.set(key, structuredClone(order))
    return { order: structuredClone(order), inserted: true }
  }

  async update(order: NftMintOrder, expectedRevision: number) {
    const key = this.key(order.ownerId, order.externalId)
    const current = this.orders.get(key)
    if (!current || current.revision !== expectedRevision || order.revision !== expectedRevision + 1) {
      throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order changed concurrently; reload before retrying.', 409)
    }
    this.orders.set(key, structuredClone(order))
  }

  async claimDeposit(order: NftMintOrder, expectedRevision: number, transactionHash: string) {
    const normalized = transactionHash.toLowerCase()
    const claimant = this.key(order.ownerId, order.externalId)
    const existingClaim = this.deposits.get(normalized)
    if (existingClaim && existingClaim !== claimant) {
      throw new ConciergeError('NFT_DEPOSIT_ALREADY_CLAIMED', 'This deposit transaction already funds another order.', 409)
    }
    this.deposits.set(normalized, claimant)
    try {
      await this.update(order, expectedRevision)
    } catch (error) {
      if (!existingClaim && this.deposits.get(normalized) === claimant) this.deposits.delete(normalized)
      throw error
    }
  }

  async claimExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    claimedAt: string,
    action: 'mint' | 'deliver' | 'refund',
  ) {
    const plan = action === 'mint'
      ? order.executionPlan
      : action === 'deliver'
        ? order.deliveryPlan
        : order.refundPlan
    if (!plan) throw new ConciergeError('NFT_EXECUTION_LEASE_INVALID', 'An execution plan is required.', 409)
    const leaseId = `${order.orderId}:${action}:${plan.executionAttempt}`
    for (const [existingLeaseId, lease] of this.executionLeases) {
      if (
        existingLeaseId.startsWith(`${order.orderId}:${action}:`)
        && lease.leaseExpiresAt <= claimedAt
      ) {
        this.executionLeases.delete(existingLeaseId)
      }
    }
    const active = [...this.executionLeases.entries()].find(
      ([existingLeaseId, lease]) => (
        existingLeaseId !== leaseId && !lease.completedAt && lease.leaseExpiresAt > claimedAt
      ),
    )
    if (active) {
      throw new ConciergeError(
        'NFT_EXECUTION_LEASE_BUSY',
        'Another treasury transaction currently owns the execution lease.',
        409,
      )
    }
    const duplicateNonce = [...this.executionLeases.entries()].find(
      ([existingLeaseId, lease]) => (
        existingLeaseId !== leaseId
        && lease.treasuryAddress === order.treasuryAddress.toLowerCase()
        && lease.transactionNonce === plan.transactionNonce
      ),
    )
    if (duplicateNonce) {
      throw new ConciergeError(
        'NFT_EXECUTION_NONCE_RESERVED',
        'The pending Ethereum nonce is already reserved by another order.',
        409,
      )
    }
    if (this.executionLeases.has(leaseId)) {
      throw new ConciergeError('NFT_EXECUTION_LEASE_CLAIMED', 'This order already has an execution lease.', 409)
    }
    this.executionLeases.set(leaseId, {
      treasuryAddress: order.treasuryAddress.toLowerCase(),
      leaseOwner: plan.leaseOwner,
      leaseExpiresAt: plan.leaseExpiresAt,
      executionAttempt: plan.executionAttempt,
      transactionNonce: plan.transactionNonce,
    })
    try {
      await this.update(order, expectedRevision)
    } catch (error) {
      this.executionLeases.delete(leaseId)
      throw error
    }
  }

  async completeExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    action: 'mint' | 'deliver' | 'refund',
    completedAt: string,
  ) {
    const candidates = [...this.executionLeases.entries()]
      .filter(([leaseId]) => leaseId.startsWith(`${order.orderId}:${action}:`))
      .sort(([, left], [, right]) => right.executionAttempt - left.executionAttempt)
    const current = candidates[0]
    if (!current) {
      throw new ConciergeError('NFT_EXECUTION_LEASE_MISSING', 'Execution lease was not found.', 409)
    }
    await this.update(order, expectedRevision)
    current[1].completedAt = completedAt
  }

  async releaseExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    action: 'mint' | 'deliver' | 'refund',
  ) {
    const candidates = [...this.executionLeases.entries()]
      .filter(([leaseId, lease]) => (
        leaseId.startsWith(`${order.orderId}:${action}:`) && !lease.completedAt
      ))
      .sort(([, left], [, right]) => right.executionAttempt - left.executionAttempt)
    const current = candidates[0]
    if (!current) {
      throw new ConciergeError('NFT_EXECUTION_LEASE_MISSING', 'Execution lease was not found.', 409)
    }
    await this.update(order, expectedRevision)
    this.executionLeases.delete(current[0])
  }

  async list(states: NftMintState[]) {
    const accepted = new Set(states)
    return [...this.orders.values()].filter(order => accepted.has(order.state)).map(order => structuredClone(order))
  }
}

type DocumentRow = { document: string }
type ExecutionLeaseMigrationRow = {
  lease_id: string
  order_id: string
  owner_id: string
  external_id: string
  action: string
  lease_owner: string
  lease_expires_at: string
  execution_attempt: number
  transaction_nonce: string
  completed_at: string | null
  document: string | null
}

export class SqliteNftMintStore implements NftMintStore {
  private readonly database: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS nft_mint_orders (
        owner_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (owner_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS nft_mint_deposits (
        transaction_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        UNIQUE (owner_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS nft_execution_leases (
        lease_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        action TEXT NOT NULL,
        treasury_address TEXT NOT NULL,
        lease_owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        execution_attempt INTEGER NOT NULL,
        transaction_nonce TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (treasury_address, transaction_nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_nft_mint_orders_state ON nft_mint_orders(state);
      CREATE INDEX IF NOT EXISTS idx_nft_execution_leases_expiry ON nft_execution_leases(lease_expires_at);
    `)
    this.migrateExecutionLeaseNonceScope()
  }

  private migrateExecutionLeaseNonceScope() {
    const columns = this.database.prepare(
      'PRAGMA table_info(nft_execution_leases)',
    ).all() as Array<{ name: string }>
    if (columns.some(column => column.name === 'treasury_address')) return

    const legacyRows = this.database.prepare(`
      SELECT leases.*, orders.document
      FROM nft_execution_leases AS leases
      LEFT JOIN nft_mint_orders AS orders ON orders.owner_id = leases.owner_id
        AND orders.external_id = leases.external_id
    `).all() as ExecutionLeaseMigrationRow[]

    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(`
        DROP INDEX IF EXISTS idx_nft_execution_leases_expiry;
        ALTER TABLE nft_execution_leases RENAME TO nft_execution_leases_legacy;
        CREATE TABLE nft_execution_leases (
          lease_id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          action TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          lease_owner TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          execution_attempt INTEGER NOT NULL,
          transaction_nonce TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE (treasury_address, transaction_nonce)
        );
      `)
      const insert = this.database.prepare(`
        INSERT INTO nft_execution_leases (
          lease_id, order_id, owner_id, external_id, action, treasury_address,
          lease_owner, lease_expires_at, execution_attempt, transaction_nonce, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const row of legacyRows) {
        let treasuryAddress = `legacy:${row.order_id}`
        try {
          const order = JSON.parse(row.document ?? '{}') as { treasuryAddress?: unknown }
          if (typeof order.treasuryAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(order.treasuryAddress)) {
            treasuryAddress = order.treasuryAddress.toLowerCase()
          }
        } catch {
          // Keep an isolated legacy scope when the historical order document is unavailable.
        }
        insert.run(
          row.lease_id,
          row.order_id,
          row.owner_id,
          row.external_id,
          row.action,
          treasuryAddress,
          row.lease_owner,
          row.lease_expires_at,
          row.execution_attempt,
          row.transaction_nonce,
          row.completed_at,
        )
      }
      this.database.exec(`
        DROP TABLE nft_execution_leases_legacy;
        CREATE INDEX idx_nft_execution_leases_expiry
          ON nft_execution_leases(lease_expires_at);
        COMMIT;
      `)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async get(ownerId: string, externalId: string) {
    const row = this.database.prepare(
      'SELECT document FROM nft_mint_orders WHERE owner_id = ? AND external_id = ?',
    ).get(ownerId, externalId) as DocumentRow | undefined
    return row ? JSON.parse(row.document) as NftMintOrder : null
  }

  async putIfAbsent(order: NftMintOrder) {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO nft_mint_orders (owner_id, external_id, state, revision, document)
      VALUES (?, ?, ?, ?, ?)
    `).run(order.ownerId, order.externalId, order.state, order.revision, JSON.stringify(order))
    if (result.changes === 1) return { order: structuredClone(order), inserted: true }
    const existing = await this.get(order.ownerId, order.externalId)
    if (!existing) throw new ConciergeError('NFT_ORDER_STORE_FAILED', 'NFT mint order persistence failed.', 500)
    return { order: existing, inserted: false }
  }

  async update(order: NftMintOrder, expectedRevision: number) {
    if (order.revision !== expectedRevision + 1) {
      throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order revision is invalid.', 409)
    }
    const result = this.database.prepare(`
      UPDATE nft_mint_orders
      SET state = ?, revision = ?, document = ?
      WHERE owner_id = ? AND external_id = ? AND revision = ?
    `).run(
      order.state,
      order.revision,
      JSON.stringify(order),
      order.ownerId,
      order.externalId,
      expectedRevision,
    )
    if (result.changes !== 1) {
      throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order changed concurrently; reload before retrying.', 409)
    }
  }

  async claimDeposit(order: NftMintOrder, expectedRevision: number, transactionHash: string) {
    if (order.revision !== expectedRevision + 1) {
      throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order revision is invalid.', 409)
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const normalized = transactionHash.toLowerCase()
      const existing = this.database.prepare(
        'SELECT owner_id, external_id FROM nft_mint_deposits WHERE transaction_hash = ?',
      ).get(normalized) as { owner_id: string; external_id: string } | undefined
      if (existing && (existing.owner_id !== order.ownerId || existing.external_id !== order.externalId)) {
        throw new ConciergeError('NFT_DEPOSIT_ALREADY_CLAIMED', 'This deposit transaction already funds another order.', 409)
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO nft_mint_deposits (transaction_hash, owner_id, external_id)
        VALUES (?, ?, ?)
      `).run(normalized, order.ownerId, order.externalId)
      const updated = this.database.prepare(`
        UPDATE nft_mint_orders
        SET state = ?, revision = ?, document = ?
        WHERE owner_id = ? AND external_id = ? AND revision = ?
      `).run(
        order.state,
        order.revision,
        JSON.stringify(order),
        order.ownerId,
        order.externalId,
        expectedRevision,
      )
      if (updated.changes !== 1) {
        throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order changed concurrently; reload before retrying.', 409)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async claimExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    claimedAt: string,
    action: 'mint' | 'deliver' | 'refund',
  ) {
    const plan = action === 'mint'
      ? order.executionPlan
      : action === 'deliver'
        ? order.deliveryPlan
        : order.refundPlan
    if (!plan || order.revision !== expectedRevision + 1) {
      throw new ConciergeError('NFT_EXECUTION_LEASE_INVALID', 'An execution plan and valid revision are required.', 409)
    }
    const leaseId = `${order.orderId}:${action}:${plan.executionAttempt}`
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        DELETE FROM nft_execution_leases
        WHERE order_id = ? AND action = ? AND lease_expires_at <= ?
      `).run(order.orderId, action, claimedAt)
      const active = this.database.prepare(`
        SELECT order_id FROM nft_execution_leases
        WHERE lease_id <> ? AND completed_at IS NULL AND lease_expires_at > ?
        LIMIT 1
      `).get(leaseId, claimedAt)
      if (active) {
        throw new ConciergeError(
          'NFT_EXECUTION_LEASE_BUSY',
          'Another treasury transaction currently owns the execution lease.',
          409,
        )
      }
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO nft_execution_leases (
          lease_id, order_id, owner_id, external_id, action, treasury_address,
          lease_owner, lease_expires_at, execution_attempt, transaction_nonce
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        leaseId,
        order.orderId,
        order.ownerId,
        order.externalId,
        action,
        order.treasuryAddress.toLowerCase(),
        plan.leaseOwner,
        plan.leaseExpiresAt,
        plan.executionAttempt,
        plan.transactionNonce,
      )
      if (inserted.changes !== 1) {
        const nonce = this.database.prepare(
          `SELECT lease_id FROM nft_execution_leases
           WHERE treasury_address = ? AND transaction_nonce = ?`,
        ).get(
          order.treasuryAddress.toLowerCase(),
          plan.transactionNonce,
        ) as { lease_id: string } | undefined
        throw new ConciergeError(
          nonce && nonce.lease_id !== leaseId
            ? 'NFT_EXECUTION_NONCE_RESERVED'
            : 'NFT_EXECUTION_LEASE_CLAIMED',
          nonce && nonce.lease_id !== leaseId
            ? 'The pending Ethereum nonce is already reserved by another order.'
            : 'This order already has an execution lease.',
          409,
        )
      }
      const updated = this.database.prepare(`
        UPDATE nft_mint_orders
        SET state = ?, revision = ?, document = ?
        WHERE owner_id = ? AND external_id = ? AND revision = ?
      `).run(
        order.state,
        order.revision,
        JSON.stringify(order),
        order.ownerId,
        order.externalId,
        expectedRevision,
      )
      if (updated.changes !== 1) {
        throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order changed concurrently; reload before retrying.', 409)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async completeExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    action: 'mint' | 'deliver' | 'refund',
    completedAt: string,
  ) {
    if (order.revision !== expectedRevision + 1) {
      throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order revision is invalid.', 409)
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const updated = this.database.prepare(`
        UPDATE nft_mint_orders
        SET state = ?, revision = ?, document = ?
        WHERE owner_id = ? AND external_id = ? AND revision = ?
      `).run(
        order.state,
        order.revision,
        JSON.stringify(order),
        order.ownerId,
        order.externalId,
        expectedRevision,
      )
      if (updated.changes !== 1) {
        throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order changed concurrently; reload before retrying.', 409)
      }
      const completed = this.database.prepare(`
        UPDATE nft_execution_leases
        SET completed_at = ?
        WHERE lease_id = (
          SELECT lease_id FROM nft_execution_leases
          WHERE order_id = ? AND action = ? AND completed_at IS NULL
          ORDER BY execution_attempt DESC
          LIMIT 1
        )
      `).run(completedAt, order.orderId, action)
      if (completed.changes !== 1) {
        throw new ConciergeError('NFT_EXECUTION_LEASE_MISSING', 'Execution lease was not found.', 409)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async releaseExecutionLease(
    order: NftMintOrder,
    expectedRevision: number,
    action: 'mint' | 'deliver' | 'refund',
  ) {
    if (order.revision !== expectedRevision + 1) {
      throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order revision is invalid.', 409)
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const released = this.database.prepare(`
        DELETE FROM nft_execution_leases
        WHERE lease_id = (
          SELECT lease_id FROM nft_execution_leases
          WHERE order_id = ? AND action = ? AND completed_at IS NULL
          ORDER BY execution_attempt DESC
          LIMIT 1
        )
      `).run(order.orderId, action)
      if (released.changes !== 1) {
        throw new ConciergeError('NFT_EXECUTION_LEASE_MISSING', 'Execution lease was not found.', 409)
      }
      const updated = this.database.prepare(`
        UPDATE nft_mint_orders
        SET state = ?, revision = ?, document = ?
        WHERE owner_id = ? AND external_id = ? AND revision = ?
      `).run(
        order.state,
        order.revision,
        JSON.stringify(order),
        order.ownerId,
        order.externalId,
        expectedRevision,
      )
      if (updated.changes !== 1) {
        throw new ConciergeError('NFT_ORDER_WRITE_CONFLICT', 'NFT mint order changed concurrently; reload before retrying.', 409)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async list(states: NftMintState[]) {
    if (!states.length) return []
    const placeholders = states.map(() => '?').join(', ')
    const rows = this.database.prepare(
      `SELECT document FROM nft_mint_orders WHERE state IN (${placeholders})`,
    ).all(...states) as unknown as DocumentRow[]
    return rows.map(row => JSON.parse(row.document) as NftMintOrder)
  }

  close() {
    this.database.close()
  }
}
