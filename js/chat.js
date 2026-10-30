// "Ask the map": a chat with an AI model that answers from this map's own layers. Plain ES module, no build step.
//
// The page sends the conversation and the map's state to the map's chat service (server/chat-service.mjs), which adds the instructions and
// the tools and passes it to the model. The model may ask for tools. This page runs them: six map commands that change only what this page
// shows, and two read tools over files this site serves. Every command and read is checked against the layer manifest (data/manifest.json):
// a layer the manifest does not list, or a field it does not list for that layer, is refused, and a layer the model may not read (the live
// layers, and anything from the Canadian Hydrographic Service) is never read. The page keeps the conversation in memory only.
// Answers cite layers as [src:<layer>] and features as [feat:<layer>/<n>]. The page turns each into a chip whose title, licence and link
// come from the manifest, never from the model, and drops a key it cannot resolve.
export const CHAT_URL = 'https://map-api.regeneratevictoria.org/chat'
const MANIFEST_FILE = 'data/manifest.json'
const MAX_ROUNDS = 4 // tool rounds per question
const MAX_HIGHLIGHT = 500
const MAX_QUERY = 50
const MAX_PLACES = 10 // places given their own years in one read
const CITE = /\[(src|feat):([a-z0-9-]+)(?:\/(\d+))?\]/g

export function createChat({ map, $, el, time, maxBounds, showFeature, motionQuery }) {
  const panel = $('chat'), log = $('chat-log'), form = $('chat-form'), input = $('chat-input'), status = $('chat-status'), btn = $('chat-btn')
  const messages = [] // the conversation, sent with each request
  let manifest = null, busy = false, hlCount = 0
  const files = new Map() // layer file -> its features, fetched once

  // ---- the manifest
  async function layers() {
    if (manifest) return manifest
    const r = await fetch(MANIFEST_FILE)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const m = await r.json()
    manifest = new Map(m.layers.map((l) => [l.id, l]))
    return manifest
  }
  const layer = (id) => manifest?.get(id) || null
  // A layer may have several files (the two years of the ecosystems, the creeks, lakes and wetlands). Their features are read once and kept
  // in one list in the manifest's order, so a feature's number is its place in that list, and each knows its file.
  async function features(l) {
    const list = [l.file].flat().filter((p) => p?.endsWith('.geojson')) // a picture layer has no features to read
    if (!list.length) return null
    const key = list.join('|')
    if (!files.has(key)) {
      const one = (file) => fetch(file).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }).then((fc) => (fc.features || []).map((f) => ({ ...f, file })))
      files.set(key, Promise.all(list.map(one)).then((all) => all.flat()))
    }
    return files.get(key)
  }

  // ---- the map's state, sent with each question
  function state() {
    const b = map.getBounds(), r = (v) => Math.round(v * 1e4) / 1e4
    const on = [...(manifest?.values() || [])].filter((l) => document.querySelector(l.box)?.checked).map((l) => l.id)
    return { layers: on, year: time.timeline.time(), view: [r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth())], zoom: Math.round(map.getZoom() * 10) / 10 }
  }

  // ---- what an answer did, so Undo can put it back
  function snapshot() {
    return { boxes: [...manifest.values()].map((l) => [l.box, !!document.querySelector(l.box)?.checked]), at: time.timeline.state().at, camera: { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }, hl: hlCount }
  }
  function restore(s) {
    for (const [sel, was] of s.boxes) { const b = document.querySelector(sel); if (b && b.checked !== was) b.click() }
    if (s.at >= 0 && time.timeline.state().axis.length > s.at) time.timeline.go(s.at)
    map.jumpTo(s.camera)
    for (let n = s.hl + 1; n <= hlCount; n++) removeHighlight(n)
  }

  // ---- matching features: only fields the manifest lists for the layer
  function matcher(l, match) {
    if (!match) return () => true
    if (!(match.field in (l.fields || {}))) throw new Error(`${l.id} has no field ${match.field} that may be used`)
    const v = match.value, get = (f) => f.properties?.[match.field]
    switch (match.op) {
      case 'eq': return (f) => get(f) === v
      case 'in': if (!Array.isArray(v)) throw new Error('in needs a list'); return (f) => v.includes(get(f))
      case 'between': if (!Array.isArray(v) || v.length !== 2) throw new Error('between needs two values'); return (f) => get(f) >= v[0] && get(f) <= v[1]
      case 'gte': return (f) => get(f) >= v
      case 'lte': return (f) => get(f) <= v
      default: throw new Error(`unknown comparison ${match.op}`)
    }
  }
  const bboxOf = (g) => {
    let w = 180, s = 90, e = -180, n = -90
    const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]) } else c.forEach(walk) }
    walk(g.coordinates)
    return [w, s, e, n]
  }
  // Metres from a point to the box around a feature: 0 when the point is inside the box.
  const metresToBox = (lng, lat, [w, s, e, n]) => {
    const dx = Math.max(w - lng, 0, lng - e) * 111320 * Math.cos(lat * Math.PI / 180), dy = Math.max(s - lat, 0, lat - n) * 110540
    return Math.hypot(dx, dy)
  }

  // ---- the highlight layers this chat adds
  function addHighlight(fs, label) {
    const n = ++hlCount, id = `chat-hl-${n}`
    map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: fs } })
    const colour = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f6f55'
    map.addLayer({ id: `${id}-line`, type: 'line', source: id, filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': colour, 'line-width': 3 } })
    map.addLayer({ id: `${id}-dot`, type: 'circle', source: id, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': colour, 'circle-stroke-width': 3 } })
    return n
  }
  function removeHighlight(n) {
    const id = `chat-hl-${n}`
    for (const l of [`${id}-line`, `${id}-dot`]) if (map.getLayer(l)) map.removeLayer(l)
    if (map.getSource(id)) map.removeSource(id)
  }

  // ---- the tools. Each returns what goes back to the model, and a chip for the visitor when it changed the map.
  const need = (id) => { const l = layer(id); if (!l) throw new Error(`no layer ${id} on this map`); return l }
  const clampBox = ([w, s, e, n]) => [Math.max(w, maxBounds[0][0]), Math.max(s, maxBounds[0][1]), Math.min(e, maxBounds[1][0]), Math.min(n, maxBounds[1][1])]
  // A point is a box of no size, so it is widened by about 500 m. A box left inside out by the clamp lies outside the map.
  const fly = (box) => {
    let [w, s, e, n] = clampBox(box)
    if (!(w <= e && s <= n)) throw new Error('that place is outside this map')
    if (e - w < 0.01) { w -= 0.005; e += 0.005 }
    if (n - s < 0.01) { s -= 0.005; n += 0.005 }
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 16, animate: !motionQuery.matches })
  }
  const TOOLS = {
    async show_layer({ layer: id, on }) {
      const l = need(id), box = document.querySelector(l.box)
      if (!box) throw new Error(`${id} has no box`)
      if (box.checked !== !!on) box.click()
      // A layer that loads something says so in its status line. The next tool (a year, a read) waits until it is in or has failed.
      const line = $(`status-${id}`)
      for (let waited = 0; on && line && waited < 15000 && (!line.dataset.state || line.dataset.state === 'loading'); waited += 150) await new Promise((r) => setTimeout(r, 150))
      const failed = line?.dataset.state === 'fail'
      return { result: { ok: !failed, layer: id, on: !!on, ...(failed ? { error: line.textContent } : {}) }, chip: `${on ? 'Turned on' : 'Turned off'} ${l.title}` }
    },
    async highlight({ layer: id, match, label }) {
      const l = need(id), fs = await features(l)
      if (!fs) throw new Error(`${id} has no file to outline from`)
      const hit = fs.filter(matcher(l, match)).slice(0, MAX_HIGHLIGHT)
      if (!hit.length) return { result: { ok: true, count: 0 } }
      addHighlight(hit, label)
      return { result: { ok: true, count: hit.length }, chip: `Outlined ${hit.length} in ${l.title}${label ? `: ${label}` : ''}` }
    },
    async fly_to({ bbox, feature }) {
      if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) fly(bbox)
      else if (feature) { const f = (await features(need(feature.layer)))?.[Number(feature.id)]; if (!f?.geometry) throw new Error('no such feature'); fly(bboxOf(f.geometry)) }
      else throw new Error('fly_to needs a box or a feature')
      return { result: { ok: true }, chip: 'Moved the map' }
    },
    async set_year({ year }) {
      if (!time.timeline.years().length) throw new Error('no time layer is on, so turn one on first')
      if (!time.timeline.goTo(Number(year))) throw new Error(`the time layers on start after ${year}`)
      return { result: { ok: true, year: time.timeline.time() }, chip: `Year set to ${year}` }
    },
    async open_panel({ layer: id, id: fid }) {
      const l = need(id), f = (await features(l))?.[Number(fid)]
      if (!f?.geometry) throw new Error('no such feature')
      fly(bboxOf(f.geometry))
      showFeature?.(l, f)
      return { result: { ok: true }, chip: `Opened ${l.title}` }
    },
    async clear() {
      for (let n = 1; n <= hlCount; n++) removeHighlight(n)
      return { result: { ok: true }, chip: 'Cleared the outlines' }
    },
    async describe_layer({ layer: id }) {
      const { sources, box, ...rest } = need(id)
      return { result: rest }
    },
    async query_features({ layer: id, match, near, limit }) {
      const l = need(id)
      if (!l.modelMayRead) throw new Error(`${l.title} may be turned on but not read`)
      const fs = await features(l)
      if (!fs) throw new Error(`${id} has no file to read`)
      const keep = Object.keys(l.fields || {}), test = matcher(l, match), max = Math.min(Number(limit) || 20, MAX_QUERY)
      const hits = []
      fs.forEach((f, i) => {
        if (!f.geometry || !test(f)) return
        const box = bboxOf(f.geometry), m = near ? metresToBox(near.lng, near.lat, box) : null
        if (near && m > near.radius_m) return
        hits.push({ f, i, box, m })
      })
      // A read near a point gives the nearest first, each with its distance, so an answer about what is near a place names what is nearest
      // and not what comes first in the file.
      if (near) hits.sort((a, b) => a.m - b.m)
      const matched = hits.length
      const out = hits.slice(0, max).map(({ f, i, box, m }) => ({ id: i, ...([l.file].flat().length > 1 ? { file: f.file } : {}), ...Object.fromEntries(keep.map((k) => [k, f.properties?.[k] ?? null])), centre: [+((box[0] + box[2]) / 2).toFixed(5), +((box[1] + box[3]) / 2).toFixed(5)], ...(near ? { distance_m: Math.round(m) } : {}) }))
      // An event layer also gets the years of the matched features and the years between with none, so an answer about which years reads them
      // from the records and does not say "every year" across a gap. The span is the asked range when the match is a range of years, otherwise
      // the first to the last record. A read of several places gives each place its own years, since one place's record hides another's gap
      // (Saanich Inlet has 1945 and Victoria Harbour has not), and names the years of all of them together as such. The places nearest the
      // point come first, or else those with the most records, and only the first MAX_PLACES get their own years.
      let span = null
      if (l.kind === 'event') {
        const asked = match?.field === 'year' && match.op === 'between' ? match.value.map(Number) : null
        const yearsOf = (ys) => {
          const [from, to] = asked || [Math.min(...ys), Math.max(...ys)], none = []
          for (let y = from; y <= to && none.length <= 100; y++) if (!ys.has(y)) none.push(y)
          return { from, to, years_with_records: [...ys].sort((a, b) => a - b), years_without_records: none }
        }
        const byPlace = new Map()
        for (const { f } of hits) {
          const y = f.properties?.year, place = f.properties?.name ?? null
          if (!Number.isInteger(y)) continue
          if (!byPlace.has(place)) byPlace.set(place, new Set())
          byPlace.get(place).add(y)
        }
        const places = [...byPlace]
        if (!near) places.sort((a, b) => b[1].size - a[1].size)
        if (places.length === 1) span = { place: places[0][0], ...yearsOf(places[0][1]) }
        else if (places.length) {
          const { from, to, ...together } = yearsOf(new Set(places.flatMap(([, ys]) => [...ys])))
          span = {
            from, to, places: places.length,
            years_by_place: places.slice(0, MAX_PLACES).map(([place, ys]) => ({ place, ...yearsOf(ys) })),
            places_left_out: Math.max(0, places.length - MAX_PLACES),
            all_places_together: together,
            years_rule: 'Each place in years_by_place has its own years. all_places_together is the years with a record at any of these places, never the years of one place. Read a place left out by its name to get its years.',
          }
        }
      }
      return { result: { layer: id, matched, returned: out.length, features: out, ...(span || {}), near_rule: near ? 'near means the box around a feature is within radius_m of the point. The features come nearest first, and distance_m is from the point to that box.' : undefined } }
    },
  }

  // ---- talking to the service. The answer streams as server-sent events in the OpenAI shape.
  async function turn(onText) {
    const r = await fetch(CHAT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, state: state() }) })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.error || `The chat did not answer (HTTP ${r.status}).`)
    }
    const reader = r.body.getReader(), dec = new TextDecoder()
    let buf = '', text = ''
    const calls = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let cut
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut).trim()
        buf = buf.slice(cut + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let d
        try { d = JSON.parse(data).choices?.[0]?.delta } catch { continue }
        if (!d) continue
        if (d.content) { text += d.content; onText(text) }
        for (const c of d.tool_calls || []) {
          const k = c.index ?? calls.length
          calls[k] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (c.id) calls[k].id = c.id
          if (c.function?.name) calls[k].function.name += c.function.name
          if (c.function?.arguments) calls[k].function.arguments += c.function.arguments
        }
      }
    }
    return { text, calls: calls.filter(Boolean) }
  }

  // ---- showing an answer: plain text with chips for the citations it could resolve
  function render(box, text, cited) {
    box.replaceChildren()
    let last = 0
    const chips = new Set() // a source or feature already cited in this answer gets no second chip
    for (const m of text.matchAll(CITE)) {
      const l = layer(m[2]), key = m[0]
      const again = !l || chips.has(key) // a key the page cannot resolve is dropped, and so is a repeat
      const before = text.slice(last, m.index)
      box.append(document.createTextNode(again ? before.replace(/\s+$/, '') : before))
      last = m.index + m[0].length
      if (again) continue
      chips.add(key)
      cited.add(l.id)
      if (m[1] === 'feat' && m[3] != null) {
        const b = el('button', `${l.title} ${Number(m[3]) + 1}`, 'chip')
        b.type = 'button'
        b.addEventListener('click', () => TOOLS.open_panel({ layer: l.id, id: m[3] }).catch(() => {}))
        box.append(b)
      } else box.append(el('span', l.title, 'chip'))
    }
    box.append(document.createTextNode(text.slice(last)))
  }
  function sourcesOf(cited) {
    const list = el('ul', null, 'chat-sources')
    for (const id of cited) {
      const l = layer(id), li = el('li'), [first, ...more] = [l.record].flat()
      const a = el('a', l.title); a.href = first; a.target = '_blank'; a.rel = 'noopener'
      li.append(a)
      more.forEach((href, k) => { const b = el('a', `record ${k + 2}`); b.href = href; b.target = '_blank'; b.rel = 'noopener'; li.append(document.createTextNode(', '), b) })
      li.append(document.createTextNode(`. ${l.licence}`))
      list.append(li)
    }
    return list
  }

  async function ask(question) {
    if (busy) return
    busy = true; input.disabled = true
    status.textContent = 'Thinking…'
    log.append(el('p', question, 'chat-q'))
    const answer = el('div', null, 'chat-a'), text = el('p'), chips = el('div', null, 'chat-did')
    answer.append(text, chips)
    log.append(answer)
    const before = snapshot(), cited = new Set()
    let changed = false
    messages.push({ role: 'user', content: question })
    try {
      for (let round = 0; round <= MAX_ROUNDS; round++) {
        const { text: said, calls } = await turn((t) => { render(text, t, new Set()); log.scrollTop = log.scrollHeight })
        messages.push({ role: 'assistant', content: said, ...(calls.length ? { tool_calls: calls } : {}) })
        if (said) render(text, said, cited)
        if (!calls.length) break
        if (round === MAX_ROUNDS) { messages.pop(); messages.push({ role: 'assistant', content: said }); break }
        for (const c of calls) {
          let out
          try {
            const f = TOOLS[c.function.name]
            if (!f) throw new Error(`no tool ${c.function.name}`)
            out = await f(JSON.parse(c.function.arguments || '{}'))
            if (out.chip) { chips.append(el('span', out.chip, 'chip did')); changed = true }
          } catch (e) { out = { result: { error: e.message } } }
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out.result) })
        }
      }
      // The model leaves out what it did to the map, so an answer that was only map actions has no text of its own.
      if (!text.textContent.trim()) text.textContent = changed ? 'Done.' : 'No answer this time. Try asking another way.'
      if (cited.size) answer.append(sourcesOf(cited))
      if (changed) {
        const undo = el('button', 'Undo', 'small')
        undo.type = 'button'
        undo.addEventListener('click', () => { restore(before); undo.disabled = true })
        chips.append(undo)
      }
      status.textContent = ''
    } catch (e) {
      // The question stays out of the conversation, so the next one starts clean.
      while (messages.length && messages.at(-1).role !== 'user') messages.pop()
      messages.pop()
      answer.remove()
      status.textContent = e.message
    } finally {
      busy = false; input.disabled = false; input.focus()
      log.scrollTop = log.scrollHeight
    }
  }

  // ---- the panel
  async function open(on) {
    panel.hidden = !on
    btn.setAttribute('aria-expanded', String(on))
    document.body.classList.toggle('chat-open', on)
    if (!on) { btn.focus(); return }
    input.focus()
    try {
      await layers()
      const r = await fetch(CHAT_URL)
      const s = r.ok ? await r.json() : { on: false }
      input.disabled = !s.on
      status.textContent = s.on ? '' : 'The chat is off just now.'
    } catch {
      input.disabled = true
      status.textContent = 'The chat could not be reached just now.'
    }
  }
  btn.addEventListener('click', () => open(panel.hidden))
  $('chat-close').addEventListener('click', () => open(false))
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) open(false) })
  // Enter sends, as in other chats, and Shift+Enter starts a new line. A key that ends a composition (an IME) does not send.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() } })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const q = input.value.trim()
    if (!q) return
    input.value = ''
    ask(q)
  })

  return { ask, tools: TOOLS, state, messages, layers }
}
