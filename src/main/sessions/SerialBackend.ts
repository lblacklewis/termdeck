import { EventEmitter } from 'node:events'
import { SessionBackend } from './SessionManager'

export interface SerialOptions {
  /** Device path: `COM3` on Windows, `/dev/ttyUSB0` elsewhere. */
  path: string
  baudRate?: number
  dataBits?: 5 | 6 | 7 | 8
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits?: 1 | 2
}

/**
 * The slice of `serialport` this needs.
 *
 * Declared structurally rather than imported so a build without the optional
 * native module still type-checks — the same reason `LocalShellBackend` declares
 * its own pty surface.
 */
interface SerialPortInstance {
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: () => void): void
  write(data: string | Buffer, cb?: (err?: Error | null) => void): void
  close(cb?: (err?: Error | null) => void): void
  isOpen: boolean
}

interface SerialPortModule {
  SerialPort: new (opts: Record<string, unknown>) => SerialPortInstance
}

let serialModule: SerialPortModule | null | undefined

function loadSerial(): SerialPortModule | null {
  if (serialModule !== undefined) return serialModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    serialModule = require('serialport') as SerialPortModule
  } catch {
    serialModule = null
  }
  return serialModule
}

/** Whether this build can open a serial port at all. */
export function isSerialAvailable(): boolean {
  return loadSerial() !== null
}

/**
 * A serial console, as a session backend.
 *
 * Serial is how network gear and embedded boards are reached: no login, no SSH,
 * just bytes at a fixed line speed. `serialport` does the platform work
 * (overlapped I/O on Windows), so it is an optional dependency loaded lazily —
 * without it the app still runs and the connect dialog says what is missing,
 * exactly like local shells and node-pty.
 *
 * Resize has no meaning on a serial line; `rows`/`cols` are kept only so the
 * terminal can be sized on screen, and the far end is told nothing.
 */
export class SerialBackend extends EventEmitter implements SessionBackend {
  private readonly port: SerialPortInstance
  private closed = false
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })

  constructor(opts: SerialOptions) {
    super()

    const mod = loadSerial()
    if (!mod) {
      throw new Error(
        'Serial is unavailable in this build: the optional `serialport` module is missing. ' +
          'SSH, telnet and local shells are unaffected.'
      )
    }

    this.port = new mod.SerialPort({
      path: opts.path,
      baudRate: opts.baudRate ?? 115200,
      dataBits: opts.dataBits ?? 8,
      parity: opts.parity ?? 'none',
      stopBits: opts.stopBits ?? 1,
      autoOpen: false
    })

    this.port.on('data', (chunk: Buffer) => {
      const text = this.decoder.decode(chunk, { stream: true })
      if (text) this.emit('data', text.replace(/(?<!\r)\n/g, '\r\n'))
    })
    this.port.on('error', (err: Error) => {
      if (this.closed) return
      this.emit('error', err)
      this.emit('exit', null, null)
    })
    this.port.on('close', () => {
      if (this.closed) return
      this.closed = true
      this.emit('exit', 0, null)
    })

    // `autoOpen: false` means the port is opened here, so a missing device or a
    // port already held by another program arrives as one error instead of an
    // event nobody is listening to yet.
    try {
      const opened = this.port as unknown as { open(cb: (err?: Error | null) => void): void }
      opened.open((err) => {
        if (err) {
          this.emit('error', err)
          this.emit('exit', null, null)
        }
      })
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      this.emit('exit', null, null)
    }
  }

  write(data: string): void {
    if (this.closed || !this.port.isOpen) return
    // Serial terminals expect CRLF for Enter, exactly like telnet.
    this.port.write(data.replace(/\r(?!\n)/g, '\r\n'))
  }

  /** Nothing to tell the far end about a window size. */
  resize(): void {}

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.port.close()
    } catch {
      // Already gone: a device unplugged mid-session lands here.
    }
  }
}
