import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their sources so tests never mix a source
// import with the built dist copy (which breaks instanceof across packages).
const workspaceSource = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@yempik\/core$/, replacement: workspaceSource('core') },
      { find: /^@yempik\/database$/, replacement: workspaceSource('database') },
      { find: /^@yempik\/oauth$/, replacement: workspaceSource('oauth') },
      { find: /^@yempik\/observability$/, replacement: workspaceSource('observability') },
      { find: /^@yempik\/security$/, replacement: workspaceSource('security') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'json', 'html'] },
  },
});
