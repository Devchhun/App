// Where the editor checks its license in (see license-server/README.md).
// The public HTTPS endpoint of the license server (never a MongoDB URI or
// admin token). The packaged editor must get an active backend verdict on
// each launch and every few hours while running. An unreachable server
// keeps the editor locked until the user retries successfully.
export const LICENSE_SERVER_URL = 'https://lifsten-server.host.wordmerl.online'

/** How often a running editor re-checks with the server. */
export const LICENSE_CHECKIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/** How often the editor re-announces this computer (see the app's
 * deviceLicense.ts). Short, because it is three things at once: the "is
 * this computer still allowed" check, what makes the Admin panel's online
 * dot live, and how a waiting user sees approval without restarting. */
export const DEVICE_REGISTER_INTERVAL_MS = 60 * 1000
