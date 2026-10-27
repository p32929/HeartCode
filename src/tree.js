// A session as a tree: going back to an earlier message never loses what came after it. That part
// is kept as a branch, and /tree goes to any message on any branch, with the code following
// (each branch keeps the files as it left them). Leaving a branch can bring a summary of it into
// the one you go to, so what was tried there isn't lost (as pi does).
//
// The chat's own fields are the branch you're on. Every other branch is in chat.branches, whole:
// { id, left (when you left it), state: { messages, history, turns, … }, tip: { file: text | null } }
// (tip: the files that branch changed, as they were when you left it). Branches share their first
// messages; the tree is worked out from the turns they have in common.
// ponytail: each branch is stored whole (shared messages repeated); fine for chats of a few MB.
import fs from 'node:fs'
import path from 'node:path'

const STATE = ['messages', 'history', 'turns', 'epoch', 'snapshots', 'sentNotes', 'todos', 'log']
export const turnKey = (t) => t.id ?? `${t.at}\0${t.task}`

const stateOf = (chat) => Object.fromEntries(STATE.map((k) => [k, chat[k]]))
const keysOf = (turns) => turns.map(turnKey)
const isPrefix = (a, b) => a.length <= b.length && a.every((k, i) => k === b[i])
const common = (a, b) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}
const read = (root, rel) => {
  try {
    return fs.readFileSync(path.resolve(root, rel), 'utf8')
  } catch {
    return null
  }
}
const changed = (turns) => [...new Set(turns.flatMap((t) => Object.keys(t.files ?? {})))]

// The files a branch changed, as they are on disk now (the branch you're on owns the disk).
const tipNow = (chat) => Object.fromEntries(changed(chat.turns).map((rel) => [rel, read(chat.root, rel)]))

// A file as it was on a branch after its first `keep` messages: as it was before the next message
// that changed it, else as the branch left it. undefined: not known.
function fileAt(turns, tip, keep, rel) {
  for (const t of turns.slice(keep)) if (rel in (t.files ?? {})) return t.files[rel]
  return tip?.[rel]
}

// The state after the first `keep` messages (as /rewind did it: back to where each stood).
function cut(state, keep) {
  const t = state.turns[keep]
  if (!t) return state
  let { messages, history, snapshots, epoch } = state
  if ((t.epoch ?? 0) < (epoch ?? 0)) {
    ;({ messages, history } = snapshots[t.epoch ?? 0]) // from before a compaction
    snapshots = snapshots.slice(0, t.epoch ?? 0)
    epoch = t.epoch ?? 0
  }
  return { ...state, messages: t.msgIndex ? (messages?.slice(0, t.msgIndex) ?? null) : null, history: history.slice(0, t.histIndex), turns: state.turns.slice(0, keep), log: (state.log ?? []).slice(0, t.logIndex), sentNotes: [], epoch, snapshots, todos: [] }
}

// Every branch as { turns, branch (null: the one you're on) }.
const lines = (chat) => [{ turns: chat.turns, branch: null }, ...(chat.branches ?? []).map((b) => ({ turns: b.state.turns, branch: b }))]

// The tree, for a picker: one item per message, depth-first, the branch you're on first.
// Item: { label, desc, depth, task, branch, keep (messages before it on that branch), here, end }
export function treeItems(chat, ago = (x) => x) {
  const root = { kids: [] }
  for (const line of lines(chat)) {
    let node = root
    line.turns.forEach((t, k) => {
      let next = node.kids.find((n) => n.key === turnKey(t))
      if (!next) node.kids.push((next = { key: turnKey(t), turn: t, kids: [], on: [] }))
      next.on.push({ branch: line.branch, k })
      node = next
    })
    if (line.turns.length) (node.ends ??= []).push(line.branch)
  }
  const items = []
  const walk = (node, depth, lead) => {
    const kids = [...node.kids].sort((a, b) => Number(b.on.some((o) => !o.branch)) - Number(a.on.some((o) => !o.branch)))
    kids.forEach((n, i) => {
      const fork = kids.length > 1
      const d = depth + (fork ? 1 : 0)
      const mine = n.on.find((o) => !o.branch) ?? n.on[0] // on the branch you're on, if it is
      const here = Boolean(n.ends?.includes(null))
      const files = Object.keys(n.turn.files ?? {}).length
      items.push({
        label: `${lead}${fork ? (i === kids.length - 1 ? '└─ ' : '├─ ') : ''}${n.turn.task.split('\n')[0].slice(0, 70)}`,
        desc: [ago(n.turn.at), files && `${files} file${files > 1 ? 's' : ''}`, here && '● you are here', !here && n.ends && '◆ end of a branch'].filter(Boolean).join(' · '),
        depth: d,
        task: n.turn.task,
        branch: mine.branch,
        keep: mine.k,
        here,
        end: Boolean(n.ends),
      })
      walk(n, d, lead + (fork ? (i === kids.length - 1 ? '   ' : '│  ') : ''))
    })
  }
  walk(root, 0, '')
  return items
}

// Keeps the branch you're on (unless it's already all in a kept branch), with its files as now.
export function stash(chat) {
  if (!chat.turns.length) return
  const keys = keysOf(chat.turns)
  const kept = chat.branches ?? []
  if (kept.some((b) => isPrefix(keys, keysOf(b.state.turns)))) return
  chat.branches = kept.filter((b) => !isPrefix(keysOf(b.state.turns), keys)) // ones it grew from
  chat.branches.push({ id: Math.random().toString(36).slice(2, 8), left: new Date().toISOString(), state: structuredClone(stateOf(chat)), tip: tipNow(chat) })
}

// The files going to (branch, keep) changes, with what each becomes: [[rel, text | null]], and
// the ones whose content isn't known (a branch saved without them).
export function codePlan(chat, branch, keep) {
  const turns = branch ? branch.state.turns : chat.turns
  const tip = branch ? branch.tip : tipNow(chat)
  const c = common(keysOf(chat.turns), keysOf(turns.slice(0, keep)))
  const plan = []
  const unknown = []
  for (const rel of new Set([...changed(chat.turns.slice(c)), ...changed(turns.slice(c, keep))])) {
    let want = fileAt(turns, tip, keep, rel)
    if (want === undefined) want = fileAt(chat.turns, {}, c, rel) // never changed on that branch: as it was where they split
    if (want === undefined) unknown.push(rel)
    else if (want !== read(chat.root, rel)) plan.push([rel, want])
  }
  return { plan, unknown }
}

// How many messages of the branch you're on the point after `keep` messages of `branch` lacks.
export const leaving = (chat, branch, keep) => chat.turns.length - common(keysOf(chat.turns), keysOf((branch ? branch.state.turns : chat.turns).slice(0, keep)))

// Goes to the point after the first `keep` messages of `branch` (null: the one you're on). The
// branch you leave is kept. code: the files follow. Returns { left: the messages only the branch
// you left had (for a summary) with its state, files: the files written }.
export function move(chat, branch, keep, { code = true } = {}) {
  const target = branch ? branch.state : stateOf(chat)
  const theirs = keysOf(target.turns.slice(0, keep))
  const c = common(keysOf(chat.turns), theirs)
  const left = { state: structuredClone(stateOf(chat)), from: c, turns: chat.turns.slice(c) }
  const { plan } = code ? codePlan(chat, branch, keep) : { plan: [] }
  stash(chat) // before anything is written: it keeps the files as they are now
  if (branch && keep === target.turns.length) chat.branches = chat.branches.filter((b) => b !== branch) // you're on it now
  Object.assign(chat, structuredClone(cut(target, keep)))
  for (const [rel, text] of plan) {
    const abs = path.resolve(chat.root, rel)
    if (text === null) fs.rmSync(abs, { force: true })
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, text)
    }
  }
  return { left, files: plan.map(([rel]) => rel) }
}

// The part of the branch you left that the new one doesn't have, as text to summarize.
export function leftText(left, transcript) {
  const { state, from } = left
  const t = state.turns[from]
  if (!t) return ''
  if (state.messages?.length && (t.epoch ?? 0) === (state.epoch ?? 0)) return transcript(state.messages.slice(t.msgIndex))
  return state.history.slice(t.histIndex).map((h) => `User: ${h.task}\nAssistant: ${h.answer}`).join('\n\n')
}

export const leftFiles = (left) => changed(left.turns)
