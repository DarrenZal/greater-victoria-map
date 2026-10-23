// Moving particles for the Greater Victoria demo map, used for the Sea currents and the Wind layers:
// particles drawn on a canvas laid over the map. Plain ES module, no build step.
//
// The model gives a velocity for each hour on a grid (see js/overlays-data.js). Once the map has
// stopped moving, the grid is turned into a velocity field in screen pixels, on a coarse grid of
// points. Short-lived particles are dropped on points that have flow and carried along that field,
// each frame drawing a short segment. The segments fade, which leaves a trail. A particle that
// reaches a place with no flow (land for currents, the edge of the model for both) or the end of its
// life starts again somewhere else. While Play runs, the field is blended from one hour to the next
// over the time between the two, so the flow changes smoothly and does not jump each hour. One
// canvas and one engine serve both layers, so only one of the two can be shown at a time.
//
// The ideas of the look come from earth.nullschool.net (https://github.com/cambecc/earth, MIT licence,
// Copyright (c) 2014 Cameron Beccario): a trail that fades a few percent a frame so it lasts about a
// second, thin lines whose brightness follows the speed, and a look of pale trails on a dark map. No
// code of it is used here. The names of the ideas are in the README.
import { screenField, fieldAt, fieldBlendAt, fieldScale, horizonRow } from './overlays-data.js'

// How each layer looks and moves. pxPerMs is the speed on the screen of a particle for each m/s of
// the flow, and it is the same at every zoom, so zoomed in the picture of a given current or wind
// moves no faster across the screen. The real flow is far slower than it looks. streakAt is the speed
// (m/s) at which a still streak (reduced motion) reaches its full length. Each band is drawn from its
// speed (m/s) up: faster flow is darker and thicker, so its trail is longer. The colours are dark
// because the basemap is pale: the currents are blue, the wind is purple, so the two are not mixed up.
// `keep` is the share of a trail still there a second later: 25% by day, so a trail lasts about half a second, and 47% in the
// Night look, on a dark map, where the trails are also light, thin and brighter and thicker with speed (`night`).
export const FLOW_PROFILES = {
  currents: {
    pxPerMs: 60, // 0.5 m/s is about 30 px a second
    streakAt: 1,
    keep: 0.25,
    night: {
      keep: 0.47,
      bands: [
        { from: 0, colour: 'rgba(175, 215, 242, 0.8)', width: 1 },
        { from: 0.15, colour: 'rgba(196, 228, 248, 0.86)', width: 1.1 },
        { from: 0.4, colour: 'rgba(222, 241, 252, 0.92)', width: 1.4 },
        { from: 0.8, colour: 'rgba(255, 255, 255, 1)', width: 1.8 },
      ],
    },
    bands: [
      { from: 0, colour: 'rgba(12, 88, 132, 0.88)', width: 1.2 },
      { from: 0.15, colour: 'rgba(8, 74, 134, 0.92)', width: 1.4 },
      { from: 0.4, colour: 'rgba(6, 52, 122, 0.96)', width: 1.7 },
      { from: 0.8, colour: 'rgba(4, 28, 92, 1)', width: 2.1 },
    ],
  },
  wind: {
    pxPerMs: 12, // 5 m/s is about 60 px a second
    streakAt: 8,
    keep: 0.25,
    night: {
      keep: 0.47,
      bands: [
        { from: 0, colour: 'rgba(216, 202, 244, 0.85)', width: 1 },
        { from: 2, colour: 'rgba(224, 210, 245, 0.86)', width: 1.1 },
        { from: 5, colour: 'rgba(238, 229, 251, 0.92)', width: 1.4 },
        { from: 9, colour: 'rgba(255, 255, 255, 1)', width: 1.8 },
      ],
    },
    bands: [
      { from: 0, colour: 'rgba(112, 52, 142, 0.82)', width: 1.2 },
      { from: 2, colour: 'rgba(98, 34, 132, 0.9)', width: 1.4 },
      { from: 5, colour: 'rgba(80, 14, 112, 0.95)', width: 1.7 },
      { from: 9, colour: 'rgba(58, 0, 88, 1)', width: 2.1 },
    ],
  },
}
const FIELD_STEP = 7 // CSS px between the points of the velocity field
const PLACE_STEP = 28 // CSS px between the points whose place on the map is asked for (map.unproject)
const WIDE_PARTICLES = 4000
const NARROW_PARTICLES = 1500
const NARROW_WIDTH = 700 // a window narrower than this gets NARROW_PARTICLES
const LIFE_S = [1.5, 3.5] // seconds a particle lives, at random
// A canvas keeps 8 bits of alpha, so a small fade rounds back to the same value and leaves a faint ghost.
// The fade is therefore taken in larger steps, a few frames apart, which leaves no ghost above 2% alpha.
const FADE_MIN_STEP = 0.1
const MAX_STEP_PX = 10 // a particle never moves further than this in one frame
const HORIZON_MARGIN_PX = 8 // nothing is drawn this close to the horizon, where a pixel covers kilometres
const BLEND_MIN_MS = 250 // a blend to the next hour is never quicker than this
const bandOf = (bands, speed) => { let k = bands.length - 1; while (k > 0 && speed < bands[k].from) k--; return k }

export function createFlow({ map, motionQuery }) {
  const canvas = document.createElement('canvas')
  canvas.id = 'flow-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  // Absolute, over the map canvas, under the popups and the panel, and it lets every touch through.
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none'
  let ctx = null
  let kind = null, profile = null // 'currents' or 'wind', and how it looks and moves
  let night = false // the look: pale trails for a dark map, or dark trails for a pale one
  let grid = null, field = null // the model's grid for the hour shown, and the screen field made from it
  let grid2 = null, field2 = null, blendFrom = 0, blendMs = 0, blendT = 0 // the hour after it, while Play blends toward it, and how far the blend has gone (0 to 1)
  let stepScale = 0 // screen velocity of the field times this gives the speed the particles move at
  let lattice = null // the places under the screen, kept until the view changes
  let on = false, moving = false
  let w = 0, h = 0
  let frameId = 0, lastTs = 0, frames = 0, fadeDue = 0
  let n = 0
  let paceSum = 0, paceN = 0 // for pace(): the speed the particles really moved at, in px per second for each m/s
  const px = new Float32Array(WIDE_PARTICLES), py = new Float32Array(WIDE_PARTICLES)
  const age = new Float32Array(WIDE_PARTICLES), life = new Float32Array(WIDE_PARTICLES)
  const out = [0, 0, 0]

  const look = () => (night ? profile.night : profile) // bands and keep of the look in use
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

  // The screen field of the hour shown. Its velocities follow the zoom (a metre is more pixels the
  // closer the view), so they are scaled by one number to put a given m/s at the same speed on the
  // screen at every zoom. The tilt is kept: near the camera the picture still moves faster than far away.
  function buildField() {
    field = screenField(grid, w, h, FIELD_STEP, places())
    const scale = fieldScale(field)
    stepScale = scale > 0 ? profile.pxPerMs / scale : 0
    buildNext()
  }
  // The screen field of the hour a blend is heading for, if there is one. It is of the same view, so the same scale serves it.
  function buildNext() { field2 = grid2 ? screenField(grid2, w, h, FIELD_STEP, places()) : null }
  // The flow at a pixel for the moment now: the hour shown, or its blend with the hour after it.
  const sample = (x, y, o) => (field2 && blendT > 0 ? fieldBlendAt(field, field2, blendT, x, y, o) : fieldAt(field, x, y, o))

  // Build the screen field for the view as it is now, and place the particles. About 4000 particles
  // when the flow fills half of a wide screen, fewer where there is less or on a narrow screen.
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
    if (field2) blendT = Math.min(1, Math.max(0, (ts - blendFrom) / blendMs))
    // Fade what is there, then draw this frame's segments on top, one path for each speed band.
    fadeDue += 1 - Math.pow(look().keep, dt)
    if (fadeDue >= FADE_MIN_STEP) {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = `rgba(0, 0, 0, ${fadeDue})`
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'
      fadeDue = 0
    }
    const bands = look().bands, paths = bands.map(() => new Path2D())
    for (let i = 0; i < n; i++) {
      age[i] += dt
      if (age[i] > life[i] || !sample(px[i], py[i], out)) { spawn(i, false); continue }
      const x0 = px[i], y0 = py[i]
      let dx = out[0] * stepScale * dt, dy = out[1] * stepScale * dt
      const d = Math.hypot(dx, dy)
      if (d > MAX_STEP_PX) { dx *= MAX_STEP_PX / d; dy *= MAX_STEP_PX / d }
      px[i] = x0 + dx; py[i] = y0 + dy
      if (out[2] > 0.05) { paceSum += Math.min(d, MAX_STEP_PX) / dt / out[2]; paceN++ }
      const path = paths[bandOf(bands, out[2])]
      path.moveTo(x0, y0); path.lineTo(px[i], py[i])
    }
    bands.forEach((b, k) => { ctx.strokeStyle = b.colour; ctx.lineWidth = b.width; ctx.stroke(paths[k]) })
  }

  // With reduced motion nothing moves. Each particle is drawn once as a short streak that fades in
  // toward the way the flow goes, so the direction can still be read. Faster flow has longer streaks.
  function still() {
    clear()
    for (let i = 0; i < n; i++) {
      if (!fieldAt(field, px[i], py[i], out)) continue
      const m = Math.hypot(out[0], out[1])
      if (!m) continue
      const bands = look().bands, len = 6 + 16 * Math.min(out[2] / profile.streakAt, 1), band = bands[bandOf(bands, out[2])]
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
  // Run the loop only while the layer is on, the map is still, this tab is in front and there is flow to draw.
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

  // Take the canvas off the map and let go of the grid.
  function hide() {
    on = false; kind = null; profile = null; grid = null; field = null; grid2 = null; field2 = null; blendT = 0; lattice = null; n = 0; stepScale = 0
    stopLoop(); clear(); fadeDue = 0; frames = 0; paceSum = 0; paceN = 0
    canvas.remove()
  }

  return {
    // Show one hour of the flow `k`, 'currents' or 'wind'. The first call puts the canvas on the map;
    // later calls for the same flow swap the hour and leave the particles where they are. A call for the
    // other flow takes the first one off and starts again.
    show(g, k) {
      if (!FLOW_PROFILES[k]) throw new Error(`no such flow: ${k}`)
      if (on && k !== kind) hide()
      // The hour a blend was heading for becomes the hour shown, with its screen field already made.
      const next = on && grid2 === g && field2 && !moving
      grid = g
      if (next) { field = field2; grid2 = null; field2 = null; blendT = 0; return }
      grid2 = null; field2 = null; blendT = 0
      if (on) {
        if (field && !moving) buildField()
        return
      }
      on = true; kind = k; profile = FLOW_PROFILES[k]
      map.getCanvasContainer().appendChild(canvas)
      ctx = canvas.getContext('2d')
      size()
      moving = map.isMoving()
      settle()
    },
    hide,
    // Blend from the hour shown to the hour after it, `g`, over `ms` (never less than BLEND_MIN_MS), starting now. A later show() of the same
    // grid makes it the hour shown. Nothing happens with the layer off or under reduced motion (the picture is still then).
    blend(g, ms) {
      if (!on || !grid || motionQuery.matches) return
      grid2 = g; blendFrom = performance.now(); blendMs = Math.max(BLEND_MIN_MS, ms); blendT = 0; field2 = null
      if (field && !moving) buildNext()
    },
    // Go back to the hour shown alone, as when Play is paused.
    unblend() { grid2 = null; field2 = null; blendT = 0 },
    // The Night look (pale trails for a dark map) or the day look (dark trails for a pale one).
    setNight(on_) {
      if (night === on_) return
      night = on_
      fadeDue = 0
      if (ctx) { clear(); if (motionQuery.matches && field) still() }
    },
    // The flow at a screen pixel as the particles feel it now, [px/s, px/s, m/s] (the pixels they move in a second, and the flow itself), or null. For scripts/browser-check.mjs.
    probe(x, y) { return on && field && sample(x, y, out) ? [out[0] * stepScale, out[1] * stepScale, out[2]] : null },
    // For scripts/browser-check.mjs.
    horizon: () => horizonRow(h, map.getVerticalFieldOfView(), map.getPitch()),
    // The speed the particles really moved at since the last call, in px per second for each m/s of flow.
    pace() { const r = { pxPerMs: paceN ? paceSum / paceN : 0, samples: paceN }; paceSum = 0; paceN = 0; return r },
    stats() {
      let drawn = 0, land = 0, top = Infinity
      if (on && ctx && field) {
        const ratio = canvas.width / w, data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        // A drawn pixel counts as over land when no point of the field with flow lies within two points of it.
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
      return { on, kind, night, blend: field2 ? blendT : 0, blending: !!field2, running: frameId !== 0, frames, particles: n, seaPoints: field ? field.list.length : 0, drawn, land, top, width: w, height: h, canvasWidth: canvas.width, attached: canvas.isConnected }
    },
  }
}
