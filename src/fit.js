// "Best fit" (modelChoice: 'fit'): your models are a pool, not a ranking. For each new message one
// short request to the model in use ranks the ones that can do the job (tools, images, room for the
// conversation: checked here) by what each is good and weak at and how it did in your tests: who
// works on it (and who next when that one fails), who reviews the work, who looks at pages. Your
// list's order only breaks ties. A message that only says to go on keeps the last pick.
import { prompt } from './prompts.js'
import { loadStrengths, strengthKey } from './strengths.js'
import { readJson, HOME } from './config.js'
import { log } from './log.js'
import path from 'node:path'

const name = (t) => `${t.provider} ${t.model}`
const GO_ON = /^\s*(continue|go on|carry on|keep going|resume|proceed|ok(ay)?|yes|do it|go ahead)\W*$/i

// One model's line for a pick (also the team list): what it can do, what it's good and weak at, how
// it did when you tested it ("Test all").
export function modelFacts(t) {
  const known = loadStrengths()[strengthKey(t.model)]
  const test = readJson(path.join(HOME, 'model-tests.json'), {})[`${t.provider}/${t.model}`]
  return [
    [t.tools ? 'tool calls' : 'no tool calls', t.images && 'images', t.thinking && 'thinking', t.context && `${Math.round(t.context / 1000)}k context`].filter(Boolean).join(', '),
    known && !/^unknown/i.test(known.good) && `good at: ${known.good}`,
    known?.weak && !/^unknown/i.test(known.weak) && `weak at: ${known.weak}`,
    test && (test.ok ? `answered your test in ${(test.ms / 1000).toFixed(1)}s` : 'failed your last test'),
  ]
    .filter(Boolean)
    .join('; ')
}

// { work, review, look, why } (names, best first), kept in chat.fit; null when there's nothing to choose.
export async function pickModels(s, task, signal, { images = 0, size = 0 } = {}) {
  const all = s.allModels?.() ?? []
  const can = all.filter((t) => t.tools && (!images || t.images) && (!size || !t.context || t.context > size * 1.2))
  if (can.length < 2) return null
  if (GO_ON.test(task) && s.chat.fit) return s.chat.fit // the same work: the same models (and the provider's cache still holds)
  const list = can.map((t, i) => `${i + 1}. ${name(t)}: ${modelFacts(t)}`).join('\n')
  const seers = all.filter((t) => t.images)
  const ask = prompt('agent/pick-models', { task: task.slice(0, 1500), choices: (s.chat.choices ?? []).join('; '), list, seers: seers.map((t, i) => `${i + 1}. ${name(t)}: ${modelFacts(t)}`).join('\n') })
  s.ui.spinner('picking the best of your models for this')
  const was = s.client.purpose
  s.client.purpose = 'pick-models'
  let said = ''
  try {
    said = (await s.client.chat({ messages: [{ role: 'user', content: ask }] }, { signal })).content
  } catch (e) {
    if (signal?.aborted) throw e
    log('fit', `no pick (${e.message}): your order`)
    return null
  } finally {
    s.client.purpose = was
    s.ui.stopSpin()
  }
  const line = (w) => new RegExp(`^\\W*${w}\\W*:\\s*(.+)$`, 'im').exec(said)?.[1] ?? ''
  const numbers = (w, from) => [...new Set([...line(w).matchAll(/\d+/g)].map((m) => from[Number(m[0]) - 1]).filter(Boolean).map(name))]
  const byName = (w, from) => from.filter((t) => line(w).toLowerCase().includes(t.model.toLowerCase())).map(name)
  const pick = (w, from) => (numbers(w, from).length ? numbers(w, from) : byName(w, from))
  const work = pick('work', can)
  if (!work.length) {
    log('fit', `no usable pick: ${said.slice(0, 200)}`)
    return null
  }
  const fit = { work, review: pick('review', can), look: /\d/.test(line('look')) ? [...new Set([...line('look').matchAll(/\d+/g)].map((m) => seers[Number(m[0]) - 1]).filter(Boolean).map(name))] : byName('look', seers), why: line('why').slice(0, 120) }
  log('fit', fit)
  s.chat.fit = fit
  return fit
}

// Others (reviewers, page checkers) in the pick's order, the rest after in your list's order.
export const byPick = (models, names = []) => [...models].sort((a, b) => ((names.indexOf(name(a)) + 1 || 1e9) - (names.indexOf(name(b)) + 1 || 1e9)))
