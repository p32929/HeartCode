// npm start: installs HeartCode for this user (`heart` everywhere), then says how to use it.
// It's a link to this folder, so a change here (git pull) needs no new install.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['npm']
const r = spawnSync(npm[0], [...npm.slice(1), 'install', '--global', root], { stdio: 'inherit' })
if (r.status !== 0) {
  console.error(`
Couldn't install HeartCode for everywhere (npm install --global failed, above).
If it says EACCES (no permission): npm's global folder belongs to another user. Either
  npm config set prefix ~/.npm-global   and add ~/.npm-global/bin to your PATH, then npm start again
or run HeartCode from here without installing:   node ${path.join(root, 'bin', 'heart.js')}`)
  process.exit(r.status ?? 1)
}
const pink = (s) => (process.stdout.isTTY ? `\x1b[38;5;205m${s}\x1b[39m` : s)
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[22m` : s)
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s)
console.log(`
${pink('♥')} ${bold('HeartCode is installed.')} Thank you for trying it!

Run it with ${bold('heart')}:

  ${bold('heart')}                    open HeartCode in this folder
  ${bold('heart .')}                  the same: this folder
  ${bold('heart ~/code/my-app')}      open that folder ${dim('(a folder, not a file)')}
  ${bold('heart settings')}           providers, models and settings, in your browser
  ${bold('heart --help')}             everything else
`)
