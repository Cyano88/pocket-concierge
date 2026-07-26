import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { Wallet } from 'ethers'

async function hidden(prompt: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('An interactive terminal is required.')
  }
  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let value = ''
  try {
    for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
      for (const character of chunk) {
        if (character === '\u0003') throw new Error('Cancelled.')
        if (character === '\r' || character === '\n') {
          stdout.write('\n')
          return value
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
  throw new Error('Terminal closed before password entry.')
}

async function main() {
  const outputPath = process.argv[2]
  if (!outputPath) throw new Error('Usage: npm run nft:vps-keystore -- <new-keystore-path>')
  const password = await hidden('New keystore password: ')
  if (password.length < 16) throw new Error('Use a password of at least 16 characters.')
  const repeated = await hidden('Repeat keystore password: ')
  if (password !== repeated) throw new Error('Passwords do not match.')

  const wallet = Wallet.createRandom()
  const json = await wallet.encrypt(password)
  const destination = resolve(outputPath)
  writeFileSync(destination, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(destination, 0o600)
  console.log(JSON.stringify({
    created: true,
    address: wallet.address,
    keystorePath: destination,
    next: 'Back up the encrypted file and configure this exact address as the Pocket NFT treasury.',
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
