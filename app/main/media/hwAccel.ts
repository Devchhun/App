import { spawn } from 'child_process'
import { cpus } from 'os'
import { ffmpegPath } from './ffmpeg'

/** How a proxy can be encoded on this computer, best first. The bundled
 * ffmpeg carries NVIDIA (NVENC), Intel (Quick Sync) and AMD (AMF) H.264
 * encoders, but each only works with that maker's GPU and driver -- so
 * each is tried once with a tiny test encode. */
export type ProxyEncodePath = 'nvenc-gpu' | 'nvenc' | 'qsv' | 'amf' | 'cpu'

let detected: Promise<ProxyEncodePath[]> | null = null

function encodes(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', ...args, '-f', 'null', '-'])
    let failed = false
    proc.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().trim()) failed = true
    })
    const timer = setTimeout(() => proc.kill(), 15_000)
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 && !failed)
    })
  })
}

const TEST_INPUT = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=0.3:r=30']

/** The proxy encode paths that work here, best first; CPU is always last. */
export function detectProxyEncodePaths(): Promise<ProxyEncodePath[]> {
  detected ??= (async () => {
    const paths: ProxyEncodePath[] = []
    if (await encodes([...TEST_INPUT, '-vf', 'format=yuv420p', '-c:v', 'h264_nvenc'])) {
      // NVIDIA: decode and resize on the GPU as well -- the CPU then does
      // almost nothing (a feature-length proxy: 7 s of CPU time instead of 94).
      if (await encodes([...TEST_INPUT, '-vf', 'hwupload_cuda,scale_cuda=320:180:format=yuv420p', '-c:v', 'h264_nvenc'])) paths.push('nvenc-gpu')
      paths.push('nvenc')
    }
    if (await encodes([...TEST_INPUT, '-vf', 'format=nv12', '-c:v', 'h264_qsv'])) paths.push('qsv')
    if (await encodes([...TEST_INPUT, '-vf', 'format=yuv420p', '-c:v', 'h264_amf'])) paths.push('amf')
    paths.push('cpu')
    console.info(`[media] proxy encoding: ${paths.join(' > ')}`)
    return paths
  })()
  return detected
}

/** ffmpeg arguments for a 480p proxy over one path: [before -i, after -i]. */
export function proxyEncodeArgs(path: ProxyEncodePath): { input: string[]; output: string[] } {
  switch (path) {
    case 'nvenc-gpu':
      return { input: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], output: ['-vf', 'scale_cuda=-2:480:format=yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '28'] }
    case 'nvenc':
      return { input: [], output: ['-vf', 'scale=-2:480,format=yuv420p', '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '28'] }
    case 'qsv':
      return { input: [], output: ['-vf', 'scale=-2:480,format=nv12', '-c:v', 'h264_qsv', '-global_quality', '28'] }
    case 'amf':
      return { input: [], output: ['-vf', 'scale=-2:480,format=yuv420p', '-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '28', '-qp_p', '28'] }
    case 'cpu':
      return { input: [], output: ['-vf', 'scale=-2:480,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'] }
  }
}

/** How many proxies are made at once: a GPU takes two; a CPU with few
 * cores takes one at a time, so importing several videos never pins it. */
export function proxyEncodeSlots(paths: ProxyEncodePath[]): number {
  if (paths[0] !== 'cpu') return 2
  return cpus().length <= 4 ? 1 : 2
}

/** Threads for CPU-heavy model work (Demucs on the CPU): all but one core,
 * so the app keeps one for itself. */
export function backgroundThreadCount(): number {
  return Math.max(1, cpus().length - 1)
}
