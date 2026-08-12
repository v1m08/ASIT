import { useCallback, useEffect, useRef } from 'react'
import { expandSnippets } from '../utils/snippets'

// Loads the user's "/KEY" shortcuts once and returns an expander for inputs.
export function useSnippets(): (text: string) => string {
  const snippetsRef = useRef<Record<string, string>>({})

  useEffect(() => {
    window.asit.settings.get().then((s) => {
      snippetsRef.current = s.snippets ?? {}
    })
  }, [])

  return useCallback((text: string) => expandSnippets(text, snippetsRef.current), [])
}
