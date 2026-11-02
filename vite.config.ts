import { defineConfig } from 'vite';
export default defineConfig({
  base: './', // relative asset paths so it works under /<repo>/ on GitHub Pages
  server: { port: 5173 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
