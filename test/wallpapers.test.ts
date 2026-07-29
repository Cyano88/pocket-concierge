import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { getAddress } from 'viem'
import { WallpaperService } from '../src/wallpapers.js'

const NFT = getAddress('0x2222222222222222222222222222222222222222')

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-wallpaper-'))
  const image = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 20, g: 80, b: 140, alpha: 1 },
    },
  }).png().toBuffer()
  const metadata = Buffer.from(JSON.stringify({
    name: 'Rights-aware test NFT',
    image: `data:image/png;base64,${image.toString('base64')}`,
  })).toString('base64')
  const service = new WallpaperService(
    join(directory, 'wallpapers.sqlite'),
    'http://127.0.0.1:8545',
    join(directory, 'files'),
    'wallpaper-test-secret-that-is-long-enough',
    () => Date.parse('2026-07-29T00:00:00.000Z'),
  )
  ;(service as unknown as { client: { readContract(): Promise<string> } }).client = {
    async readContract() {
      return `data:application/json;base64,${metadata}`
    },
  }
  return service
}

test('delivered NFT becomes a deterministic private wallpaper pack before catalog review', async () => {
  const service = await fixture()
  const first = await service.create('wallpaper-order-001', NFT, '42', { rights: 'private-use' })
  const replay = await service.create('wallpaper-order-001', NFT, '42', { rights: 'private-use' })
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(first.asset.publicCatalog, false)
  assert.deepEqual(service.listPublic(), [])
  assert.equal(first.asset.files.desktop.sha256.length, 64)
  assert.equal(first.asset.files.mobile.sha256.length, 64)
})

test('public catalog requires explicit reviewed commercial rights and paid tokens are scoped', async () => {
  const service = await fixture()
  const created = await service.create('wallpaper-order-002', NFT, '43', { rights: 'private-use' })
  assert.throws(
    () => service.promote('wallpaper-order-002', {
      rights: 'private-use',
      rightsReference: 'https://example.com/license',
    }),
    (error: unknown) => (error as { code?: string }).code === 'WALLPAPER_PUBLIC_RIGHTS_REQUIRED',
  )
  const promoted = service.promote('wallpaper-order-002', {
    rights: 'cc0',
    rightsReference: 'https://example.com/cc0-declaration',
  })
  assert.equal(promoted.publicCatalog, true)
  assert.equal(service.listPublic().length, 1)
  const purchase = service.purchase(created.asset.assetId)
  const desktop = purchase.downloads.desktop as { path: string; token: string; sha256: string }
  assert.equal((await service.download(created.asset.assetId, 'desktop', desktop.token)).length > 0, true)
  await assert.rejects(
    service.download(created.asset.assetId, 'mobile', desktop.token),
    (error: unknown) => (error as { code?: string }).code === 'WALLPAPER_DOWNLOAD_UNAUTHORIZED',
  )
})
