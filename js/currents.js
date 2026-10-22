// Sea currents for the Greater Victoria demo map: particles drawn on a canvas laid over the map.
// Plain ES module, no build step.
//
// The model gives a velocity for each hour on a grid (see js/overlays-data.js). Once the map has
// stopped moving, the grid is turned into a velocity field in screen pixels, on a coarse grid of
// points. Short-lived particles are dropped on sea points and carried along that field, each frame
// drawing a short segment. The segments fade, which leaves a trail. A particle that reaches land,
// the edge of the model or the end of its life starts again somewhere else on the sea.
import { screenField, fieldAt, horizonRow } from './overlays-data.js'

// The particles move this many times faster than the water, so 0.5 m/s shows as about 30 px a
// second at the opening zoom. It is the same at every zoom: zoomed in, the particles cover more pixels.
export const SPEED_UP = 3000
const FIELD_STEP = 7 // CSS px between the points of the velocity field
const PLACE_STEP = 28 // CSS px between the points whose place on the map is asked for (map.unproject)
const WIDE_PARTICLES = 4000
const NARROW_PARTICLES = 1500
const NARROW_WIDTH = 700 // a window narrower than this gets NARROW_PARTICLES
const LIFE_S = [1.5, 3.5] // seconds a particle lives, at random
const FADE_PER_FRAME = 0.04 // share of the trail that fades each frame, at 60 frames a second
// A canvas keeps 8 bits of alpha, so a small fade rounds back to the same value and leaves a faint ghost.
// The fade is therefore taken in larger steps, a few frames apart, which leaves no ghost above 2% alpha.
const FADE_MIN_STEP = 0.1
const MAX_STEP_PX = 10 // a particle never moves further than this in one frame
const HORIZON_MARGIN_PX = 8 // nothing is drawn this close to the horizon, where a pixel covers kilometres
// Speed bands (m/s) and how each is drawn: faster water is brighter and thicker, so its trail is longer.
const BANDS = [
  { from: 0, colour: 'rgba(214, 240, 248, 0.45)', width: 1.1 },
  { from: 0.15, colour: 'rgba(224, 245, 250, 0.65)', width: 1.3 },
  { from: 0.4, colour: 'rgba(240, 251, 253, 0.85)', width: 1.6 },
  { from: 0.8, colour: 'rgba(255, 255, 255, 1)', width: 2 },
]
const bandOf = (speed) => { let k = BANDS.length - 1; while (k > 0 && speed < BANDS[k].from) k--; return k }

export function createCurrents({ map, motionQuery }) {
  const canvas = document.createElement('canvas')
  canvas.id = 'currents-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  // Absolute, over the map canvas, under the popups and the panel, and it lets every touch through.
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none'
  let ctx = null
  let grid = null, field = null // the model's grid for the hour shown, and the screen field made from it
  let lattice = null // the places under the screen, kept until the view changes
  let on = false, moving = false
  let w = 0, h = 0
  let frameId = 0, lastTs = 0, frames = 0, fadeDue = 0
  let n = 0
  const px = new Float32Array(WIDE_PARTICLES), py = new Float32Array(WIDE_PARTICLES)
  const age = new Float32Array(WIDE_PARTICLES), life = new Float32Array(WIDE_PARTICLES)
  const out = [0, 0, 0]

  function size() {
    const box = map.getContainer()
    w = box.clientWidth; h = box.clientHeight
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio)
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.lineCap = 'round'
  }
  const clear = () => ctx?.clearRect(0, 0, w, h)

  // Which place is under each point of a lattice over the screen. map.unproject follows pitch and
  // 3D terrain, but it is slow with terrain on, so the lattice is coarse. Above the horizon of a
  // steeply pitched view it answers with places behind the camera, so those rows are left out.
  function places() {
    if (lattice) return lattice
    const cols = Math.ceil(w / PLACE_STEP) + 1, rows = Math.ceil(h / PLACE_STEP) + 1
    const lng = new Float64Array(cols * rows).fill(NaN), lat = new Float64Array(cols * rows).fill(NaN)
    const horizon = horizonRow(h, map.getVerticalFieldOfView(), map.getPitch())
    for (let j = 0; j < rows; j++) {
      if (j * PLACE_STEP < horizon + HORIZON_MARGIN_PX) continue
      for (let i = 0; i < cols; i++) {
        const p = map.unproject([i * PLACE_STEP, j * PLACE_STEP])
        if (p && Number.isFinite(p.lng) && Number.isFinite(p.lat) && Math.abs(p.lat) < 85) { lng[j * cols + i] = p.lng; lat[j * cols + i] = p.lat }
      }
    }
    return (lattice = { cols, rows, spacing: PLACE_STEP, lng, lat })
  }

  function spawn(i, fresh) {
    const o = field.list[Math.floor(Math.random() * field.list.length)]
    px[i] = ((o % field.cols) + Math.random() - 0.5) * field.step
    py[i] = (Math.floor(o / field.cols) + Math.random() - 0.5) * field.step
    life[i] = LIFE_S[0] + Math.random() * (LIFE_S[1] - LIFE_S[0])
    age[i] = fresh ? Math.random() * life[i] : 0
  }

  const buildField = () => { field = screenField(grid, w, h, FIELD_STEP, places()) }

  // Build the screen field for the view as it is now, and place the particles. About 4000 particles
  // when the sea fills half of a wide screen, fewer where there is less sea or on a narrow screen.
  function rebuild() {
    if (!on || !grid || !w || !h) return
    buildField()
    const seaArea = field.list.length * FIELD_STEP * FIELD_STEP
    const base = innerWidth < NARROW_WIDTH ? NARROW_PARTICLES : WIDE_PARTICLES
    n = field.list.length ? Math.min(base, Math.round(base * seaArea / (0.5 * w * h))) : 0
    for (let i = 0; i < n; i++) spawn(i, true)
    clear()
  }

  function frame(ts) {
    frameId = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (ts - lastTs) / 1000)
    lastTs = ts
    if (dt <= 0) return
    frames++
    // Fade what is there, then draw this frame's segments on top, one path for each speed band.
    fadeDue += 1 - Math.pow(1 - FADE_PER_FRAME, dt * 60)
    if (fadeDue >= FADE_MIN_STEP) {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0, 0, 0, ${fadeDue})`
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'
      fadeDue = 0
    }
    const paths = BANDS.map(() => new Path2D())
    for (let i = 0; i < n; i++) {
      age[i] += dt
      if (age[i] > life[i] || !fieldAt(field, px[i], py[i], out)) { spawn(i, false); continue }
      const x0 = px[i], y0 = py[i]
      let dx = out[0] * SPEED_UP * dt, dy = out[1] * SPEED_UP * dt
      const d = Math.hypot(dx, dy)
      if (d > MAX_STEP_PX) { dx *= MAX_STEP_PX / d; dy *= MAX_STEP_PX / d }
      px[i] = x0 + dx; py[i] = y0 + dy
      const path = paths[bandOf(out[2])]
      path.moveTo(x0, y0); path.lineTo(px[i], py[i])
    }
    BANDS.forEach((b, k) => { ctx.strokeStyle = b.colour; ctx.lineWidth = b.width; ctx.stroke(paths[k]) })
  }

  // With reduced motion nothing moves. Each particle is drawn once as a short streak that fades in
  // toward the way the water goes, so the direction can still be read. Faster water has longer streaks.
  function still() {
    clear()
    for (let i = 0; i < n; i++) {
      if (!fieldAt(field, px[i], py[i], out)) continue
      const m = Math.hypot(out[0], out[1])
      if (!m) continue
      const len = 6 + 16 * Math.min(out[2], 1), band = BANDS[bandOf(out[2])]
      const ux = out[0] / m, uy = out[1] / m
      ctx.strokeStyle = band.colour; ctx.lineWidth = band.width
      for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = 0.3 + 0.35 * k
        ctx.beginPath()
        ctx.moveTo(px[i] + ux * len * (k / 3 - 0.5), py[i] + uy * len * (k / 3 - 0.5))
        ctx.lineTo(px[i] + ux * len * ((k + 1) / 3 - 0.5), py[i] + uy * len * ((k + 1) / 3 - 0.5))
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  function stopLoop() { if (frameId) { cancelAnimationFrame(frameId); frameId = 0 } }
  // Run the loop only while the layer is on, the map is still, this tab is in front and there is sea to draw on.
  function sync() {
    const run = on && !!field && n > 0 && !moving && !document.hidden && !motionQuery.matches
    if (run && !frameId) { lastTs = performance.now(); frameId = requestAnimationFrame(frame) }
    if (!run) stopLoop()
  }
  function settle() {
    if (!on || moving) return
    rebuild()
    if (motionQuery.matches && field) still()
    sync()
  }

  map.on('movestart', () => { moving = true; lattice = null; stopLoop(); clear() })
  map.on('moveend', () => { moving = false; settle() })
  map.on('resize', () => { lattice = null; if (on) { size(); settle() } })
  document.addEventListener('visibilitychange', sync)
  motionQuery.addEventListener('change', () => { if (on && !moving) { clear(); settle() } })

  return {
    // Show the currents of one hour. The first call puts the canvas on the map; later calls swap
    // the hour and leave the particles where they are.
    show(g) {
      grid = g
      if (on) {
        if (field && !moving) buildField()
        return
      }
      on = true
      map.getCanvasContainer().appendChild(canvas)
      ctx = canvas.getContext('2d')
      size()
      moving = map.isMoving()
      settle()
    },
    // Take the canvas off the map and let go of the grid.
    hide() {
      on = false; grid = null; field = null; lattice = null; n = 0
      stopLoop(); clear(); fadeDue = 0
      canvas.remove()
    },
    // For scripts/browser-check.mjs.
    horizon: () => horizonRow(h, map.getVerticalFieldOfView(), map.getPitch()),
    stats() {
      let drawn = 0, land = 0, top = Infinity
      if (on && ctx && field) {
        const ratio = canvas.width / w, data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        // A drawn pixel counts as over land when no sea point of the field lies within two points of it.
        const near = (x, y) => {
          const i = Math.round(x / field.step), j = Math.round(y / field.step)
          for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < field.cols && jj < field.rows && field.sea[jj * field.cols + ii]) return true }
          return false
        }
        for (let y = 0; y < canvas.height; y += 2) {
          for (let x = 0; x < canvas.width; x += 2) {
            if (data[(y * canvas.width + x) * 4 + 3] > 40) { drawn++; top = Math.min(top, y / ratio); if (!near(x / ratio, y / ratio)) land++ }
          }
        }
      }
      return { on, running: frameId !== 0, frames, particles: n, seaPoints: field ? field.list.length : 0, drawn, land, top, width: w, height: h, canvasWidth: canvas.width, attached: canvas.isConnected }
    },
  }
}
