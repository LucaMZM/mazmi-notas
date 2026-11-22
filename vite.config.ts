import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: { ignored: ['**/node_modules.*/**', '**/src-tauri/**', '**/output/**', '**/.agents/**'] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@tiptap/') || id.includes('/node_modules/prosemirror-')) return 'editor'
          if (/\/node_modules\/(unified|remark-|rehype-|micromark|mdast-|hast-)/.test(id)) return 'markdown'
        },
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
})
