# Use Node 24+ without changing your global PATH or installing anything.
$ErrorActionPreference = 'Stop'
$harnessNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$harnessCandidates = @($harnessNode, "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
$harnessRuntime = $null
foreach ($harnessCandidate in $harnessCandidates) {
    if ($harnessCandidate -and (Test-Path -LiteralPath $harnessCandidate)) {
        $harnessVersion = & $harnessCandidate -p "Number(process.versions.node.split('.')[0])"
        if ($LASTEXITCODE -eq 0 -and [int]$harnessVersion -ge 24) { $harnessRuntime = $harnessCandidate; break }
    }
}
if (-not $harnessRuntime) { throw 'Node 24 or newer is required. Install it and put it on PATH.' }
Push-Location $PSScriptRoot
try {
    if ($args.Count -gt 0 -and $args[0] -eq 'test') {
        & $harnessRuntime --test --test-isolation=none tests/*.test.ts
    } else {
        & $harnessRuntime src/cli.ts @args
    }
    $harnessExit = $LASTEXITCODE
} finally { Pop-Location }
exit $harnessExit
