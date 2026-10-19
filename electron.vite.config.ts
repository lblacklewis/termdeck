import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Exported entry consumed by smoke/probe.cjs.
          smokeEntry: resolve(__dirname, 'src/main/smokeEntry.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    server: {
      watch: {
        // Editors and tooling drop temp dirs next to sources; watching them
        // makes the dev server crash with EBUSY when they are removed.
        ignored: ['**/.*.tmpdir/**', '**/*.tmp']
      }
    },
    plugins: [react()],
    build: {
      /*
       * electron-vite leaves `build.minify` off, which is a sensible default for
       * main and preload (readable crash traces) but not for the renderer: the
       * bundle it produced was ~2 MB of pretty-printed code with names nobody
       * reads, and every startup paid to parse it. Minified is ~1.05 MB.
       */
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
