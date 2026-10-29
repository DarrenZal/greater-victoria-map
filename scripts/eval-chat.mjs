#!/usr/bin/env node
// The eval of Ask the map: each question of scripts/eval-chat-questions.json is asked on a fresh copy of the page, through a chat service
// that calls the real model, and its answer is graded. Used to choose the model before the chat is switched on.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/eval-chat.mjs --out <dir> [--only id,id] [--pause 8]
//
// The page is the map served on BASE (default http://127.0.0.1:8791). Its calls to the chat address are passed to the service at SERVICE
// (default http://127.0.0.1:9031/chat), which runs server/chat-service.mjs with the model key, ALLOWED_ORIGINS set to BASE and MANIFEST_URL
// set to BASE's data/manifest.json. The key never reaches this script. Each question costs one to five model calls, so `--pause` (seconds)
// keeps a free plan under its tokens per minute. Writes results.json and results.md to the out folder, outside this repository.
//
// A question passes when every test it names holds: `layers` (at least one turned on or cited), `year` (the slider ends on it), `tools` (at
// least one called), `must` and `forbid` (patterns the answer must match or must not match). Every answer is also checked for links written
// by the model, which the instructions forbid. The grades are a first pass. The answers are read by a person before a model is chosen.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:8791'
const SERVICE = process.env.SERVICE || 'http://127.0.0.1:9031/chat'
const CHAT_URL = 'https://map-api.regeneratevictoria.org/chat'
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt }
const OUT = arg('--out')
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null
const PAUSE = Number(arg('--pause', '8')) * 1000
if (!OUT) { console.error('usage: node scripts/eval-chat.mjs --out <dir> [--only id,id] [--pause seconds]'); process.exit(1) }

const { questions } = JSON.parse(await readFile(join(ROOT, 'scripts/eval-chat-questions.json'), 'utf8'))
const pw = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const browser = await pw.chromium.launch()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const re = (s) => new RegExp(s, 'i')

async function askOne(item) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  // A page that fails is closed too, or its map keeps drawing and slows every page after it.
  try { return await askIn(ctx, item) } finally { await ctx.close() }
}

async function askIn(ctx, item) {
  const page = await ctx.newPage()
  const models = [] // which model answered each call, from the service's x-chat-model
  page.setDefaultTimeout(90000)
  // The page's chat address goes to the local service, with the page's own origin, as Caddy would pass it.
  await page.route(CHAT_URL, async (route) => {
    const req = route.request()
    const r = await fetch(SERVICE, { method: req.method(), headers: { 'content-type': 'application/json', origin: BASE }, body: req.method() === 'POST' ? req.postData() : undefined })
    if (r.headers.get('x-chat-model')) models.push(r.headers.get('x-chat-model'))
    await route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' }, body: Buffer.from(await r.arrayBuffer()) })
  })
  await page.goto(`${BASE}/?test`)
  await page.waitForFunction(() => window.__map?.isStyleLoaded() && window.__chat, null, { timeout: 90000 })
  await page.click('#chat-btn')
  await page.waitForFunction(() => !document.getElementById('chat-input').disabled || document.getElementById('chat-status').textContent, null, { timeout: 60000 })
  const t0 = Date.now()
  await page.evaluate((q) => window.__chat.ask(q), item.q)
  const out = await page.evaluate(() => {
    const msgs = window.__chat.messages
    const a = [...document.querySelectorAll('#chat-log .chat-a')].at(-1)
    return {
      raw: msgs.filter((m) => m.role === 'assistant').map((m) => m.content || '').join('\n'),
      shown: a?.querySelector('p')?.textContent ?? '',
      did: [...(a?.querySelectorAll('.chip.did') || [])].map((c) => c.textContent),
      sources: [...(a?.querySelectorAll('.chat-sources li') || [])].map((li) => li.textContent),
      calls: msgs.flatMap((m) => (m.tool_calls || []).map((c) => ({ name: c.function.name, args: c.function.arguments }))),
      results: msgs.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 300)),
      status: document.getElementById('chat-status').textContent,
      state: window.__chat.state(),
      cited: [...(a?.querySelectorAll('.chip:not(.did)') || [])].map((c) => c.textContent),
    }
  })
  out.seconds = Math.round((Date.now() - t0) / 100) / 10
  out.models = models
  return out
}

function grade(item, o) {
  const fails = []
  const text = `${o.raw}`
  const citedIds = [...text.matchAll(/\[(?:src|feat):([a-z0-9-]+)/g)].map((m) => m[1])
  if (item.layers && !item.layers.some((id) => o.state.layers.includes(id) || citedIds.includes(id))) fails.push(`none of ${item.layers.join(', ')} turned on or cited`)
  if (item.year != null && o.state.year !== item.year) fails.push(`year ${o.state.year}, wanted ${item.year}`)
  if (item.tools && !item.tools.some((n) => o.calls.some((c) => c.name === n))) fails.push(`none of ${item.tools.join(', ')} called`)
  for (const p of item.must || []) if (!re(p).test(o.shown || text)) fails.push(`does not say /${p}/`)
  for (const p of item.forbid || []) if (re(p).test(text)) fails.push(`says /${p}/`)
  if (/https?:\/\//.test(text)) fails.push('writes a link')
  // An action the answer claims must be one of its tool calls. The page lists the real ones under the answer.
  const called = (n) => o.calls.some((c) => c.name === n)
  if (/\b(moved|zoomed|flew|flown|centred|centered)\b[^.]{0,30}\b(map|to)\b/i.test(text) && !called('fly_to')) fails.push('claims a move it did not make')
  if (/\b(turned|switched) (on|off)\b|\bhave (now )?(turned|switched)\b/i.test(text) && !called('show_layer') && !called('clear')) fails.push('claims a layer change it did not make')
  if (/\b(set|moved) the (year|slider)\b/i.test(text) && !called('set_year')) fails.push('claims a year it did not set')
  if (!text.trim()) fails.push(`no answer${o.status ? ` (${o.status})` : ''}`)
  return fails
}

await mkdir(OUT, { recursive: true })
const results = []
for (const item of questions) {
  if (ONLY && !ONLY.has(item.id)) continue
  let o
  for (let attempt = 0; attempt < 2; attempt++) {
    try { o = await askOne(item) } catch (e) { o = { raw: '', shown: '', did: [], sources: [], calls: [], results: [], status: `harness: ${e.message}`, state: { layers: [], year: null }, cited: [] } }
    if (!/busy/i.test(o.status)) break
    await sleep(60000) // a free plan at its limit: wait a minute once
  }
  const fails = grade(item, o)
  results.push({ id: item.id, q: item.q, pass: !fails.length, fails, ...o })
  console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${item.id}${fails.length ? `: ${fails.join(' | ')}` : ''}  [${(o.models || []).join(', ')}]`)
  await sleep(PAUSE)
}
const passed = results.filter((r) => r.pass).length
await writeFile(join(OUT, 'results.json'), JSON.stringify({ model: process.env.EVAL_MODEL || null, at: new Date().toISOString(), passed, total: results.length, results }, null, 1))
const md = [`# Ask the map eval${process.env.EVAL_MODEL ? `: ${process.env.EVAL_MODEL}` : ''}`, '', `${passed} of ${results.length} passed the automatic grade.`, '']
for (const r of results) md.push(`## ${r.pass ? 'PASS' : 'FAIL'} ${r.id}: ${r.q}`, '', r.shown || `(no answer${r.status ? `: ${r.status}` : ''})`, '', `- Did: ${r.did.join(', ') || 'nothing'}`, `- Tools: ${r.calls.map((c) => `${c.name} ${c.args}`).join(' · ') || 'none'}`, `- Ended with layers ${r.state.layers.join(', ') || 'none'}, year ${r.state.year ?? 'none'}, ${r.seconds ?? '?'} s`, `- Models: ${(r.models || []).join(', ') || 'none'}`, ...(r.fails.length ? [`- Failed: ${r.fails.join(' | ')}`] : []), '')
await writeFile(join(OUT, 'results.md'), md.join('\n'))
console.log(`\n${passed} of ${results.length} passed. Results in ${OUT}`)
await browser.close()
