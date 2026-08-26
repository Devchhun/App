import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      '@renderer': resolve(__dirname, 'renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'renderer/**/*.test.ts', 'shared/**/*.test.ts']
  }
})
