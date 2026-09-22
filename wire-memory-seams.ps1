param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$root         = (Get-Location).Path
$orchPath     = Join-Path $root 'src\swarm\orchestrator.ts'
$persistPath  = Join-Path $root 'src\memory\persist.ts'
$typesPath    = Join-Path $root 'src\memory\types.ts'
$retrievePath = Join-Path $root 'src\memory\retrieve.ts'

foreach ($p in @($orchPath, $persistPath, $retrievePath)) {
  if (-not (Test-Path $p)) { throw "Missing $p" }
}

$orch     = [IO.File]::ReadAllText($orchPath)
$persist  = [IO.File]::ReadAllText($persistPath)
$retrieve = [IO.File]::ReadAllText($retrievePath)
$types    = ''
if (Test-Path $typesPath) { $types = [IO.File]::ReadAllText($typesPath) }
$blob     = $persist + [Environment]::NewLine + $types

function Get-InterfaceBody([string]$src, [string]$name) {
  $m = [regex]::Match($src, "export\s+(?:interface|type)\s+$name\s*(?:=\s*)?\{(.*?)\}", 'Singleline')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

$iface = Get-InterfaceBody $blob 'PersistRunSeamInput'
if (-not $iface) { throw 'PersistRunSeamInput not found in persist.ts / types.ts' }

Write-Host '=== PersistRunSeamInput ==='
Write-Host $iface.Trim()

$retSig = [regex]::Match($retrieve, 'export\s+(?:async\s+)?function\s+retrieveMemoryForTopic\s*\((.*?)\)', 'Singleline')
Write-Host ''
Write-Host '=== retrieveMemoryForTopic args ==='
if ($retSig.Success) { Write-Host $retSig.Groups[1].Value.Trim() } else { Write-Host '(could not parse)' }

$fields = [regex]::Matches($iface, '(?m)^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:') |
  ForEach-Object { $_.Groups[1].Value } |
  Select-Object -Unique

Write-Host ''
Write-Host '=== interface fields ==='
foreach ($f in $fields) { Write-Host (' - ' + $f) }

$required = [regex]::Matches($iface, '(?m)^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:') |
  ForEach-Object { $_.Groups[1].Value }

$map = @{
  runStartedAt    = 'runStartedAt'
  runtimeMs       = 'effectiveRuntimeMs'
  criticCallsUsed = 'criticCallsUsed'
  llmCallsUsed    = 'llmCallsUsed'
  gradedCards     = 'gradedCards'
  allQueries      = 'allQueries'
  allSources      = 'allSources'
  usedAI          = 'plan.usedAI'
  topicKeywords   = 'plan.topicKeywords'
  failedHosts     = 'failedHosts'
  failedUrls      = 'failedUrls'
  plan            = 'plan'
  profile         = 'profile'
  health          = 'health'
  llmManager      = 'llmManager'
  state           = 'state'
}

$blocked = $false
$fieldLines = New-Object System.Collections.Generic.List[string]
foreach ($f in $fields) {
  if ($map.ContainsKey($f) -and $map[$f]) {
    [void]$fieldLines.Add(('        ' + $f + ': ' + $map[$f] + ','))
  } elseif ($required -contains $f) {
    Write-Host ('REQUIRED field ' + $f + ' has no in-scope mapping; will not apply.')
    $blocked = $true
  } else {
    Write-Host ('optional field ' + $f + ' omitted (no in-scope name)')
  }
}

if ($blocked) { exit 1 }

$persistLines = New-Object System.Collections.Generic.List[string]
[void]$persistLines.Add('    // memory seam: persist this run (fail-open)')
[void]$persistLines.Add('    try {')
[void]$persistLines.Add('      await persistRunMemory({')
foreach ($line in $fieldLines) { [void]$persistLines.Add($line) }
[void]$persistLines.Add('      });')
[void]$persistLines.Add('    } catch (err) {')
[void]$persistLines.Add("      console.warn('[memory] persistRunMemory failed', err);")
[void]$persistLines.Add('    }')
[void]$persistLines.Add('')
$persistCall = [string]::Join("`r`n", $persistLines) + "`r`n"

$retrieveLines = New-Object System.Collections.Generic.List[string]
[void]$retrieveLines.Add('    // memory seam: bootstrap recall (fail-open)')
[void]$retrieveLines.Add('    try {')
[void]$retrieveLines.Add('      await retrieveMemoryForTopic(plan.topicKeywords);')
[void]$retrieveLines.Add('    } catch (err) {')
[void]$retrieveLines.Add("      console.warn('[memory] retrieveMemoryForTopic failed', err);")
[void]$retrieveLines.Add('    }')
[void]$retrieveLines.Add('')
$retrieveCall = [string]::Join("`r`n", $retrieveLines) + "`r`n"

Write-Host ''
Write-Host '=== persist snippet ==='
Write-Host $persistCall
Write-Host '=== retrieve snippet ==='
Write-Host $retrieveCall

if (-not $Apply) {
  Write-Host 'DRY RUN. Re-run with -Apply to write src\swarm\orchestrator.ts'
  exit 0
}

$next = $orch

if ($next -notmatch 'retrieveMemoryForTopic') {
  if ($next -match "from ['""]\.\./memory/persist['""]") {
    $next = [regex]::Replace(
      $next,
      "(from ['""]\.\./memory/persist['""];)",
      ('$1' + "`r`n" + "import { retrieveMemoryForTopic } from '../memory/retrieve';"),
      1
    )
  } else {
    $next = "import { retrieveMemoryForTopic } from '../memory/retrieve';`r`n" + $next
  }
}

if ($next -notmatch 'persistRunMemory\s*\(') {
  $m = [regex]::Match($next, 'return\s*\{\s*sources:\s*allSources')
  if (-not $m.Success) { throw 'Could not find return sources insertion point.' }
  $next = $next.Insert($m.Index, $persistCall)
}

if ($next -notmatch 'retrieveMemoryForTopic\s*\(') {
  $m = [regex]::Match($next, 'const plan = await buildQueryPlan\([\s\S]*?\);\r?\n')
  if (-not $m.Success) { throw 'Could not find buildQueryPlan insertion point.' }
  $next = $next.Insert($m.Index + $m.Length, "`r`n" + $retrieveCall)
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = $orchPath + '.bak-memory-' + $stamp
Copy-Item $orchPath $bak
[IO.File]::WriteAllText($orchPath, $next)
Write-Host ('Wrote ' + $orchPath)
Write-Host ('Backup ' + $bak)
Write-Host 'Run: npm run typecheck'