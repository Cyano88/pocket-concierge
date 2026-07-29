import { spawn } from 'node:child_process'

const POLL_MINIMUM_MS = 5_000

function requiredEnv(name: string) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function getWork() {
  const baseUrl = requiredEnv('POCKET_CONCIERGE_URL').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/v1/nft-mints/work-queue`, {
    headers: { 'X-Operator-Key': requiredEnv('POCKET_CONCIERGE_NFT_OPERATOR_KEY') },
  })
  const payload = await response.json().catch(() => ({ error: 'non_json_response' })) as {
    work?: Array<{
      externalId: string
      action: 'mint' | 'deliver' | 'refund'
      state: string
      prepareAt?: string
      executeAt?: string
      executionDeadline?: string
    }>
  }
  if (!response.ok || !Array.isArray(payload.work)) {
    throw new Error(`Pocket work queue failed (HTTP ${response.status}): ${JSON.stringify(payload)}`)
  }
  return payload.work
}

function runWorker(action: string, externalId: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/nft-vps-worker.ts', action, externalId],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    )
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`Pocket ${action} worker exited with code ${code}.`))
    })
  })
}

async function cycle(interval: number) {
  const work = await getWork()
  if (!work.length) {
    console.log(JSON.stringify({ status: 'idle', checkedAt: new Date().toISOString() }))
    return interval
  }
  // One treasury and one signer ledger deliberately execute serially.
  const now = Date.now()
  const next = work.find(item => !item.prepareAt || Date.parse(item.prepareAt) <= now)
  if (!next) {
    const nextPrepareAt = work
      .map(item => item.prepareAt ? Date.parse(item.prepareAt) : Number.POSITIVE_INFINITY)
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0]
    const delayMs = nextPrepareAt === undefined
      ? interval
      : Math.max(250, Math.min(interval, nextPrepareAt - now))
    console.log(JSON.stringify({
      status: 'scheduled_wait',
      checkedAt: new Date(now).toISOString(),
      nextPrepareAt: nextPrepareAt === undefined ? null : new Date(nextPrepareAt).toISOString(),
    }))
    return delayMs
  }
  if (next.executionDeadline && Date.parse(next.executionDeadline) <= now) {
    console.error(JSON.stringify({
      status: 'execution_window_closed',
      externalId: next.externalId,
      executionDeadline: next.executionDeadline,
    }))
    return interval
  }
  console.log(JSON.stringify({ status: 'work_claimed', ...next }))
  await runWorker(next.action, next.externalId)
  return 250
}

async function main() {
  if (
    String(process.env.POCKET_CONCIERGE_NFT_SIGNER_MODE || '').toLowerCase() !== 'privy'
    || String(process.env.POCKET_CONCIERGE_NFT_AUTO_EXECUTE || '').toLowerCase() !== 'true'
  ) {
    throw new Error('Managed daemon requires Privy signer mode and automatic execution.')
  }
  const once = process.argv.includes('--once')
  const configured = Number(process.env.POCKET_CONCIERGE_NFT_POLL_INTERVAL_MS || 15_000)
  const interval = Number.isFinite(configured) ? Math.max(configured, POLL_MINIMUM_MS) : 15_000
  do {
    let delayMs = interval
    try {
      delayMs = await cycle(interval)
    } catch (error) {
      if (once) throw error
      console.error(error instanceof Error ? error.message : String(error))
    }
    if (!once) await new Promise(resolve => setTimeout(resolve, delayMs))
  } while (!once)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
