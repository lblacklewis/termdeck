/**
 * Zip the unpacked Windows build for a portable download.
 *
 *   npm run pack:zip
 *
 * `electron-builder --win --dir` produces `release/win-unpacked/`, which runs by
 * launching `TermDeck.exe` with no installation. Zipping it gives one file to
 * attach to a GitHub release. Node's zlib is used rather than a dependency, and
 * the archive stores forward-slash paths with the executable bit set for Unix
 * tools that unpack it elsewhere.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'release', 'win-unpacked')
const OUT_DIR = path.join(ROOT, 'release')

if (!fs.existsSync(SRC)) {
  console.error(`No unpacked build at ${SRC}\nRun: npm run pack:win`)
  process.exit(1)
}

// ---- CRC32, needed by the zip format -------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, acc)
    else if (entry.isFile()) acc.push(path.relative(base, full))
  }
  return acc
}

/** MS-DOS date/time, as the zip header expects. */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function main() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const out = path.join(OUT_DIR, `TermDeck-${version}-win-x64-portable.zip`)

  const files = walk(SRC)
  console.log(`zipping ${files.length} files from win-unpacked …`)

  const chunks = []
  const central = []
  let offset = 0

  for (const rel of files) {
    const full = path.join(SRC, rel)
    const data = fs.readFileSync(full)
    const name = rel.split(path.sep).join('/')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const { time, day } = dosDateTime(fs.statSync(full).mtime)

    // Local file header: deflate is used, with the size written into both the
    // local and central records (no data descriptor needed).
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const payload = useDeflate ? deflated : data

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(day, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    // 0o755 << 16 marks it executable for Unix unzip.
    cd.writeUInt32LE(0o755 << 16, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  fs.writeFileSync(out, Buffer.concat([...chunks, centralBuf, end]))

  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1)
  console.log(`\nwrote ${out} (${mb} MB)`)
  console.log('Unzip it and run TermDeck.exe — no installation needed.')
}

main()
