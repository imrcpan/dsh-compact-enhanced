/**
 * Queueing compaction commands for DeepSeek Harness.
 *
 * The built-in /compact command refuses the request whenever the agent is not
 * idle, and its command request stays open for the whole summarization run, so
 * the composer cannot submit anything else while it is in flight. This plugin
 * shadows /compact: the request returns immediately, waits while the agent is
 * busy, and runs the compaction in the background once the agent is idle. The
 * run is correlated with the requesting command id, so the Chat transcript
 * upgrades that command node into the usual compaction card.
 *
 * @module dsh-compact-enhanced
 */
export const name = 'compact-enhanced'

/** The command registry and the compaction seam this plugin wraps. */
export const inject = ['commands', 'compaction']

/** Command name that shadows the built-in manual compaction command. */
const COMPACT = 'compact'

/** Command name that stops a queued or running compaction. */
const CANCEL = 'compact-cancel'

/** Reject any argument to the command, matching the built-in contract. */
const USAGE = 'Usage: /compact (no arguments)'

/** Reject any argument to the cancel command. */
const CANCEL_USAGE = 'Usage: /compact-cancel (no arguments)'

/** Result wording shared by both cancellation paths. */
const CANCELLED_TEXT = 'Compaction cancelled.'

/** How long the queue waits before retrying a start that raced a new turn. */
const DEFAULT_RETRY_DELAY_MS = 250

/** How many times a queued start retries before the failure is reported. */
const DEFAULT_MAX_QUEUE_ATTEMPTS = 40

function resolveSettings(config) {
  const source = config ?? {}
  const retryDelayMs = source.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxQueueAttempts = source.maxQueueAttempts ?? DEFAULT_MAX_QUEUE_ATTEMPTS
  if (typeof retryDelayMs !== 'number' || !Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error('compact-enhanced: retryDelayMs must be a positive finite number of milliseconds')
  }
  if (!Number.isInteger(maxQueueAttempts) || maxQueueAttempts < 1) {
    throw new Error('compact-enhanced: maxQueueAttempts must be a positive integer')
  }
  return { retryDelayMs, maxQueueAttempts }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A synchronous refusal from compactNow means the agent was not idle at the start. */
function isBusy(error) {
  return typeof error === 'object' && error !== null && error.code === 'busy'
}

/** Map one documented compaction failure to the text the command row shows. */
function failureText(error) {
  const code = typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : undefined
  switch (code) {
    case 'busy':
      return 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.'
    case 'changed':
      return 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.'
    case 'summary':
      return 'Compaction could not produce a useful summary. The attempt is recorded in the session log.'
    case 'commit':
      return 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.'
    case 'persistence':
      return 'Compaction finished, but the session could not be saved.'
    default:
      return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Mount the queueing compaction commands.
 * @param ctx - plugin context carrying the command registry and compaction seam.
 * @param config - optional retry tuning for the queue.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  /** agent -> its single pending request and its running attempt. */
  const states = new WeakMap()
  /** States materialized so far, so shutdown can drain their timers. */
  const live = new Set()

  function stateOf(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = { pending: undefined, running: undefined, timer: undefined }
      states.set(agent, state)
      live.add(state)
    }
    return state
  }

  /** Append the second lifecycle edge for one attempt: the queue outlives command/run. */
  function settle(agent, commandId, result) {
    try {
      agent.session.append('command/done', {
        commandId,
        kind: result.kind,
        ...(result.text === undefined ? {} : { text: result.text }),
        ...(result.sourceEventSeq === undefined ? {} : { sourceEventSeq: result.sourceEventSeq }),
      })
    } catch (error) {
      ctx.logger.warn('compact-enhanced: command/done append failed: %o', error)
    }
  }

  function request(invocation) {
    const agent = invocation.agent
    const state = stateOf(agent)
    if (state.running !== undefined) {
      return { kind: 'error', text: 'A compaction is already running. Stop it with /compact-cancel before starting another one.' }
    }
    if (state.pending !== undefined) {
      return { kind: 'error', text: 'A compaction is already queued; stop it with /compact-cancel or wait for the current turn to end.' }
    }
    const entry = { commandId: invocation.commandId, cancelled: false }
    state.pending = entry
    state.timer = setTimeout(() => {
      state.timer = undefined
      void drain(agent, state)
    }, 0)
    return {
      kind: 'success',
      text: agent.status === 'idle'
        ? 'Compaction started in the background.'
        : 'Compaction queued; it starts when the current turn ends.',
    }
  }

  /** Start one attempt synchronously so a busy refusal stays distinguishable from a rejection. */
  function begin(agent, state, commandId) {
    const entry = { commandId, controller: new AbortController() }
    const operation = ctx.compaction.compactNow(agent, entry.controller.signal, commandId)
    state.running = entry
    Promise.resolve(operation).then((result) => {
      settle(agent, commandId, {
        kind: 'success',
        text: result === null || result === undefined
          ? 'No compactable history yet.'
          : `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
        ...(result === null || result === undefined || result.summarySeq === undefined ? {} : { sourceEventSeq: result.summarySeq }),
      })
    }, (error) => {
      settle(agent, commandId, {
        kind: 'error',
        text: entry.controller.signal.aborted ? CANCELLED_TEXT : failureText(error),
      })
    }).finally(() => {
      if (state.running === entry) state.running = undefined
    })
    return entry
  }

  /** Wait for idleness, then start the queued attempt, retrying a start that raced a new turn. */
  async function drain(agent, state) {
    const entry = state.pending
    if (entry === undefined) return
    let attempts = 0
    while (state.pending === entry && entry.cancelled === false) {
      if (agent.status !== 'idle') await agent.whenIdle()
      if (state.pending !== entry || entry.cancelled) return
      try {
        begin(agent, state, entry.commandId)
        state.pending = undefined
        return
      } catch (error) {
        attempts += 1
        if (isBusy(error) === false || attempts >= settings.maxQueueAttempts) {
          state.pending = undefined
          settle(agent, entry.commandId, { kind: 'error', text: failureText(error) })
          return
        }
        await delay(settings.retryDelayMs)
      }
    }
  }

  /** Stop the queued request or abort the running attempt for one agent. */
  function cancel(agent) {
    const state = stateOf(agent)
    if (state.pending !== undefined) {
      const entry = state.pending
      state.pending = undefined
      entry.cancelled = true
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      settle(agent, entry.commandId, { kind: 'error', text: CANCELLED_TEXT })
      return { kind: 'success', text: 'Cancelled the queued compaction.' }
    }
    if (state.running !== undefined) {
      state.running.controller.abort(new Error('compaction cancelled by the user'))
      return { kind: 'success', text: 'Cancelling the running compaction.' }
    }
    return { kind: 'error', text: 'No queued or running compaction to cancel.' }
  }

  ctx.effect(() => {
    const disposeCompact = ctx.commands.register({
      name: COMPACT,
      description: 'Compact older conversation history, queued while the agent is busy (stop it with /compact-cancel)',
      handler: (invocation) => {
        if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
        return request(invocation)
      },
    })
    const disposeCancel = ctx.commands.register({
      name: CANCEL,
      description: 'Cancel a queued or running manual compaction',
      handler: (invocation) => {
        if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: CANCEL_USAGE }
        return cancel(invocation.agent)
      },
    })
    return () => {
      disposeCompact()
      disposeCancel()
      for (const state of live) {
        if (state.timer !== undefined) {
          clearTimeout(state.timer)
          state.timer = undefined
        }
        if (state.pending !== undefined) {
          state.pending.cancelled = true
          state.pending = undefined
        }
        if (state.running !== undefined) {
          state.running.controller.abort(new Error('compact-enhanced plugin disposed'))
        }
      }
    }
  }, 'compact-enhanced lifecycle')
}
