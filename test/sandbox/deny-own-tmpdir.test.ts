import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import type { SandboxRuntimeConfig } from '../../src/sandbox/sandbox-config.js'
import { getDefaultWritePaths } from '../../src/sandbox/sandbox-utils.js'
import { countMounts } from '../helpers/bwrap-argv.js'
import { bwrapCanNamespace } from '../helpers/bwrap-namespace.js'
import { isLinux, isMacOS, isWindows } from '../helpers/platform.js'

const OWN_TMP = ['/tmp/claude', '/private/tmp/claude']

/**
 * srt's own TMPDIR is bound writable whatever the caller says, so on Linux an
 * existing host /tmp/claude was bound back over a denyRead tmpfs and stayed
 * readable. A denyRead entry that names it now takes it out of the write
 * paths; one that spans /tmp or / does not.
 */
describe.if(!isWindows)(
  'getDefaultWritePaths and a denyRead of its TMPDIR',
  () => {
    // Where /tmp/claude is spelled /private/tmp/claude, the rule covers both.
    const droppedBy = (deny: Parameters<typeof getDefaultWritePaths>[0]) =>
      OWN_TMP.filter(p => !getDefaultWritePaths(deny).includes(p))

    it('is the whole list with no read rules, as before', () => {
      expect(getDefaultWritePaths().filter(p => OWN_TMP.includes(p))).toEqual(
        OWN_TMP,
      )
      expect(getDefaultWritePaths({ denyRead: [] })).toEqual(
        getDefaultWritePaths(),
      )
    })

    it.each([
      '/tmp/claude',
      '/tmp/claude/',
      '/tmp/claude/**',
      { path: '/tmp/claude', literal: true },
    ])('drops /tmp/claude under denyRead %j', deny => {
      // /private/tmp/claude is the same directory where /tmp links to it.
      expect(droppedBy({ denyRead: [deny] })).toEqual(
        isMacOS ? OWN_TMP : ['/tmp/claude'],
      )
    })

    it.each(['/tmp/clau*', '/tmp/*'])(
      'drops /tmp/claude under the glob denyRead %s',
      deny => {
        expect(droppedBy({ denyRead: [deny] })).toContain('/tmp/claude')
      },
    )

    it('drops /private/tmp/claude under denyRead /private/tmp/claude', () => {
      expect(droppedBy({ denyRead: ['/private/tmp/claude'] })).toContain(
        '/private/tmp/claude',
      )
    })

    it('keeps stdio, devices and the home conveniences it was not asked about', () => {
      const kept = getDefaultWritePaths({ denyRead: ['/tmp/claude'] })
      for (const p of [
        '/dev/stdout',
        '/dev/stderr',
        '/dev/null',
        '/dev/tty',
        '/dev/dtracehelper',
        '/dev/autofs_nowait',
      ]) {
        expect(kept).toContain(p)
      }
      expect(kept.length).toBe(
        getDefaultWritePaths().length - (isMacOS ? 2 : 1),
      )
    })

    it.each(['/', '/**', '/tmp', '/tmp/**', '/private/tmp', '/dev', '~/.ssh'])(
      'is unchanged under denyRead %s, which spans or misses it',
      deny => {
        expect(
          getDefaultWritePaths({ denyRead: [deny] }).filter(p =>
            OWN_TMP.includes(p),
          ),
        ).toEqual(OWN_TMP)
      },
    )

    it.each(['/tmp/claude/sub', '/tmp/claude/sub/**', '/tmp/claude-other'])(
      'is unchanged under denyRead %s, which names something else',
      deny => {
        expect(
          getDefaultWritePaths({ denyRead: [deny] }).filter(p =>
            OWN_TMP.includes(p),
          ),
        ).toEqual(OWN_TMP)
      },
    )

    it('reaches getFsWriteConfig() only when the config denies it', async () => {
      const config = (denyRead: string[]): SandboxRuntimeConfig => ({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead, allowWrite: [], denyWrite: [] },
      })
      await SandboxManager.reset()
      await SandboxManager.initialize(config([]))
      const before = SandboxManager.getFsWriteConfig().allowOnly
      await SandboxManager.reset()
      await SandboxManager.initialize(config(['/tmp/claude']))
      const after = SandboxManager.getFsWriteConfig().allowOnly
      await SandboxManager.reset()
      expect(before).toContain('/tmp/claude')
      expect(after).not.toContain('/tmp/claude')
      expect(after).toEqual(
        before.filter(
          p => p !== '/tmp/claude' && !(isMacOS && p === '/private/tmp/claude'),
        ),
      )
    })
  },
)

/**
 * The real thing: a host /tmp/claude that exists, under a config that denies
 * its reading (and its writing, as a host that hides it would). The test
 * only creates what is missing and removes only what it made.
 */
describe.if(isMacOS || (isLinux && bwrapCanNamespace()))(
  'an existing host /tmp/claude under denyRead',
  () => {
    const MARKER_NAME = `srt-deny-own-tmpdir-${process.pid}`
    const MARKER = join('/tmp/claude', MARKER_NAME)
    const SECRET = 'host-secret-of-tmp-claude'
    let createdDir = false
    let workdir: string
    let ownTmp: string
    const savedEnv = process.env.CLAUDE_CODE_TMPDIR

    beforeAll(() => {
      createdDir = !existsSync('/tmp/claude')
      mkdirSync('/tmp/claude', { recursive: true })
      writeFileSync(MARKER, SECRET)
      workdir = realpathSync(mkdtempSync(join(tmpdir(), 'deny-own-tmpdir-')))
      ownTmp = join(workdir, 'tmp')
      mkdirSync(ownTmp)
      // Where the caller points TMPDIR once /tmp/claude is hidden.
      process.env.CLAUDE_CODE_TMPDIR = ownTmp
    })

    afterAll(async () => {
      await SandboxManager.reset()
      if (savedEnv === undefined) delete process.env.CLAUDE_CODE_TMPDIR
      else process.env.CLAUDE_CODE_TMPDIR = savedEnv
      rmSync(MARKER, { force: true })
      if (createdDir) rmSync('/tmp/claude', { recursive: true, force: true })
      rmSync(workdir, { recursive: true, force: true })
    })

    const configFor = (hide: boolean): SandboxRuntimeConfig => ({
      // A domain allow list puts the proxies (and on Linux the socat bridge
      // sockets and the seccomp helper) in play.
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: {
        denyRead: hide ? ['/tmp/claude'] : [],
        allowWrite: [ownTmp],
        denyWrite: hide ? ['/tmp/claude'] : [],
      },
    })

    const run = async (hide: boolean, command: string) => {
      await SandboxManager.reset()
      await SandboxManager.initialize(configFor(hide))
      const wrapped = await SandboxManager.wrapWithSandbox(command)
      const result = spawnSync(wrapped, {
        shell: true,
        encoding: 'utf8',
        timeout: 30_000,
      })
      return { wrapped, ...result }
    }

    it('is readable with no deny (control)', async () => {
      const r = await run(false, `cat ${MARKER}`)
      expect(r.stdout).toContain(SECRET)
      expect(r.status).toBe(0)
    })

    it('is not readable under denyRead, whatever else the config says', async () => {
      const r = await run(true, `cat ${MARKER}; ls -A /tmp/claude`)
      expect(r.stdout).not.toContain(SECRET)
      expect(r.stdout).not.toContain(MARKER_NAME)
      expect(r.status).not.toBe(0)
    })

    it.if(isLinux)(
      'is a tmpfs in the bwrap arguments, not bound back, and is bound as before with no deny',
      async () => {
        const hidden = await run(true, 'true')
        expect(countMounts(hidden.wrapped, '--tmpfs', '/tmp/claude')).toBe(1)
        expect(
          countMounts(hidden.wrapped, '--bind', '/tmp/claude', '/tmp/claude'),
        ).toBe(0)
        expect(
          countMounts(
            hidden.wrapped,
            '--ro-bind',
            '/tmp/claude',
            '/tmp/claude',
          ),
        ).toBe(0)
        const plain = await run(false, 'true')
        expect(countMounts(plain.wrapped, '--tmpfs', '/tmp/claude')).toBe(0)
        expect(
          countMounts(plain.wrapped, '--bind', '/tmp/claude', '/tmp/claude'),
        ).toBe(1)
      },
    )

    it('leaves the sandbox working: TMPDIR, stdio and the proxy environment', async () => {
      const r = await run(
        true,
        `f=$(mktemp "$TMPDIR/f.XXXXXX") && echo ok > "$f" && cat "$f" && echo "$TMPDIR" && echo "$HTTP_PROXY" && echo to-dev-null > /dev/null && echo to-stderr >&2`,
      )
      expect(r.stderr).toContain('to-stderr')
      expect(r.stdout).toContain('ok')
      expect(r.stdout).toContain(ownTmp)
      expect(r.stdout).toContain('http://')
      expect(r.status).toBe(0)
    })

    it('does not hide anything else in /tmp', async () => {
      const r = await run(true, `ls -d ${workdir} && ls ${ownTmp} >/dev/null`)
      expect(r.status).toBe(0)
    })
  },
)
