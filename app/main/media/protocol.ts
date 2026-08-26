import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { extname } from 'path'
import { randomBytes } from 'crypto'

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

function guessMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

// Tokens map to absolute local paths so the renderer never sees real filesystem paths.
const tokenToPath = new Map<string, string>()

export function registerMediaToken(filePath: string): string {
  const token = randomBytes(16).toString('hex')
  tokenToPath.set(token, filePath)
  return `app-media://${token}`
}

/** Must be called before app.whenReady(). */
export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app-media',
      privileges: {
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
        corsEnabled: true
      }
    }
  ])
}

/** Must be called after app.whenReady(). */
export function registerMediaProtocolHandler(): void {
  protocol.handle('app-media', async (request) => {
    const token = new URL(request.url).hostname
    const filePath = tokenToPath.get(token)
    if (!filePath) {
      return new Response('Not found', { status: 404 })
    }

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      return new Response('File missing', { status: 404 })
    }

    const mimeType = guessMimeType(filePath)
    const range = request.headers.get('range')

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range)
      const start = match ? Number(match[1]) : 0
      const end = match && match[2] ? Number(match[2]) : stat.size - 1
      const stream = createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': mimeType
        }
      })
    }

    const stream = createReadStream(filePath)
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType
      }
    })
  })
}
