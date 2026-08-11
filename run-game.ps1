$nodePath = 'C:\Users\mashi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $nodePath)) { $nodePath = 'node' }

$gameRoot = $PSScriptRoot
$port = 4173
$localUrl = "http://127.0.0.1:$port/"
$lanIp = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1 -ExpandProperty IPAddress

if ($lanIp) {
  Write-Host "친구에게 보낼 주소: http://$lanIp`:$port/"
  Write-Host "같은 와이파이/네트워크에서 접속해야 합니다."
}

Start-Process -FilePath $nodePath -ArgumentList "`"$gameRoot\server.js`"" -WorkingDirectory $gameRoot -WindowStyle Hidden
Start-Sleep -Milliseconds 900
Start-Process $localUrl
