# Finds Kindles through the Windows Shell and copies system\vocabulary\vocab.db.
#
# Newer Kindles connect over MTP and are bound to Windows' own portable-device
# driver, so they never get a drive letter; the Shell namespace ("This PC") is
# the supported way to browse them. Older Kindles mount as a USB drive.
#
# Invoked with -EncodedCommand (not subject to the execution policy). Input comes
# from environment variables, output is a single line: KTA_JSON:{...}
#   KTA_MODE=scan                          list Kindles (MTP devices and drives)
#   KTA_MODE=copy KTA_DEVICE_ID=<shell path> KTA_STORAGE=<name> KTA_DEST=<dir>

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$SHCONTF_ALL = 0x20 -bor 0x40 -bor 0x80   # folders + non-folders + hidden items
$SSF_DRIVES = 17                           # "This PC"
$KINDLE_VID = 'vid_1949'                   # Lab126 / Amazon

function Write-Result($obj) {
  [Console]::Out.WriteLine('KTA_JSON:' + ($obj | ConvertTo-Json -Depth 8 -Compress))
}

function Get-Children($item) {
  $items = $item.GetFolder.Items()
  try { $items.Filter($SHCONTF_ALL, '*') } catch { }
  $list = @()
  foreach ($c in $items) { $list += $c }
  return ,$list
}

function Find-Child($item, [string]$name) {
  try {
    $hit = $item.GetFolder.ParseName($name)
    if ($null -ne $hit) { return $hit }
  } catch { }
  foreach ($c in (Get-Children $item)) {
    if ([string]::Equals([string]$c.Name, $name, [StringComparison]::OrdinalIgnoreCase)) { return $c }
  }
  return $null
}

function Get-ItemSize($item) {
  # FolderItem.Size is 0 for portable-device items; System.Size has the real value.
  try {
    $v = $item.ExtendedProperty('System.Size')
    if ($null -ne $v) { return [int64]$v }
  } catch { }
  try { return [int64]$item.Size } catch { return [int64]0 }
}

function Test-KindleDevice($item) {
  $path = [string]$item.Path
  if ($path -match $KINDLE_VID) { return $true }
  return ($path -match 'usb#vid_' -and [string]$item.Name -match 'kindle')
}

function Find-VocabFile($storage) {
  $sys = Find-Child $storage 'system'
  if ($null -eq $sys) { return @{ file = $null; missing = 'system' } }
  $voc = Find-Child $sys 'vocabulary'
  if ($null -eq $voc) { return @{ file = $null; missing = 'system/vocabulary' } }
  $db = Find-Child $voc 'vocab.db'
  if ($null -eq $db) { return @{ file = $null; missing = 'system/vocabulary/vocab.db' } }
  return @{ file = $db; missing = $null }
}

function Get-PortableKindles($shell) {
  $result = @()
  foreach ($it in $shell.NameSpace($SSF_DRIVES).Items()) {
    if (-not (Test-KindleDevice $it)) { continue }
    $dev = [ordered]@{ name = [string]$it.Name; id = [string]$it.Path; storages = @(); error = $null }
    try {
      foreach ($st in (Get-Children $it)) {
        $s = [ordered]@{ name = [string]$st.Name; vocabSize = $null; missing = $null; error = $null }
        try {
          $hit = Find-VocabFile $st
          if ($null -ne $hit.file) { $s.vocabSize = Get-ItemSize $hit.file } else { $s.missing = $hit.missing }
        } catch { $s.error = $_.Exception.Message }
        $dev.storages += $s
      }
    } catch { $dev.error = $_.Exception.Message }
    $result += $dev
  }
  return ,$result
}

function Get-KindleDrives {
  $result = @()
  $systemRoot = [IO.Path]::GetPathRoot($env:SystemRoot)
  foreach ($d in [IO.DriveInfo]::GetDrives()) {
    try {
      # Never touch network or optical drives: a disconnected share can hang for ages.
      if ($d.DriveType -ne [IO.DriveType]::Removable -and $d.DriveType -ne [IO.DriveType]::Fixed) { continue }
      if ($d.Name -ieq $systemRoot -or -not $d.IsReady) { continue }
      $vocab = Join-Path $d.Name 'system\vocabulary\vocab.db'
      $hasVocab = Test-Path -LiteralPath $vocab
      if (-not $hasVocab -and $d.VolumeLabel -notmatch 'kindle') { continue }
      $size = $null
      if ($hasVocab) { $size = (Get-Item -LiteralPath $vocab -Force).Length }
      $result += [ordered]@{ root = $d.Name; label = $d.VolumeLabel; vocabPath = $vocab; vocabSize = $size }
    } catch { }
  }
  return ,$result
}

function Copy-VocabFromDevice($shell, [string]$deviceId, [string]$storageName, [string]$dest, [int]$timeoutSec) {
  $dev = $null
  foreach ($it in $shell.NameSpace($SSF_DRIVES).Items()) {
    if ([string]$it.Path -eq $deviceId) { $dev = $it; break }
  }
  if ($null -eq $dev) { throw 'The Kindle is no longer connected.' }

  $storages = Get-Children $dev
  $storage = $storages | Where-Object { [string]$_.Name -eq $storageName } | Select-Object -First 1
  if ($null -eq $storage) { $storage = $storages | Select-Object -First 1 }
  if ($null -eq $storage) { throw 'The Kindle did not show any storage. Unlock it and try again.' }

  $hit = Find-VocabFile $storage
  if ($null -eq $hit.file) { throw ("Not found on the Kindle: " + $hit.missing) }
  $expected = Get-ItemSize $hit.file

  # Shell.NameSpace() only understands canonical Windows paths (backslashes).
  $dest = [IO.Path]::GetFullPath($dest)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $target = Join-Path $dest 'vocab.db'
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  $destFolder = $shell.NameSpace($dest)
  if ($null -eq $destFolder) { throw ("Cannot open the destination folder " + $dest) }

  # 4 = no progress UI, 16 = yes to all, 512 = no mkdir prompt, 1024 = no error UI
  $destFolder.CopyHere($hit.file, 4 -bor 16 -bor 512 -bor 1024)

  # CopyHere returns immediately for portable devices; wait for the complete, unlocked file.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $lastLen = -1
  $stableTicks = 0
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    Start-Sleep -Milliseconds 100
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $len = (Get-Item -LiteralPath $target -Force).Length
    if ($len -eq $lastLen -and $len -gt 0) { $stableTicks++ } else { $stableTicks = 0 }
    $lastLen = $len
    $complete = $false
    if ($expected -gt 0) { $complete = ($len -eq $expected) } else { $complete = ($stableTicks -ge 10) }
    if (-not $complete) { continue }
    try {
      $fs = [IO.File]::Open($target, 'Open', 'Read', 'None')
      $fs.Close()
      return [ordered]@{ path = $target; size = $len; expected = $expected; storage = [string]$storage.Name; ms = $sw.ElapsedMilliseconds }
    } catch { }
  }
  throw 'Timed out waiting for Windows to copy vocab.db from the Kindle.'
}

try {
  $shell = New-Object -ComObject Shell.Application
  switch ($env:KTA_MODE) {
    'scan' {
      Write-Result ([ordered]@{ ok = $true; devices = (Get-PortableKindles $shell); drives = (Get-KindleDrives) })
    }
    'copy' {
      $timeout = 120
      if ($env:KTA_TIMEOUT_SEC) { $timeout = [int]$env:KTA_TIMEOUT_SEC }
      $r = Copy-VocabFromDevice $shell $env:KTA_DEVICE_ID $env:KTA_STORAGE $env:KTA_DEST $timeout
      Write-Result ([ordered]@{ ok = $true; result = $r })
    }
    default { throw ("Unknown KTA_MODE '" + $env:KTA_MODE + "'") }
  }
} catch {
  Write-Result ([ordered]@{ ok = $false; error = $_.Exception.Message })
  exit 1
}
