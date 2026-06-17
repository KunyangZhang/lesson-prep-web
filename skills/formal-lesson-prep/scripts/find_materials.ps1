[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Stage = '',
    [string]$Grade = '',
    [string[]]$Keywords = @(),
    [int]$Limit = 80
)

if ([string]::IsNullOrWhiteSpace($Root)) {
    if ($env:PREP_MATERIAL_ROOT) {
        $Root = $env:PREP_MATERIAL_ROOT
    } elseif ($env:PREP_WORKSPACE) {
        $Root = Join-Path $env:PREP_WORKSPACE '资料库'
    } else {
        $Root = 'C:\Users\kunya\Documents\备课\资料库'
    }
}

$supportedExtensions = @(
    '.pdf', '.doc', '.docx', '.ppt', '.pptx',
    '.md', '.txt', '.tex', '.xlsx', '.xls',
    '.png', '.jpg', '.jpeg', '.webp'
)

$normalizedKeywords = @(
    $Keywords |
        ForEach-Object { $_ -split '[,，]' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ } |
        Select-Object -Unique
)

function Write-Result {
    param(
        [string]$Status,
        [array]$Candidates = @()
    )

    [pscustomobject]@{
        status = $Status
        root = $Root
        query = [pscustomobject]@{
            stage = $Stage
            grade = $Grade
            keywords = @($normalizedKeywords)
        }
        candidateCount = @($Candidates).Count
        candidates = @($Candidates)
    } | ConvertTo-Json -Depth 6
}

if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Result -Status 'missing-root'
    exit 0
}

$weightedTerms = @()
if ($Stage.Trim()) {
    $weightedTerms += [pscustomobject]@{ term = $Stage.Trim(); weight = 8 }
}
if ($Grade.Trim()) {
    $weightedTerms += [pscustomobject]@{ term = $Grade.Trim(); weight = 8 }
}
foreach ($keyword in $normalizedKeywords) {
    if ($keyword -and $keyword.Trim()) {
        $weightedTerms += [pscustomobject]@{ term = $keyword.Trim(); weight = 5 }
    }
}

$files = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $supportedExtensions -contains $_.Extension.ToLowerInvariant() }

if (-not $files) {
    Write-Result -Status 'empty-root'
    exit 0
}

$candidates = foreach ($file in $files) {
    $score = 0
    $hits = @()
    foreach ($weightedTerm in $weightedTerms) {
        if ($file.FullName.IndexOf($weightedTerm.term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $score += $weightedTerm.weight
            $hits += $weightedTerm.term
        }
    }

    [pscustomobject]@{
        path = $file.FullName
        extension = $file.Extension.ToLowerInvariant()
        sizeBytes = $file.Length
        lastWriteTime = $file.LastWriteTime.ToString('s')
        score = $score
        pathHits = @($hits | Select-Object -Unique)
    }
}

$ranked = @(
    $candidates |
        Sort-Object @{ Expression = 'score'; Descending = $true },
                    @{ Expression = 'lastWriteTime'; Descending = $true },
                    @{ Expression = 'path'; Descending = $false } |
        Select-Object -First $Limit
)

Write-Result -Status 'ok' -Candidates $ranked
