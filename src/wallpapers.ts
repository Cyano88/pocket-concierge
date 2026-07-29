import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
} from 'viem'
import { ConciergeError } from './errors.js'

export const WALLPAPER_PURCHASE_ROUTE = '/v1/okx/wallpapers/purchase'
export const WALLPAPER_PURCHASE_FEE_ATOMIC = '10000'
export const WALLPAPER_PURCHASE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['ok', 'asset', 'licenseReceipt', 'downloads'],
  properties: {
    ok: { type: 'boolean' },
    asset: { type: 'object' },
    licenseReceipt: { type: 'object' },
    downloads: { type: 'object' },
  },
}

const ERC721_METADATA_ABI = parseAbi([
  'function tokenURI(uint256 tokenId) view returns (string)',
])
const RIGHTS = new Set(['private-use', 'cc0', 'public-domain', 'commercial-license', 'creator-opt-in'])
const PUBLIC_RIGHTS = new Set(['cc0', 'public-domain', 'commercial-license', 'creator-opt-in'])
const MAX_METADATA_BYTES = 1_000_000
const MAX_IMAGE_BYTES = 20_000_000
const MAX_INPUT_PIXELS = 40_000_000
const WALLPAPER_RENDER_VERSION = '2'

type WallpaperRights = 'private-use' | 'cc0' | 'public-domain' | 'commercial-license' | 'creator-opt-in'

export type WallpaperAsset = {
  assetId: string
  renderVersion: string
  externalId: string
  nftContract: Address
  tokenId: string
  name: string
  sourceTokenUri: string
  sourceImageUri: string
  sourceImageHash: string
  rights: WallpaperRights
  rightsReference: string | null
  publicCatalog: boolean
  createdAt: string
  files: {
    preview: { path: string; sha256: string }
    desktop: { path: string; sha256: string }
    mobile: { path: string; sha256: string }
  }
}

function safeText(value: unknown, name: string, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new ConciergeError('WALLPAPER_INPUT_INVALID', `${name} must be a non-empty string of at most ${maximum} characters.`)
  }
  return value.trim()
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function isPrivateIp(address: string) {
  const normalized = address.toLowerCase()
  if (
    normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
  ) return true
  const octets = normalized.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value))) return false
  return octets[0] === 10
    || octets[0] === 127
    || octets[0] === 0
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

async function safeHttpsUrl(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConciergeError('WALLPAPER_URI_INVALID', 'NFT metadata contains an invalid URI.', 409)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new ConciergeError('WALLPAPER_URI_UNSAFE', 'Only credential-free HTTPS metadata resources are accepted.', 409)
  }
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some(result => isPrivateIp(result.address))) {
    throw new ConciergeError('WALLPAPER_URI_UNSAFE', 'Metadata resource resolves to a private or reserved network.', 409)
  }
  return url
}

function gatewayUri(raw: string) {
  if (raw.startsWith('ipfs://')) {
    const path = raw.slice(7).replace(/^ipfs\//, '')
    if (!/^[a-zA-Z0-9]+(?:\/[^\s?#]*)?$/.test(path)) {
      throw new ConciergeError('WALLPAPER_URI_INVALID', 'Invalid IPFS metadata path.', 409)
    }
    return `https://ipfs.io/ipfs/${path}`
  }
  if (raw.startsWith('ar://')) {
    const path = raw.slice(5)
    if (!/^[a-zA-Z0-9_-]+(?:\/[^\s?#]*)?$/.test(path)) {
      throw new ConciergeError('WALLPAPER_URI_INVALID', 'Invalid Arweave metadata path.', 409)
    }
    return `https://arweave.net/${path}`
  }
  return raw
}

function decodeJsonDataUri(raw: string) {
  const match = raw.match(/^data:application\/json(?:;charset=utf-8)?(;base64)?,(.*)$/i)
  if (!match) return null
  const buffer = match[1]
    ? Buffer.from(match[2]!, 'base64')
    : Buffer.from(decodeURIComponent(match[2]!), 'utf8')
  if (buffer.length > MAX_METADATA_BYTES) {
    throw new ConciergeError('WALLPAPER_METADATA_TOO_LARGE', 'NFT metadata exceeds the safe size limit.', 413)
  }
  return buffer
}

function decodeImageDataUri(raw: string) {
  const match = raw.match(/^data:image\/(png|jpeg|webp|avif|gif);base64,(.*)$/i)
  if (!match) return null
  const buffer = Buffer.from(match[2]!, 'base64')
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ConciergeError('WALLPAPER_MEDIA_TOO_LARGE', 'NFT image exceeds the safe size limit.', 413)
  }
  return buffer
}

function resolveImageUri(imageUri: string, tokenUri: string) {
  const transformed = gatewayUri(imageUri)
  if (/^(?:https:|data:)/i.test(transformed)) return transformed
  const base = gatewayUri(tokenUri)
  if (!base.startsWith('https:')) {
    throw new ConciergeError('WALLPAPER_URI_INVALID', 'Relative NFT image URI requires HTTPS metadata.', 409)
  }
  try {
    return new URL(transformed, base).toString()
  } catch {
    throw new ConciergeError('WALLPAPER_URI_INVALID', 'NFT metadata contains an invalid image URI.', 409)
  }
}

async function fetchBounded(raw: string, maximumBytes: number, accepted: RegExp) {
  let current = await safeHttpsUrl(gatewayUri(raw))
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { accept: accepted.source.includes('json') ? 'application/json' : 'image/*' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects === 3) throw new ConciergeError('WALLPAPER_FETCH_FAILED', 'Metadata redirect limit exceeded.', 409)
      current = await safeHttpsUrl(new URL(location, current).toString())
      continue
    }
    if (!response.ok) throw new ConciergeError('WALLPAPER_FETCH_FAILED', `Metadata resource returned HTTP ${response.status}.`, 409)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!accepted.test(contentType)) {
      throw new ConciergeError('WALLPAPER_MEDIA_UNSUPPORTED', `Unsupported metadata media type: ${contentType || 'missing'}.`, 409)
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > maximumBytes) throw new ConciergeError('WALLPAPER_MEDIA_TOO_LARGE', 'Metadata resource exceeds the safe size limit.', 413)
    const reader = response.body?.getReader()
    if (!reader) throw new ConciergeError('WALLPAPER_FETCH_FAILED', 'Metadata resource returned no body.', 409)
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximumBytes) {
        await reader.cancel()
        throw new ConciergeError('WALLPAPER_MEDIA_TOO_LARGE', 'Metadata resource exceeds the safe size limit.', 413)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new ConciergeError('WALLPAPER_FETCH_FAILED', 'Metadata resource could not be fetched.', 409)
}

export class WallpaperService {
  private readonly database: DatabaseSync
  private readonly client

  constructor(
    databasePath: string,
    rpcUrl: string,
    private readonly outputDirectory: string,
    private readonly downloadSecret: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.client = createPublicClient({ transport: http(rpcUrl) })
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS nft_wallpaper_assets (
        asset_id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE,
        document TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  async create(
    externalId: string,
    nftContract: Address,
    tokenId: string,
    raw: unknown,
  ) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    const rights = safeText(input.rights ?? 'private-use', 'rights', 40) as WallpaperRights
    if (!RIGHTS.has(rights)) throw new ConciergeError('WALLPAPER_RIGHTS_INVALID', 'Unsupported wallpaper rights classification.')
    const rightsReference = input.rightsReference === undefined
      ? null
      : safeText(input.rightsReference, 'rightsReference', 1000)
    if (PUBLIC_RIGHTS.has(rights) && !rightsReference) {
      throw new ConciergeError('WALLPAPER_RIGHTS_EVIDENCE_REQUIRED', 'Public catalog rights require a reviewable rightsReference.', 409)
    }
    const existing = this.getByExternalId(externalId)
    if (existing?.renderVersion === WALLPAPER_RENDER_VERSION) {
      return { replayed: true, asset: existing }
    }

    const sourceTokenUri = await this.client.readContract({
      address: nftContract,
      abi: ERC721_METADATA_ABI,
      functionName: 'tokenURI',
      args: [BigInt(tokenId)],
    })
    if (!sourceTokenUri) {
      throw new ConciergeError('WALLPAPER_METADATA_PENDING', 'NFT tokenURI is not revealed yet; retry after metadata reveal.', 409)
    }
    const inline = decodeJsonDataUri(sourceTokenUri)
    const metadataBuffer = inline ?? await fetchBounded(sourceTokenUri, MAX_METADATA_BYTES, /^application\/(?:json|[\w.+-]+\+json)$/)
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(metadataBuffer.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new ConciergeError('WALLPAPER_METADATA_INVALID', 'NFT tokenURI did not resolve to valid JSON.', 409)
    }
    const sourceImageUri = safeText(metadata.image, 'metadata.image', 4000)
    const resolvedImageUri = resolveImageUri(sourceImageUri, sourceTokenUri)
    const image = decodeImageDataUri(resolvedImageUri) ?? await fetchBounded(
      resolvedImageUri,
      MAX_IMAGE_BYTES,
      /^image\/(?:png|jpeg|webp|avif|gif)$/,
    )
    const base = sharp(image, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    const sourceInfo = await base.metadata()
    if (!sourceInfo.width || !sourceInfo.height) {
      throw new ConciergeError('WALLPAPER_IMAGE_INVALID', 'NFT image has no usable dimensions.', 409)
    }
    const assetId = `nwa_${createHash('sha256').update(`${WALLPAPER_RENDER_VERSION}:${nftContract}:${tokenId}:${sha256(image)}`).digest('hex').slice(0, 24)}`
    const directory = join(this.outputDirectory, assetId)
    await mkdir(directory, { recursive: true })
    const stats = await base.stats()
    const background = {
      r: stats.dominant.r,
      g: stats.dominant.g,
      b: stats.dominant.b,
      alpha: 1,
    }
    const render = async (name: string, width: number, height: number) => {
      const padding = Math.round(Math.min(width, height) * 0.08)
      const foreground = await sharp(image, {
        failOn: 'warning',
        limitInputPixels: MAX_INPUT_PIXELS,
      })
        .resize({
          width: width - padding * 2,
          height: height - padding * 2,
          fit: 'inside',
          withoutEnlargement: false,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer()
      const foregroundInfo = await sharp(foreground).metadata()
      const output = await sharp({
        create: {
          width,
          height,
          channels: 4,
          background,
        },
      })
        .composite([{
          input: foreground,
          left: Math.floor((width - foregroundInfo.width!) / 2),
          top: Math.floor((height - foregroundInfo.height!) / 2),
        }])
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer()
      const path = join(directory, `${name}.png`)
      await writeFile(path, output, { mode: 0o600 })
      return { path, sha256: sha256(output) }
    }
    const [preview, desktop, mobile] = await Promise.all([
      render('preview', 640, 640),
      render('desktop-1920x1080', 1920, 1080),
      render('mobile-1080x1920', 1080, 1920),
    ])
    const createdAt = new Date(this.now()).toISOString()
    const asset: WallpaperAsset = {
      assetId,
      renderVersion: WALLPAPER_RENDER_VERSION,
      externalId,
      nftContract: getAddress(nftContract),
      tokenId,
      name: typeof metadata.name === 'string' && metadata.name.trim()
        ? metadata.name.trim().slice(0, 200)
        : `NFT #${tokenId}`,
      sourceTokenUri,
      sourceImageUri,
      sourceImageHash: sha256(image),
      rights,
      rightsReference,
      publicCatalog: PUBLIC_RIGHTS.has(rights),
      createdAt,
      files: { preview, desktop, mobile },
    }
    this.database.prepare(`
      INSERT INTO nft_wallpaper_assets (asset_id, external_id, document, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        asset_id = excluded.asset_id,
        document = excluded.document,
        created_at = excluded.created_at
    `).run(assetId, externalId, JSON.stringify(asset), createdAt)
    return { replayed: false, asset }
  }

  listPublic() {
    return (this.database.prepare(`
      SELECT document FROM nft_wallpaper_assets ORDER BY created_at DESC
    `).all() as Array<{ document: string }>)
      .map(row => JSON.parse(row.document) as WallpaperAsset)
      .filter(asset => asset.publicCatalog)
      .map(asset => this.publicAsset(asset))
  }

  promote(externalId: string, raw: unknown) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    const rights = safeText(input.rights, 'rights', 40) as WallpaperRights
    const rightsReference = safeText(input.rightsReference, 'rightsReference', 1000)
    if (!PUBLIC_RIGHTS.has(rights)) {
      throw new ConciergeError('WALLPAPER_PUBLIC_RIGHTS_REQUIRED', 'Catalog assets require reviewed public commercial rights.', 409)
    }
    const asset = this.getByExternalId(externalId)
    if (!asset) throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Create the private wallpaper pack before catalog review.', 404)
    const promoted: WallpaperAsset = {
      ...asset,
      rights,
      rightsReference,
      publicCatalog: true,
    }
    this.database.prepare(`
      UPDATE nft_wallpaper_assets SET document = ? WHERE external_id = ?
    `).run(JSON.stringify(promoted), externalId)
    return promoted
  }

  getPublic(assetId: string) {
    const asset = this.get(assetId)
    return asset?.publicCatalog ? this.publicAsset(asset) : null
  }

  purchase(assetId: string) {
    const asset = this.get(assetId)
    if (!asset?.publicCatalog) throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Public wallpaper asset was not found.', 404)
    return {
      ok: true,
      asset: this.publicAsset(asset),
      licenseReceipt: {
        rights: asset.rights,
        rightsReference: asset.rightsReference,
        provenance: {
          chainId: 1,
          nftContract: asset.nftContract,
          tokenId: asset.tokenId,
          tokenUri: asset.sourceTokenUri,
          sourceImageHash: asset.sourceImageHash,
        },
      },
      downloads: this.grant(assetId),
    }
  }

  grant(assetId: string) {
    const asset = this.get(assetId)
    if (!asset) throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Wallpaper asset was not found.', 404)
    const expiresAt = new Date(this.now() + 15 * 60_000).toISOString()
    const downloads = Object.fromEntries(
      (['desktop', 'mobile'] as const).map(variant => [
        variant,
        {
          path: `/v1/wallpapers/${asset.assetId}/download/${variant}`,
          token: this.downloadToken(asset.assetId, variant, expiresAt),
          sha256: asset.files[variant].sha256,
          expiresAt,
        },
      ]),
    )
    return downloads
  }

  async download(assetId: string, variant: 'preview' | 'desktop' | 'mobile', token?: string) {
    const asset = this.get(assetId)
    if (!asset) throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Wallpaper asset was not found.', 404)
    if (variant !== 'preview') this.verifyDownloadToken(assetId, variant, token)
    if (variant === 'preview' && !asset.publicCatalog) {
      throw new ConciergeError('WALLPAPER_NOT_FOUND', 'Wallpaper asset was not found.', 404)
    }
    return readFile(asset.files[variant].path)
  }

  private publicAsset(asset: WallpaperAsset) {
    return {
      assetId: asset.assetId,
      name: asset.name,
      nftContract: asset.nftContract,
      tokenId: asset.tokenId,
      preview: `/v1/wallpapers/${asset.assetId}/download/preview`,
      rights: asset.rights,
      rightsReference: asset.rightsReference,
      provenance: {
        tokenUri: asset.sourceTokenUri,
        sourceImageHash: asset.sourceImageHash,
      },
    }
  }

  private get(assetId: string) {
    const row = this.database.prepare(
      `SELECT document FROM nft_wallpaper_assets WHERE asset_id = ?`,
    ).get(assetId) as { document: string } | undefined
    return row ? JSON.parse(row.document) as WallpaperAsset : null
  }

  private getByExternalId(externalId: string) {
    const row = this.database.prepare(
      `SELECT document FROM nft_wallpaper_assets WHERE external_id = ?`,
    ).get(externalId) as { document: string } | undefined
    return row ? JSON.parse(row.document) as WallpaperAsset : null
  }

  private downloadToken(assetId: string, variant: string, expiresAt: string) {
    const nonce = randomBytes(8).toString('hex')
    const payload = `${assetId}.${variant}.${Date.parse(expiresAt)}.${nonce}`
    const signature = createHmac('sha256', this.downloadSecret).update(payload).digest('base64url')
    return Buffer.from(`${payload}.${signature}`).toString('base64url')
  }

  private verifyDownloadToken(assetId: string, variant: string, token?: string) {
    let decoded = ''
    try {
      decoded = Buffer.from(String(token ?? ''), 'base64url').toString('utf8')
    } catch {}
    const parts = decoded.split('.')
    const [boundAsset, boundVariant, expiresAt, nonce, signature] = parts
    if (!boundAsset || !boundVariant || !expiresAt || !nonce || !signature || parts.length !== 5) {
      throw new ConciergeError('WALLPAPER_DOWNLOAD_UNAUTHORIZED', 'A valid paid download token is required.', 401)
    }
    const payload = `${boundAsset}.${boundVariant}.${expiresAt}.${nonce}`
    const expected = Buffer.from(createHmac('sha256', this.downloadSecret).update(payload).digest('base64url'))
    const supplied = Buffer.from(signature)
    if (
      boundAsset !== assetId
      || boundVariant !== variant
      || this.now() >= Number(expiresAt)
      || expected.length !== supplied.length
      || !timingSafeEqual(expected, supplied)
    ) {
      throw new ConciergeError('WALLPAPER_DOWNLOAD_UNAUTHORIZED', 'Paid download token is invalid or expired.', 401)
    }
  }
}
