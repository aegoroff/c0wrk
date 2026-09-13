import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

// Home of build/appicon.svg, which the app shell imports as the canonical
// app mark. Vite's dev server serves only paths inside server.fs.allow;
// the default (searchForWorkspaceRoot) stops at frontend/, so the icon's
// directory is appended explicitly — the repo root itself stays out.
// Production builds are unaffected (rollup reads the file from disk).
const appAssetsRoot = path.resolve(__dirname, '../build')

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(__dirname), appAssetsRoot],
    },
  },
})
