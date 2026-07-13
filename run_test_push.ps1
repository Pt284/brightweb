# run_test_push.ps1
# Chạy test_push.py với credentials lấy từ GitHub Secrets (đã lưu trong .env.test hoặc nhập tay)
#
# CÁCH DÙNG:
#   .\run_test_push.ps1
#
# Yêu cầu: pip install pywebpush google-auth requests

Write-Host "=== HM-LEAKBASE Push Test ===" -ForegroundColor Cyan
Write-Host ""

# ── Kiểm tra pywebpush ──────────────────────────────────────────────────────
$installed = pip show pywebpush 2>$null
if (-not $installed) {
    Write-Host "Cài pywebpush..." -ForegroundColor Yellow
    pip install pywebpush --quiet
}

# ── Load .env.test (nếu có) ─────────────────────────────────────────────────
$envFile = Join-Path $PSScriptRoot ".env.test"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
            $key   = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            if (-not [Environment]::GetEnvironmentVariable($key)) {
                [Environment]::SetEnvironmentVariable($key, $value, "Process")
            }
        }
    }
    Write-Host "Loaded .env.test" -ForegroundColor Green
}

# ── Kiểm tra GOOGLE_CREDENTIALS_JSON ────────────────────────────────────────
$creds = [Environment]::GetEnvironmentVariable("GOOGLE_CREDENTIALS_JSON")
if (-not $creds) {
    Write-Host ""
    Write-Host "GOOGLE_CREDENTIALS_JSON chua duoc set." -ForegroundColor Yellow
    Write-Host "Ban can paste noi dung JSON cua service account key." -ForegroundColor Yellow
    Write-Host "(Lay tu GitHub Secrets hoac Firebase Console -> Service Accounts)" -ForegroundColor Yellow
    Write-Host ""
    $creds = Read-Host "Paste GOOGLE_CREDENTIALS_JSON (1 dong)"
    if (-not $creds) {
        Write-Host "Bo qua - khong co credentials." -ForegroundColor Red
        exit 1
    }
    [Environment]::SetEnvironmentVariable("GOOGLE_CREDENTIALS_JSON", $creds, "Process")
}

# ── Kiểm tra VAPID keys ──────────────────────────────────────────────────────
$vapidPriv = [Environment]::GetEnvironmentVariable("VAPID_PRIVATE_KEY")
if (-not $vapidPriv) {
    Write-Host ""
    Write-Host "VAPID_PRIVATE_KEY chua duoc set." -ForegroundColor Yellow
    $vapidPriv = Read-Host "Paste VAPID_PRIVATE_KEY"
    [Environment]::SetEnvironmentVariable("VAPID_PRIVATE_KEY", $vapidPriv, "Process")
}

$vapidSubj = [Environment]::GetEnvironmentVariable("VAPID_SUBJECT")
if (-not $vapidSubj) {
    [Environment]::SetEnvironmentVariable("VAPID_SUBJECT", "mailto:mcdg5444@gmail.com", "Process")
}

$siteUrl = [Environment]::GetEnvironmentVariable("SITE_URL")
if (-not $siteUrl) {
    [Environment]::SetEnvironmentVariable("SITE_URL", "https://pt284.github.io/brightweb", "Process")
}

$projectId = [Environment]::GetEnvironmentVariable("FIRESTORE_PROJECT_ID")
if (-not $projectId) {
    Write-Host ""
    $projectId = Read-Host "Nhap FIRESTORE_PROJECT_ID (vi du: brightwebaccbase)"
    [Environment]::SetEnvironmentVariable("FIRESTORE_PROJECT_ID", $projectId, "Process")
}

# ── Chạy test ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Dang chay tools/test_push.py..." -ForegroundColor Cyan
Write-Host ""

python tools/test_push.py
