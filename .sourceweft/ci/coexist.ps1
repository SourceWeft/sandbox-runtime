# Coexistence check for the namespaced build on a Windows runner.
#
# Installs our build, then upstream's default install of the new release and
# of the previous one, and checks after each step that both keep working.
# Finally uninstalls ours and checks upstream is untouched and ours refuses.
# Exits non-zero when any expectation fails.
#
# Env: RESULTS_DIR, WS_ROOT, NS_USER, NS_PORTS,
#      OURS_SRTWIN (our srt-win.exe), OURS_SIDECAR (our compiled sidecar),
#      UP_DIR / OLD_DIR (npm installs of upstream with sidecar.mjs beside them)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $env:RESULTS_DIR | Out-Null
$failures = [System.Collections.Generic.List[string]]::new()
$expect = [ordered]@{}

function Note($text) { $text | Tee-Object -Append -FilePath $env:GITHUB_STEP_SUMMARY | Out-Null }

function Install($what, [scriptblock] $run) {
  $out = (& $run 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
  Note "### ${what}: exit $code`n``````n$(($out -split "`n" | Select-Object -Last 15) -join "`n")`n``````"
  if ($code -ne 0) { $failures.Add("$what exited $code") }
}

function Ours($label, $suite, $want = 'ok') {
  $env:SUITE = $suite; $env:LABEL = $label; $env:HELPERS = 'explicit'
  $env:HELPER_DIR = Split-Path $env:OURS_SRTWIN; $env:WIN_PORTS = $env:NS_PORTS
  if ($suite -eq 'kill') { $env:WIN_USER = $env:NS_USER } else { Remove-Item Env:WIN_USER -ErrorAction SilentlyContinue }
  & $env:OURS_SIDECAR | Out-Null
  $expect[$label] = @{ want = $want; user = $env:NS_USER }
}

function Upstream($label, $dir) {
  $env:SUITE = 'basic'; $env:LABEL = $label; $env:HELPERS = 'auto'
  Remove-Item Env:HELPER_DIR, Env:WIN_PORTS, Env:WIN_USER -ErrorAction SilentlyContinue
  node (Join-Path $dir 'sidecar.mjs') | Out-Null
  $expect[$label] = @{ want = 'ok'; user = 'srt-sandbox' }
}

$upCli = Join-Path $env:UP_DIR 'node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js'
$oldCli = Join-Path $env:OLD_DIR 'node_modules\@anthropic-ai\sandbox-runtime\dist\cli.js'

Install 'install ours' { & $env:OURS_SRTWIN --srt-win install --proxy-port-range $env:NS_PORTS }
Ours 't1-ours-basic' basic
Ours 't1-ours-q1' q1
Ours 't1-ours-kill' kill

Install 'install upstream (new release, default)' { node $upCli windows-install --skip-profile-grant }
Ours 't2-ours-basic' basic
Ours 't2-ours-q1' q1
Upstream 't3-upstream-new' $env:UP_DIR

Install 'install upstream (previous release, default)' { node $oldCli windows-install --skip-profile-grant }
Ours 't4-ours-basic' basic
Upstream 't5-upstream-previous' $env:OLD_DIR

Install 'uninstall ours' { & $env:OURS_SRTWIN --srt-win uninstall }
Upstream 't6-upstream-after-our-uninstall' $env:OLD_DIR
Ours 't7-ours-after-uninstall' basic 'refuse'

$expectFile = Join-Path $env:RESULTS_DIR 'expectations.json'
$expect | ConvertTo-Json -Depth 4 | Set-Content $expectFile
$check = @'
const fs = require('fs'), path = require('path')
const [dir, expectFile] = process.argv.slice(2)
const expect = JSON.parse(fs.readFileSync(expectFile, 'utf8'))
const bad = []
for (const [label, { want, user }] of Object.entries(expect)) {
  const file = fs.readdirSync(dir).find(f => f.startsWith(label) && f.endsWith('.json') && !f.startsWith('expect'))
  if (!file) { bad.push(`${label}: no result file`); continue }
  const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
  const ok = r.initialize?.ok === true
  if (want === 'refuse') { if (ok) bad.push(`${label}: initialized but should refuse`); continue }
  if (!ok) { bad.push(`${label}: initialize failed: ${String(r.initialize?.error).slice(0, 200)}`); continue }
  for (const c of r.cases ?? []) if (/fail/i.test(String(c.verdict))) bad.push(`${label}/${c.id}: ${c.verdict}`)
  const who = (r.cases ?? []).find(c => c.id === 'whoami')
  if (who && !String(who.stdout).toLowerCase().includes(user.toLowerCase())) bad.push(`${label}: ran as ${String(who.stdout).trim()}, expected ${user}`)
  for (const k of r.kill ?? []) {
    const n = Array.isArray(k.survivors) ? k.survivors.length : Number(k.survivors ?? 0)
    if (n) bad.push(`${label}/${k.id}: ${n} survivors`)
  }
}
console.log(bad.length ? bad.join('\n') : 'all expectations met')
process.exit(bad.length ? 1 : 0)
'@
$checkOut = ($check | node - $env:RESULTS_DIR $expectFile 2>&1 | Out-String).Trim()
$checkCode = $LASTEXITCODE
foreach ($line in ($checkOut -split "`n")) { if ($line -and $line -ne 'all expectations met') { $failures.Add($line.Trim()) } }
if ($checkCode -ne 0 -and -not $failures.Count) { $failures.Add("checker exited $checkCode") }

if ($failures.Count) {
  Note "### Coexistence: FAILED`n$(($failures | ForEach-Object { "- $_" }) -join "`n")"
  exit 1
}
Note '### Coexistence: all expectations met'
