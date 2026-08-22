// Generate build/icon.ico from the app's own logo mark.
//
// electron-builder was shipping the default Electron icon, so the installer,
// the taskbar and Alt-Tab all showed someone else's logo. Rather than commit a
// binary nobody can edit, the icon is RENDERED from the same gradient and
// glyph the app draws in its header — change the CSS below and re-run.
//
//   node scripts/make-icon.cjs
//
// Windows .ico supports PNG-compressed entries (Vista+), so the file is just
// a small header plus one PNG per size. No image library needed.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const OUT_DIR = join(__dirname, '..', 'build')

const page = (size) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; }
  .mark {
    width: ${size}px; height: ${size}px;
    border-radius: ${Math.round(size * 0.22)}px;
    background: linear-gradient(135deg, #7aa2f7, #bb9af7);
    color: #0e1016;
    font-family: Segoe UI, system-ui, sans-serif;
    font-weight: 800;
    font-size: ${Math.round(size * 0.6)}px;
    line-height: 1;
    display: grid; place-items: center;
  }
  /* Optical centering: the cap-height glyph sits low in its line box. */
  .mark span { transform: translateY(${-size * 0.03}px); }
</style><div class="mark"><span>A</span></div>`

/** ICONDIR + ICONDIRENTRY per image, then the PNG payloads. */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = []
  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

app.disableHardwareAcceleration() // deterministic rasterisation across machines

app.whenReady().then(async () => {
  // Rendered ONCE at the largest size and downscaled for the rest. Windows
  // refuses to lay out very small frameless windows reliably (a 24px one fails
  // to load at all), and a flaky icon build is worse than a slightly softer
  // 16px entry.
  const BASE = 256
  const win = new BrowserWindow({
    width: BASE,
    height: BASE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { sandbox: true }
  })
  const html = join(tmpdir(), 'asit-icon.html')
  writeFileSync(html, page(BASE), 'utf-8')
  await win.loadFile(html)
  await new Promise((r) => setTimeout(r, 250))

  const shot = await win.webContents.capturePage()
  // capturePage returns DEVICE pixels, so on a scaled display a 256px window
  // comes back larger. Normalise, or every .ico entry lies about its size.
  const base = shot.getSize().width === BASE ? shot : shot.resize({ width: BASE, height: BASE })
  win.destroy()

  const images = SIZES.map((size) => ({
    size,
    png: (size === BASE ? base : base.resize({ width: size, height: size, quality: 'best' })).toPNG()
  }))

  mkdirSync(OUT_DIR, { recursive: true })
  const ico = join(OUT_DIR, 'icon.ico')
  writeFileSync(ico, buildIco(images))
  writeFileSync(join(OUT_DIR, 'icon.png'), base.toPNG())
  console.log(`wrote ${ico} (${SIZES.join(', ')}px) and icon.png`)
  app.exit(0)
})
