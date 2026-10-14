import { useApp } from '../store/app'
import { CubeLogo, IconCode, IconDownload, IconMinus, IconSidebar, IconSquare, IconX } from './Icons'

/** Custom frameless title bar: logo + chat title + sidebar toggle + controls. */
export default function TitleBar({ title }: { title?: string }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const ideOpen = useApp((s) => s.ideOpen)
  const toggleIde = useApp((s) => s.toggleIde)
  // v2.6 — the quiet update pill: shown only when GitHub is strictly newer
  // AND the user didn't wave this exact version away.
  const updateInfo = useApp((s) => s.updateInfo)
  const updatePhase = useApp((s) => s.updatePhase)
  const updatePercent = useApp((s) => s.updatePercent)
  const updateDismissed = useApp((s) => s.updateDismissed)
  const downloadUpdate = useApp((s) => s.downloadUpdate)
  const applyUpdate = useApp((s) => s.applyUpdate)
  const dismissUpdate = useApp((s) => s.dismissUpdate)

  const release = updateInfo?.available ? updateInfo.release : null
  const showPill = !!release && release.version !== updateDismissed

  return (
    <div className="titlebar">
      <button
        className="tb-btn tip-below"
        data-tip={sidebarOpen ? 'Hide the sidebar — Ctrl+B' : 'Show the sidebar — Ctrl+B'}
        aria-label="Toggle sidebar"
        onClick={toggleSidebar}
      >
        <IconSidebar />
      </button>
      <button
        className={`tb-btn tip-below${ideOpen ? ' active' : ''}`}
        data-tip="Cowork — browse and edit this chat's files · Ctrl+E"
        aria-label="Toggle cowork editor"
        onClick={toggleIde}
      >
        <IconCode />
      </button>
      <div className="logo">
        <CubeLogo />
        CODEZY
      </div>
      <div className="tb-ver">v{__APP_VERSION__}</div>

      {showPill && release && (
        <div className="upd-pill" data-phase={updatePhase}>
          <button
            className="upd-main tip-below"
            data-tip={
              updatePhase === 'downloading'
                ? `Downloading CODEZY ${release.version}…`
                : updatePhase === 'ready'
                  ? `${release.name} is ready — click to restart and install`
                  : `CODEZY ${release.version} is out — click to download${
                      release.notes ? `\n${release.notes}` : ''
                    }`
            }
            aria-label={
              updatePhase === 'ready'
                ? 'Restart to install update'
                : updatePhase === 'downloading'
                  ? 'Update downloading'
                  : 'Download update'
            }
            onClick={() => {
              if (updatePhase === 'idle') void downloadUpdate()
              else if (updatePhase === 'ready') void applyUpdate()
            }}
          >
            {updatePhase === 'downloading' ? (
              <span className="upd-pct">{updatePercent >= 0 ? `${updatePercent}%` : '…'}</span>
            ) : (
              <>
                <IconDownload />
                <span className="upd-label">
                  {updatePhase === 'ready' ? 'restart to update' : `v${release.version}`}
                </span>
              </>
            )}
            <span className="upd-bar" style={{ width: `${Math.max(0, Math.min(100, updatePercent))}%` }} />
          </button>
          {(updatePhase === 'idle' || updatePhase === 'ready') && (
            <button
              className="upd-x"
              aria-label="Dismiss update"
              data-tip="Hide until the next version"
              onClick={dismissUpdate}
            >
              <IconX />
            </button>
          )}
        </div>
      )}

      <div className="tb-title">{title && title !== 'New chat' ? title : ''}</div>
      <div className="win-controls">
        <button className="tip-below" data-tip="Minimize" aria-label="Minimize" onClick={() => window.codezy.win.minimize()}>
          <IconMinus />
        </button>
        <button className="tip-below" data-tip="Maximize / restore" aria-label="Maximize" onClick={() => window.codezy.win.maximize()}>
          <IconSquare />
        </button>
        <button
          className="close tip-below"
          data-tip="Close to tray"
          aria-label="Close"
          onClick={() => window.codezy.win.close()}
        >
          <IconX />
        </button>
      </div>
    </div>
  )
}
