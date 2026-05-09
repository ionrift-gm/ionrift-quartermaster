# Run this after closing Foundry VTT
# It replaces the empty workshop-containers pack with the freshly compiled one.

$modulePath = "c:\Users\geoff\AppData\Local\FoundryVTT\Data\modules\ionrift-workshop\packs"
$livePath   = "$modulePath\workshop-containers"
$compiled   = "$modulePath\workshop-containers-compiled"
$backup     = "$modulePath\workshop-containers-backup"

# Remove old backup if it exists
if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }

# Swap
Rename-Item -Path $livePath -NewName "workshop-containers-backup"
Rename-Item -Path $compiled -NewName "workshop-containers"

Write-Host "✓ Swap complete. workshop-containers now has the compiled data." -ForegroundColor Green
Write-Host "  Restart Foundry VTT to load the containers." -ForegroundColor Cyan
