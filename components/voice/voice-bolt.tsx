"use client"

/**
 * The voice session's mark: the Blitz bolt in the accent colour, drawn on a canvas each frame. A
 * spark runs round its outline, slowly while it listens and fast while Blitz thinks; the learner's
 * voice and the reply make the spark longer and brighter and light the bolt from inside. The
 * learner's voice shows in a paler tint than the reply. Muted, it greys out and the spark stops.
 * Loudness comes from a callback read every frame, so the bolt moves without React re-rendering.
 * Colours are worked out as RGB from the theme's `--brand`, since canvas colours can't use
 * color-mix().
 */
import { useEffect, useRef } from "react"

/** What the session is doing, as the bolt shows it. */
export type BoltState = "idle" | "starting" | "listening" | "hearing" | "thinking" | "speaking"

/** How loud the learner and the reply are now, each as RMS (0..1). */
export type BoltLevels = { mic: number; out: number }

/** The bolt from the app icon, in its 1000-unit square. */
const BOLT_PATH =
  "M210.939 500.216L501.591 186.795C524.958 161.598 564.913 179.444 564.913 215.079V431.502H762.833C795.879 431.502 812.429 474.587 789.061 499.784L498.409 813.205C475.042 838.402 435.087 820.556 435.087 784.921V568.498H237.167C204.121 568.498 187.571 525.413 210.939 500.216Z"
/** The bolt's height and outline length in those units. */
const BOLT_HEIGHT = 660
const OUTLINE = 1900

/** How each state runs the spark: laps a second, its share of the outline, and the inner light. */
const MOTION: Record<BoltState, { laps: number; spark: number; light: number }> = {
  idle: { laps: 0, spark: 0, light: 0 },
  starting: { laps: 0.5, spark: 0.14, light: 0.08 },
  listening: { laps: 0.18, spark: 0.14, light: 0.12 },
  hearing: { laps: 0.4, spark: 0.16, light: 0.12 },
  thinking: { laps: 1.4, spark: 0.27, light: 0.1 },
  speaking: { laps: 0.4, spark: 0.16, light: 0.12 },
}

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

/** Eases toward [target] at [rate] a second. */
function ease(current: number, target: number, dt: number, rate: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

/**
 * The bolt, [size] CSS pixels square. [levels] is called every frame; [state] picks its motion.
 * Reduced motion keeps the spark still and lets the label carry the state.
 */
export function VoiceBolt({ size, state, levels }: { size: number; state: BoltState; levels: () => BoltLevels }) {
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
    const bolt = new Path2D(BOLT_PATH)
    const units = (size * scale * 0.68) / BOLT_HEIGHT
    let accent = ""
    let brand: [number, number, number] = [37, 99, 235]
    let energy = 0
    let grey = 0
    let pale = 0
    let laps = 0
    let spark = 0
    let light = 0
    let travelled = 0
    let frames = 0
    let last = performance.now()
    let frame = 0

    /** Draws one frame and asks for the next. */
    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      // The accent can change while voice is on; reading it now and then is enough.
      if (frames++ % 30 === 0) {
        const value = getComputedStyle(element).getPropertyValue("--brand").trim() || "#2563eb"
        if (value !== accent) { accent = value; brand = rgbOf(value) }
      }
      const { state: shown, levels: read } = latest.current
      const { mic, out } = read()
      const loud = still ? 0 : shown === "speaking" ? out : shown === "hearing" || shown === "listening" ? mic : 0
      // Speech RMS rarely passes 0.2; this maps it onto 0..1 with room for loud words. Quick up so a
      // word shows at once, slow down so it settles between syllables.
      const target = Math.min(1, Math.sqrt(loud * 5))
      energy = ease(energy, target, dt, target > energy ? 18 : 4)
      const motion = MOTION[shown]
      laps = ease(laps, motion.laps, dt, 4)
      spark = ease(spark, motion.spark + energy * 0.45, dt, 10)
      light = ease(light, motion.light + energy * 0.7 + (shown === "listening" && !still ? Math.sin(now / 625) * 0.04 : 0), dt, 10)
      grey = ease(grey, shown === "idle" ? 1 : 0, dt, 6)
      pale = ease(pale, shown === "hearing" || shown === "listening" ? 0.25 : 0, dt, 6)
      if (!still) travelled = (travelled + dt * laps * OUTLINE) % OUTLINE

      const colour = brand.map((channel, index) => Math.round(channel + ([128, 132, 140][index] - channel) * grey)) as [number, number, number]
      const w = size * scale
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, w, w)
      context.setTransform(units, 0, 0, units, w / 2 - 500 * units, w / 2 - 500 * units)
      context.lineJoin = "round"
      context.lineCap = "round"

      context.fillStyle = tint(colour, pale, light * (1 - grey))
      context.fill(bolt)
      context.setLineDash([])
      context.lineWidth = 18
      context.strokeStyle = tint(colour, 0, 0.4 + grey * 0.1)
      context.stroke(bolt)

      const length = spark * OUTLINE * (1 - grey)
      if (length > 4) {
        context.setLineDash([length, OUTLINE - length])
        context.lineDashOffset = -travelled
        context.shadowColor = tint(colour, pale, 0.9)
        context.shadowBlur = w * (0.05 + energy * 0.12)
        context.lineWidth = 22 + energy * 14
        context.strokeStyle = tint(colour, pale)
        context.stroke(bolt)
        context.shadowBlur = 0
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [size])

  return <canvas ref={canvas} className="shrink-0" style={{ width: size, height: size }} aria-hidden="true" />
}
