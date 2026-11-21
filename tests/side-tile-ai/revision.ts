/**
 * An esbuild plugin that draws with the renderer of another commit: every src file that differs between
 * that commit and HEAD is loaded as it was there (`git show <rev>:<path>`), the rest as checked out. For
 * HEAD itself nothing is swapped. No other checkout or worktree is used.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';

export function revisionPlugin(rev: string): { plugin: Plugin; swapped: string[] } {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  const head = git('rev-parse', 'HEAD').trim();
  const target = git('rev-parse', rev).trim();
  const swapped =
    head === target
      ? []
      : git('diff', '--name-only', target, 'HEAD', '--', 'src')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
  // A file the other commit has but HEAD lacks (or the reverse) would need more than a swap.
  for (const path of swapped) {
    git('cat-file', '-e', `${target}:${path}`);
    git('cat-file', '-e', `HEAD:${path}`);
  }
  const slash = (p: string) => p.split('\\').join('/').toLowerCase();
  const byPath = new Map(swapped.map((p) => [slash(resolve(p)), p]));
  return {
    swapped,
    plugin: {
      name: 'side-tile-revision',
      setup(b) {
        b.onLoad({ filter: /[.]tsx?$/ }, (args) => {
          const path = byPath.get(slash(args.path));
          if (!path) return undefined;
          return { contents: git('show', `${target}:${path}`), loader: path.endsWith('x') ? 'tsx' : 'ts' };
        });
      },
    },
  };
}
