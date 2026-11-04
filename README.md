# dsh-compact-enhanced

Queueing and cancellation for DeepSeek Harness manual compaction.

## Quick start

```bash
dsh plugin --profile web add github:imrcpan/dsh-compact-enhanced
```

## Why this exists

The built-in `/compact` command has two limits that hurt on a slow or unstable
upstream:

- **It refuses instead of queueing.** A manual compaction rejects whenever the
  agent is not idle, so the request is lost in the middle of a running turn.
- **It cannot be stopped from the UI.** The command request stays open for the
  whole summarization run, and the composer ignores submissions while a command
  is in flight. A summarizer that hangs without streaming leaves nothing to
  press and nothing to type.

This plugin shadows `/compact` with a request that returns immediately, queues
while the agent is busy, and runs the compaction in the background. The
compaction is correlated with the requesting command id, so the Chat transcript
upgrades that command row into the usual compaction card.

## Commands

| command | behavior |
| --- | --- |
| `/compact` | start now when the agent is idle, otherwise queue until the current turn ends |
| `/compact-cancel` | drop a queued request, or abort the running summarizer request |

Both commands reject arguments. `/compact` refuses a second request while one
is queued or running and names the cancel command in the error.

## What the transcript shows

The request's own lifecycle row appears immediately:

- `Compaction started in the background.`
- `Compaction queued; it starts when the current turn ends.`

Because the requesting command id is passed to the compaction engine as
`sourceCommandId`, the usual compaction events attach to that row: the
transcript turns it into the standard compaction card once the summary lands.
When the attempt settles, the plugin appends one more `command/done` for the
same id to record the outcome:

- `Compacted 42 history items (~12,345 tokens).`
- `No compactable history yet.`
- `Compaction cancelled.`
- the documented failure text for `busy`, `changed`, `summary`, `commit` and `persistence`.

The extra `command/done` is deliberate: the command service closes the request
as soon as the handler returns (that is what frees the composer), so the only
way to report the background outcome on the same row is a second lifecycle edge
for that id. Clients fold it into the existing row.

## How it works

- The plugin registers `compact` under the same name as the built-in command and
  loads after it, so its definition wins the command shadow. Disabling the
  plugin restores the built-in command unchanged.
- A run calls `ctx.compaction.compactNow(agent, signal, commandId)` with an
  `AbortSignal` this plugin owns. Cancellation aborts that signal, which reaches
  the summarizer request.
- A start that races a newly opened turn is retried after
  `retryDelayMs`, up to `maxQueueAttempts` times, before the failure is written
  to the row. Queue state is per agent and in memory.
- Nothing runs while the agent is busy: the queue waits for the agent to go idle
  and then starts in maintenance, exactly where the built-in command would have
  run.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `retryDelayMs` | `250` | wait before retrying a start that raced a new turn |
| `maxQueueAttempts` | `40` | start attempts before the queued failure is reported |

Configuration is optional; the bundle layer supplies no config at all.

## Requirements

- DeepSeek Harness `0.2.1-rc.5` (other releases may differ).
- Node.js `>=20.3`, which provides `AbortSignal.any`.

## Install

The package is a DSH bundle: `package.json` declares `dsh.bundle.patch`, so the
standard install also mounts the commands.

```bash
dsh plugin --profile web add github:imrcpan/dsh-compact-enhanced
```

Restart the profile afterwards; the composition is read at boot. The shipped
layer ([cordis.patch.yml](./cordis.patch.yml)) inserts the plugin row.

### Install from a checkout

Install the checkout as a bundle so its manifest applies:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-compact-enhanced
```

A plain `file:` dependency is also accepted, but then no bundle layer is
applied and the row from [example/cordis.patch.yml](./example/cordis.patch.yml)
has to be copied into the profile's `cordis.patch.yml` by hand.

## Limitations

- There is no client-side button. Cancellation is the `/compact-cancel` command;
  it works because `/compact` returns before the summarizer starts.
- The queue lives in memory. A host restart ends the turn and drops the queued
  request; run `/compact` again afterwards.
- Automatic pressure compaction is untouched; only the manual command is
  wrapped. A queued request still compacts if an automatic run already did the
  work, because the queue cannot know what the next idle check will find.
- Cancellation reporting is immediate, but the final row settles when the
  compaction engine returns from the aborted request.

## License

MIT.
