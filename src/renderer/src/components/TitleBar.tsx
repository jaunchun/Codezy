import { useApp } from '../store/app'
import { CubeLogo, IconCode, IconMinus, IconSidebar, IconSquare, IconX } from './Icons'

/** Custom frameless title bar: logo + chat title + sidebar toggle + controls. */
export default function TitleBar({ title }: { title?: string }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const ideOpen = useApp((s) => s.ideOpen)
  const toggleIde = useApp((s) => s.toggleIde)

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
