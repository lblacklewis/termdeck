import type { TermDeckApi } from '@shared/types'

declare global {
  interface Window {
    termdeck: TermDeckApi
  }
}

export {}
