$ErrorActionPreference='Stop'
$taskRoot='D:\HarnessMate\b3-tmp\w3'
$source=Join-Path $taskRoot 'formal-performance/b2-1/data'
$rollbackRoot=Join-Path $taskRoot 'rollback-final'
if(Test-Path -LiteralPath $rollbackRoot){throw 'Rollback destination exists; preserve it and choose a new destination.'}
New-Item -ItemType Directory -Path $rollbackRoot | Out-Null
$dataDir=Join-Path $rollbackRoot 'upgrade-data'
Copy-Item -LiteralPath $source -Destination $dataDir -Recurse
Copy-Item -LiteralPath (Join-Path $taskRoot 'formal-performance/b2-1/raw.json') -Destination (Join-Path $rollbackRoot 'source-raw.json')
$originalFiles=Get-ChildItem -LiteralPath $source -Filter 'harnessmate.db*' -File
$before=@($originalFiles | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
$env:TEMP=Join-Path $taskRoot 'temp'
$env:TMP=$env:TEMP
$env:Path="$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:Path"
$env:HARNESSMATE_DATA_DIR=$dataDir
foreach($phase in @('upgrade','readback')){
  $port=if($phase -eq 'upgrade'){50871}else{50971}
  $exe=if($phase -eq 'upgrade'){Join-Path $taskRoot 'HarnessMate-Desktop-B3-portable.exe'}else{'D:\HarnessMate\b2-fix-release\HarnessMate-Desktop-0.6.0-portable.exe'}
  $env:HARNESSMATE_PORT=[string]$port
  # Persisted port takes precedence over the environment. Change the copy only.
  $configPath=Join-Path $dataDir 'config.json'
  $copyConfig=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $copyConfig.port=$port
  $copyConfig | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath
  $userDir=Join-Path $rollbackRoot "$phase-user"
  Start-Process -FilePath $exe -ArgumentList "--user-data-dir=$userDir",'--disable-gpu','--no-first-run' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $rollbackRoot "$phase.out.log") -RedirectStandardError (Join-Path $rollbackRoot "$phase.err.log") | Out-Null
  $ready=$false
  foreach($attempt in 1..240){try{if(Invoke-RestMethod "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 1){$ready=$true;break}}catch{};Start-Sleep -Milliseconds 250}
  if(-not $ready){throw "$phase startup failed"}
  & node scripts/b3-w3/rollback.mjs $port $phase $rollbackRoot *> (Join-Path $rollbackRoot "$phase.log")
  $code=$LASTEXITCODE
  Invoke-RestMethod "http://127.0.0.1:$port/api/v1/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
  $closed=$false
  foreach($attempt in 1..120){try{Invoke-RestMethod "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 1 | Out-Null}catch{$closed=$true;break};Start-Sleep -Milliseconds 250}
  if(-not $closed){throw "$phase daemon did not close before next EXE"}
  $owned=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'HarnessMate Desktop.exe' -and $_.CommandLine -like "*--user-data-dir=$userDir*" -and $_.CommandLine -notlike '*--type=*'}
  foreach($app in $owned){& "$env:SystemRoot\System32\taskkill.exe" /PID $app.ProcessId /T /F | Out-Null}
  Write-Output "$phase exit=$code"
  if($code -ne 0){throw "$phase failed; original B2 data remains untouched"}
}
$after=@($originalFiles | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash)
if(($before | ConvertTo-Json -Compress) -ne ($after | ConvertTo-Json -Compress)){throw 'Original B2 database changed'}
@{unchanged=$true;before=$before;after=$after} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $rollbackRoot 'source-integrity.json')
