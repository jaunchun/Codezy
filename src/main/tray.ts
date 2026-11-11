// ---------------------------------------------------------------------------
// tray.ts — the tray icon behind "minimize to tray" (Settings → behavior).
//
// One 16×16 monochrome disc, embedded as a base64 PNG so the tray needs NO
// shipped asset file (build/ is not part of the installer's files). The
// tray only exists while the setting is on: syncTray(true) creates it on
// launch or when the toggle flips, syncTray(false) destroys it. Left-click
// shows/hides the window; the menu offers Open / Open data folder / Quit —
// on macOS the menu is the only surface (click events don't reach us there),
// which is also why the context menu is always attached.
// ---------------------------------------------------------------------------

import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron'

/** 16×16 RGBA white feathered disc on transparent — generated, 170 bytes. */
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAcUlEQVR42q2T2w3AIAhF/ekeDOIiz' +
  'OUmTuYGp2lCU/uwteJN+CFwEi4QgNAIAaKFtOqekgpkoHCoWE7fAAuQ+Fay2hugp7mGnADKf2kNy' +
  'AOAvAPkYlivth4JtqZRxSkA9whuE6es0X1IU07Z/UxD77wCq3+gBiKmHQQAAAAASUVORK5CYII='

let tray: Tray | null = null

export type TrayActions = {
  getWindow: () => BrowserWindow | null
  showWindow: () => void
  openDataFolder: () => void
}

/** Create-or-destroy the tray icon so it matches the setting. Safe to call
 *  on every settings change; the actions are re-read on each rebuild so the
 *  tray always talks to the CURRENT window. */
export function syncTray(enabled: boolean, actions: TrayActions): void {
  if (enabled && !tray) {
    tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`))
    tray.setToolTip('CODEZY')
    // left-click toggles the window (macOS delivers the menu instead — fine)
    tray.on('click', () => {
      const w = actions.getWindow()
      if (!w) return
      if (w.isVisible()) w.hide()
      else {
        w.show()
        w.focus()
      }
    })
  } else if (!enabled && tray) {
    tray.destroy()
    tray = null
  }
  if (tray) {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open CODEZY', click: () => actions.showWindow() },
        { label: 'Open data folder', click: () => actions.openDataFolder() },
        { type: 'separator' },
        { label: 'Quit CODEZY', click: () => app.quit() }
      ])
    )
  }
}

/** Whether a tray icon currently exists (tests + quit paths). */
export function trayVisible(): boolean {
  return tray !== null
}

/** One-shot Windows balloon off the tray icon (a no-op elsewhere — the
 *  hint is only useful where the icon is actually visible in the tray). */
export function trayBalloon(title: string, content: string): void {
  if (!tray || process.platform !== 'win32') return
  try {
    tray.displayBalloon({ title, content, iconType: 'none' })
  } catch {
    /* balloons are best effort */
  }
}
