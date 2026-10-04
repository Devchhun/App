import { useEffect, useState } from 'react'

/** Opening or creating a project from Home starts every provider afresh
 * from it. That used to be a window reload: the whole app loaded again
 * behind a blank window (seconds in development, where every module is
 * fetched anew). Now the provider tree is remounted under a new key -- the
 * same fresh start, with the code already loaded. */
const PROJECT_SWITCHED = 'cae-project-switched'

export function startProjectSession(): void {
  window.dispatchEvent(new Event(PROJECT_SWITCHED))
}

/** Changes every time another project is made the current one. */
export function useProjectSessionKey(): number {
  const [key, setKey] = useState(0)
  useEffect(() => {
    const next = (): void => setKey((k) => k + 1)
    window.addEventListener(PROJECT_SWITCHED, next)
    return () => window.removeEventListener(PROJECT_SWITCHED, next)
  }, [])
  return key
}
