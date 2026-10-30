// The chat service of the Greater Victoria demo map. Plain Node 18 or later, no packages.
//
// It holds the model key, fixes the instructions, the model and the tools, and passes a visitor's conversation to the model and the answer
// back as a stream. The browser runs the tools: the map commands change only what that visitor's page shows, and the two read tools run on
// files the map already serves. The service stores nothing. It keeps no conversation and no question, and it knows an address only as a
// counter of the rate limit, in memory, for an hour.
//
// Environment (on the server, from a file readable by root and the service only):
//   MODEL_API_KEY       the map's own key at the model provider (OPENROUTER_API_KEY is also read)
//   CHAT_MODEL          the model, as the provider names it
//   PORT                default 9030, on the loopback address only (Caddy passes /chat to it)
//   ALLOWED_ORIGINS     the pages that may call it, comma separated (default https://darrenzal.github.io)
//   MANIFEST_URL        the map's layer manifest (default the live site's data/manifest.json), read at start and every hour
//   PER_HOUR            requests per address per hour (default 60, about 20 questions with their tool steps)
//   PER_DAY             requests in total per day (default 1500)
//   OFF_FILE            while this file exists the service answers 503 (default /etc/gv-chat/off)
//   MODEL_URL           the model endpoint, OpenAI-compatible (default OpenRouter's). The checks point it at a stand-in. For Groq it is
//                       https://api.groq.com/openai/v1/chat/completions, with Zero Data Retention on in the account's Data Controls.
//   FALLBACK_URL, FALLBACK_KEY, FALLBACK_MODEL
//                       a second OpenAI-compatible endpoint, its key and model, optional. When the first answers 429 or 413 (a free plan
//                       at its limit, or a request larger than it allows), the call goes to the second at once instead of waiting.
//   MODEL_STREAM, FALLBACK_STREAM
//                       0 asks that endpoint for the whole answer at once, which the service then sends to the page as one chunk of the same
//                       stream. TELUS's Gemma (vLLM) needs it: its streamed tool calls garble nested arguments (48.4284 came as 48.04284,
//                       and "name" as "<|\"|name<|\"|"), and its answers whole are right.
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'

const env = process.env
const PORT = Number(env.PORT || 9030)
const KEY = env.MODEL_API_KEY || env.OPENROUTER_API_KEY || ''
const MODEL = env.CHAT_MODEL || ''
const MODEL_URL = env.MODEL_URL || 'https://openrouter.ai/api/v1/chat/completions'
const ORIGINS = (env.ALLOWED_ORIGINS || 'https://darrenzal.github.io').split(',').map((s) => s.trim()).filter(Boolean)
const MANIFEST_URL = env.MANIFEST_URL || 'https://darrenzal.github.io/greater-victoria-map/data/manifest.json'
const PER_HOUR = Number(env.PER_HOUR || 60)
const PER_DAY = Number(env.PER_DAY || 1500)
const OFF_FILE = env.OFF_FILE || '/etc/gv-chat/off'
// OpenRouter routes to many providers, so it is told to use only those that do not keep or train on prompts. A single provider (Groq) does
// not take that field, and its own setting (Zero Data Retention) does the same.
const RETRIES = 2, MAX_WAIT_S = Number(env.MAX_WAIT_S ?? 20)
export const extraFields = (url) => (new URL(url).host === 'openrouter.ai' ? { provider: { data_collection: 'deny' } } : {})
const MAP_URL = 'https://darrenzal.github.io/greater-victoria-map/'
const PRIMARY = { url: MODEL_URL, key: KEY, model: MODEL, stream: env.MODEL_STREAM !== '0' }
// Read at each call, so the checks can set it and take it away.
const fallback = () => (env.FALLBACK_URL && env.FALLBACK_KEY && env.FALLBACK_MODEL ? { url: env.FALLBACK_URL, key: env.FALLBACK_KEY, model: env.FALLBACK_MODEL, stream: env.FALLBACK_STREAM !== '0' } : null)

// Limits on what a page may send.
const MAX_MESSAGES = 24, MAX_QUESTION = 600, MAX_TOTAL = 40000, MAX_TOKENS = 700

// ---- the tools. Fixed here, so a page cannot add or change one. The browser runs them and sends back what they returned.
const LAYER = { type: 'string', description: 'A layer id from the manifest' }
const MATCH = {
  type: 'object',
  description: 'Which features: a field of that layer listed in the manifest, a comparison and a value',
  properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'in', 'between', 'gte', 'lte'] }, value: {} },
  required: ['field', 'op', 'value'],
}
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } })
export const TOOLS = [
  fn('show_layer', 'Turn a layer on or off, as a visitor ticking its box would.', { layer: LAYER, on: { type: 'boolean' } }, ['layer', 'on']),
  fn('highlight', 'Outline the features of a layer that match, with a short label. At most 500 features.', { layer: LAYER, match: MATCH, label: { type: 'string' } }, ['layer', 'match']),
  fn('fly_to', 'Move the map to a box [west, south, east, north] in degrees, or to a feature.', { bbox: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, feature: { type: 'object', properties: { layer: LAYER, id: { type: 'string' } } } }),
  fn('set_year', 'Move the time slider to a year that one of the ticked time layers has.', { year: { type: 'integer' } }, ['year']),
  fn('open_panel', 'Open the panel about one feature.', { layer: LAYER, id: { type: 'string' } }, ['layer', 'id']),
  fn('clear', 'Remove the outlines this chat has added.', {}),
  fn('describe_layer', 'What a layer is and is not, its years, fields, licence and record.', { layer: LAYER }, ['layer']),
  fn('query_features', 'Read up to 50 features of a layer the model may read, filtered by a match and/or a distance from a point.', { layer: LAYER, match: MATCH, near: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' }, radius_m: { type: 'number' } }, required: ['lng', 'lat', 'radius_m'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['layer']),
]

// ---- the instructions, with the manifest in them.
let manifest = null
export async function loadManifest() {
  try {
    const r = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const m = await r.json()
    if (!Array.isArray(m.layers) || !m.layers.length) throw new Error('no layers')
    manifest = m
    console.log(`manifest: ${m.layers.length} layers`)
  } catch (e) {
    console.log(`manifest not read: ${e.message}`) // the last good one stays in use
  }
}
const layerLine = (l) => [`- ${l.id}: ${l.title}. ${l.is} ${l.isNot}`, l.years ? `Years ${l.years[0]} to ${l.years[1]}, ${l.kind}.` : `Kind: ${l.kind}.`,
  l.modelMayRead ? `Fields: ${Object.keys(l.fields || {}).join(', ') || 'none'}.` : 'You may turn it on but never read or state its values.'].join(' ')
export function instructions(m = manifest) {
  return `You answer questions about the Greater Victoria open map (${MAP_URL}), a demo of open data about the land and water of Greater Victoria, British Columbia.

Answer only from this map's layers, using the tools. Do not use general knowledge for facts about places, species, years or numbers. If the map has nothing on a question, say so plainly and say which layers you looked at.

Rules:
- Cite every fact from a layer as [src:<layer id>], or [feat:<layer id>/<feature id>] for one feature. Use only ids from the manifest and from the tools' results. Never write a credit, licence or link yourself. The page adds them from its records.
- Say what a layer is not when it matters, from its manifest line. A record of herring spawn is not where herring are now, a model is not sightings, a legacy survey is not a current record, and a missing record is not proof of absence.
- Never give a live position of a whale or any animal. The map has none.
- Live layers (weather, sea, tides, gauges, earthquakes, life observations, seafloor depth): when a question is about one, call show_layer to turn it on, then say that they can read its values on the map. Never state a value yourself, and never ask the visitor to turn it on.
- Nothing about First Nations' territories, rights or positions. If asked, say this map has no such layer and that each Nation speaks for itself.
- Turn on the layers you talk about and move the map to the place, so the visitor sees what you mean. Set the year when a time layer is involved.
- Your answer is about the place and the data only. The page shows each map action under your answer, so never write that you turned a layer on or off, moved or zoomed the map, set the year or outlined something.
- Speak to the visitor as you.
- When you count, say what was counted and what was not.
- Which years a time layer has records for: call query_features and answer from its years_with_records and years_without_records. Name the years without records in the asked span. Never write "every year" or "each year" when years_without_records is not empty.
- Be brief: a few plain sentences. No headings. No em dashes or semicolons.

The visitor's page sends its state (ticked layers, year, view, selection) with each question.

Layers:
${(m?.layers || []).map(layerLine).join('\n')}`
}

// ---- limits, in memory only
const perAddress = new Map() // address -> [count, hour]
let day = { n: 0, date: '' }
function allowed(address) {
  const now = Date.now(), hour = Math.floor(now / 3600000), date = new Date(now).toISOString().slice(0, 10)
  if (day.date !== date) day = { n: 0, date }
  if (day.n >= PER_DAY) return 'day'
  const [n, h] = perAddress.get(address) || [0, hour]
  if (h === hour && n >= PER_HOUR) return 'hour'
  perAddress.set(address, [h === hour ? n + 1 : 1, hour])
  day.n++
  if (perAddress.size > 50000) for (const [a, [, ah]] of perAddress) if (ah !== hour) perAddress.delete(a)
  return null
}

// ---- checking what a page sends
export function checkBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return 'no messages'
  const msgs = body.messages
  if (!msgs.length || msgs.length > MAX_MESSAGES) return 'too many messages'
  let total = 0
  for (const m of msgs) {
    if (!m || !['user', 'assistant', 'tool'].includes(m.role)) return 'a message has a role this service does not take'
    if (m.content != null && typeof m.content !== 'string') return 'a message is not text'
    if (m.role === 'user' && (m.content || '').length > MAX_QUESTION) return `a question is longer than ${MAX_QUESTION} characters`
    if (m.role === 'tool' && typeof m.tool_call_id !== 'string') return 'a tool result has no call id'
    if (m.role === 'assistant' && m.tool_calls != null && !Array.isArray(m.tool_calls)) return 'bad tool calls'
    total += (m.content || '').length + JSON.stringify(m.tool_calls || '').length
  }
  if (total > MAX_TOTAL) return 'the conversation is too long'
  if (body.state != null && JSON.stringify(body.state).length > 4000) return 'the map state is too long'
  return null
}
const clean = (m) => m.role === 'tool' ? { role: 'tool', tool_call_id: m.tool_call_id, content: m.content || '' }
  : m.role === 'assistant' ? { role: 'assistant', content: m.content || '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((c) => ({ id: String(c.id), type: 'function', function: { name: String(c.function?.name), arguments: String(c.function?.arguments ?? '{}') } })) } : {}) }
  : { role: 'user', content: m.content || '' }

// ---- the server
function headers(origin) {
  return ORIGINS.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'Origin' } : { vary: 'Origin' }
}
function send(res, status, origin, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers(origin) })
  res.end(JSON.stringify(obj))
}
async function readBody(req) {
  let size = 0
  const parts = []
  for await (const c of req) { size += c.length; if (size > 200000) throw new Error('too big'); parts.push(c) }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

export const server = createServer(async (req, res) => {
  const origin = req.headers.origin || ''
  const path = new URL(req.url, 'http://x').pathname
  if (path !== '/chat' && path !== '/chat/') return send(res, 404, origin, { error: 'not found' })
  if (req.method === 'OPTIONS') { res.writeHead(ORIGINS.includes(origin) ? 204 : 403, headers(origin)); return res.end() }
  if (req.method === 'GET') return send(res, 200, origin, { on: !existsSync(OFF_FILE) && !!KEY && !!MODEL && !!manifest })
  if (req.method !== 'POST') return send(res, 405, origin, { error: 'POST only' })
  // An origin check stops other pages from spending the map's credit through visitors' browsers. It is not security on its own: the limits are.
  if (!ORIGINS.includes(origin)) return send(res, 403, origin, { error: 'this page may not use the chat' })
  if (existsSync(OFF_FILE) || !KEY || !MODEL || !manifest) return send(res, 503, origin, { error: 'The chat is off just now.' })
  const address = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  const over = allowed(address)
  if (over) return send(res, 429, origin, { error: over === 'hour' ? 'That is the most questions for one hour. Try again later.' : 'The chat has had its questions for today. Try again tomorrow.' })
  let body
  try { body = await readBody(req) } catch { return send(res, 400, origin, { error: 'not JSON' }) }
  const bad = checkBody(body)
  if (bad) return send(res, 400, origin, { error: bad })

  const state = body.state ? `\n\nThe visitor's map now: ${JSON.stringify(body.state)}` : ''
  const call = (p) => fetch(p.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json', 'http-referer': MAP_URL, 'x-title': 'Greater Victoria open map' },
    body: JSON.stringify({
      model: p.model, stream: p.stream, max_tokens: MAX_TOKENS, temperature: 0.2, tools: TOOLS, tool_choice: 'auto',
      ...extraFields(p.url),
      messages: [{ role: 'system', content: instructions() + state }, ...body.messages.map(clean)],
    }),
    signal: AbortSignal.timeout(60000),
  }).catch((e) => ({ ok: false, status: 502, statusText: e.message }))
  // A free plan allows few tokens a minute and says how long to wait (Groq: retry-after, in seconds). A short wait is waited out, twice at
  // most, while the page says it is thinking. A longer one is said as busy. With a second endpoint, the call goes there at once instead.
  let used = PRIMARY, upstream = await call(used)
  const second = fallback()
  // Groq's free plan answers 413 to one request larger than its tokens a minute (a long conversation with tool results), and 429 at its limit.
  if ((upstream.status === 429 || upstream.status === 413) && second) {
    console.log(`model: HTTP ${upstream.status}, asking the fallback`)
    used = second; upstream = await call(used)
  }
  for (let tries = 0; upstream.status === 429 && tries < RETRIES; tries++) {
    const after = upstream.headers?.get?.('retry-after'), wait = after ? Number(after) : NaN // no header: no wait
    if (!(wait >= 0 && wait <= MAX_WAIT_S)) break
    console.log(`model: HTTP 429, waiting ${wait} s`)
    await new Promise((r) => setTimeout(r, wait * 1000 + 250))
    upstream = await call(used)
  }
  if (!upstream.ok || !upstream.body) {
    console.log(`model: HTTP ${upstream.status}`) // the status only, never the body or the question
    // A free plan has limits per minute and per day, so the provider's 429 is said as busy, not as broken. A long wait (Groq's free plan
    // has 200,000 tokens a day, about 40 calls) is said in minutes or hours.
    if (upstream.status === 429) {
      const after = Number(upstream.headers?.get?.('retry-after')), min = Math.ceil(after / 60)
      const when = !(after > 90) ? 'in a minute' : min < 120 ? `in about ${min} minutes` : `in about ${Math.round(min / 60)} hours`
      return send(res, 503, origin, { error: after > 90 ? `The chat has used its share for now. Try again ${when}.` : 'The chat is busy just now. Try again in a minute.' })
    }
    return send(res, 502, origin, { error: 'The model did not answer just now. Try again later.' })
  }
  if (!used.stream) {
    // The whole answer, sent as one chunk of the stream the page reads: its text and its tool calls, and nothing else of the provider's.
    let m
    try { m = (await upstream.json()).choices[0].message } catch { return send(res, 502, origin, { error: 'The model did not answer just now. Try again later.' }) }
    const tool_calls = (m.tool_calls || []).map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.function?.name || '', arguments: c.function?.arguments || '' } }))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-chat-model': used.model, ...headers(origin) })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: m.content || '', ...(tool_calls.length ? { tool_calls } : {}) } }] })}\n\n`)
    return res.end('data: [DONE]\n\n')
  }
  // Which model answered, for the eval and the log. The privacy note names both.
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-chat-model': used.model, ...headers(origin) })
  try { for await (const chunk of upstream.body) res.write(chunk) } catch { /* the visitor left or the model stopped */ }
  res.end()
})

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadManifest()
  setInterval(loadManifest, 3600000).unref()
  server.listen(PORT, '127.0.0.1', () => console.log(`chat service on 127.0.0.1:${PORT}, model ${MODEL || '(none set)'}, origins ${ORIGINS.join(' ')}`))
}
