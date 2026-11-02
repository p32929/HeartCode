// What each of your models is good and bad at: learned once per model (a web search, summed up by
// the model in use), kept for every project in ~/.heart/model-strengths.json, and told to the model
// with the list of your other models, so it hands each part of a job to the one best at it.
import path from 'node:path'
import { HOME, readJson, writeJson } from './config.js'
import { webSearch } from './web.js'
import { prompt } from './prompts.js'
import { log } from './log.js'

const FILE = path.join(HOME, 'model-strengths.json')
// the same model through any provider: "openai/gpt-x:free" and "gpt-x" are one
export const strengthKey = (model) => String(model).toLowerCase().replace(/^.*\//, '').replace(/:(free|latest|beta)$/, '')
export const loadStrengths = () => readJson(FILE, {})

// The models in `models` not known yet: looked up now, a few at a time.
export async function learnStrengths(s, models, signal) {
  const known = loadStrengths()
  const missing = [...new Map(models.map((m) => [strengthKey(m.model), m.model])).entries()].filter(([k]) => !known[k])
  if (!missing.length) return
  let done = 0
  const show = () => s.ui.spinner(`learning what your models are good at (${done}/${missing.length}) — once per model`)
  show()
  const one = async ([k, model]) => {
    const found = await webSearch(`${model} LLM strengths weaknesses benchmarks`, { signal, limit: 6 }).catch((e) => (signal?.aborted ? Promise.reject(e) : `error: ${e.message}`))
    const was = s.client.purpose
    s.client.purpose = 'strengths'
    let said = ''
    try {
      said = (await s.client.chat({ messages: [{ role: 'user', content: prompt('agent/strengths', { model, found }) }] }, { signal })).content
    } catch (e) {
      if (signal?.aborted) throw e
      log('strengths', `${model}: ${e.message}`)
    } finally {
      s.client.purpose = was
    }
    const line = (word) => new RegExp(`^\\W*${word}\\W*:\\s*(.+)$`, 'im').exec(said)?.[1].trim() ?? ''
    if (line('good')) {
      known[k] = { good: line('good'), weak: line('weak'), learned: new Date().toISOString().slice(0, 10) }
      writeJson(FILE, known) // kept as it goes: Esc halfway loses nothing
    } else log('strengths', `${model}: no answer to keep (${said.slice(0, 120)})`) // asked again next time
    done++
    show()
  }
  // ponytail: 4 at a time so the search engines don't refuse; more if a first run with many models feels slow
  const queue = [...missing]
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) await one(queue.shift())
  }))
  s.ui.stopSpin()
  s.ui.step('models', `learned what ${missing.filter(([k]) => known[k]).length} of ${missing.length} model(s) are good at`)
}
