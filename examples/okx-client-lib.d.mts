export function parseUsdt(value: unknown): bigint
export function canonical(value: unknown): string
export function bodyBinding(body: unknown, key: string): string
export function bindingMatches(body: unknown, key: string, expected: unknown): boolean
export function sealJson(value: unknown, key: string): {
  algorithm: "aes-256-gcm"
  iv: string
  ciphertext: string
  tag: string
}
export function openJson(sealed: unknown, key: string): unknown
export function parseCliJson(stdout: unknown): unknown
export function selectQuote(
  data: unknown,
  maximumUsdt: string,
  requestedIndex?: number,
): {
  paymentId: string
  acceptsIndex: number
  amountAtomic: string
  amountHuman: string
  network: string
  token: string
  recipient: string
  walletWarning: string | null
}
export function findStatusProof(
  value: unknown,
  depth?: number,
): { statusUrl: string; statusToken: string } | null
