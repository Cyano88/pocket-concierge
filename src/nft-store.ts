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
  list(states: NftMintState[]): Promise<NftMintOrder[]>
}

export class MemoryNftMintStore implements NftMintStore {
  private readonly orders = new Map<string, NftMintOrder>()
  private readonly deposits = new Map<string, string>()

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

  async list(states: NftMintState[]) {
    const accepted = new Set(states)
    return [...this.orders.values()].filter(order => accepted.has(order.state)).map(order => structuredClone(order))
  }
}

type DocumentRow = { document: string }

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
      CREATE INDEX IF NOT EXISTS idx_nft_mint_orders_state ON nft_mint_orders(state);
    `)
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
