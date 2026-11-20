# Dot-source on the test host. Keep the claims directory with the run, outside per-batch
# clean-up. The caller's existing time window, STOP, isolation and cleanup checks still run.
function Test-FormalPreflight {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]] $Files,
        [Parameter(Mandatory)][string[]] $Scripts,
        [Parameter(Mandatory)][string[]] $Directories,
        [Parameter(Mandatory)][string] $ReceiptSample,
        [Parameter(Mandatory)][string[]] $ReceiptFields
    )
    $missingFiles = @($Files | Where-Object { !(Test-Path -LiteralPath $_ -PathType Leaf) })
    $missingDirs = @($Directories | Where-Object { !(Test-Path -LiteralPath $_ -PathType Container) })
    $syntaxErrors = @(foreach ($file in $Scripts) {
        try {
            $tokens = $null; $errors = $null
            [void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
            foreach ($errorItem in $errors) { "$file $($errorItem.Message)" }
        } catch { "$file $_" }
    })
    $receiptError = $null
    try {
        $sample = Get-Content -LiteralPath $ReceiptSample -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        foreach ($field in $ReceiptFields) {
            if ($field -cnotin $sample.psobject.Properties.Name) { throw "Missing receipt field $field" }
        }
    } catch { $receiptError = "$_" }
    [ordered]@{
        target = [Environment]::MachineName
        files = @{ok=($missingFiles.Count -eq 0); evidence=(($Files + $missingFiles) -join ', ')}
        syntax = @{ok=($syntaxErrors.Count -eq 0); evidence=(($Scripts + $syntaxErrors) -join ', ')}
        directories = @{ok=($missingDirs.Count -eq 0); evidence=(($Directories + $missingDirs) -join ', ')}
        receipt = @{ok=(!$receiptError); evidence="$ReceiptSample $receiptError"}
    }
}
function Invoke-FormalCase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $PermitPath,
        [Parameter(Mandatory)][string] $Case,
        [Parameter(Mandatory)][string] $ReceiptPath,
        [Parameter(Mandatory)][string] $ClaimDirectory,
        [Parameter(Mandatory)][scriptblock] $RunCase
    )
    $p = Get-Content -LiteralPath $PermitPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($p.purpose -cne 'formal' -or [string]$p.receiptCase -cne $Case -or !$p.caseId -or !$p.id -or !$p.runId -or !$p.revision) {
        throw "No matching formal permit for case $Case"
    }
    if ($p.target -and $p.target -ine [Environment]::MachineName) { throw 'Permit was issued for another target' }
    $nonce = [guid]::ParseExact($p.nonce,'D').ToString()
    [void][IO.Directory]::CreateDirectory($ClaimDirectory)
    $claim = Join-Path $ClaimDirectory $nonce
    $stream = [IO.File]::Open($claim, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Dispose()
    $started = [DateTimeOffset]::Now.ToString('o')
    $failure = $null
    try {
        $result = & $RunCase
        if (!$result -or [string]$result.case -cne $Case -or !$result.status -or !$result.start -or !$result.stop) { throw 'Missing per-case result' }
    } catch {
        $failure = $_
        $result = @{case=$Case; start=$started; stop=[DateTimeOffset]::Now.ToString('o'); status='INCONCLUSIVE'; interrupted=$true; error="$failure"}
    }
    $receipt = [ordered]@{id=$p.id;caseId=$p.caseId;revision=$p.revision;nonce=$p.nonce;result=$result}
    $tmp = "$ReceiptPath.$nonce.tmp"
    [IO.File]::WriteAllText($tmp, ($receipt | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($tmp,$ReceiptPath)
    if ($failure) { throw $failure }
    return $result
}
