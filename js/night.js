// The Night look of the map: a dark basemap and light labels, made in the browser by darkening the colours of the style that is already
// loaded (see nightColour in js/overlays-data.js), so no second style or extra request is needed. The first time Night is switched on, the
// colour of each basemap layer is kept, and switching it off puts every one back. Plain ES module, no build step.
import { nightValue, nightRole } from './overlays-data.js'

const COLOUR_PROPS = ['background-color', 'fill-color', 'fill-outline-color', 'line-color', 'text-color', 'text-halo-color', 'icon-color', 'icon-halo-color']

// `basemapSource` is the id of the vector source of the basemap (null if the basemap could not be loaded). `overrides` are the paint
// properties of the page's own layers that need a set value at night: { layerId: { property: value } }. Switching Night off puts back the value
// the layer had.
export function createNight({ map, basemapSource, overrides = {} }) {
  const g = document.createElement('canvas').getContext('2d')
  // A CSS colour as [red, green, blue, alpha], by letting the browser read it. null for text that is not a colour.
  const parse = (c) => {
    g.fillStyle = '#010203'; g.fillStyle = c
    const v = g.fillStyle
    if (v === '#010203' && !/^#010203$/i.test(c.trim())) return null
    if (v[0] === '#') return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1]
    const m = v.match(/[\d.]+/g)
    return m && m.length >= 3 ? [+m[0], +m[1], +m[2], m.length > 3 ? +m[3] : 1] : null
  }
  const saved = new Map() // layer|property -> the colour by day
  let on = false
  // The layers whose colours are darkened: the background, everything drawn from the basemap's source, and every text layer (the page's own labels too).
  const darkened = (l) => l.type === 'background' || (basemapSource && l.source === basemapSource) || l.type === 'symbol'

  function set(next) {
    if (next === on) return
    on = next
    for (const layer of map.getStyle().layers) {
      const props = []
      if (darkened(layer)) {
        for (const prop of COLOUR_PROPS) if (layer.paint && prop in layer.paint) props.push([prop, nightRole(layer, prop)])
        // A text layer that names no text colour is drawn in black, which is lost on a dark map. A road shield is left alone: its black text sits on a white picture.
        if (layer.type === 'symbol' && layer.layout?.['text-field'] && !layer.layout['icon-image'] && !(layer.paint && 'text-color' in layer.paint)) props.push(['text-color', 'text'])
      }
      for (const [prop, role] of props) {
        const key = `${layer.id}|${prop}`
        if (!saved.has(key)) saved.set(key, layer.paint?.[prop] ?? '#000000')
        map.setPaintProperty(layer.id, prop, on ? nightValue(saved.get(key), role, parse) : saved.get(key))
      }
      for (const [prop, value] of Object.entries(overrides[layer.id] || {})) {
        const key = `${layer.id}|${prop}`
        if (!saved.has(key)) saved.set(key, map.getPaintProperty(layer.id, prop))
        map.setPaintProperty(layer.id, prop, on ? value : saved.get(key))
      }
    }
  }
  return { set, isOn: () => on }
}
