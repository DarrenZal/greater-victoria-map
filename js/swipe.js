// A swipe for the Greater Victoria demo map: a second map over the page's map that draws one raster layer and is cut at a line the visitor
// drags, so the left of the line shows one picture and the right shows the page's map. Plain ES module, no build step.
//
// The second map only draws, and the page's map keeps every click. It follows the page's map on every move, with the same centre, zoom, tilt,
// turn and height of the centre above the sea, and lifts its picture over the same 3D terrain when that is on, so the two line up.
export function createSwipe({ map, MapClass, el, demTiles, exaggeration }) {
  const root = map.getContainer()
  let other = null, styled = false, at = 0.5, label = ['', '']
  const box = el('div', null, 'swipe-map')
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
    box.style.clipPath = `inset(0 ${w - x}px 0 0)`
    handle.style.left = `${x}px`
    const pct = Math.round(at * 100)
    handle.setAttribute('aria-valuenow', String(pct))
    handle.setAttribute('aria-valuetext', `${label[0]} on the left of the line, ${label[1]} on the right, the line ${pct}% across`)
  }
  const follow = () => {
    if (!other) return
    other.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), elevation: map.getCenterElevation() })
  }
  const terrain = () => {
    if (!other || !styled) return // the second map's style is not in yet. 'style.load' calls this again
    const on = !!map.getTerrain()
    if (on && !other.getSource('dem')) other.addSource('dem', { type: 'raster-dem', tiles: [demTiles], encoding: 'terrarium', tileSize: 256, maxzoom: 15 })
    other.setTerrain(on ? { source: 'dem', exaggeration } : null)
    follow()
  }
  const resize = () => { other?.resize(); place() }

  // `layer` is a raster layer with its source ({ id, source }), drawn on the left of the line. `names` are the two sides, for the handle.
  function open(layer, names) {
    if (other) close()
    label = names
    left.textContent = names[0]; right.textContent = names[1]
    root.append(box, handle)
    other = new MapClass({
      container: box, interactive: false, attributionControl: false, centerClampedToGround: false, maxPitch: 85, fadeDuration: 0,
      style: { version: 8, sources: { [layer.id]: layer.source }, layers: [{ id: layer.id, type: 'raster', source: layer.id, paint: { 'raster-fade-duration': 0 } }] },
      center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
    })
    styled = false
    other.once('style.load', () => { styled = true; terrain() })
    map.on('move', follow)
    map.on('terrain', terrain)
    map.on('resize', resize)
    place()
  }
  function close() {
    if (!other) return
    map.off('move', follow); map.off('terrain', terrain); map.off('resize', resize)
    other.remove(); other = null
    box.remove(); handle.remove()
  }

  // Drag the line with a mouse, a pen or a finger, or move it with the arrow keys (Shift for bigger steps), Home and End.
  const setAt = (v) => { at = Math.min(0.98, Math.max(0.02, v)); place() }
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId)
    const moveTo = (ev) => { const r = root.getBoundingClientRect(); setAt((ev.clientX - r.left) / r.width) }
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
    setAt(to)
  })

  return { open, close, isOpen: () => !!other, at: () => at, setAt, other: () => other }
}
