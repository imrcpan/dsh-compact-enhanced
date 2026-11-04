import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../index.js'

/** Mount the plugin against a recording context and a controllable agent. */
function harness(compactNow, config = {}) {
  const definitions = new Map()
  let dispose
  const ctx = {
    commands: { register: (definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } },
    compaction: { compactNow },
    effect: (factory) => { dispose = factory() },
    logger: { warn: () => {} },
  }
  apply(ctx, { retryDelayMs: 5, maxQueueAttempts: 3, ...config })
  const agent = {
    status: 'idle',
    appended: [],
    idleResolvers: [],
    session: { append: (type, data) => { agent.appended.push({ type, data }); return { type } } },
  }
  agent.whenIdle = () => (agent.status === 'idle' ? Promise.resolve() : new Promise((resolve) => agent.idleResolvers.push(resolve)))
  agent.goBusy = () => { agent.status = 'running' }
  agent.goIdle = () => {
    agent.status = 'idle'
    for (const resolve of agent.idleResolvers.splice(0)) resolve()
  }
  const run = (command, commandId, rawInput = '') => definitions.get(command).handler({
    agent,
    commandId,
    rawInput,
    signal: new AbortController().signal,
  })
  return { definitions, dispose: () => dispose(), agent, run }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30))

test('exposes the plugin contract', () => {
  assert.equal(name, 'compact-enhanced')
  assert.deepEqual(inject, ['commands', 'compaction'])
})

test('starts compaction immediately when the agent is idle', async () => {
  const calls = []
  const { agent, run } = harness(async (owner, signal, commandId) => {
    calls.push({ owner, commandId, signal })
    return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 42, summarySeq: 9 }
  })
  const result = await run('compact', 'cmd-1')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /started in the background/)
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].commandId, 'cmd-1')
  assert.equal(calls[0].owner, agent)
  assert.equal(calls[0].signal.aborted, false)
  const done = agent.appended.at(-1)
  assert.equal(done.type, 'command/done')
  assert.equal(done.data.kind, 'success')
  assert.equal(done.data.text, 'Compacted 3 history items (~42 tokens).')
  assert.equal(done.data.sourceEventSeq, 9)
})

test('queues while the agent is busy and starts after it goes idle', async () => {
  const calls = []
  const { agent, run } = harness(async (owner, signal, commandId) => {
    calls.push(commandId)
    return { shadowedSeqs: [1], shadowedTokenCount: 5 }
  })
  agent.goBusy()
  const result = await run('compact', 'cmd-2')
  assert.match(result.text, /queued/)
  await flush()
  assert.deepEqual(calls, [])
  agent.goIdle()
  await flush()
  assert.deepEqual(calls, ['cmd-2'])
  assert.equal(agent.appended.at(-1).data.text, 'Compacted 1 history items (~5 tokens).')
})

test('reports no compactable history', async () => {
  const { agent, run } = harness(async () => null)
  await run('compact', 'cmd-3')
  await flush()
  assert.equal(agent.appended.at(-1).data.text, 'No compactable history yet.')
})

test('refuses a second request while one is running or queued', async () => {
  const running = harness(() => new Promise(() => {}))
  await running.run('compact', 'cmd-4')
  await flush()
  const busy = await running.run('compact', 'cmd-5')
  assert.equal(busy.kind, 'error')
  assert.match(busy.text, /already running/)

  const queued = harness(async () => null)
  queued.agent.goBusy()
  await queued.run('compact', 'cmd-6')
  const second = await queued.run('compact', 'cmd-7')
  assert.equal(second.kind, 'error')
  assert.match(second.text, /already queued/)
})

test('rejects arguments on both commands', async () => {
  const { run } = harness(async () => null)
  assert.match((await run('compact', 'cmd-8', 'now')).text, /Usage: \/compact \(no arguments\)/)
  assert.match((await run('compact-cancel', 'cmd-9', 'now')).text, /Usage: \/compact-cancel \(no arguments\)/)
})

test('cancels a queued request before it starts', async () => {
  const calls = []
  const { agent, run } = harness(async (owner, signal, commandId) => {
    calls.push(commandId)
    return null
  })
  agent.goBusy()
  await run('compact', 'cmd-10')
  const cancelled = await run('compact-cancel', 'cmd-11')
  assert.equal(cancelled.kind, 'success')
  assert.match(cancelled.text, /Cancelled the queued/)
  agent.goIdle()
  await flush()
  assert.deepEqual(calls, [])
  assert.equal(agent.appended.at(-1).data.text, 'Compaction cancelled.')
})

test('cancels a running request through its abort signal', async () => {
  let seen
  const { agent, run } = harness((owner, signal) => new Promise((resolve, reject) => {
    seen = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  await run('compact', 'cmd-12')
  await flush()
  const cancelled = await run('compact-cancel', 'cmd-13')
  assert.equal(cancelled.kind, 'success')
  assert.match(cancelled.text, /Cancelling the running/)
  await flush()
  assert.equal(seen.aborted, true)
  assert.equal(agent.appended.at(-1).data.kind, 'error')
  assert.equal(agent.appended.at(-1).data.text, 'Compaction cancelled.')
})

test('reports nothing to cancel', async () => {
  const { run } = harness(async () => null)
  const result = await run('compact-cancel', 'cmd-14')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /No queued or running compaction/)
})

test('maps documented compaction failures to human text', async () => {
  const { agent, run } = harness(async () => {
    throw Object.assign(new Error('summarizer exploded'), { name: 'ManualCompactionError', code: 'summary' })
  })
  await run('compact', 'cmd-15')
  await flush()
  assert.equal(agent.appended.at(-1).data.kind, 'error')
  assert.match(agent.appended.at(-1).data.text, /could not produce a useful summary/)
})

test('retries a start that raced a new turn', async () => {
  let attempts = 0
  const { agent, run } = harness(() => {
    attempts += 1
    if (attempts < 3) throw Object.assign(new Error('agent already has active work'), { name: 'ManualCompactionError', code: 'busy' })
    return Promise.resolve({ shadowedSeqs: [1], shadowedTokenCount: 1 })
  })
  await run('compact', 'cmd-16')
  await flush()
  assert.equal(attempts, 3)
  assert.equal(agent.appended.at(-1).data.kind, 'success')
})

test('gives up after the configured queue attempts', async () => {
  let attempts = 0
  const { agent, run } = harness(() => {
    attempts += 1
    throw Object.assign(new Error('agent already has active work'), { name: 'ManualCompactionError', code: 'busy' })
  })
  await run('compact', 'cmd-17')
  await flush()
  assert.equal(attempts, 3)
  assert.match(agent.appended.at(-1).data.text, /Compaction is unavailable/)
})

test('keeps the cancel command when compact is already registered', () => {
  const definitions = new Map()
  const warnings = []
  const ctx = {
    commands: {
      register: (definition) => {
        if (definition.name === 'compact') throw new Error('command "compact" is already registered')
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    compaction: { compactNow: async () => null },
    effect: (factory) => { factory() },
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  }
  apply(ctx, {})
  assert.equal(definitions.has('compact'), false)
  assert.equal(definitions.has('compact-cancel'), true)
  assert.equal(warnings.some((line) => line.includes('/compact is already registered')), true)
})

test('shutdown drops the queue and aborts the running attempt', async () => {
  let signal
  const { agent, run, dispose } = harness((owner, attemptSignal) => new Promise((resolve, reject) => {
    signal = attemptSignal
    attemptSignal.addEventListener('abort', () => reject(attemptSignal.reason), { once: true })
  }))
  await run('compact', 'cmd-18')
  await flush()
  dispose()
  await flush()
  assert.equal(signal.aborted, true)
  assert.equal(agent.appended.at(-1).data.text, 'Compaction cancelled.')
})
