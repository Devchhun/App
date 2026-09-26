/** Whether the Home screen has been left this session. Opening a project
 * from Home goes through a window reload (see HomeScreen.tsx), and that
 * reload must land in the editor -- while a fresh launch starts on Home. */
const HOME_SEEN_KEY = 'cae-home-seen'

export function markHomeSeen(): void {
  try {
    sessionStorage.setItem(HOME_SEEN_KEY, '1')
  } catch {
    // Storage unavailable -- Home shows again next reload, nothing worse.
  }
}

export function wasHomeSeen(): boolean {
  try {
    return sessionStorage.getItem(HOME_SEEN_KEY) === '1'
  } catch {
    return false
  }
}
