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

/**
 * One git worktree per bridge session, so parallel conversations never edit the same checkout.
 * Branch `bridge/<slug>` starts from the repo's current HEAD and is kept across turns.
 */
export function ensureWorktree(opts: { baseCwd: string; sessionKey: string; dir?: string; links?: string[] }): Worktree {
  const git = (args: string[], cwd = opts.baseCwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  let root: string;
  try {
    root = git(['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`${opts.baseCwd} is not inside a git repository, so it cannot get a worktree`);
  }
  const slug = sessionSlug(opts.sessionKey);
  const branch = `bridge/${slug}`;
  const path = join(expandHome(opts.dir ?? '~/.agents-bridge/worktrees'), basename(root), slug);
  const cwd = join(path, relative(root, opts.baseCwd));

  if (existsSync(join(path, '.git'))) return { cwd, path, branch, created: false };

  mkdirSync(join(path, '..'), { recursive: true });
  let hasBranch = true;
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root);
  } catch {
    hasBranch = false;
  }
  git(hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD'], root);

  // Untracked things the agent needs to build/test (node_modules, .env) are linked from the main checkout.
  for (const name of opts.links ?? []) {
    const src = join(root, name);
    const dst = join(path, name);
    if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
  }
  return { cwd, path, branch, created: true };
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
