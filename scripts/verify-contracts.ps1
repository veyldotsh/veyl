param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [switch]$Check,
  [switch]$Submit,
  [string]$Rpc = 'https://ethereum-rpc.publicnode.com',
  [string]$KeyFile = (Join-Path $PSScriptRoot '..\data\operator\etherscan-key.dpapi')
)
$ErrorActionPreference = 'Stop'
if ($Check -and $Submit) { throw 'Choose Check or Submit.' }
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'verify-contracts.mjs'
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
function Invoke-VerificationNode([string]$Mode, [string]$Secret) {
  $arguments = @($script, '--manifest', $manifestPath, '--rpc', $Rpc)
  if ($Mode) { $arguments += $Mode }
  foreach ($argument in $arguments) { if ($argument.Contains('"') -or $argument.Contains("`n") -or $argument.Contains("`r")) { throw 'Unsupported quote or newline in a verification argument.' } }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $node
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $start.EnvironmentVariables.Remove('ETHERSCAN_API_KEY'); $start.EnvironmentVariables.Remove('VERIFIER_API_KEY')
  if ($Secret) { $start.EnvironmentVariables['ETHERSCAN_API_KEY'] = $Secret }
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $out = $stdout.Result; $err = $stderr.Result
    if ($Secret) { $out = $out.Replace($Secret, '[redacted]'); $err = $err.Replace($Secret, '[redacted]') }
    if ($out) { Write-Output $out.TrimEnd() }
    if ($err) { Write-Output $err.TrimEnd() }
    if ($process.ExitCode -ne 0) { throw 'Verification command failed. No explorer verification success is claimed.' }
  } finally { $start.EnvironmentVariables.Remove('ETHERSCAN_API_KEY'); $process.Dispose() }
}
if (-not $Submit) {
  $mode = if ($Check) { '--check' } else { '' }
  Invoke-VerificationNode $mode $null
  return
}
# Confirm deployed mainnet code before decrypting the current-user DPAPI secret.
Invoke-VerificationNode '--check' $null
$item = Get-Item -LiteralPath $KeyFile -ErrorAction Stop
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Explorer key file must not be a link.' }
$secure = $null; $pointer = [IntPtr]::Zero; $plain = $null
try {
  $secure = Get-Content -LiteralPath $item.FullName -Raw | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  Invoke-VerificationNode '--submit' $plain
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  if ($secure) { $secure.Dispose() }
  $plain = $null
}
