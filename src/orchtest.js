// Test orchestrators (the settings page): the same few scenes for each model marked as one, each a
// single request checked on what it does (answers, or one handoff with a prompt and a real model),
// not on taste. What it says about a model is what breaks orchestration: handoffs without a prompt,
// models that aren't yours, the same job twice, a model it was told is out of quota, checking again
// what was reported done.
import { orchestratorSetup } from './agent.js'

const HARD = 'write lru.py: a thread-safe LRU cache with per-key TTL and O(1) get/put, plus test_lru.py with edge cases, and run the tests'

// scene: { name, messages(first) (after the system prompt; first: a model of the team), check(reply, first) → why it failed or '' }
const SCENES = [
  { name: 'answers "hi" itself', messages: () => [{ role: 'user', content: 'hi' }], check: (r) => (r.calls.length ? 'handed a greeting to another model' : !r.content.trim() ? 'said nothing' : '') },
  { name: 'hands a small job to one model', messages: () => [{ role: 'user', content: 'list the files in this folder' }], check: (r) => one(r) },
  { name: 'hands a big job to one model', messages: () => [{ role: 'user', content: HARD }], check: (r) => one(r) },
  {
    name: 'picks another model after a failure',
    messages: (first) => [
      { role: 'user', content: HARD },
      { role: 'assistant', content: '', tool_calls: [call('t1', { description: 'Write LRU cache and tests', model: first, prompt: `${HARD}. Report what you did and the test output.` })] },
      { role: 'tool', tool_call_id: 't1', content: `error: ${first} is out of quota for 600 more minutes (its provider said so); hand it to another model` },
    ],
    check: (r, first) => one(r) || (r.calls[0].model === first ? `handed it to ${first} again` : ''),
  },
  {
    name: 'reports what was done',
    messages: (first) => [
      { role: 'user', content: HARD },
      { role: 'assistant', content: '', tool_calls: [call('t1', { description: 'Write LRU cache and tests', model: first, prompt: `${HARD}. Report what you did and the test output.` })] },
      { role: 'tool', tool_call_id: 't1', content: 'Created lru.py (LRUCache: OrderedDict + a lock, per-key TTL checked on get) and test_lru.py (11 tests: eviction order, TTL expiry, update, capacity 1, threads).\n\n$ python3 -m pytest -q\n...........  11 passed in 0.31s' },
    ],
    check: (r) => (r.calls.length ? 'handed out the finished work again' : !r.content.trim() ? 'said nothing' : ''),
  },
]
const call = (id, args) => ({ id, type: 'function', function: { name: 'agent', arguments: JSON.stringify(args) } })

// exactly one handoff, with a prompt and one of your models
function one(r) {
  if (!r.calls.length) return r.content.trim() ? "answered itself instead of handing it out" : 'did nothing'
  if (r.calls.length > 1) return `${r.calls.length} handoffs for one job`
  const c = r.calls[0]
  if (c.bad) return `a handoff that isn't JSON: ${c.bad.slice(0, 80)}`
  if (!String(c.prompt ?? '').trim()) return 'a handoff without a prompt'
  if (!c.real) return c.model ? `"${c.model}" isn't one of your models` : 'a handoff without a model'
  return ''
}

// What it did, in a few words: answered "…", or handed to which model what
const said = (t, n) => (t = String(t ?? '').replace(/\s+/g, ' ').trim()).length > n ? `${t.slice(0, n)}…` : t
const didOf = (r) =>
  r.calls.length ? r.calls.map((c) => (c.bad ? 'a handoff that isn\'t JSON' : `handed to ${c.model || '(no model)'}: "${said(c.description || c.prompt, 70)}"`)).join('; ') : r.content.trim() ? `answered: "${said(r.content, 90)}"` : 'said nothing'

// One orchestrator (client: its own, no retries) handing work to team, each scene's answer awaited
// for ms (the settings page's Tests wait): { passed, of, ms, fails: [{ scene, why }],
// steps: [{ scene, ok, why, did, ms }] }. onStep({ i, of, scene, asking }) as a scene starts, onStep({ i, of, ...step }) as it ends.
export async function testOrchestrator(client, root, team, ms, signal, onStep = () => {}) {
  const { system, tools } = orchestratorSetup(root, team)
  const names = team.map((t) => `${t.provider} ${t.model}`)
  const real = (m) => team.some((t) => [`${t.provider} ${t.model}`, `${t.provider}/${t.model}`, t.model].includes(m) || String(m).endsWith(` ${t.model}`) || t.model.endsWith(`/${m}`)) // as the agent tool takes it
  const first = names[0]
  const fails = []
  const steps = []
  const t0 = Date.now()
  for (const [i, scene] of SCENES.entries()) {
    if (signal?.aborted) break
    let why, did
    const s0 = Date.now()
    onStep({ i, of: SCENES.length, scene: scene.name, asking: true })
    const wait = AbortSignal.timeout(ms) // one that hasn't answered by then fails the scene
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
      const r = { content: res.content ?? '', calls }
      why = scene.check(r, first)
      did = didOf(r)
    } catch (e) {
      if (signal?.aborted) break
      why = wait.aborted ? `no answer within ${ms / 1000} seconds` : `the request failed: ${said(e.message, 160)}`
      did = 'no answer'
    }
    if (why) fails.push({ scene: scene.name, why })
    const step = { scene: scene.name, ok: !why, why, did, ms: Date.now() - s0, ...(wait.aborted && { slow: true }) }
    steps.push(step)
    onStep({ i, of: SCENES.length, ...step })
  }
  return { passed: SCENES.length - fails.length, of: SCENES.length, ms: Date.now() - t0, fails, steps }
}
