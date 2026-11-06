# Ikon tray LAN DROP untuk Windows — tanpa Electron.
#
# Kenapa PowerShell: NotifyIcon adalah satu-satunya API tray di Windows tanpa
# dependency native, dan System.Windows.Forms sudah ada di OS. Paket npm apa pun
# untuk ini tetap berakhir di P/Invoke yang sama, cuma menambah modul yang harus
# di-trust. Ini juga alasan `systray` versi lama dihindari: binary Go-nya kena
# false-positive antivirus.
#
# Kontrak dengan Node (server/tray.js):
#   stdout  satu JSON per baris: {"type":"quit"} | {"type":"orphan"}
#   stdin   tidak dipakai — proses ini dimatikan lewat induknya (lihat ParentPid),
#           jadi tidak ada jalur yang butuh pipa perintah.
#
# Sengaja tidak ada jendela sama sekali: semua aksi lewat menu ikon.

param(
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][int]$ParentPid
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send-Event($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Open-Dashboard {
  try { Start-Process -FilePath $Url } catch { }
}

function Copy-Address {
  try { Set-Clipboard -Value $Url } catch { }
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-Object System.Drawing.Icon($IconPath)
$notify.Text = 'LAN DROP - jalan di background'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false

$status = New-Object System.Windows.Forms.ToolStripMenuItem("LAN DROP - $Url")
$status.Enabled = $false
$null = $menu.Items.Add($status)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$open = New-Object System.Windows.Forms.ToolStripMenuItem('Buka dashboard di browser')
$open.add_Click({ Open-Dashboard })
$null = $menu.Items.Add($open)

$copy = New-Object System.Windows.Forms.ToolStripMenuItem('Salin alamat dashboard')
$copy.add_Click({ Copy-Address })
$null = $menu.Items.Add($copy)

$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$quit = New-Object System.Windows.Forms.ToolStripMenuItem('Keluar')
$quit.add_Click({ $script:reason = 'quit' })
$null = $menu.Items.Add($quit)

$notify.ContextMenuStrip = $menu

# Klik kiri ikon = buka dashboard (kebiasaan app tray Windows).
$notify.add_MouseClick({ if ($_.Button -eq 'Left') { Open-Dashboard } })

$script:reason = ''
$ticks = 0

while ($script:reason -ne 'quit') {
  [System.Windows.Forms.Application]::DoEvents()

  # Induk mati (crash / dibunuh) = ikon ini tidak ada yang bisa melayani lagi.
  # Tanpa cek ini ikon jadi "hantu" di notification area sampai mouse lewat.
  $ticks++
  if ($ticks % 7 -eq 0) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      $script:reason = 'orphan'
      break
    }
  }

  Start-Sleep -Milliseconds 150
}

$notify.Visible = $false
$notify.Dispose()

if ($script:reason -eq '') { $script:reason = 'quit' }
Send-Event @{ type = $script:reason }
