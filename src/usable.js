// Which of the models you chose HeartCode can actually use, and why not: you pick what you like; it
// leaves out, for now, what can't work. One that's left out is still in your list (the settings page
// says why), and comes back once a test shows it works again.
const REFUSED = { 401: 'its provider refuses the key (401)', 403: "your key can't use this model (403)", 404: "its provider doesn't know this model's name (404)" }

// test: its last model test ({ ok, status }); context: the most it takes in one request here (its
// window, or a per-minute cap its provider stated); need: the size of its first request in the role;
// orch: as an orchestrator, its last Test ({ passed, of }). Returns why it can't be used, or ''.
export function whyUnusable({ test, context, need, orch }) {
  if (test && !test.ok && REFUSED[test.status]) return REFUSED[test.status]
  if (context > 0 && need > 0 && context < need) return `it takes at most ${context.toLocaleString()} tokens a request here, and its first one is ${need.toLocaleString()}`
  if (orch?.of > 0 && orch.passed === 0) return 'it failed every scene of the last Test'
  return ''
}
