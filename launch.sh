#!/usr/bin/env bash
# CODEZY dev launcher for macOS/Linux — twin of launch.bat (npm run dev).
# Starts the electron-vite app: renderer + main + preload, live reload.
cd "$(dirname "$0")" || exit 1
npm run dev
code=$?
if [ "$code" -ne 0 ]; then
  echo "npm run dev exited with code $code"
  read -r -p "Press Enter to close"
fi
exit "$code"
