import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface Worktree {
  /** Where the agent should run: the same subdirectory as the configured cwd, inside the worktree. */
  cwd: string;
  path: string;
  branch: string;
  created: boolean;
  /** Something the conversation should be told (e.g. a leftover directory was moved aside). */
  notice?: string;
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

// ───────────────────────── running git / gh ─────────────────────────

/** Local git commands; generous, but a hung git must not hang the bridge. */
const LOCAL_TIMEOUT_MS = 2 * 60e3;
/** push / ls-remote / gh talk to the network. */
const NETWORK_TIMEOUT_MS = 5 * 60e3;
/** Largest stdout we keep (a huge `git status` or diff must not throw like execFileSync's 1 MB default). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface ExecOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to stdin (otherwise stdin is closed). */
  input?: string;
  /** Exit codes that are answers rather than failures (e.g. 1 for "conflicts" / "nothing ignored"). */
  okCodes?: number[];
}

/**
 * Run a command without a shell. It gets its own session (no controlling terminal, so ssh, gpg or a
 * credential helper can't stop to prompt) and the whole process group is killed on timeout.
 */
function exec(cmd: string, args: string[], o: ExecOpts): Promise<{ code: number; stdout: string }> {
  const label = `${cmd} ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}`.trim();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: string | undefined;
    const kill = (why: string) => {
      failure ??= why;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round((o.timeoutMs ?? LOCAL_TIMEOUT_MS) / 1000)}s`), o.timeoutMs ?? LOCAL_TIMEOUT_MS);
    child.stdout!.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUTPUT_BYTES) kill(`output over ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`);
      else chunks.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-4000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(new Error(`${label}: ${failure}`));
      if (code === 0 || (code !== null && o.okCodes?.includes(code))) {
        return resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' ') || (signal ? `killed by ${signal}` : `exit code ${code}`);
      reject(new Error(`${label}: ${detail}`));
    });
    if (o.input !== undefined) {
      // If git exits without reading everything, 'close' reports why; the write error itself adds nothing.
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.input);
    }
  });
}

/** git, trimmed stdout. */
async function git(cwd: string, args: string[], o: Omit<ExecOpts, 'cwd'> = {}): Promise<string> {
  return (await exec('git', args, { cwd, ...o })).stdout.trim();
}

/** git, raw stdout (for -z output, where trimming could eat a path's spaces). */
async function gitRaw(cwd: string, args: string[], o: Omit<ExecOpts, 'cwd'> = {}): Promise<string> {
  return (await exec('git', args, { cwd, ...o })).stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

const isInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function locate(opts: WorktreeOpts): Promise<Located> {
  // git reports the physical top level, so compare it with the physical cwd (macOS /tmp → /private/tmp etc.).
  let base: string;
  try {
    base = realpathSync(opts.baseCwd);
  } catch {
    throw new Error(`${opts.baseCwd} does not exist`);
  }
  const top = await tryGit(base, ['rev-parse', '--show-toplevel']);
  if (!top) throw new Error(`${opts.baseCwd} is not inside a git repository, so it cannot get a worktree`);
  const root = realpathSync(top);
  if (!isInside(root, base)) throw new Error(`${opts.baseCwd} is not inside its repository ${root}`);
  const slug = sessionSlug(opts.sessionKey);
  const path = join(expandHome(opts.dir ?? '~/.bridge/worktrees'), basename(root), slug);
  const cwd = join(path, relative(root, base));
  if (!isInside(path, cwd)) throw new Error(`the agent's directory would be outside its worktree ${path}`);
  return { root, path, branch: `bridge/${slug}`, cwd };
}

// ───────────────────────── creating ─────────────────────────

/**
 * One git worktree per bridge session, so parallel conversations never edit the same checkout.
 * Branch `bridge/<slug>` starts from whatever the main checkout has checked out, and remembers it as its
 * base (git config branch.<name>.bridgeBase) plus the commit it started from (bridgeBaseSha), for status
 * and merge.
 */
export async function ensureWorktree(opts: WorktreeOpts): Promise<Worktree> {
  const { root, path, branch, cwd } = await locate(opts);
  let created = false;
  let notice: string | undefined;
  if (!(await isWorktree(path))) {
    notice = await createWorktree(root, path, branch);
    created = true;
  }
  await linkPaths(root, path, opts.links ?? []);
  return { cwd, path, branch, created, notice };
}

/** A usable checkout at `path` (not just a directory with a stale `.git` file). */
async function isWorktree(path: string): Promise<boolean> {
  if (!existsSync(join(path, '.git'))) return false;
  const top = await tryGit(path, ['rev-parse', '--show-toplevel']);
  return !!top && realpathSync(top) === realpathSync(path);
}

async function createWorktree(root: string, path: string, branch: string): Promise<string | undefined> {
  // Forget worktrees whose directory was deleted by hand; otherwise `worktree add` says "already registered".
  await git(root, ['worktree', 'prune']);
  let notice: string | undefined;
  if (existsSync(path)) {
    if (!readdirSync(path).length) rmdirSync(path);
    else {
      // Half-created, or broken by hand. Never delete what might be someone's work: move it aside.
      const aside = `${path}.orphaned-${Date.now()}`;
      renameSync(path, aside);
      await git(root, ['worktree', 'prune']);
      notice = `⚠️ ${path} was not a usable worktree, so it was moved to ${aside} and a fresh one created.`;
    }
  }
  mkdirSync(dirname(path), { recursive: true });

  if ((await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== undefined) {
    await git(root, ['worktree', 'add', path, branch]);
    return notice;
  }
  const sha = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const head = await tryGit(root, ['symbolic-ref', '--quiet', 'HEAD']);
  const base = head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : sha;
  await git(root, ['worktree', 'add', '-b', branch, path, sha]);
  try {
    await git(root, ['config', `branch.${branch}.bridgeBase`, base]);
    await git(root, ['config', `branch.${branch}.bridgeBaseSha`, sha]);
  } catch (err) {
    // A branch without a recorded base can't be judged later; don't leave one behind.
    await removeAt(root, path, branch).catch(() => {});
    throw err;
  }
  return notice;
}

/**
 * Symlink `links` from the main checkout into the worktree, and list them in the repository's
 * info/exclude: ignore rules like `node_modules/` match directories only, so a symlink would otherwise
 * show up as untracked and an agent's `git add -A` would commit it.
 */
async function linkPaths(root: string, path: string, links: string[]) {
  if (!links.length) return;
  const names = links.map(linkName);
  const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const exclude = join(common, 'info', 'exclude');
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const lines = new Set(current.split('\n'));
  const missing = names.map(excludePattern).filter((p) => !lines.has(p));
  if (missing.length) {
    mkdirSync(dirname(exclude), { recursive: true });
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(exclude, `${sep}# linked into bridge worktrees (worktree_links)\n${missing.join('\n')}\n`);
  }
  for (const name of names) {
    const src = join(root, name);
    const dst = join(path, name);
    if (!existsSync(src) || lexists(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst);
  }
}

/** A worktree_links entry as a clean relative path ("./node_modules/" → "node_modules"). */
function linkName(raw: string): string {
  const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!name || isAbsolute(name) || name.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`worktree_links entry "${raw}" must be a path inside the repository`);
  }
  return name;
}

/** An info/exclude line matching exactly this path from the top (file, directory or symlink). */
function excludePattern(name: string): string {
  return `/${name.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ')}`;
}

function lexists(p: string) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── status ─────────────────────────

export interface WorktreeStatus {
  path: string;
  branch: string;
  /** The branch it was cut from (a commit id if the checkout was detached), or "?" if never recorded. */
  base: string;
  /**
   * Commits on the branch that the base doesn't have, newest first. Undefined when that can't be
   * determined (base branch gone and no start commit recorded, git failing): `note` says why, and the
   * branch must then never be treated as empty.
   */
  commits: string[] | undefined;
  diffstat: string;
  /** Uncommitted changes in the worktree (porcelain "XY path" lines), linked paths excluded. */
  dirty: string[];
  /** Why the counts are approximate or unknown. */
  note?: string;
  /** The revision commits are counted from (base branch ref, or the start commit). */
  from?: string;
}

/** Where this session's work stands, or undefined if it has no branch. */
export async function worktreeStatus(opts: WorktreeOpts): Promise<WorktreeStatus | undefined> {
  const { root, path, branch } = await locate(opts);
  return statusAt(root, path, branch, opts.links);
}

/** The branch's status, or undefined if the branch doesn't exist. Works when the worktree directory is gone. */
export async function statusAt(root: string, path: string, branch: string, linked: string[] = []): Promise<WorktreeStatus | undefined> {
  if ((await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) === undefined) return undefined;
  const base = await tryGit(root, ['config', '--get', `branch.${branch}.bridgeBase`]);
  const startSha = await tryGit(root, ['config', '--get', `branch.${branch}.bridgeBaseSha`]);
  const { from, note: baseNote } = await resolveBase(root, base, startSha);
  let note = baseNote;
  let commits: string[] | undefined;
  let diffstat = '';
  if (from) {
    try {
      commits = (await git(root, ['log', '--format=%h %s', `${from}..refs/heads/${branch}`])).split('\n').filter(Boolean);
      diffstat = await git(root, ['diff', '--stat', `${from}...refs/heads/${branch}`]);
    } catch (err) {
      commits = undefined;
      note = `couldn't read the branch's history (${(err as Error).message})`;
    }
  }
  const dirty = (await isWorktree(path)) ? await dirtyFiles(path, linked) : [];
  return { path, branch, base: base || '?', commits, diffstat, dirty, note, from };
}

async function resolveBase(root: string, base: string | undefined, startSha: string | undefined): Promise<{ from?: string; note?: string }> {
  const exists = async (rev: string) => (await tryGit(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])) !== undefined;
  if (base) {
    const ref = /^[0-9a-f]{40,64}$/.test(base) ? base : `refs/heads/${base}`;
    if (await exists(ref)) return { from: ref };
  }
  if (startSha && (await exists(startSha))) {
    return {
      from: startSha,
      note: `its base branch ${base ?? '(unrecorded)'} no longer exists; commits are counted from ${startSha.slice(0, 7)}, where the branch started`,
    };
  }
  return {
    note: base
      ? `its base branch ${base} no longer exists, so it is unknown which of its commits are unmerged`
      : "its base branch isn't recorded, so it is unknown which of its commits are unmerged",
  };
}

/** `git status -z`, so paths with spaces, quotes or non-ASCII characters come through verbatim. */
async function dirtyFiles(path: string, linked: string[]): Promise<string[]> {
  const links = new Set(linked.map(linkName));
  const entries = (await gitRaw(path, ['--no-optional-locks', 'status', '--porcelain=v1', '-z'])).split('\0');
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const file = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the next entry is the original path
    if (xy === '??' && links.has(file.replace(/\/$/, ''))) continue;
    out.push(`${xy} ${file}`);
  }
  return out;
}

/** Paths the branch changes that are linked, or ignored in the main checkout (merging would clobber them). */
async function unsafePaths(root: string, st: WorktreeStatus, linked: string[]): Promise<string[]> {
  const names = linked.map(linkName);
  const changed = (await gitRaw(root, ['diff', '--name-only', '-z', '--no-renames', `${st.from}...refs/heads/${st.branch}`]))
    .split('\0')
    .filter(Boolean);
  if (!changed.length) return [];
  const bad = new Set(changed.filter((p) => names.some((n) => p === n || p.startsWith(`${n}/`))));
  // Tracked files are never reported, so this finds only paths the main checkout ignores.
  const ignored = await exec('git', ['check-ignore', '-z', '--stdin'], { cwd: root, input: changed.join('\0') + '\0', okCodes: [1] });
  for (const p of ignored.stdout.split('\0')) if (p) bad.add(p);
  return [...bad];
}

function listPaths(paths: string[]) {
  return paths.length > 5 ? `${paths.slice(0, 5).join(', ')} and ${paths.length - 5} more` : paths.join(', ');
}

/** Why a squash-merge can't happen right now, or undefined if it can. */
export async function mergeBlocker(opts: WorktreeOpts, st: WorktreeStatus): Promise<string | undefined> {
  const { root } = await locate(opts);
  if (!st.commits) return `can't tell what ${st.branch} would bring in: ${st.note}`;
  if (st.note) return `can't merge into ${st.base}: ${st.note}`;
  if (st.dirty.length) return `the branch has uncommitted changes (${st.dirty.length} files) — ask the agent to commit them, or discard`;
  if (!st.commits.length) return `there is nothing to merge: ${st.branch} has no commits beyond ${st.base}`;
  const head = await tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head !== st.base) return `your main checkout (${root}) is on ${head ?? 'a detached HEAD'}, not ${st.base}; switch it to ${st.base} first`;
  if (await git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'])) {
    return `your main checkout (${root}) has uncommitted changes; commit or stash them first`;
  }
  const unsafe = await unsafePaths(root, st, opts.links ?? []);
  if (unsafe.length) {
    return `the branch changes ${listPaths(unsafe)}, which your main checkout links or ignores (merging would overwrite them) — ask the agent to take them out of its commits, or discard`;
  }
  return undefined;
}

// ───────────────────────── merging and removing ─────────────────────────

/**
 * Squash the session branch into its base in the main checkout as one commit, then remove the
 * worktree and branch. The commit is built from objects only (merge-tree + commit-tree) and the
 * checkout is then fast-forwarded, so a conflict or a failing step (signing, identity, a file in
 * the way) leaves the main checkout exactly as it was. Commit hooks don't run here; they ran when
 * the agent made the commits being squashed.
 */
export async function squashMerge(opts: WorktreeOpts): Promise<{ commit: string; message: string }> {
  const st = await worktreeStatus(opts);
  if (!st) throw new Error('this conversation has no branch');
  const blocker = await mergeBlocker(opts, st);
  if (blocker) throw new Error(blocker);
  const { root, path, branch } = await locate(opts);

  const head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const merged = await exec('git', ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', head, `refs/heads/${branch}`], {
    cwd: root,
    okCodes: [1],
  });
  const [tree, ...conflicted] = merged.stdout.split('\0');
  if (merged.code === 1) {
    throw new Error(`merge conflicts with ${st.base} in: ${conflicted.filter(Boolean).join(', ') || 'unknown files'}`);
  }
  const { title, bullets } = summarize(st);
  const message = st.commits!.length === 1 ? title : `${title}\n\nSquashed from ${branch}:\n${bullets}`;
  const sign = (await tryGit(root, ['config', '--type=bool', '--get', 'commit.gpgSign'])) === 'true' ? ['-S'] : [];
  const commit = await git(root, ['commit-tree', tree!, '-p', head, ...sign, '-F', '-'], { input: message });
  try {
    // Refuses (changing nothing) if HEAD moved meanwhile or an untracked file is in the way.
    await git(root, ['merge', '--ff-only', '--quiet', commit]);
  } catch (err) {
    throw new Error(`couldn't update your main checkout, nothing was changed: ${(err as Error).message}`);
  }
  await removeAt(root, path, branch);
  return { commit: commit.slice(0, 7), message };
}

/** Delete the session's worktree and branch, including unmerged commits. */
export async function removeWorktree(opts: WorktreeOpts) {
  const { root, path, branch } = await locate(opts);
  await removeAt(root, path, branch);
}

export async function removeAt(root: string, path: string, branch: string) {
  if (existsSync(join(path, '.git'))) await git(root, ['worktree', 'remove', '--force', path]);
  await git(root, ['worktree', 'prune']);
  if ((await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== undefined) {
    await git(root, ['branch', '-D', branch]);
  }
  // Absent when the branch never had config; nothing to remove then.
  await tryGit(root, ['config', '--remove-section', `branch.${branch}`]);
}

/**
 * Worktrees under `opts.baseCwd`'s repo that `isIdle` (by session slug) and hold nothing unmerged.
 * Each removal runs inside `guard(slug, fn)`, which can serialize it with that conversation's turns.
 * A failing worktree is reported in `errors` and doesn't stop the others.
 */
export async function pruneIdle(
  opts: Omit<WorktreeOpts, 'sessionKey'>,
  isIdle: (slug: string) => boolean,
  guard: (slug: string, fn: () => Promise<void>) => Promise<void> = (_slug, fn) => fn(),
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const wt of await listWorktrees(opts.baseCwd)) {
    const slug = wt.branch.replace(/^bridge\//, '');
    if (!isIdle(slug)) continue;
    try {
      await guard(slug, async () => {
        const st = await statusAt(wt.root, wt.path, wt.branch, opts.links);
        // Unknown counts as unmerged: only a branch known to be empty is removed without asking.
        if (st && (!st.commits || st.commits.length || st.dirty.length)) return;
        await removeAt(wt.root, wt.path, wt.branch);
        removed.push(wt.branch);
      });
    } catch (err) {
      errors.push(`${wt.branch}: ${(err as Error).message}`);
    }
  }
  return { removed, errors };
}

/** Every bridge worktree of the repo containing `baseCwd`. */
export async function listWorktrees(baseCwd: string): Promise<{ root: string; path: string; branch: string }[]> {
  const top = existsSync(baseCwd) ? await tryGit(baseCwd, ['rev-parse', '--show-toplevel']) : undefined;
  if (!top) return [];
  const root = realpathSync(top);
  const out: { root: string; path: string; branch: string }[] = [];
  let path = '';
  for (const entry of (await gitRaw(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (entry.startsWith('worktree ')) path = entry.slice('worktree '.length);
    if (entry.startsWith('branch refs/heads/bridge/')) out.push({ root, path, branch: entry.slice('branch refs/heads/'.length) });
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

/** Commit subjects oldest-first as a title + bullet body (used for squash messages and PRs). */
export function summarize(st: WorktreeStatus): { title: string; bullets: string } {
  const subjects = (st.commits ?? []).map((c) => c.replace(/^\S+\s/, '')).reverse();
  return { title: subjects[0] ?? st.branch, bullets: subjects.map((x) => `- ${x}`).join('\n') };
}

// ───────────────────────── pull requests ─────────────────────────

/** Why the branch can't be pushed as a PR right now, or undefined. */
export async function prBlocker(opts: WorktreeOpts, st: WorktreeStatus): Promise<string | undefined> {
  const { root } = await locate(opts);
  if (!st.commits) return `can't tell what ${st.branch} would propose: ${st.note}`;
  if (st.dirty.length) return `the branch has uncommitted changes (${st.dirty.length} files) — ask the agent to commit them, or discard`;
  if (!st.commits.length) return `there is nothing to propose: ${st.branch} has no commits beyond ${st.base}`;
  const unsafe = await unsafePaths(root, st, opts.links ?? []);
  if (unsafe.length) {
    return `the branch changes ${listPaths(unsafe)}, which your main checkout links or ignores (local files that don't belong in a PR) — ask the agent to take them out of its commits, or discard`;
  }
  if (!(await tryGit(root, ['remote', 'get-url', 'origin']))) return 'the repository has no "origin" remote';
  return undefined;
}

/** ssh may never prompt (host key, passphrase): keep the user's ssh command, add BatchMode. */
async function sshCommand(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { SSH_ASKPASS_REQUIRE: 'never' };
  const own = process.env.GIT_SSH_COMMAND || (process.env.GIT_SSH ? undefined : await tryGit(root, ['config', '--get', 'core.sshCommand']));
  // GIT_SSH names a wrapper program that takes no options; the missing terminal and the timeout still apply.
  if (own !== undefined || !process.env.GIT_SSH) env.GIT_SSH_COMMAND = `${own || 'ssh'} -o BatchMode=yes`;
  return env;
}

/**
 * Push the session branch to origin and open (or reuse) a pull request into its base.
 * `token` authenticates both git (through gh's credential helper, for this command only) and gh;
 * it is passed in the environment and never stored. `push -u` records origin as the branch's
 * upstream in branch config, which is removed with the branch.
 */
export async function pushPullRequest(opts: WorktreeOpts, token: string): Promise<{ url: string; created: boolean }> {
  const st = await worktreeStatus(opts);
  if (!st) throw new Error('this conversation has no branch');
  const blocker = await prBlocker(opts, st);
  if (blocker) throw new Error(blocker);
  const { root } = await locate(opts);
  const env = { ...process.env, ...(await sshCommand(root)), GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
  const run = async (cmd: string, args: string[]) => (await exec(cmd, args, { cwd: root, env, timeoutMs: NETWORK_TIMEOUT_MS })).stdout.trim();

  if (!(await run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${st.base}`]))) {
    throw new Error(`${st.base} doesn't exist on origin yet — push it first`);
  }
  await run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '-u', 'origin', `refs/heads/${st.branch}:refs/heads/${st.branch}`]);
  try {
    const url = await run('gh', ['pr', 'view', st.branch, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url']);
    if (url) return { url, created: false };
  } catch {
    /* no PR yet */
  }
  const { title, bullets } = summarize(st);
  const body = `${bullets}\n\n---\nOpened from a chat conversation via bridge (branch \`${st.branch}\`).`;
  const url = await run('gh', ['pr', 'create', '--head', st.branch, '--base', st.base, '--title', title, '--body', body]);
  return { url: url.split('\n').pop() ?? url, created: true };
}
