// The time control of the Greater Victoria demo map: one slider, a Play button, Earlier and Later, and a readout of what each layer shows.
// Plain ES module, no build step. It is hidden until a layer that changes over time is ticked.
//
// A layer registers its steps (see js/time-data.js) and two functions:
//   register(id, { kind, steps, order, show(frame, t), line(frame, t) })
// `show` puts the layer's picture for year `t` on the map (`frame` is its own step for that year, or null when it has nothing for it) and may
// return a promise that settles when the picture is in, so Play waits for it. `line` is the layer's sentence in the readout, and the readout
// lists the layers by `order`. A layer leaves with
// unregister(id). The slider runs over the steps of every registered layer, so all of them move through time together. A layer can call
// register again with other steps (another past, or years after today) and the slider follows.
import { timeAxis, axisIndex, frameAt } from './time-data.js'

const STEP_MS = 1300 // how long Play shows each step, once its pictures are in
const WAIT_MS = 10000 // the longest Play waits for a step's pictures before it moves on

export function createTimeline({ $, motionQuery }) {
  const bar = $('timebar'), slider = $('time-slider'), play = $('time-play'), prev = $('time-prev'), next = $('time-next')
  const year = $('time-year'), lines = $('time-lines'), from = $('time-from'), to = $('time-to'), paused = $('time-paused')
  const layers = new Map()
  let axis = [], at = -1, playing = false, timer = 0, token = 0, ready = Promise.resolve()
  // For scripts/browser-check.mjs: each step Play or the visitor moves to, with the time it was shown.
  const log = new URLSearchParams(location.search).has('test') ? [] : null

  function register(id, spec) {
    const fresh = !layers.has(id)
    layers.set(id, spec)
    const t = axis[at]?.t
    axis = timeAxis([...layers.values()].map((l) => l.steps))
    // A layer just ticked starts at its first step when the year the slider is on has nothing of it, so ticking a box always shows something.
    at = t == null || (fresh && !frameAt(spec.steps, spec.kind, t)) ? axisIndex(axis, spec.steps[0].t) : axisIndex(axis, t)
    apply()
  }
  function unregister(id) {
    if (!layers.delete(id)) return
    const t = axis[at]?.t
    axis = timeAxis([...layers.values()].map((l) => l.steps))
    at = axis.length ? axisIndex(axis, t) : -1
    if (!axis.length) setPlaying(false)
    apply()
  }

  // Show step `at` on every layer and say so.
  function apply() {
    bar.hidden = !axis.length
    if (!axis.length) { lines.replaceChildren(); return }
    const s = axis[at], waits = []
    slider.max = String(axis.length - 1)
    slider.value = String(at)
    slider.setAttribute('aria-valuetext', s.label)
    year.textContent = s.label
    from.textContent = axis[0].label
    to.textContent = axis.at(-1).label
    const out = []
    for (const l of [...layers.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const frame = frameAt(l.steps, l.kind, s.t)
      const p = l.show(frame, s.t)
      if (p?.then) waits.push(p)
      out.push(l.line(frame, s.t))
    }
    lines.replaceChildren(...out.map((text) => { const p = document.createElement('p'); p.textContent = text; return p }))
    ready = Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, WAIT_MS))])
    if (log) log.push({ t: s.t, at: performance.now() })
    sync()
  }
  function go(i) {
    if (!axis.length) return
    at = Math.max(0, Math.min(axis.length - 1, i))
    apply()
  }

  function sync() {
    const reduced = motionQuery.matches
    play.textContent = playing ? 'Pause' : 'Play'
    play.setAttribute('aria-pressed', String(playing))
    play.disabled = reduced || axis.length < 2
    paused.hidden = !reduced
    prev.disabled = at <= 0
    next.disabled = at >= axis.length - 1
    // A readout that changes every step is not read out while Play runs.
    lines.setAttribute('aria-live', playing ? 'off' : 'polite')
  }
  // Play moves one step at a time and waits for the pictures of each step before it starts counting. It stops at the last step. Play pressed
  // there starts again from the first.
  function setPlaying(on) {
    playing = !!on && !motionQuery.matches && axis.length > 1
    token++
    clearTimeout(timer); timer = 0
    if (playing && at >= axis.length - 1) go(0)
    sync()
    if (playing) schedule()
  }
  async function schedule() {
    const mine = token
    await ready
    if (mine !== token || !playing) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = 0
      if (mine !== token || !playing || document.hidden) return // a hidden tab waits, and visibilitychange starts it again
      go(at + 1)
      if (at >= axis.length - 1) setPlaying(false)
      else schedule()
    }, STEP_MS)
  }

  play.addEventListener('click', () => setPlaying(!playing))
  prev.addEventListener('click', () => { setPlaying(false); go(at - 1) })
  next.addEventListener('click', () => { setPlaying(false); go(at + 1) })
  slider.addEventListener('input', () => { setPlaying(false); go(Number(slider.value)) })
  document.addEventListener('visibilitychange', () => { if (playing && !document.hidden && !timer) schedule() })
  motionQuery.addEventListener('change', () => { if (motionQuery.matches) setPlaying(false); sync() })

  return {
    register, unregister, go, setPlaying,
    // the year the slider is on, or null when nothing is registered
    time: () => axis[at]?.t ?? null,
    state: () => ({ axis: axis.map((s) => s.label), at, playing, layers: [...layers.keys()], log }),
  }
}
