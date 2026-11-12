import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';

export interface Worktree {
  /** Where the agent should run: the same subdirectory as the configured cwd, inside the worktree. */
  cwd: string;
  path: string;
  branch: string;
  created: boolean;
}

export interface WorktreeOpts {
  baseCwd: string;
  sessionKey: string;
  dir?: string;
  /** Untracked paths linked in from the main checkout (they never count as uncommitted work). */
  links?: string[];
}

interface Located {
  root: string;
  path: string;
  branch: string;
  cwd: string;
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function locate(opts: WorktreeOpts): Located {
  const root = tryGit(opts.baseCwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new Error(`${opts.baseCwd} is not inside a git repository, so it cannot get a worktree`);
  const slug = sessionSlug(opts.sessionKey);
  const path = join(expandHome(opts.dir ?? '~/.agents-bridge/worktrees'), basename(root), slug);
  return { root, path, branch: `bridge/${slug}`, cwd: join(path, relative(root, opts.baseCwd)) };
}

/**
 * One git worktree per bridge session, so parallel conversations never edit the same checkout.
 * Branch `bridge/<slug>` starts from whatever the main checkout has checked out, and remembers it
 * as its base (git config branch.<name>.bridgeBase) for status and merge.
 */
export function ensureWorktree(opts: WorktreeOpts): Worktree {
  const { root, path, branch, cwd } = locate(opts);
  if (existsSync(join(path, '.git'))) return { cwd, path, branch, created: false };

  mkdirSync(join(path, '..'), { recursive: true });
  const hasBranch = tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) !== undefined;
  if (!hasBranch) {
    const head = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const base = head === 'HEAD' ? git(root, ['rev-parse', 'HEAD']) : head;
    git(root, ['worktree', 'add', '-b', branch, path, 'HEAD']);
    git(root, ['config', `branch.${branch}.bridgeBase`, base]);
  } else {
    git(root, ['worktree', 'add', path, branch]);
  }

  for (const name of opts.links ?? []) {
    const src = join(root, name);
    const dst = join(path, name);
    if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
  }
  return { cwd, path, branch, created: true };
}

export interface WorktreeStatus {
  path: string;
  branch: string;
  base: string;
  /** Commits on the branch that the base doesn't have, newest first. */
  commits: string[];
  diffstat: string;
  /** Uncommitted changes in the worktree (porcelain lines), linked paths excluded. */
  dirty: string[];
}

/** Where this session's work stands, or undefined if it has no worktree. */
export function worktreeStatus(opts: WorktreeOpts): WorktreeStatus | undefined {
  const { root, path, branch } = locate(opts);
  return statusAt(root, path, branch, opts.links);
}

export function statusAt(root: string, path: string, branch: string, linked: string[] = []): WorktreeStatus | undefined {
  if (!existsSync(join(path, '.git'))) return undefined;
  const base = tryGit(root, ['config', `branch.${branch}.bridgeBase`]) ?? 'main';
  const range = `${base}..${branch}`;
  const commits = (tryGit(root, ['log', '--format=%h %s', range]) ?? '').split('\n').filter(Boolean);
  const diffstat = tryGit(root, ['diff', '--stat', `${base}...${branch}`]) ?? '';
  const links = new Set(linked);
  const dirty = git(path, ['status', '--porcelain'])
    .split('\n')
    .filter((l) => l && !(l.startsWith('?? ') && links.has(l.slice(3).replace(/\/$/, ''))));
  return { path, branch, base, commits, diffstat, dirty };
}

/** Why a squash-merge can't happen right now, or undefined if it can. */
export function mergeBlocker(opts: WorktreeOpts, st: WorktreeStatus): string | undefined {
  const { root } = locate(opts);
  if (st.dirty.length) return `the branch has uncommitted changes (${st.dirty.length} files) — ask the agent to commit them, or discard`;
  if (!st.commits.length) return `there is nothing to merge: ${st.branch} has no commits beyond ${st.base}`;
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== st.base) return `your main checkout (${root}) is on ${current}, not ${st.base}; switch it to ${st.base} first`;
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    return `your main checkout (${root}) has uncommitted changes; commit or stash them first`;
  }
  return undefined;
}

/**
 * Squash the session branch into its base in the main checkout as one commit, then remove the
 * worktree and branch. On conflict nothing changes and the conflicting files are reported.
 */
export function squashMerge(opts: WorktreeOpts): { commit: string; message: string } {
  const st = worktreeStatus(opts);
  if (!st) throw new Error('this conversation has no branch');
  const blocker = mergeBlocker(opts, st);
  if (blocker) throw new Error(blocker);
  const { root } = locate(opts);

  try {
    git(root, ['merge', '--squash', st.branch]);
  } catch {
    const conflicts = tryGit(root, ['diff', '--name-only', '--diff-filter=U']) ?? '';
    tryGit(root, ['reset', '--merge']);
    throw new Error(`merge conflicts with ${st.base} in: ${conflicts.split('\n').filter(Boolean).join(', ') || 'unknown files'}`);
  }
  const subjects = st.commits.map((c) => c.replace(/^\S+\s/, '')).reverse();
  const message =
    subjects.length === 1
      ? subjects[0]!
      : `${subjects[0]}\n\nSquashed from ${st.branch}:\n${subjects.map((s) => `- ${s}`).join('\n')}`;
  git(root, ['commit', '-q', '-m', message]);
  const commit = git(root, ['rev-parse', '--short', 'HEAD']);
  removeWorktree(opts);
  return { commit, message };
}

/** Delete the session's worktree and branch, including unmerged commits. */
export function removeWorktree(opts: WorktreeOpts) {
  const { root, path, branch } = locate(opts);
  removeAt(root, path, branch);
}

export function removeAt(root: string, path: string, branch: string) {
  if (existsSync(path)) tryGit(root, ['worktree', 'remove', '--force', path]);
  tryGit(root, ['worktree', 'prune']);
  tryGit(root, ['branch', '-D', branch]);
  tryGit(root, ['config', '--remove-section', `branch.${branch}`]);
}

/** Every bridge worktree of the repo containing `baseCwd`. */
export function listWorktrees(baseCwd: string): { root: string; path: string; branch: string }[] {
  const root = tryGit(baseCwd, ['rev-parse', '--show-toplevel']);
  if (!root) return [];
  const out: { root: string; path: string; branch: string }[] = [];
  let path = '';
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('branch refs/heads/bridge/')) out.push({ root, path, branch: line.slice('branch refs/heads/'.length) });
  }
  return out;
}

export function sessionSlug(sessionKey: string): string {
  const readable = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  const hash = createHash('sha1').update(sessionKey).digest('hex').slice(0, 6);
  return `${readable}-${hash}`;
}

export function expandHome(p: string) {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
