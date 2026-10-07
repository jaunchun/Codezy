import { useEffect } from 'react'
import { useApp } from './store/app'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import Composer from './components/Composer'
import SettingsModal from './components/SettingsModal'
import SetupScreen from './components/SetupScreen'
import ToastStack from './components/ToastStack'
import Palette from './components/Palette'
import ApproveModal from './components/ApproveModal'
import Shortcuts from './components/Shortcuts'
import IdePane from './components/IdePane'
import BootSplash from './components/BootSplash'

export default function App() {
  const ready = useApp((s) => s.ready)
  const settings = useApp((s) => s.settings)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const ideOpen = useApp((s) => s.ideOpen)
  const session = useApp((s) => s.sessions.find((x) => x.id === s.activeId))
  // first-run setup: shows until the user finishes (or skips) it once
  const setupOpen = !!ready && !!settings && settings.setupDone !== true

  // boot: load settings/sessions/models and subscribe to streaming events
  useEffect(() => {
    void useApp.getState().init()
  }, [])

  // base font size from settings
  useEffect(() => {
    if (settings) document.body.style.fontSize = `${settings.fontSize}px`
  }, [settings?.fontSize])

  // global shortcuts: Ctrl+N new chat, Ctrl+, settings, Ctrl+U usage,
  // Ctrl+K palette, Ctrl+B focus mode, Ctrl+/ cheat sheet
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        void useApp.getState().newChat()
      }
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        useApp.getState().setSettingsOpen(true)
      }
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault()
        useApp.getState().setUsageOpen(true)
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useApp.getState().setPaletteOpen(!useApp.getState().paletteOpen)
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useApp.getState().toggleSidebar()
      }
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault()
        useApp.getState().toggleShortcuts()
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        useApp.getState().toggleIde()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) return <BootSplash ready={false} /> // logo pops in while init runs

  return (
    <>
      <BootSplash ready />
      <div className={`app${setupOpen ? ' setup' : ''}`}>
        <TitleBar title={session?.title} />
        <div className={`app-body${sidebarOpen ? '' : ' focus'}${ideOpen ? ' code' : ''}`}>
          <Sidebar />
          <main className="main-pane">
            <ChatView />
            <Composer />
          </main>
          <IdePane />
        </div>
        <SettingsModal />
        {setupOpen && <SetupScreen />}
        <ApproveModal />
        <Palette />
        <Shortcuts />
        <ToastStack />
      </div>
    </>
  )
}
