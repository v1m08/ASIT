import { useRef } from 'react'

// Ctrl+Shift+T's memory: the last few closed tabs, newest on top.

export function useClosedTabs<T>(cap = 10): {
  /** dropIf: remove matching older entries first (re-closing a resource
   *  should move it to the top, not duplicate it). */
  push: (item: T, dropIf?: (t: T) => boolean) => void
  pop: () => T | undefined
} {
  const stack = useRef<T[]>([])
  return {
    push: (item, dropIf) => {
      const kept = dropIf ? stack.current.filter((t) => !dropIf(t)) : stack.current
      stack.current = [...kept, item].slice(-cap)
    },
    pop: () => stack.current.pop()
  }
}
