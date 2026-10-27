export function fmtDate(d) {
  return d.toISOString().slice(0, 10)
}

export function shout(s) {
  return s.toUpperCase() + '!'
}
