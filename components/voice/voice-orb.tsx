"use client"

/**
 * The voice session's orb, drawn on a canvas each frame: a soft sphere whose edge ripples with
 * the learner's voice while they talk and with the reply while it plays, that breathes while it
 * listens, turns a quicker sheen while Blitz thinks, and greys out while muted or starting.
 * Loudness comes from a callback read every frame, so the orb moves without React re-rendering.
 * Colours are worked out as RGB from the theme's `--brand`, since canvas colours can't use
 * color-mix().
 */
import { useEffect, useRef } from "react"

/** What the session is doing, as the orb shows it. */
export type OrbState = "idle" | "starting" | "listening" | "hearing" | "thinking" | "speaking"

/** How loud the learner and the reply are now, each as RMS (0..1). */
export type OrbLevels = { mic: number; out: number }

/** Ripples around the edge: how many bumps, how fast they travel, and how much each counts. */
const WAVES = [
  { bumps: 3, speed: 0.9, weight: 0.5 },
  { bumps: 5, speed: -1.3, weight: 0.3 },
  { bumps: 7, speed: 1.7, weight: 0.2 },
]

/** A CSS colour as red, green and blue (0..255), read back off a one-pixel canvas so any CSS form works. */
function rgbOf(colour: string): [number, number, number] {
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!pixel) return [37, 99, 235]
  pixel.fillStyle = colour
  pixel.fillRect(0, 0, 1, 1)
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

/** [rgb] mixed toward white by [white] (0..1), at [alpha], as a canvas colour. */
function tint([r, g, b]: [number, number, number], white: number, alpha = 1): string {
  const mix = (channel: number) => Math.round(channel + (255 - channel) * white)
  return `rgba(${mix(r)},${mix(g)},${mix(b)},${alpha.toFixed(3)})`
}

/** Eases toward [target]: quickly up so a word shows at once, slowly down so it settles between syllables. */
function follow(current: number, target: number, dt: number): number {
  const rate = target > current ? 18 : 4
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

/**
 * The orb, [size] CSS pixels square. [levels] is called every frame; [state] picks its motion.
 * Reduced motion keeps the sphere still and lets the label carry the state.
 */
export function VoiceOrb({ size, state, levels }: { size: number; state: OrbState; levels: () => OrbLevels }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ state, levels })
  useEffect(() => { latest.current = { state, levels } })

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext("2d")
    if (!element || !context) return
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const scale = window.devicePixelRatio || 1
    element.width = size * scale
    element.height = size * scale
    const brand = rgbOf(getComputedStyle(element).getPropertyValue("--brand").trim() || "#2563eb")
    let energy = 0
    let thinking = 0
    let grey = 0
    let speaking = 0
    let sheen = 0
    let last = performance.now()
    let frame = 0

    /** Draws one frame and asks for the next. */
    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const t = still ? 0 : now / 1000
      const { state: shown, levels: read } = latest.current
      const { mic, out } = read()
      const loud = still ? 0 : shown === "speaking" ? out : shown === "hearing" || shown === "listening" ? mic : 0
      // Speech RMS rarely passes 0.2; this maps it onto 0..1 with room for loud words.
      energy = follow(energy, Math.min(1, Math.sqrt(loud * 5)), dt)
      thinking = follow(thinking, shown === "thinking" || shown === "starting" ? 1 : 0, dt * 0.6)
      speaking = follow(speaking, shown === "speaking" ? 1 : 0, dt * 0.6)
      grey = follow(grey, shown === "idle" ? 1 : 0, dt * 0.6)
      sheen += still ? 0 : dt * (0.4 + thinking * 1.6)

      const w = size * scale
      const centre = w / 2
      const breathe = Math.sin(t * 1.6) * 0.012 * (1 - energy)
      const radius = w * 0.34 * (1 + breathe + energy * 0.08 - thinking * 0.03 * (1 + Math.sin(t * 3)))
      context.clearRect(0, 0, w, w)
      context.save()
      const colour = brand.map((channel, index) => Math.round(channel + ([128, 132, 140][index] - channel) * grey)) as [number, number, number]

      // Glow, wider and brighter with the voice, kept inside the canvas so its edge never shows.
      const glow = context.createRadialGradient(centre, centre, radius * 0.6, centre, centre, Math.min(centre, radius * (1.3 + energy * 0.3)))
      glow.addColorStop(0, tint(colour, 0.2, 0.3 + energy * 0.4))
      glow.addColorStop(1, tint(colour, 0.2, 0))
      context.fillStyle = glow
      context.fillRect(0, 0, w, w)
      if (speaking > 0.01) {
        context.strokeStyle = tint(colour, 0.3, speaking * (0.25 + energy * 0.45))
        context.lineWidth = scale * (1 + energy * 2)
        context.beginPath()
        context.arc(centre, centre, radius * (1.08 + energy * 0.22), 0, Math.PI * 2)
        context.stroke()
      }

      // The body: a closed curve whose radius ripples with the voice.
      const ripple = 0.006 + energy * 0.035
      context.beginPath()
      for (let step = 0; step <= 96; step++) {
        const angle = (step / 96) * Math.PI * 2
        let wave = 0
        for (const { bumps, speed, weight } of WAVES) wave += Math.sin(angle * bumps + t * speed * (1 + energy * 2)) * weight
        const r = radius * (1 + wave * ripple)
        const x = centre + Math.cos(angle) * r
        const y = centre + Math.sin(angle) * r
        if (step === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.closePath()
      const body = context.createRadialGradient(centre - radius * 0.35, centre - radius * 0.45, radius * 0.1, centre, centre, radius * 1.05)
      body.addColorStop(0, tint(colour, 0.75))
      body.addColorStop(0.55, tint(colour, 0.15))
      body.addColorStop(1, tint(colour, 0))
      context.fillStyle = body
      context.fill()

      // A soft light circling inside the sphere, faint at rest and quicker while thinking.
      context.clip()
      const light = 0.06 + thinking * 0.22
      const sx = centre + Math.cos(sheen) * radius * 0.45
      const sy = centre + Math.sin(sheen) * radius * 0.45
      const sweep = context.createRadialGradient(sx, sy, 0, sx, sy, radius * 0.75)
      sweep.addColorStop(0, `rgba(255,255,255,${light.toFixed(3)})`)
      sweep.addColorStop(1, "rgba(255,255,255,0)")
      context.fillStyle = sweep
      context.fillRect(0, 0, w, w)
      context.restore()
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [size])

  return <canvas ref={canvas} className="shrink-0" style={{ width: size, height: size }} aria-hidden="true" />
}
