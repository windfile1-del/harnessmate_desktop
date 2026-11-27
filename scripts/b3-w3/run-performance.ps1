$ErrorActionPreference='Stop'
$workspaceRoot=(Get-Location).Path
$taskRoot='D:\HarnessMate\b3-tmp\w3'
$env:TEMP=Join-Path $taskRoot 'temp'
$env:TMP=$env:TEMP
$env:Path="$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:Path"
$summary=@()
foreach($runNumber in 1..3){
  foreach($version in @('B2','B3')){
    $name="$($version.ToLower())-$runNumber"
    $port=if($version -eq 'B2'){50171+($runNumber-1)*200}else{50271+($runNumber-1)*200}
    $debugPort=$port+1
    $dataDir=Join-Path $taskRoot "performance/$name/data"
    $userDir=Join-Path $taskRoot "performance/$name/user"
    New-Item -ItemType Directory -Path $dataDir,$userDir -Force | Out-Null
    $env:HARNESSMATE_DATA_DIR=$dataDir
    $env:HARNESSMATE_REPLAY_WORKSPACE=Join-Path $taskRoot "performance/$name/repo"
    $env:HARNESSMATE_PORT=[string]$port
    $exe=if($version -eq 'B2'){'D:\HarnessMate\b2-fix-release\HarnessMate-Desktop-0.6.0-portable.exe'}else{Join-Path $taskRoot 'HarnessMate-Desktop-B3-portable.exe'}
    $launch=Start-Process -FilePath $exe -ArgumentList "--user-data-dir=$userDir","--remote-debugging-port=$debugPort",'--disable-gpu','--no-first-run' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot "performance/$name/out.log") -RedirectStandardError (Join-Path $taskRoot "performance/$name/err.log") -PassThru
    $ready=$false
    foreach($attempt in 1..240){try { $health=Invoke-RestMethod "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 1; if($health){$ready=$true;break} } catch {}; Start-Sleep -Milliseconds 250}
    if(-not $ready){throw "$name portable startup failed"}
    & node scripts/b3-w3/setup.mjs $port *> (Join-Path $taskRoot "performance/$name/setup.log")
    if($LASTEXITCODE -ne 0){throw "$name setup failed"}
    $output=Join-Path $taskRoot "performance/$name/raw.json"
    & node scripts/b3-w3/performance.mjs $port $debugPort $version $output *> (Join-Path $taskRoot "performance/$name/measurement.log")
    $code=$LASTEXITCODE
    $summary+=@{version=$version;run=$runNumber;port=$port;exitCode=$code;output=$output;exe=$exe}
    $summary | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $taskRoot 'performance/runs.json')
    try { Invoke-RestMethod "http://127.0.0.1:$port/api/v1/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch {}
    $apps=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'HarnessMate Desktop.exe' -and $_.CommandLine -like "*--remote-debugging-port=$debugPort*" -and $_.CommandLine -notlike '*--type=*' }
    foreach($ownedApp in $apps){& "$env:SystemRoot\System32\taskkill.exe" /PID $ownedApp.ProcessId /T /F | Out-Null}
    Write-Output "$name exit=$code raw=$output"
    if($code -ne 0){throw "$name measurement failed"}
  }
}
