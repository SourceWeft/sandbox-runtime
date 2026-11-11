import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { listenInRange } from '../../src/sandbox/listen-in-range.js'

/**
 * A listener whose bind result is scripted per port: a port named in
 * `refusals` fails with that error code, any other port binds. Records
 * every port asked for, in order.
 */
function scriptedListener(refusals: Record<number, string>): {
  server: EventEmitter
  doListen: (port: number) => void
  tried: number[]
} {
  const server = new EventEmitter()
  const tried: number[] = []
  const doListen = (port: number): void => {
    tried.push(port)
    const code = refusals[port]
    queueMicrotask(() => {
      if (code === undefined) {
        server.emit('listening')
        return
      }
      const err: NodeJS.ErrnoException = new Error(
        `listen ${code}: 127.0.0.1:${port}`,
      )
      err.code = code
      server.emit('error', err)
    })
  }
  return { server, doListen, tried }
}

/** What `attempt` rejected with; fails the test if it resolved. */
async function rejection(attempt: Promise<void>): Promise<unknown> {
  return attempt.then(
    () => {
      throw new Error('expected listenInRange to reject')
    },
    (err: unknown) => err,
  )
}

describe('listenInRange', () => {
  it('moves to the next port when one is in use', async () => {
    const { server, doListen, tried } = scriptedListener({
      60180: 'EADDRINUSE',
    })
    await listenInRange(server, doListen, [60180, 60189], new Set())
    expect(tried).toEqual([60180, 60181])
  })

  // Windows answers a bind on a port that is held exclusively, held by
  // another account, or reserved with WSAEACCES, which Node reports as
  // EACCES: the port is as unavailable as one in use.
  it('moves to the next port when one is refused with EACCES', async () => {
    const { server, doListen, tried } = scriptedListener({ 60180: 'EACCES' })
    await listenInRange(server, doListen, [60180, 60189], new Set())
    expect(tried).toEqual([60180, 60181])
    expect(server.listenerCount('error')).toBe(0)
    expect(server.listenerCount('listening')).toBe(0)
  })

  it('skips an excluded port after a refused one', async () => {
    const { server, doListen, tried } = scriptedListener({
      60180: 'EACCES',
      60182: 'EADDRINUSE',
    })
    await listenInRange(server, doListen, [60180, 60189], new Set([60181]))
    expect(tried).toEqual([60180, 60182, 60183])
  })

  it('rejects when every port in the range is refused', async () => {
    const { server, doListen, tried } = scriptedListener({
      60180: 'EACCES',
      60181: 'EADDRINUSE',
      60182: 'EACCES',
    })
    const attempt = listenInRange(server, doListen, [60180, 60182], new Set())
    expect(await rejection(attempt)).toMatchObject({ code: 'EACCES' })
    expect(tried).toEqual([60180, 60181, 60182])
    expect(server.listenerCount('error')).toBe(0)
    expect(server.listenerCount('listening')).toBe(0)
  })

  it('rejects when the ports left after a refusal are all excluded', async () => {
    const { server, doListen, tried } = scriptedListener({ 60180: 'EACCES' })
    const attempt = listenInRange(
      server,
      doListen,
      [60180, 60181],
      new Set([60181]),
    )
    expect(await rejection(attempt)).toMatchObject({
      message: expect.stringContaining('No free port in range 60180-60181'),
    })
    expect(tried).toEqual([60180])
  })

  it('does not retry on any other error', async () => {
    const { server, doListen, tried } = scriptedListener({
      60180: 'EADDRNOTAVAIL',
    })
    const attempt = listenInRange(server, doListen, [60180, 60189], new Set())
    expect(await rejection(attempt)).toMatchObject({ code: 'EADDRNOTAVAIL' })
    expect(tried).toEqual([60180])
  })

  it('binds port 0 once and does not retry without a range', async () => {
    const { server, doListen, tried } = scriptedListener({ 0: 'EACCES' })
    const attempt = listenInRange(server, doListen, undefined, new Set())
    expect(await rejection(attempt)).toMatchObject({ code: 'EACCES' })
    expect(tried).toEqual([0])
  })
})
