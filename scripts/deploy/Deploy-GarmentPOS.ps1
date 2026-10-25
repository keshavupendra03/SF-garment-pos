<#
.SYNOPSIS
    Deploys the Garment POS app to a Salesforce org and gives users full access to it.

.DESCRIPTION
    Runs these stages in order, stopping at the first failure:
      1/8 Pre-flight    CLI, project folder, org connection, org type, target user(s)
      2/8 Validate      dry-run deploy of the whole force-app folder in one payload
      3/8 Deploy        the real deploy (same payload)
      4/8 Permissions   assigns the Garment_POS_Full_Access permission set
      5/8 Store         creates the POS Store record and applies any shop details passed in
      6/8 Sample data   optional sample garment catalog (-WithSampleProducts)
      7/8 Apex tests    runs every *Test class of this project in the org
      8/8 Smoke test    a real bill + return inside a transaction that is rolled back

    Before running: create the target user in the org, then authenticate the org in the CLI
    (sf org login web --alias <alias>). See docs\DEPLOYMENT.md.

    A full log is written to logs\deploy-<alias>-<timestamp>.log.

.PARAMETER TargetOrg
    Alias (or username) of the authenticated org to deploy to.

.PARAMETER TargetUsername
    Username of the end user who should get full access to the app.

.PARAMETER AdditionalUsernames
    More usernames that should also get full access.

.PARAMETER SkipAdminAssignment
    Do not assign the permission set to the CLI user doing the deploy.

.PARAMETER StoreName
.PARAMETER StorePhone
.PARAMETER StoreGstin
.PARAMETER StoreAddress
    Optional shop details written to the POS Store record (all can be changed later in the app's Settings tab).

.PARAMETER WithSampleProducts
    Also load the sample garment catalog (scripts\apex\seed.apex). For demo/test orgs.

.PARAMETER ValidateOnly
    Stop after the dry-run validation. Nothing is changed in the org.

.PARAMETER SkipTests
    Skip stage 7 (Apex tests). Not recommended.

.PARAMETER AllowProduction
    Required to deploy to a Production org.

.EXAMPLE
    .\scripts\deploy\Deploy-GarmentPOS.ps1 -TargetOrg shop01 -TargetUsername owner@shop01.com

.EXAMPLE
    .\scripts\deploy\Deploy-GarmentPOS.ps1 -TargetOrg shop01 -TargetUsername owner@shop01.com `
        -StoreName "Keshav Garments" -StorePhone 9876500000 -StoreGstin 08ABCDE1234F1Z5 -WithSampleProducts
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $TargetOrg,
    [Parameter(Mandatory = $true)] [string] $TargetUsername,
    [string[]] $AdditionalUsernames = @(),
    [switch] $SkipAdminAssignment,
    [string] $StoreName,
    [string] $StorePhone,
    [string] $StoreGstin,
    [string] $StoreAddress,
    [switch] $WithSampleProducts,
    [switch] $ValidateOnly,
    [switch] $SkipTests,
    [switch] $AllowProduction
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PermissionSetName = 'Garment_POS_Full_Access'
$GstinPattern = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
$TotalStages = 8
$Started = Get-Date
$Results = New-Object System.Collections.Generic.List[object]

# ---------------------------------------------------------------- helpers

function Write-Stage([int] $Number, [string] $Title) {
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $Number, $TotalStages, $Title) -ForegroundColor Cyan
    Write-Host ('-' * 60) -ForegroundColor DarkGray
}

function Write-Ok([string] $Text) { Write-Host "  OK    $Text" -ForegroundColor Green }
function Write-Info([string] $Text) { Write-Host "        $Text" -ForegroundColor Gray }
function Write-Warn([string] $Text) { Write-Host "  WARN  $Text" -ForegroundColor Yellow }
function Write-Bad([string] $Text) { Write-Host "  FAIL  $Text" -ForegroundColor Red }

function Add-Result([string] $Stage, [string] $Status, [string] $Detail) {
    $Results.Add([pscustomobject]@{ Stage = $Stage; Status = $Status; Detail = $Detail })
}

function Write-Summary {
    $elapsed = (Get-Date) - $Started
    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkGray
    Write-Host 'SUMMARY' -ForegroundColor Cyan
    foreach ($r in $Results) {
        $color = 'Green'
        if ($r.Status -eq 'FAILED') { $color = 'Red' } elseif ($r.Status -ne 'PASSED') { $color = 'Yellow' }
        Write-Host ("  {0,-14} {1,-8} {2}" -f $r.Stage, $r.Status, $r.Detail) -ForegroundColor $color
    }
    Write-Host ("  Time taken: {0:mm\:ss}" -f $elapsed) -ForegroundColor Gray
    Write-Host "  Log file:   $LogFile" -ForegroundColor Gray
}

function Stop-Deploy([string] $Stage, [string] $Message) {
    Write-Bad $Message
    Add-Result $Stage 'FAILED' $Message
    Write-Summary
    Write-Host ''
    Write-Host 'Deployment stopped. Fix the problem above and run the script again (it is safe to re-run).' -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch { }
    Pop-Location
    exit 1
}

# Runs an sf CLI command with --json and returns the parsed result. Never throws on a failed
# command: callers inspect .status / .result. (Windows PowerShell 5.1 turns native stderr into
# terminating errors under 'Stop', so the preference is relaxed around the call.)
# Network hiccups (DNS, timeouts, resets) are retried; every command used here is safe to repeat.
$NetworkErrorPattern = 'ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network'
$MaxAttempts = 3

function Invoke-SfOnce([string[]] $Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & sf @Arguments --json 2>$null
    } finally {
        $ErrorActionPreference = $previous
    }
    $text = ($raw | Out-String).Trim()
    if (-not $text) {
        return [pscustomobject]@{ status = 1; message = "No output from: sf $($Arguments -join ' ')"; result = $null }
    }
    try {
        return $text | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ status = 1; message = "Unreadable output from: sf $($Arguments -join ' ')`n$text"; result = $null }
    }
}

function Invoke-Sf([string[]] $Arguments) {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $res = Invoke-SfOnce $Arguments
        $message = [string](Get-Prop $res 'message')
        if ((Get-Prop $res 'status') -eq 0 -or $message -notmatch $NetworkErrorPattern -or $attempt -eq $MaxAttempts) {
            return $res
        }
        Write-Warn "Network problem ($($message.Split("`n")[0])). Retrying in $(10 * $attempt)s (attempt $($attempt + 1) of $MaxAttempts)..."
        Start-Sleep -Seconds (10 * $attempt)
    }
}

function Get-Prop($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Invoke-SoqlQuery([string] $Soql) {
    $res = Invoke-Sf @('data', 'query', '--query', $Soql, '--target-org', $TargetOrg)
    if ((Get-Prop $res 'status') -ne 0) { throw "Query failed: $(Get-Prop $res 'message')" }
    return @(Get-Prop (Get-Prop $res 'result') 'records')
}

function ConvertTo-ApexString([string] $Value) {
    return "'" + ($Value -replace '\\', '\\' -replace "'", "\'" -replace "`r?`n", '\n') + "'"
}

# Runs anonymous Apex from a string or file; returns the sf result after checking success.
function Invoke-AnonymousApex([string] $Stage, [string] $FilePath) {
    $res = Invoke-Sf @('apex', 'run', '--file', $FilePath, '--target-org', $TargetOrg)
    $r = Get-Prop $res 'result'
    if ($null -eq $r) { Stop-Deploy $Stage "Could not run Apex: $(Get-Prop $res 'message')" }
    if (-not (Get-Prop $r 'compiled')) { Stop-Deploy $Stage "Apex did not compile: $(Get-Prop $r 'compileProblem')" }
    if (-not (Get-Prop $r 'success')) {
        Stop-Deploy $Stage "Apex failed: $(Get-Prop $r 'exceptionMessage') $(Get-Prop $r 'exceptionStackTrace')"
    }
    return $r
}

function Show-DeployFailures($DeployResult) {
    $details = Get-Prop $DeployResult 'details'
    foreach ($f in @(Get-Prop $details 'componentFailures')) {
        if ($null -ne $f) { Write-Bad ("{0} {1}: {2}" -f (Get-Prop $f 'componentType'), (Get-Prop $f 'fullName'), (Get-Prop $f 'problem')) }
    }
    $tests = Get-Prop $details 'runTestResult'
    foreach ($f in @(Get-Prop $tests 'failures')) {
        if ($null -ne $f) { Write-Bad ("Test {0}.{1}: {2}" -f (Get-Prop $f 'name'), (Get-Prop $f 'methodName'), (Get-Prop $f 'message')) }
    }
}

# ---------------------------------------------------------------- start

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $ProjectRoot

$LogDir = Join-Path $ProjectRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$safeAlias = $TargetOrg -replace '[^A-Za-z0-9_.-]', '_'
$LogFile = Join-Path $LogDir ("deploy-{0}-{1}.log" -f $safeAlias, $Started.ToString('yyyyMMdd-HHmmss'))
Start-Transcript -Path $LogFile -Append | Out-Null

Write-Host ''
Write-Host 'GARMENT POS - DEPLOYMENT' -ForegroundColor Cyan
Write-Host "Target org:  $TargetOrg"
Write-Host "Target user: $TargetUsername"

# ---------------------------------------------------------------- 1/8 pre-flight

Write-Stage 1 'Pre-flight checks'
$stage = 'Pre-flight'

if (-not (Get-Command sf -ErrorAction SilentlyContinue)) {
    Stop-Deploy $stage 'Salesforce CLI (sf) is not installed or not on PATH. Install it from developer.salesforce.com/tools/salesforcecli.'
}
$cliVersion = (& sf --version | Select-Object -First 1)
Write-Ok "Salesforce CLI: $cliVersion"

if (-not (Test-Path (Join-Path $ProjectRoot 'sfdx-project.json')) -or -not (Test-Path (Join-Path $ProjectRoot 'force-app'))) {
    Stop-Deploy $stage "Project not found at $ProjectRoot (sfdx-project.json / force-app missing)."
}
Write-Ok "Project folder: $ProjectRoot"

$orgInfo = Invoke-Sf @('org', 'display', '--target-org', $TargetOrg)
if ((Get-Prop $orgInfo 'status') -ne 0 -or $null -eq (Get-Prop $orgInfo 'result')) {
    Stop-Deploy $stage "Org '$TargetOrg' is not authenticated. Run: sf org login web --alias $TargetOrg"
}
$cliUser = Get-Prop $orgInfo.result 'username'
$orgId = Get-Prop $orgInfo.result 'id'
$instanceUrl = Get-Prop $orgInfo.result 'instanceUrl'
$connected = Get-Prop $orgInfo.result 'connectedStatus'
if ($connected -and $connected -ne 'Connected') {
    Stop-Deploy $stage "Org '$TargetOrg' status is '$connected'. Log in again: sf org login web --alias $TargetOrg"
}
Write-Ok "Org Id:       $orgId"
Write-Ok "Logged in as: $cliUser"
Write-Ok "Instance:     $instanceUrl"

try {
    $org = (Invoke-SoqlQuery 'SELECT Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization')[0]
} catch {
    Stop-Deploy $stage $_.Exception.Message
}
$isSandbox = [bool](Get-Prop $org 'IsSandbox')
$isTrialOrScratch = $null -ne (Get-Prop $org 'TrialExpirationDate')
$orgType = Get-Prop $org 'OrganizationType'
$isProduction = (-not $isSandbox) -and (-not $isTrialOrScratch) -and ($orgType -ne 'Developer Edition')
$kind = 'Production'
if ($isSandbox) { $kind = 'Sandbox' } elseif ($isTrialOrScratch) { $kind = 'Scratch / trial org' } elseif ($orgType -eq 'Developer Edition') { $kind = 'Developer Edition' }
Write-Ok "Org:          $(Get-Prop $org 'Name') ($orgType, $kind)"

if ($isProduction -and -not $AllowProduction) {
    Stop-Deploy $stage 'This is a PRODUCTION org. Re-run with -AllowProduction if you really mean to deploy here.'
}

# Users who get the permission set.
$usernames = New-Object System.Collections.Generic.List[string]
foreach ($u in (@($TargetUsername) + $AdditionalUsernames)) {
    if ($u -and -not $usernames.Contains($u.Trim())) { $usernames.Add($u.Trim()) }
}
if (-not $SkipAdminAssignment -and $cliUser -and -not $usernames.Contains($cliUser)) { $usernames.Add($cliUser) }
foreach ($u in $usernames) {
    if ($u -match "['\\]") { Stop-Deploy $stage "Invalid username: $u" }
}
$inList = ($usernames | ForEach-Object { "'$_'" }) -join ','
try {
    $users = Invoke-SoqlQuery "SELECT Username, IsActive, Profile.Name, Profile.UserLicense.Name FROM User WHERE Username IN ($inList)"
} catch {
    Stop-Deploy $stage $_.Exception.Message
}
foreach ($u in $usernames) {
    $match = $users | Where-Object { $_.Username -eq $u } | Select-Object -First 1
    if ($null -eq $match) { Stop-Deploy $stage "User '$u' was not found in this org. Create the user first (Setup > Users), then re-run." }
    if (-not $match.IsActive) { Stop-Deploy $stage "User '$u' is inactive. Activate the user, then re-run." }
    $license = Get-Prop (Get-Prop (Get-Prop $match 'Profile') 'UserLicense') 'Name'
    $profileName = Get-Prop (Get-Prop $match 'Profile') 'Name'
    Write-Ok "User:         $u (profile: $profileName, licence: $license)"
    if ($license -and $license -notmatch '^Salesforce') {
        Write-Warn "Licence '$license' may not allow custom apps. Use a Salesforce or Salesforce Platform licence."
    }
}

if ($StoreGstin -and ($StoreGstin.Trim().ToUpper() -notmatch $GstinPattern)) {
    Stop-Deploy $stage "GSTIN '$StoreGstin' is not valid. Expected 15 characters like 08ABCDE1234F1Z5."
}

$testClasses = @(Get-ChildItem (Join-Path $ProjectRoot 'force-app\main\default\classes') -Filter '*Test.cls' | ForEach-Object { $_.BaseName })
if ($isProduction) {
    # Production does not accept NoTestRun when Apex is deployed; this app's tests do not depend on
    # field-level security, so running them inside the deploy is safe on a brand-new org.
    $testLevelArgs = @('--test-level', 'RunSpecifiedTests')
    foreach ($t in $testClasses) { $testLevelArgs += @('--tests', $t) }
    Write-Info "Production: the project's tests ($($testClasses -join ', ')) run inside the deploy."
} else {
    $testLevelArgs = @('--test-level', 'NoTestRun')
    Write-Info 'Tests are skipped during the deploy and run separately in stage 7.'
}
Add-Result $stage 'PASSED' "$kind org, $($usernames.Count) user(s) checked"

# ---------------------------------------------------------------- 2/8 validate

Write-Stage 2 'Validate deployment (dry run, nothing is changed)'
$stage = 'Validate'
$deployArgs = @('project', 'deploy', 'start', '--source-dir', 'force-app', '--target-org', $TargetOrg, '--wait', '30') + $testLevelArgs
$res = Invoke-Sf ($deployArgs + @('--dry-run'))
$r = Get-Prop $res 'result'
if ($null -eq $r -or (Get-Prop $r 'status') -ne 'Succeeded') {
    Show-DeployFailures $r
    $message = Get-Prop $res 'message'
    if (-not $message) { $message = 'Validation failed. See errors above.' }
    Stop-Deploy $stage $message
}
Write-Ok ("Validation succeeded: {0} components" -f (Get-Prop $r 'numberComponentsTotal'))
Add-Result $stage 'PASSED' ("{0} components" -f (Get-Prop $r 'numberComponentsTotal'))

if ($ValidateOnly) {
    Add-Result 'Deploy' 'SKIPPED' '-ValidateOnly'
    Write-Summary
    Write-Host ''
    Write-Host 'Validation only: nothing was changed in the org.' -ForegroundColor Green
    try { Stop-Transcript | Out-Null } catch { }
    Pop-Location
    exit 0
}

# ---------------------------------------------------------------- 3/8 deploy

Write-Stage 3 'Deploy'
$stage = 'Deploy'
$res = Invoke-Sf $deployArgs
$r = Get-Prop $res 'result'
if ($null -eq $r -or (Get-Prop $r 'status') -ne 'Succeeded') {
    Show-DeployFailures $r
    $message = Get-Prop $res 'message'
    if (-not $message) { $message = 'Deploy failed. See errors above.' }
    Stop-Deploy $stage $message
}
Write-Ok ("Deployed {0} components (deploy id {1})" -f (Get-Prop $r 'numberComponentsDeployed'), (Get-Prop $r 'id'))
Add-Result $stage 'PASSED' ("{0} components" -f (Get-Prop $r 'numberComponentsDeployed'))

# ---------------------------------------------------------------- 4/8 permissions

Write-Stage 4 "Assign permission set $PermissionSetName"
$stage = 'Permissions'
$assignArgs = @('org', 'assign', 'permset', '--name', $PermissionSetName, '--target-org', $TargetOrg)
foreach ($u in $usernames) { $assignArgs += @('--on-behalf-of', $u) }
$res = Invoke-Sf $assignArgs
$r = Get-Prop $res 'result'
foreach ($s in @(Get-Prop $r 'successes')) {
    if ($null -ne $s) { Write-Ok "Assigned to $(Get-Prop $s 'name')" }
}
$hardFailures = 0
foreach ($f in @(Get-Prop $r 'failures')) {
    if ($null -eq $f) { continue }
    $msg = Get-Prop $f 'message'
    if ($msg -match 'Duplicate|already') {
        Write-Ok "Already assigned to $(Get-Prop $f 'name')"
    } else {
        Write-Bad "$(Get-Prop $f 'name'): $msg"
        $hardFailures++
    }
}
if ($null -eq $r -and (Get-Prop $res 'status') -ne 0) { Stop-Deploy $stage "Assignment failed: $(Get-Prop $res 'message')" }

# Confirm from the org itself.
$assigned = @(Invoke-SoqlQuery "SELECT Assignee.Username FROM PermissionSetAssignment WHERE PermissionSet.Name = '$PermissionSetName' AND Assignee.Username IN ($inList)")
$assignedNames = @($assigned | ForEach-Object { $_.Assignee.Username })
$missing = @($usernames | Where-Object { $assignedNames -notcontains $_ })
if ($hardFailures -gt 0 -or $missing.Count -gt 0) {
    Stop-Deploy $stage ("Permission set missing for: {0}" -f ($missing -join ', '))
}
Add-Result $stage 'PASSED' ("assigned to {0}" -f ($usernames -join ', '))

# ---------------------------------------------------------------- 5/8 store

Write-Stage 5 'Store record and shop details'
$stage = 'Store'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('// Generated by Deploy-GarmentPOS.ps1')
$lines.Add('POS_Store__c s = PosStorage.getStore(true);')
$changed = @()
if ($StoreName) { $lines.Add("s.Name = $(ConvertTo-ApexString $StoreName.Trim());"); $changed += 'name' }
if ($StorePhone) { $lines.Add("s.Phone__c = $(ConvertTo-ApexString $StorePhone.Trim());"); $changed += 'phone' }
if ($StoreGstin) { $lines.Add("s.GSTIN__c = $(ConvertTo-ApexString $StoreGstin.Trim().ToUpper());"); $changed += 'GSTIN' }
if ($StoreAddress) { $lines.Add("s.Address__c = $(ConvertTo-ApexString $StoreAddress.Trim());"); $changed += 'address' }
if ($changed.Count -gt 0) { $lines.Add('update s;') }
$lines.Add("System.debug(LoggingLevel.ERROR, 'POS_STORE_READY ' + s.Name + ' (' + s.Id + ')');")
$storeFile = Join-Path $env:TEMP ("garmentpos-store-{0}.apex" -f [guid]::NewGuid())
# No BOM: Windows PowerShell's UTF8 encoding adds one, which the Apex compiler rejects.
[IO.File]::WriteAllText($storeFile, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding $false))
try {
    $r = Invoke-AnonymousApex $stage $storeFile
} finally {
    Remove-Item $storeFile -ErrorAction SilentlyContinue
}
$storeLine = (@((Get-Prop $r 'logs') -split "`n") | Where-Object { $_ -match 'USER_DEBUG.*POS_STORE_READY' } | Select-Object -First 1)
$storeLabel = 'store ready'
if ($storeLine -match 'POS_STORE_READY (.+)$') { $storeLabel = $Matches[1].Trim() }
Write-Ok "POS Store: $storeLabel"
if ($changed.Count -gt 0) {
    Write-Ok ("Updated: {0}" -f ($changed -join ', '))
} else {
    Write-Info 'No shop details passed. Set them later in the app: Settings > Shop details.'
}
Add-Result $stage 'PASSED' $storeLabel

# ---------------------------------------------------------------- 6/8 sample data

Write-Stage 6 'Sample products'
$stage = 'Sample data'
if ($WithSampleProducts) {
    $null = Invoke-AnonymousApex $stage (Join-Path $ProjectRoot 'scripts\apex\seed.apex')
    Write-Ok 'Sample garment catalog loaded.'
    Add-Result $stage 'PASSED' 'sample catalog loaded'
} else {
    Write-Info 'Skipped (add -WithSampleProducts to load a demo catalog).'
    Add-Result $stage 'SKIPPED' 'not requested'
}

# ---------------------------------------------------------------- 7/8 tests

Write-Stage 7 'Apex tests'
$stage = 'Apex tests'
if ($SkipTests) {
    Write-Warn 'Skipped (-SkipTests).'
    Add-Result $stage 'SKIPPED' '-SkipTests'
} else {
    $testArgs = @('apex', 'run', 'test', '--target-org', $TargetOrg, '--wait', '30')
    foreach ($t in $testClasses) { $testArgs += @('--class-names', $t) }
    $res = Invoke-Sf $testArgs
    $r = Get-Prop $res 'result'
    $summary = Get-Prop $r 'summary'
    if ($null -eq $summary) { Stop-Deploy $stage "Tests did not run: $(Get-Prop $res 'message')" }
    foreach ($t in @(Get-Prop $r 'tests')) {
        if ($null -ne $t -and (Get-Prop $t 'Outcome') -ne 'Pass') {
            Write-Bad ("{0}: {1}" -f (Get-Prop $t 'FullName'), (Get-Prop $t 'Message'))
        }
    }
    $outcome = Get-Prop $summary 'outcome'
    $detail = "{0} passed, {1} failed" -f (Get-Prop $summary 'passing'), (Get-Prop $summary 'failing')
    if ($outcome -ne 'Passed') { Stop-Deploy $stage "Tests failed ($detail)." }
    Write-Ok "All tests passed ($detail) in $($testClasses.Count) classes"
    Add-Result $stage 'PASSED' $detail
}

# ---------------------------------------------------------------- 8/8 smoke test

Write-Stage 8 'Smoke test (real bill + return, then rolled back)'
$stage = 'Smoke test'
$r = Invoke-AnonymousApex $stage (Join-Path $ProjectRoot 'scripts\apex\smoke-test.apex')
$passLine = (@((Get-Prop $r 'logs') -split "`n") | Where-Object { $_ -match 'USER_DEBUG.*SMOKE_TEST_PASSED' } | Select-Object -First 1)
if (-not $passLine) { Stop-Deploy $stage 'Smoke test ran but did not report success.' }
Write-Ok 'Billing, bill storage, return, credit note and stock all work. No test data was kept.'
Add-Result $stage 'PASSED' 'bill + return + credit note OK'

# ---------------------------------------------------------------- done

Write-Summary
Write-Host ''
Write-Host 'DEPLOYMENT COMPLETE' -ForegroundColor Green
Write-Host 'Next (manual, see docs\DEPLOYMENT.md section 4):' -ForegroundColor Cyan
Write-Host '  1. Log in as the end user > App Launcher > Garment POS > POS Billing'
Write-Host '  2. Settings tab: check shop details, GST slabs, time zone, return window'
Write-Host '  3. Settings tab: set up the Bluetooth printer and print a test page (on the phone)'
Write-Host '  4. Products tab: add your styles (or bulk-load products) and print barcode labels'
try { Stop-Transcript | Out-Null } catch { }
Pop-Location
exit 0
