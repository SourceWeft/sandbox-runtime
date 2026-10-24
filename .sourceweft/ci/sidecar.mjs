// Test sidecar: runs one suite of cases under @anthropic-ai/sandbox-runtime
// and records what happened. The same file runs under Node and is the entry
// compiled with `bun build --compile`. Used by .github/workflows/sourceweft-sync.yml.
//
// Env:
//   SUITE         q1 | q3 | q5 | kill | basic
//   LABEL         name of this run (results file name)
//   RESULTS_DIR   where the JSON result goes
//   WS_ROOT       scratch root for the workspace
//   HELPERS       auto | explicit (explicit: HELPER_DIR/apply-seccomp, HELPER_DIR/srt-win.exe)
//   HELPER_DIR    directory holding helpers for HELPERS=explicit
//   BWRAP_PATH    Linux: config.bwrapPath
//   WIN_USER / WIN_GUID / WIN_PORTS   Windows: windows.sandboxUser / sublayerGuid / proxyPortRange (lo-hi)
//   SRT_LABEL_VERSION  informational
import * as srt from '@anthropic-ai/sandbox-runtime'
import srtPkg from '@anthropic-ai/sandbox-runtime/package.json' with { type: 'json' }
import { spawn, spawnSync } from 'node:child_process'
import dnsp from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// srt must run with no proxy in its own environment (parentProxy would be
// picked up from it and the resolved-address check is skipped then).
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const proxyEnvAtStart = PROXY_VARS.filter(v => process.env[v] !== undefined)
for (const v of PROXY_VARS) delete process.env[v]

const { SandboxManager } = srt
const E = process.env
const suite = E.SUITE ?? 'q1'
const label = E.LABEL ?? suite
const resultsDir = E.RESULTS_DIR
const wsRoot = E.WS_ROOT
if (!resultsDir || !wsRoot) throw new Error('RESULTS_DIR and WS_ROOT are required')
const isWin = process.platform === 'win32'
const helpers = E.HELPERS ?? 'auto'
const helperDir = E.HELPER_DIR
const REAL = 'sw-real-token-5f2c9a7e1b'
process.env.SW_FAKE_TOKEN = REAL

const ws = path.join(wsRoot, `ws-${label}`)
fs.rmSync(ws, { recursive: true, force: true })
fs.mkdirSync(ws, { recursive: true })
fs.mkdirSync(resultsDir, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── files the sandboxed commands run (written into the workspace) ──────────
const PROBE = String.raw`
const http = require('http'), tls = require('tls'), net = require('net')
const argv = process.argv.slice(2)
const out = o => console.log('PROBE ' + JSON.stringify(o))
const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const [mode, a1, a2] = argv
setTimeout(() => { out({ stage: 'timeout' }); process.exit(5) }, 40000).unref()
if (mode === 'TCP') {
  const s = net.connect({ host: a1, port: +a2 })
  let buf = ''
  s.setTimeout(10000, () => { out({ stage: 'tcp', connected: false, code: 'TIMEOUT' }); process.exit(1) })
  s.on('connect', () => s.write('GET / HTTP/1.0\r\nHost: ' + a1 + '\r\n\r\n'))
  s.on('data', d => { buf += d })
  s.on('end', () => { out({ stage: 'tcp', connected: true, head: buf.slice(0, 200) }); process.exit(0) })
  s.on('error', e => { out({ stage: 'tcp', connected: false, code: e.code, message: e.message }); process.exit(1) })
} else {
  const method = mode, url = new URL(a1), isHttps = url.protocol === 'https:'
  const authEnv = flag('--auth-env'), body = flag('--body')
  const envSeen = authEnv ? process.env[authEnv] : undefined
  const pick = names => names.map(n => process.env[n]).find(Boolean)
  const proxyRaw = isHttps ? pick(['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) : pick(['http_proxy', 'HTTP_PROXY'])
  if (!proxyRaw) { out({ stage: 'error', code: 'NO_PROXY_ENV' }); process.exit(4) }
  const proxy = new URL(proxyRaw)
  const pauth = proxy.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : undefined
  const headers = { host: url.host, 'user-agent': 'srt-p0-probe' }
  if (authEnv) headers.authorization = 'Bearer ' + envSeen
  if (body !== undefined) { headers['content-type'] = 'text/plain'; headers['content-length'] = Buffer.byteLength(body) }
  const pickHeaders = h => ({ 'x-proxy-error': h['x-proxy-error'], 'content-type': h['content-type'] })
  const finish = (res, extra) => {
    let data = ''
    res.on('data', d => { if (data.length < 4000) data += d })
    res.on('end', () => {
      out({ stage: 'response', status: res.statusCode, statusMessage: res.statusMessage, headers: pickHeaders(res.headers), bodyHead: data.slice(0, 1500), envSeen, ...extra })
      process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 3)
    })
  }
  const fail = (stage, e) => { out({ stage, code: e.code, message: String(e.message).slice(0, 300), envSeen }); process.exit(4) }
  if (isHttps) {
    const port = url.port || 443
    // agent:false: on Windows srt sets NODE_USE_ENV_PROXY=1, which would make
    // Node's global agent proxy this request to the proxy a second time.
    const req = http.request({ agent: false, host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: url.hostname + ':' + port,
      headers: { host: url.hostname + ':' + port, ...(pauth && { 'proxy-authorization': pauth }) } })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        out({ stage: 'connect', status: res.statusCode, statusMessage: res.statusMessage, headers: pickHeaders(res.headers), envSeen })
        process.exit(2)
      }
      const t = tls.connect({ socket, servername: url.hostname })
      t.on('error', e => fail('tls', e))
      // no agent: with createConnection and agent undefined Node uses this socket
      // (agent:false would make it ignore createConnection)
      const r2 = http.request({ createConnection: () => t, method, path: url.pathname + url.search, headers })
      r2.on('response', res2 => finish(res2, { connectStatus: 200 }))
      r2.on('error', e => fail('request', e))
      r2.end(body)
    })
    req.on('response', res => finish(res, { note: 'CONNECT answered as response' }))
    req.on('error', e => fail('proxy', e))
    req.end()
  } else {
    const req = http.request({ agent: false, host: proxy.hostname, port: proxy.port, method, path: url.href,
      headers: { ...headers, ...(pauth && { 'proxy-authorization': pauth }) } })
    req.on('response', res => finish(res))
    req.on('error', e => fail('proxy', e))
    req.end(body)
  }
}
`
// binds a loopback server inside the sandbox and connects to it itself
const SELFSERVE = String.raw`
const http = require('http')
const port = +process.argv[2]
const srv = http.createServer((q, s) => s.end('self-ok'))
srv.on('error', e => { console.log('PROBE ' + JSON.stringify({ stage: 'listen', ok: false, code: e.code, message: e.message })); process.exit(1) })
srv.listen(port, '127.0.0.1', () => {
  http.get({ agent: false, host: '127.0.0.1', port, path: '/' }, r => { let d=''; r.on('data', c => d += c); r.on('end', () => {
    console.log('PROBE ' + JSON.stringify({ stage: 'self', ok: d === 'self-ok', status: r.statusCode })); process.exit(0) }) })
    .on('error', e => { console.log('PROBE ' + JSON.stringify({ stage: 'self', ok: false, code: e.code })); process.exit(1) })
})
`
const GRANDCHILD = String.raw`
const { spawn } = require('child_process')
const a = spawn('ping', ['-n', '120', '127.0.0.1'], { stdio: 'ignore', detached: true }); a.unref()
const b = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' })
console.log('spawned ping=' + a.pid + ' node=' + b.pid + ' self=' + process.pid)
setTimeout(() => {}, 120000)
`
fs.writeFileSync(path.join(ws, 'probe.cjs'), PROBE)
fs.writeFileSync(path.join(ws, 'selfserve.cjs'), SELFSERVE)
fs.writeFileSync(path.join(ws, 'grandchild.cjs'), GRANDCHILD)

// ── config ─────────────────────────────────────────────────────────────────
function platformConfig() {
  if (isWin) {
    const srtWinPath = helpers === 'explicit' ? path.join(helperDir, 'srt-win.exe') : srt.VENDORED_SRT_WIN_EXE
    const w = { srtWin: { path: srtWinPath } }
    if (E.WIN_USER) w.sandboxUser = E.WIN_USER
    if (E.WIN_GUID) w.sublayerGuid = E.WIN_GUID
    if (E.WIN_PORTS) w.proxyPortRange = E.WIN_PORTS.split('-').map(Number)
    return { windows: w }
  }
  const c = {}
  if (helpers === 'explicit') c.seccomp = { applyPath: path.join(helperDir, 'apply-seccomp') }
  if (E.BWRAP_PATH) c.bwrapPath = E.BWRAP_PATH
  return c
}
const filesystem = { denyRead: [], allowWrite: [ws], denyWrite: [] }

const filterLog = []
const askLog = []
const blocked = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.168.0.0', 16], ['224.0.0.0', 4], ['255.255.255.255', 32], ['100.100.100.200', 32], ['168.63.129.16', 32], ['192.0.0.192', 32]])
  blocked.addSubnet(a, p, 'ipv4')
for (const [a, p] of [['::1', 128], ['::', 128], ['fe80::', 10], ['fc00::', 7], ['ff00::', 8], ['fd00:ec2::', 32]]) blocked.addSubnet(a, p, 'ipv6')
function localOrPrivate(hostRaw) {
  const host = hostRaw.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') return 'local name'
  const fam = net.isIP(host)
  if (fam === 4 && blocked.check(host, 'ipv4')) return 'private/loopback/link-local/metadata IPv4 literal'
  if (fam === 6) {
    const m = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m && blocked.check(m[1], 'ipv4')) return 'IPv4-mapped private literal'
    if (blocked.check(host, 'ipv6')) return 'private/loopback/link-local IPv6 literal'
  }
  return null
}
async function askAll({ host, port }) {
  const why = localOrPrivate(host)
  const decision = why
    ? SandboxManager.askCallbackDenyReason === true
      ? { allow: false, reason: `sidecar ask: ${why} (${host})` }
      : false
    : true
  askLog.push({ host, port, decision })
  return decision
}

let config
let askCallback
const network = { allowedDomains: [], deniedDomains: [] }
if (suite === 'q1') {
  Object.assign(network, {
    allowedDomains: ['registry.npmjs.org', 'httpbin.org', 'postman-echo.com'],
    tlsTerminate: {},
    filterRequest: async (req, info) => {
      const host = new URL(req.url).hostname
      const deny = req.method === 'POST' && host === 'httpbin.org'
      filterLog.push({ method: req.method, url: req.url, scheme: info?.scheme, decision: deny ? 'deny' : 'allow' })
      return deny ? { action: 'deny', reason: 'sidecar policy: POST to httpbin.org denied' } : { action: 'allow' }
    },
  })
  config = {
    network,
    filesystem,
    credentials: { envVars: [{ name: 'SW_FAKE_TOKEN', mode: 'mask', injectHosts: ['httpbin.org'] }] },
  }
} else if (suite === 'q3') {
  Object.assign(network, {
    deniedResolvedAddresses: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7'],
  })
  askCallback = askAll
  config = { network, filesystem }
} else if (suite === 'q5') {
  Object.assign(network, { allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true })
  config = { network, filesystem }
} else {
  network.allowedDomains = ['registry.npmjs.org']
  config = { network, filesystem }
}
Object.assign(config, platformConfig())

// ── runner ─────────────────────────────────────────────────────────────────
function startWrapped(argv, env, opts = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd: ws, env, shell: false, windowsHide: true, ...opts })
  const r = { stdout: '', stderr: '', code: undefined, signal: undefined }
  child.stdout?.on('data', d => (r.stdout += d))
  child.stderr?.on('data', d => (r.stderr += d))
  child.on('error', e => (r.stderr += `spawn error: ${e.message}`))
  r.done = new Promise(res => child.on('close', (code, signal) => { r.code = code; r.signal = signal; res(r) }))
  r.child = child
  return r
}
async function wrap(command, id) {
  const w = await SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, undefined, ws, { commandId: `${label}-${id}` })
  const env = isWin ? w.env : { ...w.env, HOME: ws }
  return { argv: w.argv, env }
}
function probeOf(stdout) {
  const line = stdout.split(/\r?\n/).reverse().find(l => l.startsWith('PROBE '))
  try { return line ? JSON.parse(line.slice(6)) : undefined } catch { return undefined }
}
const violationsSeen = () => SandboxManager.getSandboxViolationStore().getViolations().length
async function runCase(id, command, timeoutMs = 90_000) {
  const before = SandboxManager.getSandboxViolationStore().getViolations()
  const started = performance.now()
  let w
  try {
    w = await wrap(command, id)
  } catch (e) {
    return { id, command, wrapError: String(e?.stack ?? e).slice(0, 1500) }
  }
  const r = startWrapped(w.argv, w.env)
  const timer = setTimeout(() => r.child.kill('SIGKILL'), timeoutMs)
  await r.done
  clearTimeout(timer)
  const after = SandboxManager.getSandboxViolationStore().getViolations()
  const newViolations = after.filter(v => !before.includes(v)).map(v => v.line)
  // violations are keyed by the proxy username, which carries the commandId
  const byId = SandboxManager.annotateStderrWithSandboxFailures(`${label}-${id}`, r.stderr)
  const byText = SandboxManager.annotateStderrWithSandboxFailures(command, r.stderr)
  const annotated = byId.length >= byText.length ? byId : byText
  return {
    id,
    command,
    exit: r.code,
    signal: r.signal,
    ms: Math.round(performance.now() - started),
    stdout: r.stdout.trim().slice(0, 2500),
    stderr: annotated.trim().slice(-2500),
    hasViolationsTag: annotated.includes('<sandbox_violations>'),
    violationsKey: byId.includes('<sandbox_violations>') ? 'commandId' : byText.includes('<sandbox_violations>') ? 'command' : null,
    newViolations,
    probe: probeOf(r.stdout),
  }
}

const node = 'node'
const probe = (...a) => `${node} probe.cjs ${a.join(' ')}`
// a policy refusal answered by srt's proxy (403 carrying X-Proxy-Error)
const refusedBySrt = p => !!p && (p.stage === 'connect' || p.stage === 'response') && p.status === 403 && !!p.headers?.['x-proxy-error']

// [id, command, expectation(r) => boolean | undefined (observe)]
function casesFor() {
  const echo = ['echo', 'echo hello', r => r.exit === 0 && r.stdout.includes('hello')]
  const whoami = ['whoami', 'whoami', undefined]
  const allowed = ['https-allowed-node', probe('GET', 'https://registry.npmjs.org/left-pad'), r => r.probe?.status === 200]
  const denied = ['https-denied-example.com', probe('GET', 'https://example.com/'),
    r => r.exit !== 0 && r.probe?.status === 403 && r.hasViolationsTag]
  if (suite === 'basic' || suite === 'kill') return [echo, whoami, allowed, denied]
  if (suite === 'q1') {
    return [
      echo,
      whoami,
      allowed,
      isWin
        ? ['https-allowed-python', `python -c "import urllib.request as u;print(u.urlopen('https://registry.npmjs.org/left-pad',timeout=20).status)"`, r => r.stdout.trim().endsWith('200')]
        : ['https-allowed-curl', 'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/left-pad', r => r.stdout.trim() === '200'],
      denied,
      ['mask-injected-httpbin', probe('GET', 'https://httpbin.org/headers', '--auth-env', 'SW_FAKE_TOKEN'),
        r => r.probe?.status === 200 && r.probe.bodyHead.includes(REAL) && !!r.probe.envSeen && r.probe.envSeen !== REAL],
      ['mask-not-injected-postman-echo', probe('GET', 'https://postman-echo.com/headers', '--auth-env', 'SW_FAKE_TOKEN'),
        r => r.probe?.status === 200 && !r.probe.bodyHead.includes(REAL) && !!r.probe.envSeen && r.probe.bodyHead.includes(r.probe.envSeen)],
      ['filter-post-httpbin-denied', probe('POST', 'https://httpbin.org/post', '--body', 'hi'), r => r.probe?.status === 403],
      ...(isWin
        ? []
        : [['seccomp-unix-socket-blocked', `python3 -c "import socket; socket.socket(socket.AF_UNIX); print('UNIX_SOCKET_CREATED')"`,
            r => r.exit !== 0 && !r.stdout.includes('UNIX_SOCKET_CREATED')]]),
    ]
  }
  if (suite === 'q3') {
    // a name the ask callback allowed, refused afterwards by the resolved-address check
    const refused = r => r.exit !== 0 && refusedBySrt(r.probe) && r.newViolations.some(l => /resolved to/.test(l))
    // an IP literal / local name the ask callback itself refused
    const askRefused = r => r.exit !== 0 && refusedBySrt(r.probe) && r.newViolations.some(l => /sidecar ask:/.test(l))
    return [
      echo,
      ['public-allowed-via-ask', probe('GET', 'https://registry.npmjs.org/left-pad'), r => r.probe?.status === 200],
      ['nip-10-https', probe('GET', 'https://10.0.0.1.nip.io/'), refused],
      ['nip-10-http', probe('GET', 'http://10.0.0.1.nip.io/'), refused],
      ['nip-172-https', probe('GET', 'https://172.16.0.1.nip.io/'), refused],
      ['nip-192-https', probe('GET', 'https://192.168.1.1.nip.io/'), refused],
      ['nip-100.64-https', probe('GET', 'https://100.64.0.1.nip.io/'), refused],
      ['nip-127-https', probe('GET', 'https://127.0.0.1.nip.io/'), refused],
      ['localtest.me-https', probe('GET', 'https://localtest.me/'), refused],
      ['nip-metadata-http', probe('GET', 'http://169.254.169.254.nip.io/latest/meta-data/'), refused],
      ['sslip-fc00-v6-https', probe('GET', 'https://fc00--1.sslip.io/'), refused],
      ['literal-10-https', probe('GET', 'https://10.0.0.1/'), askRefused],
      ['literal-metadata-http', probe('GET', 'http://169.254.169.254/latest/meta-data/'), askRefused],
      ['localhost-name-http', probe('GET', 'http://localhost:8080/'), askRefused],
    ]
  }
  if (suite === 'q5') {
    return [
      echo,
      ['sandbox-self-loopback-bind+connect', `${node} selfserve.cjs 18767`, r => r.probe?.ok === true],
      ['sandbox-to-host-loopback-direct-tcp', probe('TCP', '127.0.0.1', '18766'), undefined],
      ['sandbox-to-host-loopback-via-proxy', probe('GET', 'http://127.0.0.1:18766/'), undefined],
    ]
  }
  return [echo]
}

// ── host-side helpers ──────────────────────────────────────────────────────
function tcpFromHost(port) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port })
    let buf = ''
    s.setTimeout(4000, () => { s.destroy(); res({ connected: false, code: 'TIMEOUT' }) })
    s.on('connect', () => s.write('GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'))
    s.on('data', d => (buf += d))
    s.on('end', () => res({ connected: true, head: buf.slice(0, 120) }))
    s.on('error', e => res({ connected: false, code: e.code }))
  })
}
function winProcs() {
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '$p = Get-Process -IncludeUserName | Select-Object Id,ProcessName,UserName; ' +
    '$c = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine; ' +
    '@{p=$p;c=$c} | ConvertTo-Json -Depth 3 -Compress'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
  try {
    const j = JSON.parse(ps.stdout)
    const users = new Map(j.p.map(x => [x.Id, x.UserName]))
    return j.c.map(x => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name, user: users.get(x.ProcessId) ?? null, cmd: (x.CommandLine ?? '').slice(0, 220) }))
  } catch (e) {
    return { error: String(e), stderr: ps.stderr?.slice(0, 500) }
  }
}
const sbxUser = (E.WIN_USER || 'srt-sandbox').toLowerCase()
const ofSandboxUser = list => (Array.isArray(list) ? list.filter(p => p.user && p.user.toLowerCase().endsWith('\\' + sbxUser)) : list)
const srtWinProcs = list => (Array.isArray(list) ? list.filter(p => /srt-win/i.test(p.name)) : list)

// ── main ───────────────────────────────────────────────────────────────────
const report = {
  label,
  suite,
  platform: process.platform,
  arch: process.arch,
  srt: srtPkg.version,
  runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
  execPath: process.execPath,
  execSize: (() => { try { return fs.statSync(process.execPath).size } catch { return null } })(),
  importMetaUrl: import.meta.url,
  helpers,
  proxyEnvAtStart,
  vendoredSrtWinExe: isWin ? { path: srt.VENDORED_SRT_WIN_EXE, exists: fs.existsSync(srt.VENDORED_SRT_WIN_EXE) } : undefined,
  configSummary: JSON.parse(JSON.stringify(config, (k, v) => (typeof v === 'function' ? '[fn]' : v))),
  cases: [],
}

let t = performance.now()
try {
  await SandboxManager.initialize(config, askCallback)
  report.initialize = { ok: true, ms: Math.round(performance.now() - t) }
} catch (e) {
  report.initialize = { ok: false, ms: Math.round(performance.now() - t), error: String(e?.stack ?? e).slice(0, 3000), code: e?.code }
}
try {
  report.dependencies = await SandboxManager.checkDependenciesAsync()
} catch (e) {
  report.dependencies = { threw: String(e?.message ?? e).slice(0, 1500) }
}
if (isWin) {
  try {
    const srtWin = srt.resolveSrtWin(config.windows.srtWin)
    report.windowsStatus = await srt.checkWindowsSandboxStatusAsync({ srtWin, sublayerGuid: config.windows.sublayerGuid })
    delete report.windowsStatus?.user?.caCertPem
  } catch (e) {
    report.windowsStatus = { threw: String(e?.message ?? e).slice(0, 1500) }
  }
}

let hostServer
if (report.initialize.ok) {
  if (suite === 'q3') {
    report.hostDns = {}
    for (const h of ['10.0.0.1.nip.io', '172.16.0.1.nip.io', '192.168.1.1.nip.io', '100.64.0.1.nip.io', '127.0.0.1.nip.io', 'localtest.me', '169.254.169.254.nip.io', 'fc00--1.sslip.io', 'registry.npmjs.org']) {
      try { report.hostDns[h] = await dnsp.lookup(h, { all: true }) } catch (e) { report.hostDns[h] = { error: e.code } }
    }
  }
  if (suite === 'q5') {
    hostServer = http.createServer((q, s) => s.end('host-ok'))
    await new Promise(r => hostServer.listen(18766, '127.0.0.1', r))
    report.hostServerSelfCheck = await tcpFromHost(18766)
  }
  for (const [id, command, expect] of casesFor()) {
    const c = await runCase(id, command)
    c.expect = expect ? 'assert' : 'observe'
    c.verdict = expect ? (expect(c) ? 'pass' : 'FAIL') : 'observed'
    report.cases.push(c)
  }
  if (suite === 'q5') {
    // host -> server started inside the sandbox
    const serverCmd = `${isWin ? 'python' : 'python3'} -m http.server 18765 --bind 127.0.0.1`
    const w = await wrap(serverCmd, 'sandbox-server')
    const srv = startWrapped(w.argv, w.env)
    const attempts = []
    for (let i = 0; i < 8; i++) {
      await sleep(1500)
      const a = await tcpFromHost(18765)
      attempts.push(a)
      if (a.connected) break
    }
    // a second, separate sandboxed command -> that server
    const peer = await runCase('sandbox-to-other-sandbox-server-direct-tcp', probe('TCP', '127.0.0.1', '18765'))
    peer.expect = 'observe'
    peer.verdict = 'observed'
    report.cases.push(peer)
    srv.child.kill()
    await Promise.race([srv.done, sleep(5000)])
    report.hostToSandboxServer = {
      reached: attempts.some(a => a.connected),
      attempts,
      serverExit: srv.code,
      serverStderr: srv.stderr.slice(-800),
    }
    if (isWin) report.sandboxUserProcsAfterServerKill = ofSandboxUser(winProcs())
  }
  if (suite === 'kill' && isWin) {
    report.kill = []
    for (const [id, command, how] of [
      ['ping', 'ping -n 120 127.0.0.1', 'kill'],
      ['node-grandchild', `${node} grandchild.cjs`, 'kill'],
      ['node-grandchild-taskkill-tree', `${node} grandchild.cjs`, 'taskkill-tree'],
    ]) {
      const w = await wrap(command, `kill-${id}`)
      const r = startWrapped(w.argv, w.env)
      await sleep(8000)
      const procsBefore = winProcs()
      const rec = {
        id,
        command,
        how,
        brokerPid: r.child.pid,
        brokerArgv0: w.argv[0],
        sandboxUserProcsBefore: ofSandboxUser(procsBefore),
        srtWinProcsBefore: srtWinProcs(procsBefore),
      }
      if (how === 'kill') rec.killReturned = r.child.kill()
      else rec.taskkill = spawnSync('taskkill', ['/F', '/T', '/PID', String(r.child.pid)], { encoding: 'utf8' }).stdout?.trim()
      await Promise.race([r.done, sleep(5000)])
      rec.brokerExit = { code: r.code, signal: r.signal, closed: r.code !== undefined }
      await sleep(5000)
      const procsAfter = winProcs()
      rec.sandboxUserProcsAfter = ofSandboxUser(procsAfter)
      rec.srtWinProcsAfter = srtWinProcs(procsAfter)
      rec.survivors = Array.isArray(rec.sandboxUserProcsAfter) ? rec.sandboxUserProcsAfter.length : null
      rec.stdout = r.stdout.slice(0, 600)
      rec.stderr = r.stderr.slice(-800)
      // clean up survivors so the next variant starts from nothing
      if (Array.isArray(rec.sandboxUserProcsAfter)) {
        rec.cleanup = rec.sandboxUserProcsAfter.map(p => spawnSync('taskkill', ['/F', '/PID', String(p.pid)], { encoding: 'utf8' }).status)
      }
      report.kill.push(rec)
    }
  }
}
// A refusal only proves isolation when the sandbox itself ran.
if (report.cases.find(c => c.id === 'echo')?.verdict !== 'pass') {
  for (const c of report.cases) if (c.verdict === 'pass' && c.id !== 'echo') c.verdict = 'inconclusive'
}
report.askLog = askLog
report.filterLog = filterLog
report.violationCount = report.initialize.ok ? violationsSeen() : 0
hostServer?.close()
await SandboxManager.reset().catch(e => (report.resetError = String(e?.message ?? e)))

const file = path.join(resultsDir, `${label}.json`)
fs.writeFileSync(file, JSON.stringify(report, null, 2))

// ── step summary ───────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|')
const lines = [
  `### ${label} — ${process.platform}/${process.arch} · ${report.runtime} · srt ${report.srt} · helpers=${helpers}`,
  '',
  `exec: \`${report.execPath}\` (${report.execSize} bytes) · import.meta.url: \`${report.importMetaUrl}\``,
  '',
  `initialize: **${report.initialize.ok ? 'ok' : 'FAILED'}** (${report.initialize.ms} ms)` +
    (report.initialize.ok ? '' : `\n\n\`\`\`\n${report.initialize.error}\n\`\`\``),
  '',
  `dependencies: \`${esc(JSON.stringify(report.dependencies)).slice(0, 700)}\``,
  '',
]
if (isWin) {
  lines.push(`vendored srt-win: \`${report.vendoredSrtWinExe.path}\` exists=${report.vendoredSrtWinExe.exists}`, '')
  lines.push(`windows status: \`${esc(JSON.stringify(report.windowsStatus)).slice(0, 900)}\``, '')
}
if (report.cases.length) {
  lines.push('| case | verdict | exit | ms | probe / output |', '|---|---|---|---|---|')
  for (const c of report.cases) {
    const p = c.probe ? JSON.stringify({ ...c.probe, bodyHead: c.probe.bodyHead?.slice(0, 160) }) : `${c.stdout ?? ''} ${c.stderr ?? c.wrapError ?? ''}`
    const v = c.newViolations?.length ? ` · violations: ${c.newViolations.join(' ; ')}` : ''
    lines.push(`| ${c.id} | ${c.verdict} | ${c.exit ?? ''} | ${c.ms ?? ''} | ${esc(p + v).slice(0, 420)} |`)
  }
}
if (askLog.length) lines.push('', `ask callback: \`${esc(JSON.stringify(askLog)).slice(0, 900)}\``)
if (filterLog.length) lines.push('', `filterRequest: \`${esc(JSON.stringify(filterLog)).slice(0, 600)}\``)
if (report.hostToSandboxServer) lines.push('', `host -> sandbox python http.server 127.0.0.1:18765: reached=**${report.hostToSandboxServer.reached}** \`${esc(JSON.stringify(report.hostToSandboxServer.attempts.at(-1)))}\``)
if (report.kill) {
  lines.push('', '| kill variant | how | broker closed | sandbox-user procs before | after (+5s) | survivors |', '|---|---|---|---|---|---|')
  for (const k of report.kill) {
    const names = l => (Array.isArray(l) ? l.map(p => `${p.name}:${p.pid}`).join(' ') : esc(JSON.stringify(l)).slice(0, 120))
    lines.push(`| ${k.id} | ${k.how} | ${k.brokerExit.closed} | ${names(k.sandboxUserProcsBefore)} | ${names(k.sandboxUserProcsAfter)} | ${k.survivors} |`)
  }
}
const summary = `${lines.join('\n')}\n\n`
if (E.GITHUB_STEP_SUMMARY) fs.appendFileSync(E.GITHUB_STEP_SUMMARY, summary)
console.log(summary)
process.exit(0)
