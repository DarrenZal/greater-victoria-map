// A swipe for the Greater Victoria demo map: a line the visitor drags across the map, with what each side shows drawn by a map of its own
// over the page's map and cut at the line. Plain ES module, no build step.
//
// The air photos give the left side only (the 1932 photo), and the page's map shows 1950 on the right. The sensitive ecosystems are shapes
// over the street map, so they give both sides (1994-95 on the left, 2002 on the right) and the page's map draws neither, or each year would
// show through the other. The maps over the page's map only draw, and the page's map keeps every click. They follow it on every move, with
// the same centre, zoom, tilt, turn and height of the centre above the sea, and lift what they draw over the same 3D terrain when that is on,
// so everything lines up.
// `listeners` are map events ({ error, sourcedata }) the caller also wants from the maps over the page's map, so a source that fails there
// is reported as it is on the page's map.
export function createSwipe({ map, MapClass, el, demTiles, exaggeration, onMove, listeners = {} }) {
  const root = map.getContainer()
  let sides = [], at = 0.5, range = [0.02, 0.98], label = ['', '']
  const handle = el('div', null, 'swipe-handle')
  handle.setAttribute('role', 'slider')
  handle.tabIndex = 0
  handle.setAttribute('aria-valuemin', '0')
  handle.setAttribute('aria-valuemax', '100')
  const grip = el('span', null, 'swipe-grip')
  const left = el('span', null, 'swipe-label left'), right = el('span', null, 'swipe-label right')
  handle.append(grip, left, right)

  const place = () => {
    const w = root.clientWidth, x = Math.round(at * w)
    for (const s of sides) s.box.style.clipPath = s.right ? `inset(0 0 0 ${x}px)` : `inset(0 ${w - x}px 0 0)`
    handle.style.left = `${x}px`
    // At an edge the grip moves inside the map, so it can still be taken.
    if (at <= 0 || at >= 1) handle.dataset.edge = at <= 0 ? 'left' : 'right'
    else delete handle.dataset.edge
    const pct = Math.round(at * 100)
    handle.setAttribute('aria-valuenow', String(pct))
    handle.setAttribute('aria-valuetext', `${label[0]} on the left of the line, ${label[1]} on the right, the line ${pct}% across`)
  }
  const follow = () => {
    for (const s of sides) s.map.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), elevation: map.getCenterElevation() })
  }
  const terrain = () => {
    const on = !!map.getTerrain()
    for (const s of sides) {
      if (!s.styled) continue // that map's style is not in yet. Its 'style.load' calls this again
      if (on && !s.map.getSource('dem')) s.map.addSource('dem', { type: 'raster-dem', tiles: [demTiles], encoding: 'terrarium', tileSize: 256, maxzoom: 15 })
      s.map.setTerrain(on ? { source: 'dem', exaggeration } : null)
    }
    follow()
  }
  const resize = () => { for (const s of sides) s.map.resize(); place() }

  // `spec.left`, and `spec.right` if given, is what that side draws: style `sources` and `layers`. `names` are the two sides, for the
  // handle. `opts.at` is where the line starts, as the share of the map left of it, and `opts.edges` lets the line go to the edges.
  // `opts.skirts` keeps MapLibre's terrain skirts, the walls it hangs below each terrain tile's edges to hide the cracks between tiles. The
  // page's map hides the walls under its opaque ground. A side that draws shapes over clear ground has no ground, so the walls would show as
  // long streaks below the shapes on a tilted map, and it goes without them. A photo covers its ground, and without the walls the cracks
  // between terrain tiles would show through it as lines.
  function open(spec, names, opts = {}) {
    if (sides.length) close()
    label = names
    left.textContent = names[0]; right.textContent = names[1]
    range = opts.edges ? [0, 1] : [0.02, 0.98]
    at = clamp(opts.at ?? 0.5)
    for (const side of ['left', 'right']) {
      if (!spec[side]) continue
      const box = el('div', null, 'swipe-map')
      root.append(box)
      const s = { box, right: side === 'right', styled: false }
      s.map = new MapClass({
        container: box, interactive: false, attributionControl: false, centerClampedToGround: false, maxPitch: 85, fadeDuration: 0, terrainSkirtLength: opts.skirts ? 'auto' : 'none',
        style: { version: 8, sources: spec[side].sources, layers: spec[side].layers },
        center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
      })
      s.map.once('style.load', () => { s.styled = true; terrain() })
      for (const [type, fn] of Object.entries(listeners)) s.map.on(type, fn)
      sides.push(s)
    }
    root.append(handle)
    map.on('move', follow)
    map.on('terrain', terrain)
    map.on('resize', resize)
    place()
  }
  function close() {
    if (!sides.length) return
    map.off('move', follow); map.off('terrain', terrain); map.off('resize', resize)
    for (const s of sides) { s.map.remove(); s.box.remove() }
    sides = []
    handle.remove()
  }

  // Drag the line with a mouse, a pen or a finger, or move it with the arrow keys (Shift for bigger steps), Home and End. A line that may
  // go to the edges snaps to one within 2% of it. Only a move by the visitor is passed to `onMove`.
  const clamp = (v) => {
    const c = Math.min(range[1], Math.max(range[0], v))
    return range[0] === 0 && c < 0.02 ? 0 : range[1] === 1 && c > 0.98 ? 1 : c
  }
  const setAt = (v, byVisitor = false) => { at = clamp(v); place(); if (byVisitor) onMove?.(at) }
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId)
    const moveTo = (ev) => { const r = root.getBoundingClientRect(); setAt((ev.clientX - r.left) / r.width, true) }
    const up = () => { handle.removeEventListener('pointermove', moveTo); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up) }
    handle.addEventListener('pointermove', moveTo)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
    e.preventDefault()
  })
  handle.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.02
    const to = { ArrowLeft: at - d, ArrowDown: at - d, ArrowRight: at + d, ArrowUp: at + d, Home: 0, End: 1 }[e.key]
    if (to == null) return
    e.preventDefault()
    setAt(to, true)
  })

  return {
    open, close, isOpen: () => sides.length > 0, at: () => at, setAt: (v) => setAt(v),
    // the line's distance from the left of the map in pixels, the map of the left side, and every map over the page's map
    x: () => Math.round(at * root.clientWidth), other: () => sides[0]?.map ?? null, maps: () => sides.map((s) => s.map),
  }
}
