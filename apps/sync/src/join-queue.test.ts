import { describe, expect, it } from 'vitest'
import { isConnectFrame, JoinQueue } from './join-queue.ts'

const connect = (id: string) =>
  JSON.stringify({
    type: 'connect',
    connectRequestId: id,
    schema: {},
    protocolVersion: 8,
    lastServerClock: -1,
  })
const push = (clock: number) => JSON.stringify({ type: 'push', clientClock: clock, presence: ['put', {}] })

/** A queue whose macrotasks run only when the test says so. */
function manual() {
  const tasks: (() => void)[] = []
  const q = new JoinQueue({ schedule: (fn) => void tasks.push(fn) })
  return {
    q,
    pending: () => tasks.length,
    /** Runs the next scheduled macrotask. */
    tick() {
      const t = tasks.shift()
      if (!t) throw new Error('nothing scheduled')
      t()
    },
  }
}

describe('isConnectFrame', () => {
  it('recognises the TLSync connect request, whole or as the first chunk', () => {
    expect(isConnectFrame(connect('a'))).toEqual({ connect: true, chunked: false })
    expect(isConnectFrame(`2_${connect('a').slice(0, 30)}`)).toEqual({ connect: true, chunked: true })
    expect(isConnectFrame(`0_${connect('a')}`)).toEqual({ connect: true, chunked: false })
    expect(isConnectFrame(push(1))).toEqual({ connect: false, chunked: false })
    expect(isConnectFrame('{"type":"ping"}').connect).toBe(false)
    // a push whose payload merely mentions "connect" is not one
    expect(isConnectFrame('{"type":"push","diff":{"type":"connect"}}').connect).toBe(false)
  })
})

describe('JoinQueue', () => {
  it('runs at most one connect per macrotask, in arrival order', () => {
    const { q, tick, pending } = manual()
    const seen: string[] = []
    for (const s of ['a', 'b', 'c']) q.push(s.charCodeAt(0), connect(s), () => seen.push(s))
    expect(seen).toEqual([]) // nothing runs in the I/O callback that received them
    expect(pending()).toBe(1)
    tick()
    expect(seen).toEqual(['a'])
    tick()
    expect(seen).toEqual(['a', 'b'])
    tick()
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(pending()).toBe(0)
    expect(q.size).toBe(0)
  })

  it("holds a socket's later frames behind its connect and delivers them right after it, in order", () => {
    const { q, tick } = manual()
    const log: string[] = []
    const deliver = (t: string) =>
      log.push(JSON.parse(t).type === 'connect' ? 'connect' : `push:${JSON.parse(t).clientClock}`)
    q.push(1, connect('a'), deliver)
    q.push(1, push(1), deliver)
    q.push(1, push(2), deliver)
    expect(log).toEqual([])
    tick()
    expect(log).toEqual(['connect', 'push:1', 'push:2'])
    // once joined, frames pass straight through
    q.push(1, push(3), deliver)
    expect(log).toEqual(['connect', 'push:1', 'push:2', 'push:3'])
  })

  it('never delays sessions that are already on the board: their frames interleave with queued joins', () => {
    const { q, tick } = manual()
    const log: string[] = []
    for (const s of ['j1', 'j2', 'j3']) q.push(s.length + s.charCodeAt(1), connect(s), () => log.push(s))
    q.push(99, push(7), () => log.push('editor-push')) // an editor who joined earlier
    expect(log).toEqual(['editor-push'])
    tick()
    q.push(99, push(8), () => log.push('editor-push-2'))
    expect(log).toEqual(['editor-push', 'j1', 'editor-push-2'])
    tick()
    tick()
    expect(log).toEqual(['editor-push', 'j1', 'editor-push-2', 'j2', 'j3'])
  })

  it('waits for every chunk of a chunked connect before queueing it', () => {
    const { q, tick, pending } = manual()
    const got: string[] = []
    const full = connect('big')
    q.push(1, `1_${full.slice(0, 20)}`, (t) => got.push(t))
    expect(pending()).toBe(0)
    q.push(1, `0_${full.slice(20)}`, (t) => got.push(t))
    expect(pending()).toBe(1)
    q.push(1, push(1), (t) => got.push(t))
    tick()
    expect(got).toEqual([`1_${full.slice(0, 20)}`, `0_${full.slice(20)}`, push(1)])
  })

  it('drops the frames of a socket that closed while queued, and keeps serving the others', () => {
    const { q, tick } = manual()
    const log: string[] = []
    q.push(1, connect('gone'), () => log.push('gone'))
    q.push(2, connect('stays'), () => log.push('stays'))
    q.drop(1)
    tick()
    expect(log).toEqual(['stays'])
    expect(q.size).toBe(0)
  })

  it('a handler that throws does not stall the queue', () => {
    const { q, tick } = manual()
    const log: string[] = []
    q.push(1, connect('a'), () => {
      throw new Error('boom')
    })
    q.push(2, connect('b'), () => log.push('b'))
    tick()
    tick()
    expect(log).toEqual(['b'])
  })

  it('uses setImmediate by default: other I/O and timers run between two joins', async () => {
    const q = new JoinQueue()
    const log: string[] = []
    q.push(1, connect('a'), () => log.push('a'))
    q.push(2, connect('b'), () => log.push('b'))
    setImmediate(() => log.push('other'))
    await new Promise((r) => setTimeout(r, 20))
    expect(log).toEqual(['a', 'other', 'b'])
  })
})
