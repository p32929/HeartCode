// "Best fit" (modelChoice: 'fit'): for each new message, your models ranked by how good each is at
// what this message needs — by public rankings (rankings.js), not by a model's opinion of models.
// One short request names the skills the task needs (web pages, code, images…); the rest is
// arithmetic: who leads the work (and who next when one fails) and who reviews it (not the lead).
// A model the rankings don't know comes after those they do, in your order. A message that only says to go on keeps the last pick.
// "Your order" (the default): none of this — your list as you set it.
import { prompt } from './prompts.js'
import { log } from './log.js'
import { rankings, score, SKILLS } from './rankings.js'

const name = (t) => `${t.provider} ${t.model}`
const GO_ON = /^\s*(continue|go on|carry on|keep going|resume|proceed|ok(ay)?|yes|do it|go ahead)\W*$/i

// The skills this task needs, from SKILLS: { work: [...] } — asked of the model in use (naming
// what a task needs is easy; judging models is what the rankings are for). ['coding'] when it can't say.
async function skillsFor(s, task, signal) {
  const ask = prompt('agent/pick-skills', { task: task.slice(0, 1500), choices: (s.chat.choices ?? []).join('; '), skills: Object.entries(SKILLS).map(([k, [, , what]]) => `${k}: ${what}`).join('\n') })
  const was = s.client.purpose
  s.client.purpose = 'pick-skills'
  try {
    const said = (await s.client.chat({ messages: [{ role: 'user', content: ask }] }, { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) })).content
    const line = /^\W*skills?\W*:\s*(.+)$/im.exec(said)?.[1] ?? said
    const named = Object.keys(SKILLS).filter((k) => new RegExp(`(^|[^\\w-])${k}($|[^\\w-])`, 'i').test(line))
    return named.length ? named : ['coding']
  } catch (e) {
    if (signal?.aborted) throw e
    log('fit', `no skills named (${e.message}): coding`)
    return ['coding']
  } finally {
    s.client.purpose = was
  }
}

// { work, review, why } (names, best first), kept in chat.fit; null when there's nothing to choose.
export async function pickModels(s, task, signal, { images = 0, size = 0 } = {}) {
  const all = s.allModels?.() ?? []
  const can = all.filter((t) => t.tools && (!images || t.images) && (!size || !t.context || t.context > size * 1.2))
  if (can.length < 2) return null
  if (GO_ON.test(task) && s.chat.fit) return s.chat.fit // the same work: the same models (and the provider's cache still holds)
  const data = await rankings({ signal, onWait: () => s.ui.spinner('getting the model rankings (once a week)') })
  s.ui.stopSpin()
  if (!data) return null
  s.ui.spinner('what does this task need')
  const skills = await skillsFor(s, task, signal)
  s.ui.stopSpin()
  if (images && !skills.includes('vision')) skills.push('vision')
  // best first by score; not ranked: after, in your order
  const ranked = (models, wanted) =>
    models
      .map((t, i) => ({ t, i, sc: score(t.model, wanted, data) }))
      .sort((a, b) => (a.sc ?? 2) - (b.sc ?? 2) || a.i - b.i)
  const order = ranked(can, skills)
  const lead = name(order[0].t)
  const fit = {
    work: order.map((x) => name(x.t)),
    review: ranked(can, ['coding', 'hard']).filter((x) => x.sc != null).map((x) => name(x.t)).filter((n) => n !== lead).slice(0, 2),
    why: skills.join(', '),
  }
  log('fit', { skills, scores: order.slice(0, 8).map((x) => `${x.t.model} ${x.sc == null ? 'not ranked' : x.sc.toFixed(2)}`), review: fit.review })
  s.chat.fit = fit
  return fit
}

// Others (reviewers, page checkers) in the pick's order, the rest after in your list's order.
export const byPick = (models, names = []) => [...models].sort((a, b) => ((names.indexOf(name(a)) + 1 || 1e9) - (names.indexOf(name(b)) + 1 || 1e9)))
