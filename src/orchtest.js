// Test orchestrators (the settings page): the same few scenes for each model marked as one, each
// checked on what it does (answers, or one handoff a model can work from), not on taste. Each scene
// is asked twice at once and the worse counts (a model answers differently each time). No answer in
// time (Tests wait) is no result, not a mistake: what's scored is how it orchestrates.
import { orchestratorSetup, codeLines } from './agent.js'

const LRU = 'write lru.py: a thread-safe LRU cache with per-key TTL and O(1) get/put, plus test_lru.py with edge cases, and run the tests'
const GAME = 'make me a car racing game in 3D with beautiful looking cars and nice roads, in the browser'

// scene: { name, messages(first) (after the system prompt; first: a model of the team), check(reply, first) → why it failed or '' }
const SCENES = [
  { name: 'answers "hi" itself', messages: () => [{ role: 'user', content: 'hi' }], check: (r) => (r.calls.length ? 'handed a greeting to another model' : !r.content.trim() ? 'said nothing' : '') },
  { name: 'answers a question it knows itself', messages: () => [{ role: 'user', content: "in JavaScript, what's the difference between let and const?" }], check: (r) => (r.calls.length ? 'handed out a question it could answer' : !r.content.trim() ? 'said nothing' : '') },
  { name: 'hands a small job to one model', messages: () => [{ role: 'user', content: 'list the files in this folder' }], check: (r) => one(r) },
  { name: 'hands a big job to one model, with a prompt it can work from and a check', messages: () => [{ role: 'user', content: GAME }], check: (r) => (r.asked && !r.calls.length ? '' : one(r) || checked(r)) }, // asking the user how first is fine too
  {
    name: 'picks another model after a failure',
    messages: (first) => [
      { role: 'user', content: LRU },
      { role: 'assistant', content: '', tool_calls: [call('t1', { description: 'Write LRU cache and tests', model: first, prompt: `${LRU}. Report what you did and the test output.` })] },
      { role: 'tool', tool_call_id: 't1', content: `error: ${first} is out of quota for 600 more minutes (its provider said so); hand it to another model` },
    ],
    check: (r, first) => one(r) || (r.calls[0].model === first ? `handed it to ${first} again` : '') || checked(r),
  },
  {
    name: 'reports what was done',
    messages: (first) => [
      { role: 'user', content: LRU },
      { role: 'assistant', content: '', tool_calls: [call('t1', { description: 'Write LRU cache and tests', model: first, prompt: `${LRU}. Report what you did and the test output.` })] },
      { role: 'tool', tool_call_id: 't1', content: 'Created lru.py (LRUCache: OrderedDict + a lock, per-key TTL checked on get) and test_lru.py (11 tests: eviction order, TTL expiry, update, capacity 1, threads).\n\n$ python3 -m pytest -q\n...........  11 passed in 0.31s' },
    ],
    check: (r) => (r.calls.length ? 'handed out the finished work again' : !r.content.trim() ? 'said nothing' : ''),
  },
]
export const SCENE_COUNT = SCENES.length
const call = (id, args) => ({ id, type: 'function', function: { name: 'agent', arguments: JSON.stringify(args) } })

// exactly one handoff a model can work from: a prompt that says the job (not one pointing at text
// it can't see) and one of your models; the work not written in the reply instead
function one(r) {
  if (!r.calls.length) return codeLines(r.content) > 30 ? 'wrote the work in its reply instead of handing it out' : r.content.trim() ? 'answered itself instead of handing it out' : 'did nothing'
  if (r.calls.length > 1) return `${r.calls.length} handoffs for one job`
  const c = r.calls[0]
  if (c.bad) return `a handoff that isn't JSON: ${c.bad.slice(0, 80)}`
  const p = String(c.prompt ?? '').trim()
  if (!p) return 'a handoff without a prompt'
  if (p.length < 40) return `a prompt too thin to work from ("${p}")`
  if (/\b(previous|above|earlier|last) (answer|reply|response|message|code)\b|as (described|shown) (above|earlier)/i.test(p)) return "its prompt points at text the model can't see"
  if (!c.real) return c.model ? `"${c.model}" isn't one of your models` : 'a handoff without a model'
  return ''
}

// a job that makes something carries a check HeartCode runs (else it's only the model's word)
const checked = (r) => (String(r.calls[0].check ?? '').trim() ? '' : 'no check: nothing would prove the work was done')

// What it did, in a few words: answered "…", or handed to which model what
const said = (t, n) => (t = String(t ?? '').replace(/\s+/g, ' ').trim()).length > n ? `${t.slice(0, n)}…` : t
const didOf = (r) =>
  r.asked && !r.calls.length ? 'asked the user a question first' : r.calls.length ? r.calls.map((c) => (c.bad ? "a handoff that isn't JSON" : `handed to ${c.model || '(no model)'}: "${said(c.description || c.prompt, 70)}"`)).join('; ') : r.content.trim() ? `answered: "${said(r.content, 90)}"` : 'said nothing'

// One orchestrator (client: its own, no retries) handing work to team, each answer awaited for ms
// (the settings page's Tests wait): { passed, of, fails, slow, ms, steps: [{ i, scene, ok, why, did, ms, slow }] }
// (fails: its mistakes; slow: scenes with no answer in time). Every scene at once, each request when
// its provider has room (gate). onStep({ i, of, scene, asking }) as a scene starts, onStep({ i, of,
// ...step }) as it ends (in any order: i says which).
export async function testOrchestrator(client, root, team, ms, signal, onStep = () => {}, gate = (fn) => fn()) {
  const { system, tools } = orchestratorSetup(root, team)
  const real = (m) => team.some((t) => [`${t.provider} ${t.model}`, `${t.provider}/${t.model}`, t.model].includes(m) || String(m).endsWith(` ${t.model}`) || t.model.endsWith(`/${m}`)) // as the agent tool takes it
  const first = `${team[0].provider} ${team[0].model}`
  // one try of a scene: { ok, why, did, slow }
  const once = (scene, sent) => gate(() => (sent(), tryOnce(scene)))
  const tryOnce = async (scene) => {
    const wait = AbortSignal.timeout(ms)
    try {
      const res = await client.chat({ messages: [{ role: 'system', content: system }, ...scene.messages(first)], tools }, { signal: signal ? AbortSignal.any([signal, wait]) : wait })
      const calls = (res.toolCalls ?? []).filter((c) => c.function.name === 'agent').map((c) => {
        try {
          const a = JSON.parse(c.function.arguments || '{}')
          return { ...a, real: real(a.model) }
        } catch {
          return { bad: String(c.function.arguments) }
        }
      })
      const r = { content: res.content ?? '', calls, asked: (res.toolCalls ?? []).some((c) => c.function.name === 'ask_user') }
      const why = scene.check(r, first)
      return { ok: !why, why, did: didOf(r) }
    } catch (e) {
      if (signal?.aborted) throw e
      return wait.aborted ? { ok: false, slow: true, why: `no answer within ${ms / 1000} seconds`, did: 'no answer' } : { ok: false, why: `the request failed: ${said(e.message, 160)}`, did: 'no answer' }
    }
  }
  const t0 = Date.now()
  const steps = (
    await Promise.all(
      SCENES.map(async (scene, i) => {
        if (signal?.aborted) return null
        let s0 = 0
        const sent = () => s0 || ((s0 = Date.now()), onStep({ i, of: SCENES.length, scene: scene.name, asking: true })) // its first request sent (not waiting for room)
        let tries
        try {
          tries = await Promise.all([once(scene, sent), once(scene, sent)])
        } catch {
          return null // stopped
        }
        // the worse: a mistake over no answer over a pass
        const step = { i, scene: scene.name, ms: Date.now() - s0, ...(tries.find((x) => !x.ok && !x.slow) ?? tries.find((x) => x.ok) ?? tries[0]) }
        onStep({ of: SCENES.length, ...step })
        return step
      }),
    )
  ).filter(Boolean)
  const fails = steps.filter((x) => !x.ok && !x.slow).map((x) => ({ scene: x.scene, why: x.why }))
  return { passed: steps.filter((x) => x.ok).length, of: SCENES.length, fails, slow: steps.filter((x) => x.slow).length, ms: Date.now() - t0, steps }
}
