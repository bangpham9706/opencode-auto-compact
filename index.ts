import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Config knobs — edit these or pass via plugin options in opencode.json
// ---------------------------------------------------------------------------
const TARGET_RATIO = 0.6 // compact when estimated next context > 60% of limit
const WINDOW_SIZE = 10 // average tokens/turn over last N turns
const COOLDOWN_MS = 60_000 // don't retrigger compaction within 1 minute
const MIN_TURNS = 2 // need at least 2 turns before predictions start
const LOG_FILE = "/tmp/opencode/auto-compact.log"

const log = (...args: unknown[]) => {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(" ")}\n`)
  } catch {
    // logging must never break the plugin
  }
}

interface Tokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** Total context tokens of a message, same formula the TUI context % display uses. */
function totalTokens(t?: Tokens): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0)
    + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}

export default Plugin.define({
  id: "auto-compact",
  async setup(ctx) {
    const opt = (ctx.options ?? {}) as {
      targetRatio?: number
      windowSize?: number
      cooldownMs?: number
      minTurns?: number
      debug?: boolean
    }
    const targetRatio = opt.targetRatio ?? TARGET_RATIO
    const windowSize = opt.windowSize ?? WINDOW_SIZE
    const cooldownMs = opt.cooldownMs ?? COOLDOWN_MS
    const minTurns = opt.minTurns ?? MIN_TURNS
    const debug = opt.debug !== false

    // eslint-disable-next-line no-use-before-define

    // ---------------- state ----------------
    // per session: last observed context total, per-turn deltas
    const lastTotal = new Map<string, number>()
    const deltas = new Map<string, number[]>() // token cost of each completed user turn
    const lastCompactAt = new Map<string, number>()
    // model limits: "providerID:id" -> context limit
    const limits = new Map<string, number>()

    async function refreshLimits() {
      try {
        const res = await ctx.model.list()
        const data = (res?.data ?? []) as Array<{ id: string; providerID: string; limit?: { context?: number } }>
        for (const m of data) {
          if (m.providerID && m.id && m.limit?.context)
            limits.set(`${m.providerID}:${m.id}`, m.limit.context)
        }
      } catch (e) {
        log("model.list failed", e)
      }    }
    await refreshLimits()
    log(`loaded: targetRatio=${targetRatio}, windowSize=${windowSize}, cached limits=${limits.size}`)

    async function getContext(sessionID: string) {
      return await (ctx.session.context({ sessionID }) as Promise<
        Array<{ type: string; tokens?: Tokens; status?: string }>
      >)
    }

    function currentTokens(messages: Awaited<ReturnType<typeof getContext>>): number {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!
        if (m.type === "assistant" && m.tokens) return totalTokens(m.tokens)
      }
      return 0
    }

    function hasRunningCompaction(messages: Awaited<ReturnType<typeof getContext>>): boolean {
      return messages.some((m) => m.type === "compaction" && m.status === "running")
    }

    function limitFor(session: { model?: { providerID: string; id: string } & Tokens }, messages: Awaited<ReturnType<typeof getContext>>): number {
      const m = session?.model
      if (m) {
        const key = `${m.providerID}:${m.id}`
        const cached = limits.get(key)
        if (cached) return cached
        if ((m as { limit?: { context?: number } }).limit?.context)
          return (m as { limit: { context: number } }).limit.context
      }
      // fallback: parse the "tokens/limit" percentage info if present — skip
      return 0
    }

    async function avgDeltaFor(sessionID: string): Promise<number> {
      const ds = deltas.get(sessionID) ?? []
      if (ds.length === 0) return 0
      const use = ds.slice(-windowSize)
      return use.reduce((a, b) => a + b, 0) / use.length
    }

    // ---------------- track tokens after every execution ----------------
    const controller = new AbortController()
    const pump = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.execution.succeeded") continue
          const sessionID = (event.data as { sessionID: string }).sessionID
          try {
            const messages = await getContext(sessionID)
            const total = currentTokens(messages)
            const prev = lastTotal.get(sessionID) ?? 0
            if (total > 0) {
              if (prev > 0 && total >= prev) {
                const arr = deltas.get(sessionID) ?? []
                arr.push(total - prev)
                deltas.set(sessionID, arr)
              }
              lastTotal.set(sessionID, total)
            }
            if (debug) {
              log("turn tracked", { sessionID, total, delta: prev > 0 ? total - prev : null })
            }
          } catch (e) {
            if (debug) log("tracking error", sessionID, e)
          }
        }
      } catch (e) {
        if (controller.signal.aborted) return
        log("event stream error", e)
      }
    })()

    // ---------------- predict + compact at prompt admission ----------------
    const hook = await ctx.session.hook("prompt", async (event: {
      sessionID: string
    }) => {
      const sessionID = event.sessionID
      try {
        const messages = await getContext(sessionID)
        if (hasRunningCompaction(messages)) {
          if (debug) log("skip: compaction already running", sessionID)
          return
        }

        const session = (await ctx.session.get({ sessionID })) as never as {
          model?: { providerID: string; id: string } & Tokens
        }
        const limit = limitFor(session, messages)
        if (!limit) {
          if (debug) log("skip: no limit known", session?.model)
          return
        }

        const avgDelta = await avgDeltaFor(sessionID)
        const turns = (deltas.get(sessionID) ?? []).length
        if (turns < minTurns) {
          if (debug) log("skip: not enough turn history", { sessionID, turns })
          return
        }

        const current = currentTokens(messages)
        const estimated = current + avgDelta
        const threshold = limit * targetRatio

        if (debug)
          log("check", {
            sessionID,
            current,
            avgDelta: Math.round(avgDelta),
            estimated,
            threshold: Math.round(threshold),
            limit,
            pct: `${Math.round((estimated / limit) * 100)}%`,
          })

        if (estimated <= threshold) return

        const last = lastCompactAt.get(sessionID) ?? 0
        if (Date.now() - last < cooldownMs) {
          if (debug) log("skip: cooldown", sessionID)
          return
        }

        log(`TRIGGER: estimated next context ${estimated}/${limit} (${Math.round((estimated / limit) * 100)}%) exceeds ${targetRatio * 100}% target — compacting`)
        lastCompactAt.set(sessionID, Date.now())
        const result = await ctx.session.compact({ sessionID })
        log("compaction admitted", result)
      } catch (e) {
        log("prompt hook error", e)
      }
    })

    return () => {
      controller.abort()
      void hook.dispose()
    }
  },
})
