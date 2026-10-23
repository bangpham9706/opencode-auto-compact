opencode-auto-compact
=====================

Predictive auto-compaction for [OpenCode](https://opencode.ai) V2 — a plugin
that triggers compaction *before* the context window overflows, based on how
much context each user turn in your session actually costs.

> **Great together:** pair this with
> [opencode-vcc](https://github.com/bangpham9706/opencode-vcc).
> opencode-auto-compact answers *when* to compact; opencode-vcc answers
> *how* the summary is written (algorithmic, structured, with full `vcc_recall`
> access to everything that gets dropped). Install both and they cooperate
> with zero configuration.

What it does
------------

OpenCode already compacts automatically, but only *after* the context window
is (nearly) full — often the very turn that overflows is the expensive one.
`opencode-auto-compact` instead:

1. **Tracks the cost of every user turn.** After each completed turn it
   records how many tokens the session's context grew by, keeping a rolling
   average of the last N turns.
2. **Predicts the next turn.** At prompt admission — before the agent starts
   answering — it estimates the context size as *current tokens + average
   turn cost*.
3. **Compacts early when needed.** If the estimate would cross a target
   percentage of the model's context window (60% by default), it requests
   compaction *before* the model call, so your prompt is answered against a
   freshly compacted (summarized) context instead of one that silently
   overflows or gets cut mid-work.

Everything is tunable by editing constants at the top of the plugin file.

Install
-------

Clone the plugin directly into OpenCode's global plugin directory. It has **no
npm dependencies** (it uses only the plugin framework the binary provides), so
there is nothing to install beyond the clone:

```bash
git clone https://github.com/bangpham9706/opencode-auto-compact \
  ~/.config/opencode/plugins/opencode-auto-compact
opencode service restart
```

That is everything: any directory under `~/.config/opencode/plugins/` is
auto-discovered and loaded for every project.

Verify it loaded — the plugin's log file should show a startup line:

```bash
tail /tmp/opencode/auto-compact.log
# [timestamp] loaded: targetRatio=0.6, windowSize=10, cached limits=525
```

### Alternative: clone elsewhere, symlink into place

```bash
git clone https://github.com/bangpham9706/opencode-auto-compact ~/src/opencode-auto-compact
ln -s ~/src/opencode-auto-compact ~/.config/opencode/plugins/opencode-auto-compact
opencode service restart
```

The symlink is followed, so editing the source is immediately live after a
service restart.

Config
------

All knobs sit at the top of `~/.config/opencode/plugins/<dir>/index.ts` —
edit the file and run `opencode service restart`:

```ts
const TARGET_RATIO = 0.6      // compact when the estimated next context would
                              // exceed 60% of the model's context limit
const WINDOW_SIZE  = 10       // average the last N user turns for the estimate
const COOLDOWN_MS  = 60_000   // never re-trigger compaction more often than this
const MIN_TURNS    = 2        // don't predict until this many turns are tracked
const LOG_FILE     = "/tmp/opencode/auto-compact.log"
```

There is also an options path for `plugins`-list installs (`option.debug`).
Debug logging is on by default; set `"debug": false` (or flip `const debug`
in the file) to only log actual triggers.

Reading the log
---------------

Every completed turn logs its measured cost, and every prompt admission logs
the prediction:

```
turn tracked {"sessionID":"ses_…","total":412500,"delta":38210}
check {"current":412500,"avgDelta":39110,"estimated":451610,"threshold":330000,...}
TRIGGER: estimated next context 451610/550000 (82%) exceeds 60% target — compacting
compaction admitted {...}
```

If something does not match OpenCode's current event/payload shapes you will
see a `tracking error` / `prompt hook error` line with the cause — the fixes
are local to this plugin.

How it plays with OpenCode's own compaction
-------------------------------------------

The plugin runs alongside, not against, OpenCode's built-in threshold: the
built-in one reacts *after* the window fills, this one pre-empts *before* the
next turn. Whichever fires first wins; the other simply sees an already
compacted session and stands down. Manual `/compact` and `/vcc` still work
exactly as before.

Companion plugin
----------------

[opencode-vcc](https://github.com/bangpham9706/opencode-vcc) replaces the
compaction *summary* itself with a deterministic, no-LLM, section-structured
digest, and keeps every dropped message on disk for full-fidelity recall via
the `vcc_recall` tool. Trigger early (auto-compact) + summarize smartly
(vcc) = the two halves of a well-behaved long session.

Requirements
------------

* A recent OpenCode V2 build with the V2 plugin API
  (`Plugin.define` / `ctx.session.hook("prompt")` / `ctx.event.subscribe`).
* No model, provider, or npm dependencies.

License
-------

MIT. See `LICENSE`.
