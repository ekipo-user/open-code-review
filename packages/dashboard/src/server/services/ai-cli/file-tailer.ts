/**
 * FileTailer — stream a growing file as decoded UTF-8 chunks.
 *
 * The belt-and-suspenders half of the wedge fix. Detached agentic CLIs are
 * spawned with their stdout/stderr redirected to a per-execution log FILE
 * rather than an OS pipe. A leaked grandchild (e.g. an MCP daemon that
 * `setsid()`'d away) can then inherit fd 1/2 without holding a pipe whose EOF
 * the dashboard waits on — so `proc.on('close')` fires on the *direct* child's
 * exit and finalization can never hang on stdio EOF again.
 *
 * This class reads the new bytes appended to that file and hands them to the
 * SAME `(chunk: string) => void` sink the old `proc.stdout.on('data')` path
 * used — so the proven line-buffer + parseLine loop in command-runner is
 * unchanged. A `StringDecoder` preserves multi-byte UTF-8 codepoints that
 * straddle a read boundary (the role `stdout.setEncoding('utf-8')` played for
 * the pipe), so a JSON line carrying emoji/non-ASCII is never corrupted.
 *
 * All I/O is synchronous (`readSync` at an explicit offset) so {@link stop} can
 * do a final drain inline from the synchronous `close` handler with no
 * lost-tail race.
 */

import { openSync, readSync, closeSync, existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_POLL_MS = 100;
const READ_CHUNK_BYTES = 64 * 1024;

export class FileTailer {
  private fd: number | null = null;
  private offset = 0;
  private readonly decoder = new StringDecoder("utf8");
  private timer: NodeJS.Timeout | null = null;
  private readonly buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly onChunk: (chunk: string) => void,
    private readonly pollMs = DEFAULT_POLL_MS,
  ) {}

  /** Begin polling for appended bytes. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    // Never let the tail timer keep the dashboard's event loop alive.
    this.timer.unref?.();
  }

  private ensureOpen(): boolean {
    if (this.fd !== null) return true;
    if (!existsSync(this.path)) return false;
    try {
      this.fd = openSync(this.path, "r");
    } catch {
      return false;
    }
    return true;
  }

  /** Read everything currently available from `offset` to EOF. */
  private poll(): void {
    if (!this.ensureOpen()) return;
    // ensureOpen() guarantees an open fd on success, but narrow it locally
    // rather than asserting non-null (the project bans `!`).
    const fd = this.fd;
    if (fd === null) return;
    let bytes: number;
    do {
      try {
        bytes = readSync(fd, this.buf, 0, this.buf.length, this.offset);
      } catch {
        return; // transient read error — try again next tick
      }
      if (bytes > 0) {
        this.offset += bytes;
        const chunk = this.decoder.write(this.buf.subarray(0, bytes));
        if (chunk) this.onChunk(chunk);
      }
    } while (bytes === this.buf.length); // buffer was full — more may remain
  }

  /**
   * Stop tailing: do one final drain to EOF, flush any partial multi-byte
   * remainder, and close the fd. Safe to call more than once. Synchronous so a
   * `close` handler can finalize the stream with no lost-tail race.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.poll(); // final read to EOF
    const tail = this.decoder.end();
    if (tail) this.onChunk(tail);
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* best-effort */
      }
      this.fd = null;
    }
  }
}
