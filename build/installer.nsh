# CODEZY — dark, Chrome-setup-style window for the one-click installer.
#
# electron-builder prepends this file to the NSIS script (shared header), i.e.
# BEFORE MUI2 and the pages are declared, so we can attach a SHOW hook to the
# InstFiles ("Installing") page and rebuild it entirely: near-black backdrop,
# dark title bar, the 48px logo low-center, one centered status line and
# a thin Google-blue progress bar — the stock grey dialog never shows.
#
# Real-world structure (learned the hard way):
#  * The oneClick window is COMPACT (client ~377x78) — we resize it to a
#    fixed 450x228 client (frame delta MEASURED via GetWindowRect, never
#    assumed) and pin the page to fill it.
#  * The install section spawns SpiderBanner (icon + text via control 1000)
#    AFTER the page is shown — the only hook after it is customCheckAppRunning,
#    which *replaces* the default app-running check, so we re-insert their
#    exact default macros first and then hide the banner away. The page handle
#    is found ONCE at SHOW (page-first enumeration, same order the template
#    itself relies on) and reused, so the banner can never be mistaken for it.
#  * Structs (RECT, the DWM dark-mode BOOL) go through System::Alloc +
#    System::Call "*$R8(...)" — the pattern proven in getProcessInfo.nsh.
#  * Z-order inside the page: our backdrop bitmap goes HWND_BOTTOM (the
#    progress bar is a template child and must stay above it), the bar is
#    pushed HWND_TOP when repositioned.
#
# Purely cosmetic — install/uninstall logic untouched:
#  * /S silent mode never fires the SHOW hook and skips our UI in the section
#    hook: in-app updates byte-identical.
#  * The uninstaller build compiles none of this (!ifndef BUILD_UNINSTALLER).
#
# Assets: build/gen-installer-assets.mjs -> installer-bg.bmp, installer-logo.bmp
# Diagnostics: appends to %TEMP%\codezy-ui.log on every run.

!ifndef BUILD_UNINSTALLER

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW codezyInstallerShow
  !define CODEZY_W 450
  !define CODEZY_H 228

  Var codezyUiDone
  Var codezyUiBuilt
  Var codezyPage
  Var codezyBar
  Var codezyBg
  Var codezyLogo
  Var codezyText
  Var codezyFont
  Var codezyCancel

  # allowOnlyOneInstallerInstance.nsh only includes getProcessInfo.nsh and
  # declares $pid when customCheckAppRunning is NOT defined — since we define
  # it, provide them here (identical to the stock path we re-insert below).
  !include "getProcessInfo.nsh"
  Var pid

  !macro customInit
    InitPluginsDir
    SetOutPath $PLUGINSDIR
    File /oname=codezy-bg.bmp "${BUILD_RESOURCES_DIR}\installer-bg.bmp"
    File /oname=codezy-logo.bmp "${BUILD_RESOURCES_DIR}\installer-logo.bmp"
  !macroend

  # Append one line to %TEMP%\codezy-ui.log.
  # HANDLE and TXT must be different registers — the macro opens the file
  # into HANDLE while the message lives in TXT. NSIS strips the quotes from
  # macro arguments, so the body re-quotes TXT; the CRLF goes out as a second
  # FileWrite.
  !macro codezyLog HANDLE TXT
    FileOpen ${HANDLE} "$TEMP\codezy-ui.log" a
    FileSeek ${HANDLE} 0 END
    FileWrite ${HANDLE} "${TXT}"
    FileWrite ${HANDLE} "$\r$\n"
    FileClose ${HANDLE}
  !macroend

  # Runs from the install section right after SpiderBanner::Show created the
  # banner dialog and the template retitled it with $(installing). Defining
  # this macro REPLACES the default app-running check (CHECK_APP_RUNNING), so
  # the stock macros are re-inserted first — byte-identical default behaviour
  # — and then our UI is re-laid over the (now banner-free) window. Silent
  # mode never shows UI: everything cosmetic is skipped so /S stays untouched.
  !macro customCheckAppRunning
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
    ${IfNot} ${Silent}
      Call codezyHideMain
      Call codezyLayout
    ${EndIf}
  !macroend

  # Hide every main-window child except the page dialog (#32770). Runs twice:
  # at SHOW (banner not yet created — it survives and is caught by the second
  # call) and from customCheckAppRunning (banner + its layout already done).
  # The page is looked up only while unset: first #32770 child at SHOW time
  # is the page (the template's own banner lookup proves enumeration order),
  # and the pinned handle keeps later calls unambiguous.
  Function codezyHideMain
    StrCmp $codezyPage "" codezyFindPage
    StrCmp $codezyPage 0 codezyFindPage
    Goto codezyWalk

  codezyFindPage:
    System::Call 'user32::FindWindowExW(p $HWNDPARENT, p 0, t "#32770", p 0) p .r0'
    StrCpy $codezyPage $0

  codezyWalk:
    StrCmp $codezyPage 0 codezyHideDone
    StrCmp $codezyPage "" codezyHideDone
    System::Call 'user32::FindWindowExW(p $HWNDPARENT, p 0, p 0, p 0) p .r1'
    codezyHideLoop:
      StrCmp $1 0 codezyHideDone
      StrCmp $1 $codezyPage codezyHideNext
      System::Call 'user32::ShowWindow(p r1, i 0)'
    codezyHideNext:
      System::Call 'user32::FindWindowExW(p $HWNDPARENT, p r1, p 0, p 0) p .r1'
      Goto codezyHideLoop
  codezyHideDone:
  FunctionEnd

  # One full (idempotent) pass of our layout: compact window, dark chrome,
  # page children scanned + controls created on the FIRST call, then every
  # element repositioned (safe to run again after the banner refit).
  Function codezyLayout
    StrCmp $codezyPage 0 codezyLayoutDone
    StrCmp $codezyPage "" codezyLayoutDone

    # --- window: fixed 450x228 client (frame delta measured, not assumed) --
    System::Alloc 16
    Pop $R8
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p $R8)'
    System::Call '*$R8(i.r0,i.r1,i.r2,i.r3)'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p $R8)'
    System::Call '*$R8(i.r4,i.r5,i.r6,i.r7)'
    System::Free $R8
    IntOp $8 $2 - $0
    IntOp $9 $3 - $1
    IntOp $0 $6 - $4
    IntOp $1 $7 - $5
    IntOp $8 $8 - $0
    IntOp $9 $9 - $1
    IntOp $6 $8 + ${CODEZY_W}
    IntOp $7 $9 + ${CODEZY_H}
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r6, i r7, i 0x0016)'
    System::Call 'user32::SetWindowPos(p $codezyPage, p 0, i 0, i 0, i ${CODEZY_W}, i ${CODEZY_H}, i 0x0014)'

    # --- dark title bar: DWMWA_USE_IMMERSIVE_DARK_MODE (20; 19 fallback on
    # early Win10 builds — the second call is a harmless no-op elsewhere) ---
    System::Alloc 4
    Pop $R8
    System::Call '*$R8(i 1)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, p $R8, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, p $R8, i 4)'
    System::Free $R8

    # drop WS_MAXIMIZEBOX — the window has exactly one size
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r0'
    IntOp $0 $0 & 0xFFFEFFFF
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)'
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i 0, i 0, i 0x0037)'

    # --- first pass: scan the page children, create our own controls -------
    StrCmp $codezyUiBuilt 1 codezyPlace
    StrCpy $codezyUiBuilt 1

    # Page children: keep only the progress bar — status text, log, details
    # and cancel all go (we draw our own). Found by class; control ids differ
    # across NSIS builds.
    System::Call 'user32::FindWindowExW(p $codezyPage, p 0, p 0, p 0) p .r8'
    codezyScanLoop:
      StrCmp $8 0 codezyScanDone
      System::Call 'user32::GetClassNameW(p r8, t .r9, i 64)'
      StrCmp $9 "msctls_progress32" codezyKeepBar
      System::Call 'user32::ShowWindow(p r8, i 0)'
      Goto codezyScanNext
    codezyKeepBar:
      StrCpy $codezyBar $8
    codezyScanNext:
      System::Call 'user32::FindWindowExW(p $codezyPage, p r8, p 0, p 0) p .r8'
      Goto codezyScanLoop
    codezyScanDone:
      StrCmp $codezyBar 0 0 codezyBarLogOk
      !insertmacro codezyLog $0 "NO PROGRESS BAR FOUND"
    codezyBarLogOk:
    System::Call 'user32::IsWindowVisible(p $codezyPage) i .r1'
    !insertmacro codezyLog $0 "P1 pagevis=$1"
    System::Alloc 16
    Pop $R8
    System::Call 'user32::GetWindowRect(p $codezyPage, p $R8)'
    System::Call '*$R8(i.r1,i.r2,i.r3,i.r4)'
    System::Free $R8
    !insertmacro codezyLog $0 "P1 pagerect=$1,$2,$3,$4"
    System::Call 'user32::GetClassNameW(p $codezyPage, t .r1, i 64)'
    !insertmacro codezyLog $0 "P1 pagecls=$1"

    # Dark class brush insurance: every #32770 dialog repaints dark instead
    # of the stock dialog face while controls move (one brush per run).
    System::Call 'gdi32::CreateSolidBrush(i 0x00221F1E) p .r8'
    # 32-bit NSIS: user32 exports SetClassLongW, not SetClassLongPtrW (x64-only name)
    System::Call 'user32::SetClassLongW(p $codezyPage, i -10, i r8) i .r3'
    StrCpy $1 $3
    !insertmacro codezyLog $0 "P1 brushret=$1"

    # Backdrop bitmap — created at the fixed client size, then pushed to
    # HWND_BOTTOM so the template's progress bar stays visible above it.
    System::Call 'user32::CreateWindowExW(i 0, t "Static", t "", i 0x5000000E, i 0, i 0, i ${CODEZY_W}, i ${CODEZY_H}, p $codezyPage, p 0, p 0, p 0) p .r8'
    StrCpy $codezyBg $8
    System::Call 'user32::LoadImageW(p 0, t "$PLUGINSDIR\codezy-bg.bmp", i 0, i 0, i 0, i 0x10) p .r9'
    System::Call 'user32::SendMessageW(p $codezyBg, i 0x0172, i 0, p r9)'
    System::Call 'user32::SetWindowPos(p $codezyBg, p 1, i 0, i 0, i 0, i 0, i 0x0013)'
    StrCpy $1 $codezyBg
    !insertmacro codezyLog $0 "P1 bg=$1"
    StrCpy $1 $9
    !insertmacro codezyLog $0 "P1 bgimg=$1"

    # 48px logo tile
    System::Call 'user32::CreateWindowExW(i 0, t "Static", t "", i 0x5000000E, i 0, i 0, i 48, i 48, p $codezyPage, p 0, p 0, p 0) p .r8'
    StrCpy $codezyLogo $8
    System::Call 'user32::LoadImageW(p 0, t "$PLUGINSDIR\codezy-logo.bmp", i 0, i 0, i 0, i 0x10) p .r9'
    System::Call 'user32::SendMessageW(p $codezyLogo, i 0x0172, i 0, p r9)'
    StrCpy $1 $codezyLogo
    !insertmacro codezyLog $0 "P1 logo=$1"
    StrCpy $1 $9
    !insertmacro codezyLog $0 "P1 logoimg=$1"

    # Status line: our own centered Static ("Installing CODEZY") — Segoe UI
    # 13px regular, quiet light grey, vertically centered.
    System::Call 'user32::CreateWindowExW(i 0, t "Static", t "Installing ${PRODUCT_NAME}", i 0x50000201, i 24, i 100, i 402, i 20, p $codezyPage, p 0, p 0, p 0) p .r8'
    StrCpy $codezyText $8
    System::Call 'user32::CreateFontW(i -13, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Segoe UI") p .r9'
    StrCpy $codezyFont $9
    System::Call 'user32::SendMessageW(p $codezyText, i 0x0030, p r9, i 1)'
    # SetCtlColors order is (text, bg) — E8EAED is the text, bg transparent
    # so the dark backdrop bitmap shows through.
    SetCtlColors $codezyText "E8EAED" "transparent"
    StrCpy $1 $codezyText
    !insertmacro codezyLog $0 "P1 text=$1"

    # Cancel button — Chrome-style plain text button, bottom-right. A Static
    # with SS_NOTIFY, not a real Button: Windows always paints its own face on
    # buttons (SetCtlColors can't restyle them), which rendered a white classic
    # button on the dark backdrop. SS_NOTIFY makes it click-reports like a
    # button; control ID IDCANCEL (2) → NSIS's own abort-confirmation flow.
    System::Call 'user32::CreateWindowExW(i 0, t "Static", t "Cancel", i 0x50010101, i 338, i 180, i 88, i 24, p $codezyPage, p 2, p 0, p 0) p .r8'
    StrCpy $codezyCancel $8
    System::Call 'user32::CreateFontW(i -14, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, t "Segoe UI") p .r9'
    System::Call 'user32::SendMessageW(p $codezyCancel, i 0x0030, p r9, i 1)'
    SetCtlColors $codezyCancel "9AA0A6" "transparent"
    StrCpy $1 $codezyCancel
    !insertmacro codezyLog $0 "P1 cancel=$1"
    !insertmacro codezyLog $0 "page built: bar=$codezyBar"

    # --- placement (idempotent — re-run after the banner refit) ------------
    codezyPlace:
    System::Call 'user32::SetWindowPos(p $codezyBg, p 0, i 0, i 0, i ${CODEZY_W}, i ${CODEZY_H}, i 0x0014)'

    # logo: centered horizontally, 40px, top margin 40 — Chrome-setup puts
    # the mark top-center with the status text under it.
    IntOp $9 ${CODEZY_W} / 2
    IntOp $9 $9 - 20
    System::Call 'user32::SetWindowPos(p $codezyLogo, p 0, i r9, i 40, i 40, i 40, i 0x0014)'

    # status line under the logo, centered, quiet
    System::Call 'user32::SetWindowPos(p $codezyText, p 0, i 24, i 100, i 402, i 20, i 0x0014)'

    # hairline bar under the text, 88% wide, centered
    IntOp $7 ${CODEZY_W} * 88
    IntOp $7 $7 / 100
    IntOp $8 ${CODEZY_W} - $7
    IntOp $8 $8 / 2
    IntOp $6 100 + 34

    # cancel: bottom-right corner, small quiet text button
    StrCmp $codezyCancel 0 codezyCancelDone
    StrCmp $codezyCancel "" codezyCancelDone
    IntOp $5 ${CODEZY_W} - 112
    IntOp $9 ${CODEZY_H} - 48
    System::Call 'user32::SetWindowPos(p $codezyCancel, p 0, i r5, i r9, i 0, i 0, i 0x0015)'
  codezyCancelDone:

    # Progress bar: untheme first (visual styles removed) so the classic
    # color messages take; colors are COLORREF 0xBBGGRR —
    # track CCM_SETBKCOLOR (0x2001) quiet dark grey, fill PBM_SETBARCOLOR
    # (0x409) Google blue. Kept to a 3px hairline.
    StrCmp $codezyBar 0 codezyPlaceDone
    System::Call 'uxtheme::SetWindowTheme(p $codezyBar, t "", t "")'
    System::Call 'user32::SetWindowPos(p $codezyBar, p 0, i r8, i r6, i r7, i 3, i 0x0014)'
    System::Call 'user32::SendMessageW(p $codezyBar, i 0x2001, i 0, i 0x003C4043)'
    System::Call 'user32::SendMessageW(p $codezyBar, i 0x0409, i 0, i 0x00F8B48A)'
  codezyPlaceDone:

    # per-run identity probe: which window is which, and is anything visible
    # NOTE: System::Call rN registers == NSIS $N (NOT $RN) — read back $1..$5
    System::Call 'user32::IsWindowVisible(p $codezyPage) i .r1'
    System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i .r2'
    System::Call 'user32::GetParent(p $codezyPage) p .r3'
    System::Call 'user32::GetWindowLongW(p $codezyPage, i -16) i .r4'
    System::Call 'user32::IsWindowVisible(p $codezyBar) i .r5'
    StrCpy $6 $HWNDPARENT
    StrCpy $7 $codezyPage
    StrCpy $8 $codezyBar
    !insertmacro codezyLog $0 "P2 pagevis=$1 mainvis=$2 pageparent=$3 pagestyle=$4 barvis=$5 | HwndParent=$6 page=$7 bar=$8"
    # inventory: children of $HWNDPARENT, then children of $codezyPage
    System::Call 'user32::FindWindowExW(p $HWNDPARENT, p 0, p 0, p 0) p .r1'
    codezyInvMain:
      StrCmp $1 0 codezyInvMainDone
      System::Call 'user32::GetClassNameW(p r1, t .r2, i 64)'
      System::Call 'user32::IsWindowVisible(p r1) i .r3'
      StrCpy $4 "MAIN kid cls=$2 vis=$3 hwnd=$1"
      !insertmacro codezyLog $0 "$4"
      System::Call 'user32::FindWindowExW(p $HWNDPARENT, p r1, p 0, p 0) p .r1'
      Goto codezyInvMain
    codezyInvMainDone:
      System::Call 'user32::FindWindowExW(p $codezyPage, p 0, p 0, p 0) p .r1'
    codezyInvPage:
      StrCmp $1 0 codezyInvPageDone
      System::Call 'user32::GetClassNameW(p r1, t .r2, i 64)'
      System::Call 'user32::IsWindowVisible(p r1) i .r3'
      StrCpy $4 "PAGE kid cls=$2 vis=$3 hwnd=$1"
      !insertmacro codezyLog $0 "$4"
      System::Call 'user32::FindWindowExW(p $codezyPage, p r1, p 0, p 0) p .r1'
      Goto codezyInvPage
    codezyInvPageDone:

    # Title bar text (the stock instfiles caption is blank).
    SendMessage $HWNDPARENT 0x000C 0 "STR:${PRODUCT_NAME} Setup"

    # The instfiles page child carries no WS_VISIBLE in the oneClick flow
    # (pagestyle 0x4000004C) — without this explicit show, every control we
    # build on it (and the stock progress bar) stays invisible and only the
    # main window's flat #F0F0F0 face shows. SW_SHOWNOACTIVATE: reveal the
    # page without stealing focus from the install thread.
    System::Call 'user32::ShowWindow(p $codezyPage, i 4)'
    System::Call 'user32::InvalidateRect(p $codezyPage, p 0, i 1)'

  codezyLayoutDone:
  FunctionEnd

  Function codezyInstallerShow
    StrCmp $codezyUiDone 1 codezyDone
    StrCpy $codezyUiDone 1

    !insertmacro codezyLog $0 "=== SHOW ==="
    Call codezyHideMain
    StrCmp $codezyPage 0 codezyNoPage
    Call codezyLayout
    !insertmacro codezyLog $0 "show done"
    Goto codezyDone
  codezyNoPage:
    !insertmacro codezyLog $0 "NO PAGE DIALOG FOUND"

  codezyDone:
  FunctionEnd

!endif
