$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeFile = Join-Path $projectRoot 'logs/runtime.json'
if (-not (Test-Path -LiteralPath $runtimeFile)) { Write-Output '没有本项目的启动记录。'; exit 0 }
$runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
foreach ($service in $runtime.processes) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($service.pid)" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -and $process.CommandLine.Contains($projectRoot) -and $process.Name -eq 'node.exe') {
    Stop-Process -Id $service.pid
    Write-Output "已停止 $($service.name)。"
  }
}
