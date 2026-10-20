import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { SessionBackend } from './SessionManager'

export interface TelnetOptions {
  host: string
  port?: number
}

/** Telnet control bytes (RFC 854). */
const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

/** The only options this client agrees to. */
const OPT_ECHO = 1
const OPT_SUPPRESS_GO_AHEAD = 3
const OPT_TERMINAL_TYPE = 24
const OPT_NAWS = 31

/** Where the option parser is: in the data, or inside an IAC sequence. */
type ParseState = 'data' | 'iac' | 'negotiate' | 'sub' | 'sub-iac'

/**
 * A telnet connection, as a session backend.
 *
 * Plain `node:net` plus the small amount of RFC 854 that an interactive
 * terminal actually needs: answer window size, say what terminal this is, and
 * refuse everything else. The parser is a byte-level state machine because the
 * negotiation bytes are interleaved with the output and several of them are
 * longer than one byte — a `replace()` over the chunk would corrupt any binary
 * data that happens to contain 0xFF.
 *
 * What the server sends is decoded as streaming UTF-8, so a multi-byte
 * character split across two TCP segments survives. Line endings are normalised
 * to `\r\n`: the RFC says telnet sends CRLF, and plenty of devices send bare LF,
 * which a terminal renders as "down one line, same column".
 */
export class TelnetBackend extends EventEmitter implements SessionBackend {
  private readonly socket: Socket
  private state: ParseState = 'data'
  /** Bytes of the chunk being parsed; cleared once it is decoded and emitted. */
  private data: number[] = []
  private closed = false
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private cols: number
  private rows: number
  /**
   * Set once the server has asked for it, so a resize knows whether it is worth
   * sending. Sending NAWS to a server that never asked is harmless but noisy.
   */
  private nawsAgreed = false

  constructor(opts: TelnetOptions, cols: number, rows: number) {
    super()
    this.cols = cols
    this.rows = rows

    this.socket = createConnection({ host: opts.host, port: opts.port ?? 23 })
    this.socket.setNoDelay(true)
    this.socket.on('data', (chunk: Buffer) => this.feed(chunk))
    this.socket.on('error', (err: Error) => {
      // A refused or unreachable connection never reaches 'close' with a reason,
      // and the pane has to say something: without this the tab sits empty.
      // `closed` also stops the 'close' that follows from reporting the exit
      // twice — the renderer drops the session either way, but a duplicate exit
      // makes the connections window flicker.
      if (this.closed) return
      this.closed = true
      this.emit('error', err)
      this.emit('exit', null, null)
    })
    this.socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      this.emit('exit', 0, null)
    })
  }

  write(data: string): void {
    if (this.closed) return
    // Telnet expects CRLF; a terminal sends bare CR for Enter.
    this.socket.write(data.replace(/\r(?!\n)/g, '\r\n'))
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    if (this.nawsAgreed) this.sendNaws()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
  }

  // ---- negotiation --------------------------------------------------------

  private send(...bytes: number[]): void {
    if (this.closed) return
    this.socket.write(Buffer.from(bytes))
  }

  private sendNaws(): void {
    // Two 16-bit values, big endian, with 0xFF doubled: inside a subnegotiation
    // a bare 0xFF would be read as IAC and swallow the rest of the sequence.
    const pair = (n: number): number[] => {
      const v = Math.max(0, Math.min(65535, Math.round(n)))
      const out: number[] = []
      for (const b of [Math.floor(v / 256), v % 256]) {
        out.push(b)
        if (b === IAC) out.push(IAC)
      }
      return out
    }
    this.send(IAC, SB, OPT_NAWS, ...pair(this.cols), ...pair(this.rows), IAC, SE)
  }

  /** Answer one `IAC WILL/WONT/DO/DONT <option>`. */
  private negotiate(command: number, option: number): void {
    if (command === DO) {
      if (option === OPT_NAWS) {
        this.nawsAgreed = true
        this.send(IAC, WILL, option)
        this.sendNaws()
        return
      }
      if (option === OPT_TERMINAL_TYPE) {
        this.send(IAC, WILL, option)
        return
      }
      if (option === OPT_SUPPRESS_GO_AHEAD) {
        this.send(IAC, WILL, option)
        return
      }
      // Everything else (including binary mode): refuse, but keep talking. A
      // client that goes silent on an unknown option hangs the session.
      this.send(IAC, WONT, option)
      return
    }
    if (command === WILL) {
      if (option === OPT_ECHO || option === OPT_SUPPRESS_GO_AHEAD) {
        this.send(IAC, DO, option)
        return
      }
      this.send(IAC, DONT, option)
      return
    }
    // WONT / DONT: the server is telling us what it will not do. Nothing to answer.
  }

  private feed(chunk: Buffer): void {
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) this.state = 'iac'
          else this.data.push(byte)
          break
        case 'iac':
          if (byte === IAC) {
            this.data.push(IAC)
            this.state = 'data'
          } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
            this.state = 'negotiate'
            this.pending = byte
          } else if (byte === SB) {
            this.state = 'sub'
          } else {
            // A two-byte command (NOP, GA, ...): nothing to do with it.
            this.state = 'data'
          }
          break
        case 'negotiate':
          this.negotiate(this.pending, byte)
          this.state = 'data'
          break
        case 'sub':
          if (byte === IAC) this.state = 'sub-iac'
          break
        case 'sub-iac':
          if (byte === SE) this.state = 'data'
          else if (byte === IAC) {
            // Doubled 0xFF inside the subnegotiation payload.
          } else this.state = 'sub'
          break
      }
    }
    this.flush()
  }

  /** One byte held between `IAC <cmd>` and its option number. */
  private pending = 0

  private flush(): void {
    if (this.data.length === 0) return
    const text = this.decoder.decode(Uint8Array.from(this.data), { stream: true })
    this.data = []
    if (!text) return
    this.emit('data', text.replace(/(?<!\r)\n/g, '\r\n'))
  }
}
