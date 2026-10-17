# Captures frames of the installer window (window rect only, PrintWindow so
# occluded windows still render). Usage:
#   powershell -File tests\.tmp\shoot-setup.ps1 <exe> <outdir>
param(
  [Parameter(Mandatory = $true)][string]$exe,
  [Parameter(Mandatory = $true)][string]$out
)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
New-Item -ItemType Directory -Force -Path $out | Out-Null
$p = Start-Process $exe -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 150
  $p.Refresh()
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO WINDOW'; exit 1 }
[Win32Cap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$n = 0
for ($i = 0; $i -lt 60; $i++) {
  if (-not [Win32Cap]::IsWindow($h)) { break }
  Start-Sleep -Milliseconds 250
  $r = New-Object Win32Cap+RECT
  [Win32Cap]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  if ($w -le 8 -or $ht -le 8) { continue }
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [Win32Cap]::PrintWindow($h, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $n++
  $file = Join-Path $out ("shot-{0:d2}.png" -f $n)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Output "frames=$n"
if (-not $p.HasExited) {
  if (-not $p.WaitForExit(40000)) { Write-Output 'STILL RUNNING - killing'; $p.Kill() }
}
Write-Output 'done'
