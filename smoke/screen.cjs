/**
 * One-off: what display geometry and scaling is the app running under?
 *
 *   electron smoke/screen.cjs
 */
const { app, screen, BrowserWindow } = require('electron')

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay()
  const all = screen.getAllDisplays()

  console.log('primary display:')
  console.log('  size (DIP):        ' + primary.size.width + 'x' + primary.size.height)
  console.log('  work area (DIP):   ' + primary.workAreaSize.width + 'x' + primary.workAreaSize.height)
  console.log('  scaleFactor:       ' + primary.scaleFactor)
  console.log('  physical pixels:   ' + Math.round(primary.size.width * primary.scaleFactor) +
    'x' + Math.round(primary.size.height * primary.scaleFactor))
  console.log('  bounds:            ' + JSON.stringify(primary.bounds))
  console.log('displays: ' + all.length)
  for (const d of all) {
    console.log(`  [${d.id}] ${d.size.width}x${d.size.height} @${d.scaleFactor}`)
  }

  const win = new BrowserWindow({ width: 1500, height: 950, show: true })
  await win.loadURL('data:text/html,<h1>probe</h1>')
  const info = await win.webContents.executeJavaScript(`(() => ({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
    zoom: window.outerWidth ? window.outerWidth : null
  }))()`)
  console.log('window viewport: ' + JSON.stringify(info))
  app.exit(0)
})
