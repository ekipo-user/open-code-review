import { mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileTailer } from '../file-tailer.js'

let dir: string
let logPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocr-tailer-'))
  logPath = join(dir, 'exec.log')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Collect chunks and reconstruct the full text + the line stream a consumer
 *  (command-runner's line buffer) would see. */
function collector() {
  let text = ''
  return {
    onChunk: (c: string) => {
      text += c
    },
    get text() {
      return text
    },
  }
}

describe('FileTailer', () => {
  it('drains the full file on stop, even content written after start', () => {
    writeFileSync(logPath, 'line one\n')
    const c = collector()
    const tailer = new FileTailer(logPath, c.onChunk, 5)
    tailer.start()
    appendFileSync(logPath, 'line two\nline three\n')
    // stop() does a final synchronous drain to EOF — no need to wait for a tick.
    tailer.stop()
    expect(c.text).toBe('line one\nline two\nline three\n')
  })

  it('reconstructs a codepoint split across a single tailer’s reads', () => {
    const rocket = Buffer.from('start🚀end\n', 'utf-8')
    // Write byte-by-byte while the tailer polls, so reads land mid-codepoint.
    const fd = openSync(logPath, 'w')
    const c = collector()
    const tailer = new FileTailer(logPath, c.onChunk, 1)
    tailer.start()
    for (const byte of rocket) {
      writeSync(fd, Buffer.from([byte]))
    }
    closeSync(fd)
    tailer.stop()
    expect(c.text).toBe('start🚀end\n')
    expect(c.text).not.toContain('�')
  })

  it('handles a file that does not exist yet, then appears', () => {
    const c = collector()
    const tailer = new FileTailer(logPath, c.onChunk, 5)
    tailer.start() // file absent at start
    writeFileSync(logPath, 'delayed\n')
    tailer.stop()
    expect(c.text).toBe('delayed\n')
  })

  it('reads content larger than one internal buffer', () => {
    const big = 'x'.repeat(200_000) + '\n' // > 64KB read chunk
    writeFileSync(logPath, big)
    const c = collector()
    const tailer = new FileTailer(logPath, c.onChunk, 5)
    tailer.start()
    tailer.stop()
    expect(c.text).toBe(big)
  })

  it('is safe to stop twice', () => {
    writeFileSync(logPath, 'once\n')
    const c = collector()
    const tailer = new FileTailer(logPath, c.onChunk, 5)
    tailer.start()
    tailer.stop()
    expect(() => tailer.stop()).not.toThrow()
    expect(c.text).toBe('once\n')
  })
})
