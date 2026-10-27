import { fmtDate, shout } from './utils.js'

const today = fmtDate(new Date('2026-01-02T00:00:00Z'))
console.log(shout('date ' + today))
