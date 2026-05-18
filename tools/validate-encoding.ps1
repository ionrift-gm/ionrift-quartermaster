# validate-encoding.ps1
# Checks .hbs / .js / .css / .json files for known UTF-8 re-encoding corruption.
# Run before every release tag. Exit 0 = clean, Exit 1 = violations found.
#
# Patterns caught (expressed as hex byte sequences to avoid embedding bad chars
# in the validator itself):
#   C3 A2 E2 82 AC E2 80 93  -- broken en-dash  (rare triple-encode)
#   C3 A2 E2 82 AC E2 80 94  -- broken em-dash  (rare triple-encode)
#   C3 A2 E2 82 AC E2 80 9C  -- broken left-dquote / alt en-dash
#   E2 80 B0 CB 86            -- broken approx sign (double-encode of approximation)
#   C3 A2 E2 89 88            -- broken approx sign (double-encode variant)
#   C3 A2 E2 80 A2 C2 90      -- broken box-drawing char (=)
#   Ã¢                        -- common double-encode artifact prefix (ASCII detectable)
#
# Usage:
#   .\tools\validate-encoding.ps1
#   .\tools\validate-encoding.ps1 -SearchPath ".\scripts"
#   .\tools\validate-encoding.ps1 -FailFast

param(
    [string]$SearchPath = (Join-Path $PSScriptRoot ".."),
    [switch]$FailFast
)

# Byte-sequence patterns to search for. Each entry has:
#   Label  : human-readable name shown in output
#   Bytes  : byte array that represents the corrupted sequence in UTF-8
$bytePatterns = @(
    @{ Label = "Broken en-dash (triple-encode variant A)"; Bytes = [byte[]]@(0xC3,0xA2,0xE2,0x82,0xAC,0xE2,0x80,0x93) },
    @{ Label = "Broken em-dash (triple-encode variant A)"; Bytes = [byte[]]@(0xC3,0xA2,0xE2,0x82,0xAC,0xE2,0x80,0x94) },
    @{ Label = "Broken en-dash / ldquo (triple-encode B)"; Bytes = [byte[]]@(0xC3,0xA2,0xE2,0x82,0xAC,0xE2,0x80,0x9C) },
    @{ Label = "Broken approx sign (double-encode A)"    ; Bytes = [byte[]]@(0xE2,0x80,0xB0,0xCB,0x86) },
    @{ Label = "Broken approx sign (double-encode B)"    ; Bytes = [byte[]]@(0xC3,0xA2,0xE2,0x89,0x88) },
    @{ Label = "Broken box-drawing char (double-encode)" ; Bytes = [byte[]]@(0xC3,0xA2,0xE2,0x80,0xA2,0xC2,0x90) }
)

# ASCII-detectable prefix pattern (catches many remaining double-encode artifacts)
# String form is safe here because all chars are below 0x80 except the ones we want to flag
$asciiPattern = "Ã¢"

$extensions = @("*.hbs","*.js","*.css","*.json")
$files = Get-ChildItem -Path $SearchPath -Include $extensions -Recurse -File |
    Where-Object { $_.FullName -notmatch "\\node_modules\\" -and $_.FullName -notmatch "\\.git\\" }

$violations = @()
$rootAbs = (Resolve-Path $SearchPath).Path.TrimEnd('\')

foreach ($file in $files) {
    $rawBytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $text = [System.Text.Encoding]::UTF8.GetString($rawBytes)
    $relPath = $file.FullName.Substring([Math]::Min($file.FullName.Length, $rootAbs.Length + 1))
    $lines = $text -split "`r`n|`r|`n"

    foreach ($p in $bytePatterns) {
        $patternStr = [System.Text.Encoding]::UTF8.GetString($p.Bytes)
        $lineNum = 0
        foreach ($line in $lines) {
            $lineNum++
            if ($line.Contains($patternStr)) {
                $violations += [PSCustomObject]@{
                    File    = $relPath
                    Line    = $lineNum
                    Issue   = $p.Label
                    Snippet = $line.Trim().Substring(0, [Math]::Min(70, $line.Trim().Length))
                }
                if ($FailFast) { break }
            }
        }
    }

    # ASCII-pattern check
    $lineNum = 0
    foreach ($line in $lines) {
        $lineNum++
        if ($line.Contains($asciiPattern)) {
            $violations += [PSCustomObject]@{
                File    = $relPath
                Line    = $lineNum
                Issue   = "Double-encode artifact prefix (Ã¢)"
                Snippet = $line.Trim().Substring(0, [Math]::Min(70, $line.Trim().Length))
            }
            if ($FailFast) { break }
        }
    }
}

if ($violations.Count -eq 0) {
    Write-Host "PASS: Encoding clean -- no mangled characters found in $($files.Count) files." -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAIL: $($violations.Count) encoding violation(s) found in $($files.Count) scanned files:" -ForegroundColor Red
    Write-Host ""
    $violations | Format-Table -AutoSize File, Line, Issue
    Write-Host "Fix: read raw bytes, identify the mangled sequence, and replace with correct UTF-8." -ForegroundColor Yellow
    exit 1
}
