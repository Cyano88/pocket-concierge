import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ConciergeError } from './errors.js'
import type { AuthorityReceipt, Mission } from './types.js'

export interface MissionStore {
  get(ownerId: string, externalId: string): Promise<Mission | null>
  getReceipt(receiptId: string): Promise<AuthorityReceipt | null>
  putIfAbsent(mission: Mission): Promise<{ mission: Mission; inserted: boolean }>
  update(mission: Mission, expectedRevision: number, receipt?: AuthorityReceipt): Promise<void>
}

export class MemoryMissionStore implements MissionStore {
  private readonly missions = new Map<string, Mission>()
  private readonly receipts = new Map<string, AuthorityReceipt>()

  private key(ownerId: string, externalId: string) {
    return `${ownerId}:${externalId}`
  }

  async get(ownerId: string, externalId: string) {
    return structuredClone(this.missions.get(this.key(ownerId, externalId)) ?? null)
  }

  async getReceipt(receiptId: string) {
    return structuredClone(this.receipts.get(receiptId) ?? null)
  }

  async putIfAbsent(mission: Mission) {
    const key = this.key(mission.ownerId, mission.externalId)
    const existing = this.missions.get(key)
    if (existing) return { mission: structuredClone(existing), inserted: false }
    this.missions.set(key, structuredClone(mission))
    return { mission: structuredClone(mission), inserted: true }
  }

  async update(mission: Mission, expectedRevision: number, receipt?: AuthorityReceipt) {
    const current = this.missions.get(this.key(mission.ownerId, mission.externalId))
    if (!current || current.revision !== expectedRevision || mission.revision !== expectedRevision + 1) {
      throw new ConciergeError('MISSION_WRITE_CONFLICT', 'Mission changed concurrently; reload it before retrying.', 409)
    }
    this.missions.set(this.key(mission.ownerId, mission.externalId), structuredClone(mission))
    if (receipt) this.receipts.set(receipt.receiptId, structuredClone(receipt))
  }
}

type MissionRow = {
  document: string
}

export class SqliteMissionStore implements MissionStore {
  private readonly database: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS missions (
        owner_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (owner_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS authority_receipts (
        receipt_id TEXT PRIMARY KEY,
        document TEXT NOT NULL
      );
    `)
  }

  async get(ownerId: string, externalId: string) {
    const row = this.database.prepare(
      'SELECT document FROM missions WHERE owner_id = ? AND external_id = ?',
    ).get(ownerId, externalId) as MissionRow | undefined
    return row ? JSON.parse(row.document) as Mission : null
  }

  async getReceipt(receiptId: string) {
    const row = this.database.prepare(
      'SELECT document FROM authority_receipts WHERE receipt_id = ?',
    ).get(receiptId) as MissionRow | undefined
    return row ? JSON.parse(row.document) as AuthorityReceipt : null
  }

  async putIfAbsent(mission: Mission) {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO missions (owner_id, external_id, revision, document)
      VALUES (?, ?, ?, ?)
    `).run(mission.ownerId, mission.externalId, mission.revision, JSON.stringify(mission))
    if (result.changes === 1) return { mission: structuredClone(mission), inserted: true }
    const existing = await this.get(mission.ownerId, mission.externalId)
    if (!existing) throw new ConciergeError('MISSION_STORE_FAILED', 'Mission persistence failed.', 500)
    return { mission: existing, inserted: false }
  }

  async update(mission: Mission, expectedRevision: number, receipt?: AuthorityReceipt) {
    if (mission.revision !== expectedRevision + 1) {
      throw new ConciergeError('MISSION_WRITE_CONFLICT', 'Mission revision is invalid.', 409)
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.database.prepare(`
        UPDATE missions
        SET revision = ?, document = ?
        WHERE owner_id = ? AND external_id = ? AND revision = ?
      `).run(
        mission.revision,
        JSON.stringify(mission),
        mission.ownerId,
        mission.externalId,
        expectedRevision,
      )
      if (result.changes !== 1) {
        throw new ConciergeError('MISSION_WRITE_CONFLICT', 'Mission changed concurrently; reload it before retrying.', 409)
      }
      if (receipt) {
        this.database.prepare(`
          INSERT INTO authority_receipts (receipt_id, document)
          VALUES (?, ?)
          ON CONFLICT(receipt_id) DO UPDATE SET document = excluded.document
        `).run(receipt.receiptId, JSON.stringify(receipt))
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    this.database.close()
  }
}
