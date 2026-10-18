import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// The demo imports the package by name; these aliases point it at ../src so
// it always runs against the working copy.
export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^hls-to-mp4\/react$/, replacement: here('../src/react.js') },
      { find: /^hls-to-mp4$/, replacement: here('../src/index.js') },
    ],
  },
  server: { fs: { allow: [here('..')] } },
  build: { outDir: here('dist'), emptyOutDir: true },
});
