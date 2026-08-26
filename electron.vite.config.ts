import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'app/main/index.ts')
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: resolve(__dirname, 'app/preload/index.ts')
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'renderer/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'renderer/src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    plugins: [react()]
  }
})
