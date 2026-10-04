import { useEffect, useRef } from 'react'

const FRAME_MS = 1000 / 30
const TAU = Math.PI * 2
/** How much faster it turns while the mouse is on its button. */
const HOVER_SPEEDUP = 14
/** How quickly the speed follows (per second): a spin-up, not a jump. */
const SPEED_EASE = 5

interface Spark {
  angle: number
  speed: number
  life: number
  age: number
  size: number
}

/** The fire half of a yin-yang of radius r, centred on 0,0: the right
 * half with its bulge at the top, reaching into the left half at the
 * bottom. */
function firePath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath()
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false)
  ctx.arc(0, r / 2, r / 2, Math.PI / 2, (3 * Math.PI) / 2, false)
  ctx.arc(0, -r / 2, r / 2, Math.PI / 2, -Math.PI / 2, true)
  ctx.closePath()
}

/** Glowing blobs drifting inside the current clip: flame / frost texture. */
function drawBlobs(ctx: CanvasRenderingContext2D, r: number, t: number, seed: number, inner: string, outer: string): void {
  for (let i = 0; i < 5; i++) {
    const a = seed + i * 1.7 + t * (0.35 + i * 0.07)
    const d = r * (0.25 + 0.45 * ((Math.sin(t * 0.9 + i * 2.3 + seed) + 1) / 2))
    const x = Math.cos(a) * d
    const y = Math.sin(a * 1.3) * d
    const size = r * (0.35 + 0.2 * Math.sin(t * 1.7 + i))
    const g = ctx.createRadialGradient(x, y, 0, x, y, size)
    g.addColorStop(0, inner)
    g.addColorStop(1, outer)
    ctx.fillStyle = g
    ctx.fillRect(x - size, y - size, size * 2, size * 2)
  }
}

/** A yin-yang of fire and ice, slowly turning, energy pouring off its rim
 * as wisps and sparks -- the Recap button's emblem (it took the Earth's
 * place). Spins up fast while the mouse is on its button. Still when the
 * OS asks for reduced motion. */
export function YinYangOrb({ size = 40, secondsPerTurn = 10, className }: { size?: number; secondsPerTurn?: number; className?: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const scale = Math.max(2, Math.min(3, (window.devicePixelRatio || 1) * 2))
    const pixels = Math.round(size * scale)
    canvas.width = pixels
    canvas.height = pixels
    const c = pixels / 2
    // Room around the disc for the energy.
    const r = pixels * 0.33
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const sparks: Spark[] = []
    const newSpark = (): Spark => ({ angle: Math.random() * TAU, speed: 0.25 + Math.random() * 0.45, life: 0.8 + Math.random() * 1.2, age: 0, size: 0.6 + Math.random() * 1.1 })
    for (let i = 0; i < 26; i++) sparks.push({ ...newSpark(), age: Math.random() * 1.5 })
    let alive = true
    let raf = 0
    let last = -Infinity
    let prev = performance.now()
    // Turned by integrating its speed (not read off the clock), so speeding
    // up and slowing down never jumps the picture.
    let phase = 0.3 * TAU
    let speed = 1
    let hovered = false
    const host = canvas.parentElement
    const enter = (): void => {
      hovered = true
    }
    const leave = (): void => {
      hovered = false
    }
    host?.addEventListener('mouseenter', enter)
    host?.addEventListener('mouseleave', leave)

    const draw = (now: number): void => {
      if (!alive) return
      raf = requestAnimationFrame(draw)
      if (now - last < FRAME_MS) return
      last = now
      const dt = Math.min(0.1, (now - prev) / 1000)
      prev = now
      const t = still ? 0 : now / 1000
      if (!still) {
        const target = hovered ? HOVER_SPEEDUP : 1
        speed += (target - speed) * Math.min(1, dt * SPEED_EASE)
        phase += (dt / secondsPerTurn) * TAU * speed
      }
      const turn = phase
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, pixels, pixels)
      ctx.translate(c, c)

      // Halo: cool on one side, warm on the other, breathing.
      const breath = 0.75 + 0.25 * Math.sin(t * 2.2)
      ctx.globalCompositeOperation = 'lighter'
      // Warm light off the fire side, cold light off the ice side.
      const side = (dx: number, color: string): void => {
        const hx = Math.cos(turn) * r * 0.35 * dx
        const hy = Math.sin(turn) * r * 0.35 * dx
        const halo = ctx.createRadialGradient(hx, hy, r * 0.6, hx, hy, r * 1.55)
        halo.addColorStop(0, color.replace('A', String(0.42 * breath)))
        halo.addColorStop(1, color.replace('A', '0'))
        ctx.fillStyle = halo
        ctx.fillRect(-c, -c, pixels, pixels)
      }
      side(1, 'rgba(255, 140, 40, A)')
      side(-1, 'rgba(70, 190, 255, A)')

      // Wisps of energy curling off the rim, coloured by the half under them.
      ctx.lineCap = 'round'
      for (let i = 0; i < 30; i++) {
        const base = (i / 30) * TAU + turn * 0.6
        const wave = Math.sin(t * 2.4 + i * 1.9)
        const reach = r * (1.12 + 0.28 * ((Math.sin(t * 1.6 + i * 2.7) + 1) / 2))
        const fire = Math.cos(base - turn) > 0
        const color = fire ? `rgba(255, ${150 + Math.round(60 * wave)}, 60, ${0.8 * breath})` : `rgba(90, ${210 + Math.round(30 * wave)}, 255, ${0.8 * breath})`
        ctx.strokeStyle = color
        ctx.lineWidth = scale * (0.8 + 0.8 * ((wave + 1) / 2))
        ctx.beginPath()
        const a0 = base
        const a1 = base + 0.35 + 0.15 * wave
        ctx.moveTo(Math.cos(a0) * r * 0.98, Math.sin(a0) * r * 0.98)
        ctx.quadraticCurveTo(Math.cos((a0 + a1) / 2) * reach * 1.08, Math.sin((a0 + a1) / 2) * reach * 1.08, Math.cos(a1) * reach, Math.sin(a1) * reach)
        ctx.stroke()
      }

      // Sparks flying out.
      for (const s of sparks) {
        s.age += still ? 0 : dt
        if (s.age > s.life) Object.assign(s, newSpark())
        const k = s.age / s.life
        const d = r * (1 + k * 0.55 * (1 + s.speed))
        const x = Math.cos(s.angle) * d
        const y = Math.sin(s.angle) * d
        const fire = Math.cos(s.angle - turn) > 0
        const alpha = Math.sin(Math.PI * k) * 0.9
        const g = ctx.createRadialGradient(x, y, 0, x, y, s.size * scale * 1.6)
        g.addColorStop(0, fire ? `rgba(255, 230, 160, ${alpha})` : `rgba(210, 245, 255, ${alpha})`)
        g.addColorStop(1, fire ? 'rgba(255, 120, 30, 0)' : 'rgba(60, 180, 255, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, s.size * scale * 1.6, 0, TAU)
        ctx.fill()
      }

      // The disc itself, turning.
      ctx.globalCompositeOperation = 'source-over'
      ctx.save()
      ctx.rotate(turn)
      ctx.shadowColor = 'rgba(140, 220, 255, 0.9)'
      ctx.shadowBlur = r * 0.35
      const ice = ctx.createRadialGradient(-r * 0.2, -r * 0.1, r * 0.1, 0, 0, r)
      ice.addColorStop(0, '#e9fdff')
      ice.addColorStop(0.45, '#5fe3ff')
      ice.addColorStop(1, '#0a6fd6')
      ctx.fillStyle = ice
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, TAU)
      ctx.fill()
      ctx.shadowBlur = 0

      ctx.save()
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, TAU)
      ctx.clip()
      ctx.globalCompositeOperation = 'lighter'
      drawBlobs(ctx, r, t, 0.7, 'rgba(220, 250, 255, 0.35)', 'rgba(120, 220, 255, 0)')
      ctx.restore()

      ctx.save()
      firePath(ctx, r)
      ctx.shadowColor = 'rgba(255, 170, 60, 0.95)'
      ctx.shadowBlur = r * 0.3
      const flame = ctx.createRadialGradient(r * 0.35, -r * 0.2, r * 0.05, 0, 0, r)
      flame.addColorStop(0, '#fff6c8')
      flame.addColorStop(0.35, '#ffb43a')
      flame.addColorStop(0.75, '#ff6a12')
      flame.addColorStop(1, '#b8260a')
      ctx.fillStyle = flame
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.clip()
      ctx.globalCompositeOperation = 'lighter'
      drawBlobs(ctx, r, t, 2.1, 'rgba(255, 235, 150, 0.45)', 'rgba(255, 120, 20, 0)')
      ctx.restore()

      // The S between the halves glows white-hot.
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = `rgba(255, 250, 225, ${0.55 + 0.25 * Math.sin(t * 3)})`
      ctx.lineWidth = scale * 0.8
      ctx.shadowColor = 'rgba(255, 245, 210, 1)'
      ctx.shadowBlur = r * 0.25
      ctx.beginPath()
      ctx.arc(0, r / 2, r / 2, Math.PI / 2, (3 * Math.PI) / 2, false)
      ctx.arc(0, -r / 2, r / 2, Math.PI / 2, -Math.PI / 2, true)
      ctx.stroke()
      ctx.restore()

      // The two eyes: a flame eye in the ice, a frost eye in the fire.
      const eye = r * 0.15
      const frostEye = ctx.createRadialGradient(0, r / 2, 0, 0, r / 2, eye)
      frostEye.addColorStop(0, '#bff6ff')
      frostEye.addColorStop(0.6, '#1e8fd8')
      frostEye.addColorStop(1, '#0a4f8f')
      ctx.fillStyle = frostEye
      ctx.beginPath()
      ctx.arc(0, r / 2, eye, 0, TAU)
      ctx.fill()
      ctx.shadowColor = 'rgba(255, 220, 120, 1)'
      ctx.shadowBlur = r * 0.3
      const flameEye = ctx.createRadialGradient(0, -r / 2, 0, 0, -r / 2, eye * 1.2)
      flameEye.addColorStop(0, '#fffbe6')
      flameEye.addColorStop(0.5, '#ffd36a')
      flameEye.addColorStop(1, '#ff8a1e')
      ctx.fillStyle = flameEye
      ctx.beginPath()
      ctx.arc(0, -r / 2, eye * (1 + 0.12 * Math.sin(t * 4)), 0, TAU)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.restore()

      if (still) {
        cancelAnimationFrame(raf)
        alive = false
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      host?.removeEventListener('mouseenter', enter)
      host?.removeEventListener('mouseleave', leave)
    }
  }, [size, secondsPerTurn])

  return <canvas ref={canvasRef} className={className} style={{ width: size, height: size }} aria-hidden />
}
