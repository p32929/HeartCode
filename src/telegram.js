// Telegram notifications: HeartCode messages you through your own bot when a task finishes, fails
// or waits for you (a question, a permission). Telegram's Bot API (https://core.telegram.org/bots/api):
// getMe checks the token, getUpdates finds your chat once you've pressed Start in the bot,
// sendMessage sends (plain text, 4096 characters at most). Set up on the settings page
// (cfg.telegram: { token, chatId, chatName, bot, on, events }). The token is never logged or shown whole.
import { log } from './log.js'
import { saveConfig } from './config.js'

const API = process.env.HEART_TELEGRAM_API || 'https://api.telegram.org' // the env: a stand-in server, for tests
export const EVENTS = {
  done: 'A task finished',
  failed: 'A task failed',
  waiting: 'HeartCode is waiting for an answer (a question or a permission)',
}

async function call(token, method, body = {}, timeout = 15_000) {
  let res
  try {
    res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  } catch (e) {
    throw new Error(`can't reach Telegram (${e.cause?.code || e.name})`) // not e.message: the URL has the token in it
  }
  const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
  if (!j.ok) throw Object.assign(new Error(j.error_code === 401 || j.error_code === 404 ? 'Telegram refused the bot token (check it in @BotFather)' : j.description || `HTTP ${res.status}`), { code: j.error_code, retryAfter: j.parameters?.retry_after })
  return j.result
}

// The token shown to people: its bot's number and the last 4 characters.
export const tokenHint = (token) => (token ? `${String(token).split(':')[0]}:…${String(token).slice(-4)}` : '')

// A token checked, and the chats that have written to the bot (newest first): { bot, chats: [{ id, name }] }.
// None yet: the user hasn't pressed Start in the bot (or wrote to it more than a day ago).
export async function connect(token) {
  const me = await call(token, 'getMe')
  const updates = await call(token, 'getUpdates', { limit: 100, allowed_updates: ['message'] }).catch((e) => {
    if (e.code === 409) throw new Error('this bot is set up with a webhook, so its messages can\'t be read here: use a bot of its own for HeartCode')
    throw e
  })
  const chats = new Map()
  for (const u of [...updates].reverse()) {
    const chat = u.message?.chat
    if (!chat || chats.has(chat.id)) continue
    chats.set(chat.id, { id: chat.id, name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id)) })
  }
  return { bot: me.username, chats: [...chats.values()] }
}

export const tgReady = (t) => Boolean(t?.token && t?.chatId && t.on !== false)

// One message; a rate limit is waited out once (Telegram says how long).
export async function sendTelegram(t, text, { silent = false } = {}) {
  const body = { chat_id: t.chatId, text: String(text).slice(0, 4096), disable_notification: silent, link_preview_options: { is_disabled: true } }
  try {
    return await call(t.token, 'sendMessage', body)
  } catch (e) {
    if (!e.retryAfter) throw e
    await new Promise((r) => setTimeout(r, Math.min(e.retryAfter, 60) * 1000))
    return await call(t.token, 'sendMessage', body)
  }
}

// An event, if Telegram is set up and that event is on. Never waits on it, never throws: a
// notification that can't be sent is logged, the work goes on.
// A token saved before Start was pressed in the bot has no chat yet: it's looked up then (and kept).
export function notify(cfg, event, text) {
  const t = cfg?.telegram
  if (!t?.token || t.on === false || t.events?.[event] === false) return
  const chat = t.chatId ? Promise.resolve(t) : findChat(cfg)
  chat.then((ready) => ready && sendTelegram(ready, text)).catch((e) => log('telegram', `${event}: couldn't send (${e.message})`))
}
async function findChat(cfg) {
  const { chats } = await connect(cfg.telegram.token)
  if (!chats.length) {
    log('telegram', "no chat yet: press Start in the bot (Telegram), then HeartCode finds it")
    return null
  }
  Object.assign(cfg.telegram, { chatId: chats[0].id, chatName: chats[0].name })
  saveConfig(cfg)
  log('telegram', `found the chat: ${chats[0].name}`)
  return cfg.telegram
}
