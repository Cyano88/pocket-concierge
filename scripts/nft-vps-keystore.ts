import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { Wallet } from 'ethers'

async function hidden(prompt: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('An interactive terminal is required.')
  }
  stdout.write(prompt)
  stdin.setEncoding('utf8')
  return new Promise<string>((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onEnd = () => {
      cleanup()
      reject(new Error('Terminal closed before password entry.'))
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new Error('Cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }
        value = character === '\u007f' || character === '\b'
          ? value.slice(0, -1)
          : value + character
      }
    }
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.setRawMode(true)
    stdin.resume()
  })
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
