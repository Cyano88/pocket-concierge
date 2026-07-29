type Window = {
  count: number
  resetAt: number
}

export type RateLimitResult = {
  allowed: boolean
  retryAfterSeconds: number
}

export class FixedWindowRateLimiter {
  private readonly keys = new Map<string, Window>()
  private global: Window

  constructor(
    private readonly perKeyLimit: number,
    private readonly globalLimit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    const resetAt = this.now() + this.windowMs
    this.global = { count: 0, resetAt }
  }

  consume(key: string): RateLimitResult {
    const now = this.now()
    this.global = this.current(this.global, now)
    const currentKey = this.current(this.keys.get(key), now)
    const allowed = currentKey.count < this.perKeyLimit
      && this.global.count < this.globalLimit
    const resetAt = Math.max(currentKey.resetAt, this.global.resetAt)

    if (!allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      }
    }

    currentKey.count += 1
    this.global.count += 1
    this.keys.set(key, currentKey)
    return { allowed: true, retryAfterSeconds: 0 }
  }

  private current(window: Window | undefined, now: number): Window {
    if (!window || now >= window.resetAt) {
      return { count: 0, resetAt: now + this.windowMs }
    }
    return window
  }
}
