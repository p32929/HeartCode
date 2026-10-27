// heartcode -w / --worktree=name: work in a git worktree of its own, on its own branch, so the
// task's changes stay apart from yours until you merge them. It goes in
// <repo>/.heartcode/worktrees/<name> (kept out of git status), on the branch heartcode/<name>,
// from the current commit. The same name again continues in the same worktree.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function createWorktree(root, name) {
  let top
  try {
    top = git(root, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new Error(`--worktree needs a git repository; ${root} isn't in one`)
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  name = String(name || `task-${stamp}`).replace(/[^\w.-]+/g, '-')
  const dir = path.join(top, '.heartcode', 'worktrees', name)
  const branch = `heartcode/${name}`
  const base = git(top, ['rev-parse', 'HEAD'])
  if (!fs.existsSync(dir)) {
    const exists = (() => {
      try {
        git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
        return true
      } catch {
        return false
      }
    })()
    git(top, ['worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir, 'HEAD'])])
  }
  // keep the worktrees out of the main checkout's git status and file list
  const exclude = path.join(path.resolve(top, git(top, ['rev-parse', '--git-common-dir'])), 'info', 'exclude')
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  if (!text.split('\n').includes('.heartcode/worktrees/')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}.heartcode/worktrees/\n`)
  }
  return { name, dir, branch, top, base, cwd: path.join(dir, path.relative(top, root)) }
}

// What the worktree holds now: uncommitted changes and commits on its branch since it was made.
export function worktreeState(wt) {
  const changes = git(wt.dir, ['status', '--porcelain']).split('\n').filter(Boolean).length
  const commits = Number(git(wt.dir, ['rev-list', '--count', `${wt.base}..HEAD`]))
  return { changes, commits, empty: !changes && !commits }
}

export function removeWorktree(wt) {
  git(wt.top, ['worktree', 'remove', '--force', wt.dir])
  try {
    git(wt.top, ['branch', '-D', wt.branch])
  } catch {}
}
