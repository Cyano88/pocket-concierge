import type { Mission } from './types.js'

export interface MissionStore {
  get(ownerId: string, externalId: string): Promise<Mission | null>
  putIfAbsent(mission: Mission): Promise<{ mission: Mission; inserted: boolean }>
  update(mission: Mission): Promise<void>
}

export class MemoryMissionStore implements MissionStore {
  private readonly missions = new Map<string, Mission>()

  private key(ownerId: string, externalId: string) {
    return `${ownerId}:${externalId}`
  }

  async get(ownerId: string, externalId: string) {
    return structuredClone(this.missions.get(this.key(ownerId, externalId)) ?? null)
  }

  async putIfAbsent(mission: Mission) {
    const key = this.key(mission.ownerId, mission.externalId)
    const existing = this.missions.get(key)
    if (existing) return { mission: structuredClone(existing), inserted: false }
    this.missions.set(key, structuredClone(mission))
    return { mission: structuredClone(mission), inserted: true }
  }

  async update(mission: Mission) {
    this.missions.set(this.key(mission.ownerId, mission.externalId), structuredClone(mission))
  }
}
