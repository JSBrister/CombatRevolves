import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** Short commit ID shown on the title screen, so you can tell which build you're playing. */
function buildId(): string {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    const id = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? '+' : '';
    return id + dirty;
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  base: './', // relative asset paths so it works under /<repo>/ on GitHub Pages
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  server: { port: 5173 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
