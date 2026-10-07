/// <reference types="vite/client" />

import type { CodezyApi } from '../../shared/api'

declare global {
  interface Window {
    codezy: CodezyApi
  }
  /** build-time constant — package.json version injected by electron.vite.config */
  const __APP_VERSION__: string
}

export {}
