# Current-user portable installation. Never stops applications or installs DSH.
[CmdletBinding()]
param(
  [string]$Archive,
  [string]$Checksum,
  [string]$Version = 'latest',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\AgentWorkbench'),
  [switch]$NoPath,
  [switch]$Noninteractive
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows; use install.sh on macOS.' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Only Windows x64 is supported.' }
$repo = if ($env:WORKBENCH_RELEASE_REPO) { $env:WORKBENCH_RELEASE_REPO } else { 'Nie0008/agent-workbench-open' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid release repository' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('agent-workbench-install-' + [guid]::NewGuid())
$app = Join-Path $InstallRoot 'app'
$bin = Join-Path $InstallRoot 'bin'
$backupApp = $null
$backupBin = $null
$installed = $false
$binInstalled = $false
$committed = $false
if (-not ('WorkbenchInstall.NativePath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace WorkbenchInstall {
  public static class NativePath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
      IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path,
      uint length, uint flags);
    public static string Resolve(string path) {
      using (var handle = CreateFileW(Path.GetFullPath(path), 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var buffer = new StringBuilder(512);
        uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= buffer.Capacity) {
          buffer = new StringBuilder(checked((int)length + 1));
          length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
          if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        string result = buffer.ToString();
        if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + result.Substring(8);
        return result.StartsWith(@"\\?\", StringComparison.Ordinal) ? result.Substring(4) : result;
      }
    }
  }
}
'@
}
function Assert-Stopped {
  if (-not (Test-Path -LiteralPath $app)) { return }
  # CIM and TEMP may spell the same directory with long and 8.3 paths, or through a junction.
  $prefix = [WorkbenchInstall.NativePath]::Resolve($app).TrimEnd('\') + '\'
  $originalPrefix = [IO.Path]::GetFullPath($app).TrimEnd('\') + '\'
  foreach ($process in Get-CimInstance Win32_Process) {
    if (-not $process.ExecutablePath) { continue }
    try { $executable = [WorkbenchInstall.NativePath]::Resolve($process.ExecutablePath) }
    catch {
      # Unrelated protected/system executables need no additional access to install Workbench.
      $original = [IO.Path]::GetFullPath($process.ExecutablePath)
      $targetPath = $original.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $original.StartsWith($originalPrefix, [StringComparison]::OrdinalIgnoreCase)
      if ($targetPath -and (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) {
        throw "Cannot verify the executable path of running process $($process.ProcessId); nothing was replaced."
      }
      continue
    }
    if ($executable.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Agent Workbench is running. Quit it yourself before installing; no task has been stopped.'
    }
  }
}
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  if (-not $Archive) {
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    $useGh = $false
    if ($ghCommand) {
      try { & $ghCommand.Source auth status 1>$null 2>$null; $useGh = $LASTEXITCODE -eq 0 } catch { $useGh = $false }
    }
    if ($Version -eq 'latest') {
      if ($useGh) {
        $viewArgs = @('release', 'view', '--repo', $repo, '--json', 'tagName', '--jq', '.tagName')
        $Version = & $ghCommand.Source @viewArgs
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read release with gh. Check repository access, or use -Archive for offline installation.' }
      } else {
        try {
          $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' }
          $Version = $release.tag_name
        } catch { throw 'Cannot download release. A private repository requires authenticated gh, or -Archive for offline installation.' }
      }
      $Version = $Version -replace '^v', ''
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') { throw 'Invalid release version' }
    $asset = "agent-workbench-$Version-win32-x64.zip"
    $Archive = Join-Path $temp $asset
    $Checksum = "$Archive.sha256"
    $base = "https://github.com/$repo/releases/download/v$Version"
    if ($useGh) {
      $downloadArgs = @('release', 'download', "v$Version", '--repo', $repo, '--pattern', $asset, '--pattern', "$asset.sha256", '--dir', $temp)
      & $ghCommand.Source @downloadArgs
      if ($LASTEXITCODE -ne 0) { throw 'Cannot download release with gh. Check repository access, or use -Archive for offline installation.' }
    } else {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $Archive
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile $Checksum
      } catch { throw 'Cannot download release. A private repository requires authenticated gh, or -Archive for offline installation.' }
    }
  }
  if (-not $Checksum) { $Checksum = "$Archive.sha256" }
  $expected = ((Get-Content -LiteralPath $Checksum -TotalCount 1) -split '\s+')[0]
  if ($expected -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Invalid SHA-256 file' }
  if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $expected) { throw 'SHA-256 verification failed; nothing was installed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if (-not $name.StartsWith('agent-workbench/') -or $name -match '(^|/)\.\.(/|$)' -or $name.Contains(':')) { throw 'Unsafe archive paths' }
    }
  } finally { $zip.Dispose() }
  Expand-Archive -LiteralPath $Archive -DestinationPath (Join-Path $temp 'unpacked')
  $bundle = Join-Path $temp 'unpacked\agent-workbench'
  $metadata = Get-Content -LiteralPath (Join-Path $bundle 'bundle.json') -Raw | ConvertFrom-Json
  if ($metadata.platform -ne 'win32' -or $metadata.arch -ne 'x64') { throw 'Wrong package platform or architecture' }
  $source = Join-Path $bundle 'app'
  if (-not (Test-Path -LiteralPath (Join-Path $source 'electron.exe')) -or -not (Test-Path -LiteralPath (Join-Path $source 'resources\app\dist\main\cli.js')) -or -not (Test-Path -LiteralPath (Join-Path $source 'resources\app\bin\agent-workbench.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $bundle 'bin\agent-workbench.cmd'))) { throw 'Incomplete application bundle' }
  Assert-Stopped
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  # Keep staging on the destination volume so final moves are atomic.
  $stage = Join-Path $InstallRoot ('.stage-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'app') -Recurse
  Copy-Item -LiteralPath (Join-Path $bundle 'bin') -Destination (Join-Path $stage 'bin') -Recurse
  Assert-Stopped
  $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
  if (Test-Path -LiteralPath $app) { $backupApp = "$app.backup-$suffix"; Move-Item -LiteralPath $app -Destination $backupApp }
  if (Test-Path -LiteralPath $bin) { $backupBin = "$bin.backup-$suffix"; Move-Item -LiteralPath $bin -Destination $backupBin }
  Move-Item -LiteralPath (Join-Path $stage 'app') -Destination $app
  $installed = $true
  Move-Item -LiteralPath (Join-Path $stage 'bin') -Destination $bin
  $binInstalled = $true
  if (-not $NoPath) {
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') })) {
      [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User')
    }
  }
  if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$bin;$env:Path" }
  $committed = $true
  Write-Host "Installed: $app`nCommand: $(Join-Path $bin 'workbench.cmd')`nDispatch: $(Join-Path $bin 'agent-workbench.cmd')"
  if ($backupApp) { Write-Host "Previous app retained: $backupApp" }
  if ($backupBin) { Write-Host "Previous commands retained: $backupBin" }
  $setupArgs = @('setup')
  if ($Noninteractive -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { $setupArgs += '--noninteractive' }
  & (Join-Path $bin 'workbench.cmd') @setupArgs
  if ($LASTEXITCODE -ne 0) { throw "Installed successfully, but setup returned $LASTEXITCODE. Run workbench setup again." }
} finally {
  if (-not $committed) {
    if ($binInstalled -and (Test-Path -LiteralPath $bin)) { Remove-Item -LiteralPath $bin -Recurse -Force }
    if ($installed -and (Test-Path -LiteralPath $app)) { Remove-Item -LiteralPath $app -Recurse -Force }
    if ($backupApp -and (Test-Path -LiteralPath $backupApp)) { Move-Item -LiteralPath $backupApp -Destination $app }
    if ($backupBin -and (Test-Path -LiteralPath $backupBin)) {
      Move-Item -LiteralPath $backupBin -Destination $bin
    }
  }
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Remove-Item -LiteralPath $temp -Recurse -Force
}
