#!/usr/bin/env node
// Browser checks for the Greater Victoria demo map, run in headless Chromium.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/browser-check.mjs [--shots dir] [--only regex]
//
// --only runs only the checks whose reported name matches the regex (case does not matter), for a rerun of a few checks that failed. A group of
// checks that has no name the regex could match is skipped, so a rerun takes minutes. The default, with no --only, runs every check.
//
// Playwright is not a dependency of this folder. Point PLAYWRIGHT_MODULE at an
// existing install, or leave it unset if `playwright` resolves from here.
// The folder is served by a small built-in static server on a free port.
// The page loads map tiles from tiles.openfreemap.org and, since Terrain shading and 3D terrain
// are on by default, elevation tiles from s3.amazonaws.com, and the desktop run ticks each live layer against its real service
// (api.weather.gc.ca, geo.weather.gc.ca, earthquake.usgs.gov, api.gbif.org, api.tidesandcurrents.noaa.gov), so this needs network.
// Sea currents are checked on both screen sizes, in 2D and 3D and under reduced motion, against geo.weather.gc.ca, and so are
// Wind, Sea temperature and Sea saltiness (same host), Tides and tidal currents (NOAA, one popup for each station, and the Victoria
// Harbour gauge of the Canadian Hydrographic Service at api-iwls.dfo-mpo.gc.ca) and Seafloor depth (ETOPO1 colours drawn from the
// elevation tiles, and over them the Canadian Hydrographic Service's NONNA tiles from nonna-geoserver.data.chs-shc.ca, which the check
// also compares with that service's own depth grid). The failure lines are checked separately with the outside hosts blocked.
//
// The page is declared ready by window.__ready, not map.loaded() or the 'idle'
// event, because neither settles while the flow dashes animate.
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname, dirname, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' }
const BOWKER = [-123.3165974, 48.4309387]
// Map layers of the optional overlays that exist from the start, all hidden. The radar layer is made on first use.
const OVERLAY_LAYERS = ['radar-credit', 'currents-credit', 'wind-credit', 'temperature-credit', 'salinity-credit', 'seafloor', 'seafloor-nonna', 'seafloor-nonna-10', 'tides-dot', 'tides-label', 'ecoregions-fill', 'ecoregions-sea-mask', 'ecoregions-line', 'alerts-fill', 'alerts-line', 'industry-dot', 'life-dot', 'water-dot', 'conditions-dot', 'aqhi-dot', 'quakes-dot', 'aqhi-label', 'conditions-label', 'water-label', 'quakes-label', 'protected-fill', 'protected-line', 'srkw-fill', 'srkw-line', 'cetaceans-fill', 'cetaceans-line', 'kelp-fill', 'kelp-line', 'eelgrass-fill', 'eelgrass-line', 'herring-line', 'seabirds-dot']
// What each box asks of the network when ticked: [host, ...] and the file it loads from this site.
// The radar is last: once ticked it asks again every 6 minutes while on, which would land in the window of whichever box is being ticked then
// (a request from another host than its own) and would stall the page, if it were ticked first and the others took a long time.
const OVERLAY_NET = {
  currents: { hosts: ['geo.weather.gc.ca'] }, wind: { hosts: ['geo.weather.gc.ca'] }, alerts: { hosts: ['api.weather.gc.ca'] }, aqhi: { hosts: ['api.weather.gc.ca'] },
  temperature: { hosts: ['geo.weather.gc.ca'] }, salinity: { hosts: ['geo.weather.gc.ca'] },
  // Tides ask NOAA or the Canadian Hydrographic Service only when a station is clicked, so ticking them contacts no outside host. Seafloor depth asks
  // the Canadian Hydrographic Service for tiles as soon as it is ticked (its ETOPO1 colours come from tiles the page already has).
  tides: { hosts: [] }, seafloor: { hosts: ['nonna-geoserver.data.chs-shc.ca'] },
  conditions: { hosts: ['api.weather.gc.ca'] }, water: { hosts: ['api.weather.gc.ca'] }, quakes: { hosts: ['earthquake.usgs.gov'] },
  life: { hosts: ['api.gbif.org'] }, ecoregions: { hosts: [], file: 'data/ecoregions.geojson' }, industry: { hosts: [], file: 'data/industry-waste.geojson' },
  // Marine life and protection: one file of this site each, so ticking contacts no outside host.
  protected: { hosts: [], file: 'data/marine-protected.geojson' }, srkw: { hosts: [], file: 'data/srkw-habitat.geojson' }, cetaceans: { hosts: [], file: 'data/whale-density.geojson' },
  kelp: { hosts: [], file: 'data/kelp.geojson' }, eelgrass: { hosts: [], file: 'data/eelgrass.geojson' }, herring: { hosts: [], file: 'data/herring-spawn.geojson' }, seabirds: { hosts: [], file: 'data/seabird-colonies.geojson' },
  radar: { hosts: ['geo.weather.gc.ca'] },
}
const NONNA_HOST = 'nonna-geoserver.data.chs-shc.ca', IWLS_HOST = 'api-iwls.dfo-mpo.gc.ca'
const LIVE_HOSTS = ['api.weather.gc.ca', 'geo.weather.gc.ca', 'earthquake.usgs.gov', 'api.gbif.org', 'api.tidesandcurrents.noaa.gov', NONNA_HOST, IWLS_HOST]
const ECCC_STATEMENT = 'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.'
// Text the map's attribution must carry while each layer is on.
const OVERLAY_ATTRIB = {
  radar: ECCC_STATEMENT, currents: ECCC_STATEMENT, wind: ECCC_STATEMENT, alerts: ECCC_STATEMENT, aqhi: ECCC_STATEMENT, conditions: ECCC_STATEMENT, water: ECCC_STATEMENT,
  temperature: ECCC_STATEMENT, salinity: ECCC_STATEMENT, tides: 'NOAA/NOS/CO-OPS', seafloor: 'Seafloor depth in Canadian waters: Canadian Hydrographic Service (NONNA, not for navigation)',
  quakes: 'U.S. Geological Survey', life: 'GBIF', ecoregions: 'Ecoregions 2017 \u00a9 Resolve', industry: 'HydroWASTE',
  protected: 'Protected areas: CPCAD', srkw: 'Killer whale critical habitat', cetaceans: 'Whale and porpoise model', kelp: 'Coastal habitat: CRIMS', eelgrass: 'Coastal habitat: CRIMS', herring: 'Coastal habitat: CRIMS', seabirds: 'Coastal habitat: CRIMS',
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (p.endsWith('/')) p += 'index.html'
      const abs = normalize(join(ROOT, p))
      if (!abs.startsWith(ROOT)) { res.writeHead(403).end(); return }
      const body = await readFile(abs)
      res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream' }).end(body)
    } catch { res.writeHead(404).end('not found') }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

let failures = 0, reported = 0
const onlyAt = process.argv.indexOf('--only')
if (onlyAt > 0 && !process.argv[onlyAt + 1]) throw new Error('--only needs a regular expression')
const ONLY = onlyAt > 0 ? new RegExp(process.argv[onlyAt + 1], 'i') : null
// With --only, a check whose name does not match is run and left unreported. `force` is for a group that stopped early, which is always reported.
const report = (pass, name, detail = '', force = false) => {
  if (ONLY && !force && !ONLY.test(name)) return
  reported++
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ': ' + detail : ''}`)
}

// ---- --only: which groups could report a check that matches
// The groups are the functions below. A group that calls others lists them, so it runs when any of them could match. What a group can report is
// read from its own text: the sentences it passes to t() and report(), as written (a ${...} in one stands for anything), so the list cannot fall
// behind the checks. A regex that matches none of them skips the group. If nothing matches at all, the run fails.
const CHILDREN = {
  checkViewport: ['checkLoadState', 'checkCurrents3d', 'checkToggles', 'checkFlowToggles', 'checkMarchDirection', 'checkTerrain', 'checkTerrain3d', 'checkOverlays', 'checkCurrents', 'checkWind', 'checkBlend', 'checkSea', 'checkTides', 'checkSeafloor', 'checkMarine', 'checkNight', 'checkPopups'],
}
const SOURCE = ONLY ? await readFile(fileURLToPath(import.meta.url), 'utf8') : ''
// What the name of a check starts with, for each group that is not run on both screen sizes. The others start with "desktop: " or "phone: ".
const PREFIXES = { checkReducedMotion: [''], checkBasemapDown: [''], checkOverlaysBlocked: ['hosts blocked: '], checkGeomet: ['geomet: '] }
const VIEWPORTS = ['desktop: ', 'phone: ']
const mayReport = (fn, prefixes = PREFIXES[fn] || VIEWPORTS) => {
  const at = SOURCE.search(new RegExp(`^(?:async )?function ${fn}\\(`, 'm'))
  if (at < 0) return true // not found: run it rather than skip it by mistake
  const end = SOURCE.indexOf('\n}\n', at), text = SOURCE.slice(at, end < 0 ? undefined : end)
  const sentences = [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2]).filter((x) => (x.match(/ /g) || []).length >= 3)
  const seen = sentences.flatMap((x) => [x.replace(/\$\{[^}]*\}/g, 'x'), ...x.split(/\$\{[^}]*\}/)])
  return seen.some((x) => prefixes.some((p) => ONLY.test(p + x))) || (CHILDREN[fn] || []).some((child) => mayReport(child, prefixes))
}
// `prefix` narrows it to one viewport: the checks of the desktop run all start with "desktop: ", and the phone's with "phone: ".
const wants = (fn, prefix) => !ONLY || mayReport(fn.name, prefix === undefined ? undefined : [prefix])
// Run a group. If a page call throws or times out, that is recorded as a failure and the next group still runs.
async function guarded(label, fn) {
  // Playwright's own message carries a log of what it was waiting for (for example the element that covered a button), so more than its first line is kept.
  try { await fn() } catch (e) { report(false, `${label} stopped before it finished`, String(e?.message || e).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8).join(' | ').slice(0, 900), true) }
}

export async function runBrowserChecks() {
  failures = 0; reported = 0
  const shotsIdx = process.argv.indexOf('--shots')
  const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null
  if (shots) await mkdir(shots, { recursive: true })
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
  const { server, base } = await serve()
  const browser = await chromium.launch()
  try {
    for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
      if (wants(checkViewport, `${name}: `)) await guarded(`${name}: ${checkViewport.name}`, () => checkViewport(browser, base, name, vp, shots))
    }
    if (wants(checkReducedMotion)) await guarded(checkReducedMotion.name, () => checkReducedMotion(browser, base))
    if (wants(checkBasemapDown)) await guarded(checkBasemapDown.name, () => checkBasemapDown(browser, base, shots))
    if (wants(checkOverlaysBlocked)) await guarded(checkOverlaysBlocked.name, () => checkOverlaysBlocked(browser, base))
    if (wants(checkGeomet)) await guarded(checkGeomet.name, () => checkGeomet(browser, base))
  } finally {
    await browser.close()
    server.close()
  }
  const matched = reported
  if (ONLY && !matched) report(false, `--only ${ONLY}: no check matched`, 'check the spelling against the names of an earlier run', true)
  console.log(`\n${failures === 0 ? 'All browser checks passed' : failures + ' browser check(s) failed'}${ONLY ? ` (${matched} reported for --only ${ONLY})` : ''}.`)
  return failures
}

// The Canadian Hydrographic Service's tide service (IWLS) answers HTTP 500, with no CORS header, to a user agent that says "HeadlessChrome"
// (found on 2026-10-22), so the check names itself as the ordinary Chrome it is. A visitor's own browser does not say it.
const userAgent = (browser) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`
async function openPage(browser, base, vp, { blockTiles = false, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, reducedMotion, userAgent: userAgent(browser) })
  const page = await ctx.newPage()
  const problems = [], warnings = [], requests = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text().slice(0, 200)); else if (m.type() === 'warning') warnings.push(m.text().slice(0, 160)) })
  page.on('pageerror', (e) => problems.push('page error: ' + e.message.slice(0, 200)))
  page.on('requestfailed', (r) => {
    // MapLibre cancels elevation tiles and Canadian Hydrographic Service tiles it no longer needs, for example while the map tilts into 3D at load or moves on.
    if (/ERR_ABORTED/.test(r.failure()?.errorText || '') && ['s3.amazonaws.com', NONNA_HOST].includes(new URL(r.url()).host)) return
    if (!blockTiles || !r.url().includes('tiles.openfreemap.org')) problems.push(`request failed (${r.failure()?.errorText || '?'}): ` + r.url().slice(0, 120))
  })
  page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url().slice(0, 120)}`) })
  if (blockTiles) await page.route('https://tiles.openfreemap.org/**', (r) => r.abort())
  await page.goto(base + '/index.html?test', { waitUntil: 'load' })
  // The page is slow to come up when the machine is busy (load 100 to 200 on 22 October), so this waits long enough for it.
  await page.waitForFunction(() => window.__ready && window.__map.areTilesLoaded(), null, { timeout: 180000 })
  await page.waitForTimeout(2000)
  return { ctx, page, problems, warnings, requests }
}

async function checkViewport(browser, base, name, vp, shots) {
  const { ctx, page, problems, warnings, requests } = await openPage(browser, base, vp)
  const t = (s) => `${name}: ${s}`
  const shot = shots ? (label) => page.screenshot({ timeout: 120000, path: join(shots, `${name}-${label}.png`) }) : null
  // Each group is run on its own: one that throws or times out is recorded as a failure and the next one still runs.
  const run = (fn, ...args) => (wants(fn, `${name}: `) ? guarded(t(fn.name), () => fn(...args)) : null)
  try {
    // 3D terrain is on by default: the map tilts to 60 degrees once it is ready.
    await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1, null, { timeout: 90000 }).catch(() => {})
    await run(checkLoadState, page, requests, t, name, shots)
    await run(checkCurrents3d, page, requests, t, shot)

    // The checks below run on the flat map. checkTerrain3d switches 3D terrain on and off again.
    const flat = [checkToggles, checkFlowToggles, checkMarchDirection, checkTerrain, checkTerrain3d, checkOverlays, checkCurrents, checkWind, checkBlend, checkSea, checkTides, checkSeafloor, checkMarine, checkNight, checkPopups]
    if (flat.some((fn) => wants(fn, `${name}: `))) {
      await guarded(t('turning 3D terrain off'), async () => {
        await setBox(page, '#terrain3d', false)
        await page.waitForFunction(() => window.__map.getPitch() < 0.5 && !window.__map.getTerrain(), null, { timeout: 90000 })
        await page.waitForTimeout(1500)
      })
    }
    await run(checkToggles, page, t)
    await run(checkFlowToggles, page, t)
    if (name === 'desktop') await run(checkMarchDirection, page, t)
    await run(checkTerrain, page, requests, t, shot)
    await run(checkTerrain3d, page, requests, t, shot)
    if (name === 'desktop') await run(checkOverlays, page, requests, t, shot)
    await run(checkCurrents, page, requests, t, name, shot)
    await run(checkWind, page, requests, t, name, shot)
    if (name === 'desktop') await run(checkBlend, page, requests, t, name, shot)
    await run(checkSea, page, requests, t, name, shot)
    await run(checkTides, page, requests, t, name, shot)
    await run(checkSeafloor, page, requests, t, name, shot)
    await run(checkMarine, page, requests, t, name, shot)
    await run(checkNight, page, requests, t, name, shot)
    await run(checkPopups, page, t, name, vp, shots)

    // A 429 from GBIF (it refuses bursts) is reported on the page as a partial result, so it is not a page problem.
    const hardProblems = problems.filter((p) => (!/openfreemap/i.test(p) || /HTTP|page error/.test(p)) && !/status of 429/.test(p))
    report(hardProblems.length === 0, t('no page errors, console errors or failed requests'), hardProblems.slice(0, 3).join(' | '))
    if (warnings.length) console.log(`      (${warnings.length} console warnings, listed once: ${[...new Set(warnings)].slice(0, 5).join(' || ')})`)
  } finally {
    await ctx.close()
  }
}

// What the page looks like as it opens: the layers, their defaults, the boxes, the credit, the hosts it contacts and the 3D start.
async function checkLoadState(page, requests, t, name, shots) {
  const info = await page.evaluate((OVERLAY_LAYERS) => {
    const m = window.__map
    const vis = (id) => m.getLayer(id) ? (m.getLayoutProperty(id, 'visibility') ?? 'visible') : 'absent'
    const attrib = document.querySelector('.maplibregl-ctrl-attrib')
    const panel = document.getElementById('panel').getBoundingClientRect()
    const a = attrib.getBoundingClientRect()
    return {
      layers: ['hillshade', 'bec-fill', 'bec-sea-mask', 'watersheds-fill', 'watersheds-line', 'parks-local', 'parks-bc', 'parks-bc-line', 'wetlands', 'lakes', 'streams', 'streams-flow', 'muni-fill', 'muni-line', 'streams-label', 'parks-bc-label', 'muni-label', 'pins', 'pins-label', ...OVERLAY_LAYERS].filter((id) => !m.getLayer(id)),
      defaults: Object.fromEntries(['bec-fill', 'hillshade', 'watersheds-line', 'parks-local', 'parks-bc', 'streams', 'streams-flow', 'muni-line', 'pins'].map((id) => [id, vis(id)])),
      overlayDefaults: Object.fromEntries(OVERLAY_LAYERS.map((id) => [id, vis(id)])),
      view3d: { terrain: m.getTerrain(), pitch: m.getPitch(), maxPitch: m.getMaxPitch(), rotate: m.dragRotate.isEnabled(), box: document.getElementById('terrain3d').checked, sky: !!(m.getSky && m.getSky()?.['sky-color']), note: !document.getElementById('terrain3d-note').hidden },
      overlayBoxes: [...document.querySelectorAll('input[data-overlay]')].map((b) => b.checked),
      overlayRadarLayer: !!m.getLayer('radar'),
      seaScalarLayer: !!m.getLayer('sea-scalar'),
      flowCanvas: !!document.getElementById('flow-canvas'),
      flowBox: { checked: document.getElementById('flow').checked, disabled: document.getElementById('flow').disabled },
      terrainChecked: document.querySelector('input[data-group=terrain]').checked,
      flowRunning: window.__flow.running(),
      zoom: m.getZoom(),
      attribText: attrib.innerText,
      attribCollapsed: !attrib.classList.contains('maplibregl-compact-show') && !attrib.hasAttribute('open'),
      attribCompact: attrib.classList.contains('maplibregl-compact'),
      attribHeight: a.height,
      panelOverlapsAttrib: !(panel.right <= a.left || panel.left >= a.right || panel.bottom <= a.top || panel.top >= a.bottom),
      overflowX: document.documentElement.scrollWidth > innerWidth,
      banner: document.getElementById('demo-banner').innerText,
      pinCount: document.getElementById('pins-count').textContent,
      emptyVisible: !document.getElementById('pins-empty').hidden,
      emptyText: document.getElementById('pins-empty').textContent,
    }
  }, OVERLAY_LAYERS)
  report(info.layers.length === 0, t('all map layers present'), 'missing: ' + info.layers.join(', '))
  report(JSON.stringify(info.defaults) === JSON.stringify({ 'bec-fill': 'none', hillshade: 'visible', 'watersheds-line': 'none', 'parks-local': 'visible', 'parks-bc': 'visible', streams: 'visible', 'streams-flow': 'visible', 'muni-line': 'visible', pins: 'visible' }), t('default layer visibility as specified'), JSON.stringify(info.defaults))
  report(info.flowBox.checked && !info.flowBox.disabled && info.flowRunning && info.terrainChecked, t('Flow box is on and the flow loop is running; Terrain shading box is on'), JSON.stringify({ flowBox: info.flowBox, running: info.flowRunning, terrain: info.terrainChecked, zoom: info.zoom }))
  report(Object.values(info.overlayDefaults).every((v) => v === 'none') && info.overlayBoxes.length === 22 && info.overlayBoxes.every((b) => !b) && !info.overlayRadarLayer && !info.flowCanvas && !info.seaScalarLayer, t('every new layer exists, is hidden and unticked at load, and the particle canvas and the sea picture do not exist yet (ecoregions, industry, radar, sea currents, wind, sea temperature, sea saltiness, tides, seafloor, alerts, air quality, conditions, river gauges, earthquakes, life observations)'), JSON.stringify([info.overlayDefaults, info.overlayBoxes, info.overlayRadarLayer]))
  const v = info.view3d
  report(v.box && v.terrain?.source === 'terrain-dem' && v.terrain.exaggeration === 2 && Math.abs(v.pitch - 60) < 1 && v.maxPitch >= 60 && v.rotate && v.sky && v.note, t('3D terrain is on at load: terrain from the elevation tiles, tilted to 60 degrees, rotation unlocked, sky and note shown'), JSON.stringify(v))
  const hosts = [...new Set(requests.map((u) => new URL(u).host))].filter((h) => !h.startsWith('127.0.0.1'))
  report(hosts.includes('s3.amazonaws.com') && hosts.every((h) => h === 'tiles.openfreemap.org' || h === 's3.amazonaws.com'), t('on load the page contacts only the basemap host and the elevation tiles (no weather or other service)'), hosts.join(', '))
  report(!info.overflowX, t('no horizontal page scroll'))
  report(info.banner.includes('Demo.') && !info.banner.includes('could not be reached'), t('demo banner shown, basemap reached'), info.banner)
  report(info.pinCount === '(1)' && info.emptyVisible && info.emptyText === 'No events listed yet.', t('pins panel: 1 example place and the empty-state sentence'), info.emptyText)
  if (name === 'desktop') {
    report(info.attribText.includes('OpenFreeMap') && info.attribText.includes('OpenStreetMap') && info.attribText.includes('Open Government Licence'), t('attribution shows basemap and BC credit'), info.attribText)
    // Two lines at most: with terrain on by default, its credit joins the basemap and BC credits.
    report(info.attribHeight < 50, t('attribution strip fits on two lines'), `${info.attribHeight}px high`)
  } else {
    report(info.attribCompact && info.attribCollapsed, t('attribution is the collapsed (i) button after load'), JSON.stringify({ compact: info.attribCompact, collapsed: info.attribCollapsed }))
    report(!info.panelOverlapsAttrib, t('layers panel does not cover the attribution control'))
  }

  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-1-default.png`) })
}

// The water, ecosystem zone and watershed boxes.
async function checkToggles(page, t) {
  // toggles
  const toggled = await page.evaluate(async () => {
    const m = window.__map
    const set = (g, v) => { const b = document.querySelector(`input[data-group=${g}]`); b.checked = v; b.dispatchEvent(new Event('change')) }
    const vis = (id) => m.getLayoutProperty(id, 'visibility') ?? 'visible'
    set('water', false); const hidden = vis('streams') === 'none' && vis('lakes') === 'none' && vis('streams-label') === 'none'
    set('water', true); const shown = vis('streams') === 'visible'
    set('bec', true); const bec = vis('bec-fill') === 'visible' && vis('bec-sea-mask') === 'visible'
    set('watersheds', true); const ws = vis('watersheds-fill') === 'visible' && vis('watersheds-line') === 'visible'
    return { hidden, shown, bec, ws }
  })
  report(toggled.hidden && toggled.shown, t('water toggle hides and restores creeks, lakes and wetlands'))
  report(toggled.bec && toggled.ws, t('BEC (with sea mask) and watershed toggles work'))
}

// Popups of the example pin, a creek or watershed and a municipality, the credits panel and the Fit button, on the flat map.
async function checkPopups(page, t, name, vp, shots) {
  await page.waitForTimeout(1200)
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-2-bec-watersheds.png`) })

  // watershed popup: zoom into Bowker, click, smallest watershed wins
  await page.evaluate(([x, y]) => window.__map.jumpTo({ center: [x, y], zoom: 13.2 }), BOWKER)
  await page.waitForTimeout(2500)
  const pt = await page.evaluate(([x, y]) => { const p = window.__map.project([x, y]); return { x: p.x, y: p.y } }, BOWKER)
  // 1. pin popup
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(600)
  const popup = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!popup && popup.includes('Bowker Creek') && popup.includes('Example place, not an event') && popup.includes('3.4 km'), t('example pin popup opens with its sourced text'), String(popup).slice(0, 120))
  const titleVisible = await page.evaluate(() => {
    const h = document.querySelector('.maplibregl-popup-content h3')
    if (!h) return false
    const r = h.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2)
    return !!top && !!top.closest('.maplibregl-popup-content')
  })
  report(titleVisible, t('popup title is not covered by the banner or buttons'))
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-3-bowker-popup.png`) })
  const popupLinks = await page.evaluate(() => [...document.querySelectorAll('.maplibregl-popup-content a')].map((a) => a.href + ' ' + a.rel))
  report(popupLinks.length > 0 && popupLinks.every((l) => l.startsWith('https://') && l.includes('noopener')), t('popup links are https and rel=noopener'), popupLinks.join(' | '))

  // 2. with pins off, a click on the same spot gives a watershed or creek popup
  await page.evaluate(() => { const b = document.querySelector('input[data-group=pins]'); b.checked = false; b.dispatchEvent(new Event('change')) })
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await page.mouse.click(pt.x, pt.y + 40)
  await page.waitForTimeout(600)
  const popup2 = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!popup2 && /watershed|creek|park|municipality|Oak Bay|Saanich|Victoria/i.test(popup2), t('a click away from the pin opens a feature popup'), String(popup2).slice(0, 160))
  await page.evaluate(() => { const b = document.querySelector('input[data-group=pins]'); b.checked = true; b.dispatchEvent(new Event('change')) })

  // 3. municipality popup from a click inside the boundary
  const mu = await page.evaluate(() => {
    const m = window.__map
    for (const g of ['water', 'parks', 'bec', 'watersheds', 'pins']) { const b = document.querySelector(`input[data-group=${g}]`); b.checked = false; b.dispatchEvent(new Event('change')) }
    document.querySelector('.maplibregl-popup')?.remove()
    m.jumpTo({ center: [-123.37, 48.45], zoom: 11 })
    return true
  })
  await page.waitForTimeout(1800)
  await page.mouse.click(vp.width / 2, vp.height / 2)
  await page.waitForTimeout(600)
  const popup3 = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!popup3 && popup3.includes('municipality') && popup3.includes('adjacent water'), t('municipality popup opens from inside the boundary and mentions adjacent water'), String(popup3).slice(0, 160))
  void mu

  // credits
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await page.click('#credits-btn')
  const creditsOpen = await page.evaluate(() => !document.getElementById('credits').hidden)
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, `${name}-4-credits.png`) })
  await page.keyboard.press('Escape')
  const creditsClosed = await page.evaluate(() => document.getElementById('credits').hidden)
  report(creditsOpen && creditsClosed, t('credits panel opens and Escape closes it'))

  // fit button
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  await page.click('#fit')
  await page.waitForTimeout(1500)
  const center = await page.evaluate(() => window.__map.getCenter())
  report(Math.abs(center.lng - -123.43) < 0.1 && Math.abs(center.lat - 48.48) < 0.1, t('Fit to Greater Victoria returns to the home view'), JSON.stringify(center))
}

// Set a checkbox and tell the page, the way a tap would.
const setBox = (page, sel, v) => page.evaluate(([s, val]) => { const b = document.querySelector(s); b.checked = val; b.dispatchEvent(new Event('change')) }, [sel, v])

// Flow sub-toggle: on by default, and the loop runs only while the dashes can be seen.
async function checkFlowToggles(page, t) {
  const state = () => page.evaluate(() => {
    const m = window.__map, b = document.getElementById('flow')
    return { vis: m.getLayoutProperty('streams-flow', 'visibility') ?? 'visible', running: window.__flow.running(), disabled: b.disabled, checked: b.checked, dash: JSON.stringify(m.getPaintProperty('streams-flow', 'line-dasharray')) }
  })
  const on = await state()
  await page.waitForTimeout(400)
  const later = await state()
  report(on.vis === 'visible' && on.running && on.dash !== later.dash, t('Flow is on by default: layer visible, loop running, dash pattern advancing'), JSON.stringify([on, later.dash]))

  await setBox(page, '#flow', false)
  const off = await state()
  report(off.vis === 'none' && !off.running && !off.disabled, t('Flow box off: dashes hidden and the loop stopped'), JSON.stringify(off))
  await setBox(page, '#flow', true)

  await setBox(page, 'input[data-group=water]', false)
  const noWater = await state()
  report(noWater.vis === 'none' && !noWater.running && noWater.disabled, t('Creeks box off: Flow is hidden, stopped and disabled'), JSON.stringify(noWater))
  await setBox(page, 'input[data-group=water]', true)
  const back = await state()
  report(back.vis === 'visible' && back.running && !back.disabled, t('Creeks box on again: Flow returns'), JSON.stringify(back))

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hidden = await state()
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  const shown = await state()
  report(!hidden.running && shown.running, t('loop stops while the tab is hidden and resumes when it is shown'), JSON.stringify({ hidden: hidden.running, shown: shown.running }))

  // The map's bounds keep it from zooming out far on a wide screen, so the zoom
  // gate can be out of reach. It is checked wherever the map can go below the flow zoom.
  const gate = await page.evaluate(() => ({ zoom: window.__map.getZoom(), flow: window.__flow.minZoom }))
  await page.evaluate((z) => window.__map.jumpTo({ zoom: z }), gate.flow - 0.1)
  await page.waitForTimeout(150)
  const reached = await page.evaluate(() => window.__map.getZoom())
  const far = await state()
  await page.evaluate((z) => window.__map.jumpTo({ zoom: z }), gate.zoom)
  await page.waitForTimeout(150)
  const near = await state()
  if (reached < gate.flow) report(!far.running && near.running, t('loop stops when zoomed out past the flow layer and resumes when zoomed back in'), JSON.stringify({ far: far.running, near: near.running }))
  else console.log(`      (${t(`zoom gate not reachable at this width: the map stops zooming out at ${reached.toFixed(2)}, above the flow zoom ${gate.flow}, so it is not checked here`)})`)
}

// The dash pattern must march along the order of a line's vertices, because
// data/streams-flow.geojson is built with the last vertex downstream. A west to
// east test line is drawn in magenta with each of the page's 14 dash steps, and
// the pattern has to move east on every step, including the wrap from the last
// step to the first.
async function checkMarchDirection(page, t) {
  const view = await page.evaluate(() => ({ center: window.__map.getCenter().toArray(), zoom: window.__map.getZoom() }))
  const line = await page.evaluate(() => {
    const m = window.__map
    const box = document.getElementById('flow'); box.checked = false; box.dispatchEvent(new Event('change'))
    m.jumpTo({ center: [-123.2, 48.45], zoom: 14 })
    const c = m.getCenter()
    const a = [c.lng - 0.012, c.lat], b = [c.lng + 0.012, c.lat]
    m.addSource('flowtest', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [a, b] } } })
    m.addLayer({ id: 'flowtest', type: 'line', source: 'flowtest', layout: { 'line-cap': 'butt' }, paint: { 'line-color': '#ff00ff', 'line-width': 8, 'line-dasharray': window.__flow.sequence[0] } })
    const pa = m.project(a), pb = m.project(b)
    return { x0: Math.round(pa.x), x1: Math.round(pb.x), y: Math.round(pa.y) }
  })
  const rows = []
  const steps = await page.evaluate(() => window.__flow.sequence.length)
  for (let i = 0; i < steps; i++) {
    await page.evaluate((i) => new Promise((resolve) => {
      const m = window.__map
      m.setPaintProperty('flowtest', 'line-dasharray', window.__flow.sequence[i])
      m.once('idle', resolve); m.triggerRepaint()
    }), i)
    const png = await page.screenshot({ clip: { x: line.x0 + 30, y: line.y - 1, width: line.x1 - line.x0 - 60, height: 3 } })
    rows.push(await page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 1, img.width, 1).data
      let out = ''
      for (let x = 0; x < img.width; x++) out += d[x * 4] > 180 && d[x * 4 + 1] < 100 && d[x * 4 + 2] > 180 ? '1' : '0'
      return out
    }, png.toString('base64')))
  }
  await page.evaluate((v) => { const m = window.__map; m.removeLayer('flowtest'); m.removeSource('flowtest'); m.jumpTo(v); const box = document.getElementById('flow'); box.checked = true; box.dispatchEvent(new Event('change')) }, view)
  // How far the pattern moved from step i to step i + 1, in pixels (positive is east).
  const shiftOf = (p, q) => {
    let best = null
    for (let s = -12; s <= 12; s++) {
      let match = 0, n = 0
      for (let x = 20; x < p.length - 20; x++) { n++; if (q[x] === p[x - s]) match++ }
      if (!best || match / n > best.fit) best = { s, fit: match / n }
    }
    return best
  }
  const moves = rows.map((r, i) => shiftOf(r, rows[(i + 1) % rows.length]))
  const east = moves.filter((m) => m.s > 0 && m.fit > 0.95).length
  const inked = rows[0].split('').filter((c) => c === '1').length
  report(inked > rows[0].length * 0.2 && east === moves.length, t(`dash pattern marches along vertex order on all ${moves.length} steps (test line drawn west to east moves east)`), `inked ${inked}/${rows[0].length}, moves ${JSON.stringify(moves.map((m) => [m.s, +m.fit.toFixed(2)]))}`)
}

// Terrain shading: on by default, with elevation tiles from AWS and their credit on the map.
// Unticking hides it and ticking shows it again. It is left off for checkTerrain3d.
async function checkTerrain(page, requests, t, shot) {
  const s3 = () => requests.filter((u) => new URL(u).host === 's3.amazonaws.com').length
  const state = () => page.evaluate(() => ({ vis: window.__map.getLayoutProperty('hillshade', 'visibility') ?? 'visible', attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  const on = await state()
  report(on.vis === 'visible' && s3() > 0, t('Terrain shading on by default: layer visible and elevation tiles requested from AWS'), `${on.vis}, ${s3()} requests`)
  report(on.attrib.includes('AWS Terrain Tiles') && on.attrib.includes('OGL') && on.attrib.includes('USGS'), t('map attribution carries the terrain credit while the layer is on'), on.attrib.slice(0, 200))
  if (shot) await shot('terrain-on')
  await setBox(page, 'input[data-group=terrain]', false)
  const off = await state()
  await setBox(page, 'input[data-group=terrain]', true)
  const again = await state()
  await setBox(page, 'input[data-group=terrain]', false)
  report(off.vis === 'none' && again.vis === 'visible', t('Terrain shading box hides the layer and shows it again'), JSON.stringify([off.vis, again.vis]))
}

// 3D terrain: on by default (checkViewport switches it off first). Ticking it sets MapLibre terrain from the elevation tiles, tilts the
// map to 60 degrees, unlocks rotation and pitch and adds a sky. The Terrain shading box stays
// independent of it. Unticking resets the pitch and bearing and removes the terrain.
async function checkTerrain3d(page, requests, t, shot) {
  const s3 = () => requests.filter((u) => new URL(u).host === 's3.amazonaws.com').length
  const st = () => page.evaluate(() => {
    const m = window.__map
    return { terrain: m.getTerrain(), pitch: m.getPitch(), maxPitch: m.getMaxPitch(), bearing: m.getBearing(), rotate: m.dragRotate.isEnabled(), hill: m.getLayoutProperty('hillshade', 'visibility'), sky: m.getSky ? m.getSky() : null,
      note: !document.getElementById('terrain3d-note').hidden, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent, hillBox: document.querySelector('input[data-group=terrain]').checked }
  })
  // A view the elevation tiles for which have not been fetched yet.
  await page.evaluate(() => window.__map.jumpTo({ center: [-123.56, 48.49], zoom: 12.6 }))
  await page.waitForTimeout(1500)
  const before = s3()
  await setBox(page, '#terrain3d', true)
  await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1, null, { timeout: 150000 })
  await page.waitForTimeout(2500)
  const on = await st()
  report(on.terrain?.source === 'terrain-dem' && on.terrain.exaggeration === 2 && Math.abs(on.pitch - 60) < 1 && on.maxPitch >= 60 && on.rotate && on.note, t('3D terrain on: terrain set from the elevation tiles, map tilted to 60 degrees, rotation and pitch unlocked'), JSON.stringify({ ...on, attrib: undefined }))
  report(on.hill === 'none' && !on.hillBox, t('3D terrain on leaves the Terrain shading box and layer alone'))
  report(!!on.sky && !!on.sky['sky-color'], t('3D terrain on: a sky is set'), JSON.stringify(on.sky))
  report(s3() > before, t('3D terrain on: elevation tiles are requested from AWS'), `${s3() - before} new requests`)
  report(on.attrib.includes('AWS Terrain Tiles') && on.attrib.includes('USGS'), t('map attribution carries the terrain credit with 3D terrain on and shading off'), on.attrib.slice(0, 160))
  await setBox(page, 'input[data-group=terrain]', true)
  const both = await st()
  await setBox(page, 'input[data-group=terrain]', false)
  const shadeOff = await st()
  report(!!both.terrain && both.hill === 'visible' && !!shadeOff.terrain && shadeOff.hill === 'none', t('Terrain shading toggles on and off while 3D terrain stays on'), JSON.stringify([both.hill, shadeOff.hill, !!shadeOff.terrain]))
  // The flat layers are drawn over the relief and can still be found there.
  const drawn = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['streams', 'lakes', 'parks-local', 'muni-line'] }).length)
  report(drawn > 0, t('with 3D terrain on, creeks, lakes, parks and boundaries are still drawn and can be queried over the relief'), `${drawn} features`)
  if (shot) await shot('terrain3d-on')
  await page.evaluate(() => window.__map.jumpTo({ bearing: 40 }))
  await setBox(page, '#terrain3d', false)
  await page.waitForFunction(() => window.__map.getPitch() < 0.5 && Math.abs(window.__map.getBearing()) < 0.5 && !window.__map.getTerrain(), null, { timeout: 90000 })
  await page.waitForTimeout(500)
  const off = await st()
  report(off.terrain === null && off.pitch < 0.5 && Math.abs(off.bearing) < 0.5 && off.maxPitch === 0 && !off.rotate && !off.note, t('3D terrain off again: pitch and bearing back to 0, terrain removed, rotation locked'), JSON.stringify({ ...off, attrib: undefined, sky: undefined }))
}

// ---- sea currents
const currentsStats = (page) => page.evaluate(() => window.__overlays.flow.stats())
// A number that changes when the overlay canvas changes: its alpha values, weighted by position.
const canvasSignature = (page) => page.evaluate(() => {
  const c = document.getElementById('flow-canvas')
  if (!c) return null
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let sum = 0
  for (let i = 3, k = 1; i < d.length; i += 16, k++) sum = (sum + d[i] * (k % 9973)) % 1e9
  return sum
})
// This machine draws in software and a map that has just stopped moving can take a second or two to give the loop a frame,
// so a check that reads the canvas waits until something has been drawn on it.
const waitDrawn = (page) => page.waitForFunction(() => window.__overlays.flow.stats().drawn > 300, null, { timeout: 45000 }).catch(() => {})
const seaHour = (text) => text.match(/for (.+?), Environment Canada/)?.[1] || null
const SEA_STATUS = /^Modelled surface currents for [A-Z][a-z]{2} \d{1,2}, \d{1,2}\s[ap]\.m\. P[SD]T, Environment Canada’s CIOPS Salish Sea model \(experimental, not for navigation\)\.$/
// Particles are drawn, and almost none of them over land (a drawn pixel more than two field points
// from any sea point). The pixel count is a sample of every other pixel.
const drawnOverSea = (st) => st.drawn > 300 && st.land / st.drawn < 0.01
const WIND_STATUS = /^Modelled wind for [A-Z][a-z]{2} \d{1,2}, \d{1,2}\s[ap]\.m\. P[SD]T, Environment Canada’s HRDPS model \(forecast, not for navigation\)\.$/
const SEA_COLOUR = [194, 200, 202] // the basemap's sea, as drawn (#c2c8ca)

// The size of each coverage image the page receives, read as the replies arrive.
function watchWcs(page) {
  const pending = [], list = []
  page.on('response', (r) => { if (r.url().includes('service=WCS')) pending.push(r.body().then((b) => list.push({ url: r.url(), bytes: b.length }), () => {})) })
  return { settled: async () => { await Promise.all(pending); return [...list] } }
}
// How readable the particles are: the contrast, against the sea colour, of each pixel drawn with at least half
// opacity (a pale drawing on the pale sea scores 1.2 to 1.9, a dark one 3 or more).
const canvasContrast = (page, sea = SEA_COLOUR) => page.evaluate((SEA) => {
  const c = document.getElementById('flow-canvas')
  if (!c) return null
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const ls = lum(...SEA), ratios = []
  for (let i = 0; i < d.length; i += 16) {
    const a = d[i + 3] / 255
    if (a < 0.5) continue
    const l = lum(d[i] * a + SEA[0] * (1 - a), d[i + 1] * a + SEA[1] * (1 - a), d[i + 2] * a + SEA[2] * (1 - a))
    ratios.push((Math.max(l, ls) + 0.05) / (Math.min(l, ls) + 0.05))
  }
  ratios.sort((x, y) => x - y)
  return { n: ratios.length, median: ratios[Math.floor(ratios.length / 2)] ?? 0, p10: ratios[Math.floor(ratios.length * 0.1)] ?? 0 }
}, sea)
// Drawn pixels over the basemap's water and over land, told apart by asking the map what it shows in each 24 px square.
const drawnOverWaterAndLand = (page) => page.evaluate(() => {
  const m = window.__map, c = document.getElementById('flow-canvas')
  const wl = m.getStyle().layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source && !/mask/.test(l.id))
  if (!c || !wl) return null
  const ratio = c.width / c.clientWidth, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  const out = { water: 0, land: 0, waterSquares: 0, landSquares: 0 }
  for (let y = 0; y + 24 <= c.clientHeight; y += 24) {
    for (let x = 0; x + 24 <= c.clientWidth; x += 24) {
      const key = m.queryRenderedFeatures([x + 12, y + 12], { layers: [wl.id] }).length ? 'water' : 'land'
      out[key + 'Squares']++
      for (let py = y; py < y + 24; py += 2) for (let px = x; px < x + 24; px += 2) if (d[((Math.round(py * ratio)) * c.width + Math.round(px * ratio)) * 4 + 3] > 40) out[key]++
    }
  }
  return out
})

// With 3D terrain on (pitch 60) the particles still draw, over the sea only. Run while the page is as it opened.
async function checkCurrents3d(page, requests, t, shot) {
  // The creek dashes redraw the whole map and slow a headless browser to a crawl, so they are off meanwhile.
  await setBox(page, '#flow', false)
  const idle = LIVE_HOSTS.map((h) => hostCount(requests, h))
  report(idle.every((n) => n === 0) && !requests.some((u) => u.includes('HRDPS')), t('nothing is requested from Environment Canada (sea currents and wind included), USGS or GBIF before a box is ticked'), JSON.stringify(idle))
  // The relief matters here: unproject must hit the mountains, not the flat plane.
  const relief = await page.waitForFunction(() => window.__map.queryTerrainElevation([-123.3466, 48.4906]) > 50, null, { timeout: 120000 }).then(() => true, () => false)
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForTimeout(2500)
  await waitDrawn(page)
  const st = await currentsStats(page), view = await page.evaluate(() => ({ pitch: window.__map.getPitch(), terrain: !!window.__map.getTerrain() }))
  report(st.running && view.terrain && Math.abs(view.pitch - 60) < 1 && drawnOverSea(st), t(`currents: with 3D terrain on (pitch 60${relief ? ', relief loaded' : ', relief not loaded in time'}) particles are drawn over the sea and not over land`), JSON.stringify({ ...st, view, status: await statusOf(page, 'currents') }))
  if (shot) await shot('currents-3d')
  // At the steepest tilt the top of the screen is sky. Above the horizon unproject answers with places behind the
  // camera, so nothing may be drawn there. The horizon is found from unproject itself: going up the middle of the
  // screen, the first row where the latitude runs off past 70 N or falls by a degree (relief in the way moves it by far less).
  await page.evaluate(() => window.__map.jumpTo({ pitch: 75 }))
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(2500)
  await waitDrawn(page)
  const steep = await currentsStats(page)
  const edge = await page.evaluate(() => {
    const m = window.__map; let prev = -90, flip = 0
    for (let y = innerHeight - 1; y >= 0; y -= 2) { const q = m.unproject([innerWidth / 2, y]); if (!q || q.lat < prev - 1 || q.lat > 70) { flip = y; break } prev = q.lat }
    return { flip, formula: window.__overlays.flow.horizon() }
  })
  // The answers turn wild a little below the horizon row (the ground there is thousands of kilometres away), never above it.
  report(edge.flip >= edge.formula - 2 && edge.flip - edge.formula <= 15 && steep.top >= edge.formula && drawnOverSea(steep), t('currents: at pitch 75 the horizon row used by the layer is where unproject starts answering with places behind the camera, and nothing is drawn above it'), JSON.stringify({ edge, top: steep.top, drawn: steep.drawn, land: steep.land, on: steep.on, status: await statusOf(page, 'currents') }))
  if (shot) await shot('currents-3d-steep')

  // Wind in 3D: ticking it switches the currents off, the particles are drawn over the relief, and nothing is drawn above the horizon.
  await page.evaluate(() => window.__map.jumpTo({ pitch: 60 }))
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await setBox(page, 'input[data-overlay=wind]', true)
  await waitStatus(page, 'wind').catch(() => {})
  await page.waitForTimeout(2500)
  await waitDrawn(page)
  const w3 = await currentsStats(page), w3view = await page.evaluate(() => ({ pitch: window.__map.getPitch(), terrain: !!window.__map.getTerrain(), currentsBox: document.querySelector('input[data-overlay=currents]').checked }))
  report(w3.kind === 'wind' && w3.running && w3view.terrain && Math.abs(w3view.pitch - 60) < 1 && !w3view.currentsBox && w3.drawn > 300, t('wind: with 3D terrain on (pitch 60) the particles are drawn and the sea currents are off'), JSON.stringify({ ...w3, w3view }))
  if (shot) await shot('wind-3d')
  await page.evaluate(() => window.__map.jumpTo({ pitch: 75 }))
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(2500)
  await waitDrawn(page)
  const w3steep = await currentsStats(page), w3horizon = await page.evaluate(() => window.__overlays.flow.horizon())
  report(w3steep.kind === 'wind' && w3steep.drawn > 300 && w3steep.top >= w3horizon, t('wind: at pitch 75 nothing is drawn above the horizon row'), JSON.stringify({ top: w3steep.top, horizon: w3horizon, drawn: w3steep.drawn }))
  if (shot) await shot('wind-3d-steep')
  await setBox(page, 'input[data-overlay=wind]', false)
  await setBox(page, '#flow', true)
}

// Sea currents on the flat map: what is requested, what is drawn and where, the loop's stops and starts,
// Play, and what unticking leaves behind.
async function checkCurrents(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open) // open on a desktop, closed on a phone
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await page.evaluate(() => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: [-123.43, 48.48], zoom: 10.4 }) })
  await panel(true)
  await page.waitForTimeout(800)
  await setBox(page, '#flow', false)
  const wide = page.viewportSize().width >= 700
  const start = requests.length
  const wcs = () => requests.slice(start).filter((u) => u.includes('service=WCS'))
  const timesOf = (list) => [...new Set(list.map((u) => new URL(u).searchParams.get('time')))].sort()
  const images = watchWcs(page)

  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  const st0 = await statusOf(page, 'currents')
  const first = wcs(), caps = requests.slice(start).filter((u) => u.includes('GetCapabilities') && u.includes('CIOPS-SalishSea')).length
  const ui = await page.evaluate(() => ({ controls: !document.getElementById('currents-controls').hidden, play: document.getElementById('currents-play').disabled, note: document.getElementById('currents-note').textContent, noteShown: !document.getElementById('currents-note').hidden }))
  report(st0.state === 'ok' && SEA_STATUS.test(st0.text), t('currents: the status line names the model hour in Pacific time and the model, and says experimental and not for navigation'), st0.text)
  report(caps === 1 && first.length === 2 && first.some((u) => u.includes('VelocityX_0.5m')) && first.some((u) => u.includes('VelocityY_0.5m')) && timesOf(first).length === 1, t('currents: ticking requests the hours on offer once and the two components of one hour, and nothing else'), JSON.stringify({ caps, first: first.map((u) => u.slice(70, 150)) }))
  report(ui.controls && !ui.play && ui.noteShown && /^Particles are sped up so you can see them: 0\.5 m\/s shows as about 30 px a second at any zoom\. The real water moves much slower than it looks\. Play steps through the next 13 hours\./.test(ui.note) && !/times faster/.test(ui.note), t('currents: Play is on offer and the note gives the pace on the screen (30 px a second for 0.5 m/s at any zoom), not a factor that is false at other zooms'), JSON.stringify(ui))
  const got = await images.settled()
  const total = got.reduce((a, x) => a + x.bytes, 0)
  console.log(`      (${t(`currents: one hour is ${got.length} images, ${got.map((x) => x.bytes.toLocaleString('en-CA')).join(' + ')} bytes, ${total.toLocaleString('en-CA')} bytes in all`)})`)
  report(got.length === 2 && got.every((x) => x.bytes > 50e3 && x.bytes < 100e3) && total < 160e3, t('currents: one hour is two images of about 73 KB each, under 160 KB in all (a quarter of the full 500 m grid, which was 586 KB)'), JSON.stringify(got.map((x) => x.bytes)))

  await page.waitForTimeout(2000)
  await waitDrawn(page)
  const st = await currentsStats(page)
  const want = wide ? st.particles > 1500 && st.particles <= 4000 : st.particles > 100 && st.particles <= 1500
  report(st.on && st.running && st.attached && want && drawnOverSea(st), t(`currents: after about 2 s the canvas has particle pixels over the sea and almost none over land (${st.particles} particles, ${wide ? 'wide' : 'narrow'} screen)`), JSON.stringify(st))
  const sigA = await canvasSignature(page)
  let sigB = sigA
  for (let i = 0; i < 20 && sigB === sigA; i++) { await page.waitForTimeout(500); sigB = await canvasSignature(page) }
  report(sigA !== null && sigA !== sigB, t('currents: the picture keeps changing while it runs'))
  const con = await canvasContrast(page)
  report(!!con && con.n > 100 && con.median >= 3 && con.p10 >= 2.2, t('currents: the particles are dark enough to read on the pale sea (the pixels drawn at half opacity or more have a median contrast of 3 to 1 or better against the sea colour, and nearly all 2.2 or better)'), JSON.stringify(con))
  // The same pace on the screen at every zoom: the particles really move the same px a second for each m/s of current.
  const view = { center: [-123.43, 48.48], zoom: 10.4 }
  const paceAt = [-123.28, 48.37] // open water south of Oak Bay, so that there is sea in view even on a phone at zoom 12.5
  const pace = {}
  for (const z of [8.6, 10.4, 12.5]) {
    await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [paceAt, z])
    await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
    await page.waitForTimeout(1200)
    await waitDrawn(page)
    await page.evaluate(() => window.__overlays.flow.pace())
    await page.waitForTimeout(3000)
    pace[z] = await page.evaluate(() => window.__overlays.flow.pace())
  }
  report(Object.values(pace).every((p) => p.samples > 200 && Math.abs(p.pxPerMs - 60) <= 6), t('currents: the particles move at the same pace on the screen at zoom 8.6, 10.4 and 12.5 (60 px a second for each m/s, within 10%)'), JSON.stringify(Object.fromEntries(Object.entries(pace).map(([z, p]) => [z, [+p.pxPerMs.toFixed(1), p.samples]]))))
  await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [view.center, view.zoom])
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(1500)
  await waitDrawn(page)
  const dom = await page.evaluate(() => {
    const c = document.getElementById('flow-canvas'), cs = getComputedStyle(c), ratio = Math.min(devicePixelRatio, 2)
    return { events: cs.pointerEvents, z: cs.zIndex, inContainer: c.parentElement === window.__map.getCanvasContainer(), sized: c.width === Math.round(innerWidth * ratio) && c.height === Math.round(innerHeight * ratio), hidden: c.getAttribute('aria-hidden') }
  })
  report(dom.events === 'none' && dom.z === 'auto' && dom.inContainer && dom.sized && dom.hidden === 'true', t('currents: the canvas sits in the map under its popups and the panel, lets every touch through and matches the window size'), JSON.stringify(dom))
  if (shot) {
    await page.evaluate(() => document.getElementById('currents-controls').scrollIntoView({ block: 'center' }))
    await shot('currents-panel')
    if (!wide) await panel(false) // on a phone the panel would hide the map
    await shot('currents-2d')
    await panel(true)
  }
  const f0 = (await currentsStats(page)).frames
  await page.waitForTimeout(3000)
  const fps = ((await currentsStats(page)).frames - f0) / 3
  console.log(`      (${t(`headless run of the loop, Flow off: ${fps.toFixed(0)} frames a second. This machine draws in software, so it says nothing about a phone`)})`)

  // the loop stops while the tab is hidden and while the map moves, and starts again
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hid = await currentsStats(page)
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(300)
  const shown = await currentsStats(page)
  report(!hid.running && shown.running, t('currents: the loop stops while the tab is hidden and resumes when it is shown'), JSON.stringify([hid.running, shown.running]))
  // Read at the first 'move' event, while the map is moving, so a slow machine cannot let the move finish first.
  const moving = await page.evaluate(() => new Promise((resolve) => {
    window.__map.once('move', () => resolve(window.__overlays.flow.stats()))
    window.__map.easeTo({ center: [-123.3, 48.5], duration: 1800 })
  }))
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(1500)
  await waitDrawn(page)
  const after = await currentsStats(page)
  report(!moving.running && moving.drawn === 0 && after.running && drawnOverSea(after), t('currents: while the map moves the picture is cleared and the loop paused, and both come back when it stops'), JSON.stringify({ moving: [moving.running, moving.drawn], after: [after.running, after.drawn, after.land] }))

  // Play: one hour on, the hour after it fetched ahead, nothing more, and Pause stops it
  const hours = () => page.evaluate(() => ({ at: window.__overlays.sea.at, time: window.__overlays.sea.hours[window.__overlays.sea.at], n: window.__overlays.sea.hours.length }))
  const h0 = await hours(), text0 = (await statusOf(page, 'currents')).text
  await page.click('#currents-play')
  const btn = await page.evaluate(() => ({ text: document.getElementById('currents-play').textContent, pressed: document.getElementById('currents-play').getAttribute('aria-pressed') }))
  await page.waitForFunction((t0) => document.getElementById('status-currents').textContent !== t0 && document.getElementById('status-currents').dataset.state === 'ok', text0, { timeout: 90000 })
  const h1 = await hours(), text1 = (await statusOf(page, 'currents')).text
  report(btn.text === 'Pause' && btn.pressed === 'true' && h0.n === 13 && h1.at === h0.at + 1 && Date.parse(h1.time) - Date.parse(h0.time) === 3600000 && seaHour(text1) !== seaHour(text0) && SEA_STATUS.test(text1), t('currents: Play steps one hour on and the hour label in the status line follows it'), JSON.stringify({ btn, h0, h1, label: [seaHour(text0), seaHour(text1)] }))
  await page.waitForTimeout(1500)
  await page.click('#currents-play')
  const paused = await hours(), pausedBtn = await page.evaluate(() => document.getElementById('currents-play').textContent)
  const heldAt = wcs().length
  await page.waitForTimeout(3500)
  const still = await hours()
  const asked = timesOf(wcs())
  const latest = Math.max(...asked.map(Date.parse))
  report(pausedBtn === 'Play' && still.at === paused.at && wcs().length === heldAt, t('currents: Pause stops the hours and the button says Play again, with no more requests'), JSON.stringify({ pausedBtn, paused: paused.at, still: still.at, heldAt, now: wcs().length }))
  report(asked[0] === h0.time && latest <= Date.parse(paused.time) + 3600000 && wcs().length === asked.length * 2, t('currents: each hour is two requests, and only the hour shown and the one after it were asked for'), JSON.stringify({ asked, shown: paused.time, requests: wcs().length }))

  // the readout: a click on the sea shows the modelled current of the hour shown, read from the grid already loaded
  await panel(false)
  await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z }) }, [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(1500)
  const hourNow = seaHour((await statusOf(page, 'currents')).text)
  const reqBefore = hostCount(requests, 'geo.weather.gc.ca')
  const open = await readoutAt(page, READOUT_SEA)
  const seaLine = open.want ? (open.want.still ? `Almost still: ${open.want.knots.toFixed(2)} knots (${open.want.ms.toFixed(2)} m/s).` : `${open.want.knots.toFixed(1)} knots (${open.want.ms.toFixed(2)} m/s), flowing toward the ${open.want.toward}.`) : null
  report(!!open.text && !!open.want && open.text.startsWith('Modelled sea current') && open.text.includes(seaLine) && open.text.includes(`Surface current for ${hourNow}.`) && open.text.includes('Model estimate, not for navigation.') && /\d\.\d knots \(\d\.\d\d m\/s\), flowing toward the (north|south|east|west|north-east|north-west|south-east|south-west)\./.test(open.text), t('currents: a click on the sea opens a popup with the speed in knots and m/s, the compass point it flows toward, the hour shown and the not-for-navigation line, the same as the grid says at that place'), JSON.stringify(open))
  report(hostCount(requests, 'geo.weather.gc.ca') === reqBefore, t('currents: the readout makes no request (it reads the grid already loaded)'))
  const onMuni = await readoutAt(page, READOUT_MUNI)
  // The area popup that follows is the municipality, or the ecosystem zone when that box has been left ticked by an earlier check (it comes first in the popup order).
  const areaAt = onMuni.text ? onMuni.text.search(/Legal boundary\. It includes adjacent water\.|A biogeoclimatic zone groups land/) : -1
  report(!!onMuni.text && onMuni.text.startsWith('Modelled sea current') && areaAt > onMuni.text.indexOf('Model estimate, not for navigation.'), t('currents: on water inside an area (municipal boundary or ecosystem zone) the popup shows the current first and then the area popup, unchanged'), JSON.stringify(onMuni.text))
  const onLand = await readoutAt(page, READOUT_LAND)
  report(!!onLand.text && !onLand.want && !onLand.text.includes('Modelled sea current'), t('currents: a click on land opens the same popup as before, with no current in it'), JSON.stringify(onLand.text))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())

  // a click goes through the canvas, and the popup is above it (the panel is shut so it cannot be in the way on a phone)
  await panel(false)
  await page.evaluate((b) => window.__map.jumpTo({ center: b, zoom: 13.2 }), BOWKER)
  await page.waitForTimeout(2500)
  const pt = await page.evaluate(([x, y]) => { const p = window.__map.project([x, y]); return { x: p.x, y: p.y } }, BOWKER)
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(600)
  const pop = await page.evaluate(() => { const c = document.querySelector('.maplibregl-popup'); return c ? { text: c.innerText.slice(0, 60), z: getComputedStyle(c).zIndex } : null })
  report(!!pop && pop.text.includes('Bowker Creek') && pop.z === '4', t('currents: with the layer on, a click reaches the map and the popup opens above the canvas'), JSON.stringify(pop))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  if (shot && wide) { await page.evaluate(() => window.__map.jumpTo({ center: [-123.43, 48.4], zoom: 11.2 })); await page.waitForTimeout(2500); await shot('currents-2d-zoomed') }

  // unticking stops the loop, frees the canvas and takes the credit off the map
  await setBox(page, 'input[data-overlay=currents]', false)
  await page.waitForTimeout(1200)
  const off = await page.evaluate(() => ({ stats: window.__overlays.flow.stats(), canvas: !!document.getElementById('flow-canvas'), status: !document.getElementById('status-currents').hidden, controls: !document.getElementById('currents-controls').hidden, note: !document.getElementById('currents-note').hidden, play: document.getElementById('currents-play').textContent, playing: window.__overlays.sea.playing, kept: window.__overlays.sea.cache.size, layer: window.__map.getLayoutProperty('currents-credit', 'visibility'), attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  const sigOff = await canvasSignature(page)
  report(!off.stats.on && !off.stats.running && !off.canvas && sigOff === null && !off.status && !off.controls && !off.note && off.play === 'Play' && !off.playing && off.kept === 0 && off.layer === 'none' && !off.attrib.includes('Data Server End-use Licence'), t('currents: unticking stops the loop, removes the canvas and the hours kept in memory, hides the status line and controls and takes the credit off the map'), JSON.stringify({ ...off, attrib: undefined }))
  // with the layer off a click on the sea shows no current
  await page.evaluate(([c, z]) => { window.__map.jumpTo({ center: c, zoom: z }) }, [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(800)
  const offClick = await readoutAt(page, READOUT_SEA)
  report(!offClick.text || !offClick.text.includes('Modelled sea current'), t('currents: with the layer off a click on the sea shows no current'), JSON.stringify(offClick.text))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

// Click a place on the flat map (the view is north-up) and read the popup. `want` is what the grid of the hour shown
// says there: the same place, found from the same pixel the click used.
const READOUT_VIEW = { center: [-123.30, 48.40], zoom: 10 } // Greater Victoria, with Haro Strait and the Oak Bay waters in view on a phone too
const READOUT_SEA = [-123.20, 48.35] // open water east of Discovery Island
const READOUT_MUNI = [-123.30, 48.39] // water inside the Oak Bay boundary and the Coastal Douglas-fir zone
const READOUT_LAND = [-123.40, 48.45] // land
async function readoutAt(page, [lng, lat]) {
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  const p = await page.evaluate(([x, y]) => { const q = window.__map.project([x, y]); return { x: Math.round(q.x), y: Math.round(q.y) } }, [lng, lat])
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(500)
  const text = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText.replace(/\n+/g, ' ').replace(/×$/, '').trim() || null)
  const want = await page.evaluate(async ([x, y]) => {
    const D = await import('/js/overlays-data.js'), g = window.__overlays.sea.shown?.grid
    const ll = window.__map.unproject([x, y]), uv = g && D.seaVelocity(g, ll.lng, ll.lat)
    return uv ? D.currentReadout(uv) : null
  }, [p.x, p.y])
  return { text, want }
}

// Wind on the flat map: it switches Sea currents off (one canvas, one engine), what is requested, what is drawn (over land
// and sea), how readable it is, Play, the credit, and what unticking leaves behind.
async function checkWind(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z }) }, [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await panel(true)
  await page.waitForTimeout(800)
  await setBox(page, '#flow', false)
  const wide = page.viewportSize().width >= 700
  const images = watchWcs(page)
  const flowStats = () => page.evaluate(() => window.__overlays.flow.stats())
  const ui = (id) => page.evaluate((id) => ({ box: document.querySelector(`input[data-overlay=${id}]`).checked, status: !document.getElementById('status-' + id).hidden, controls: !document.getElementById(id + '-controls').hidden, note: !document.getElementById(id + '-note').hidden, layer: window.__map.getLayoutProperty(id + '-credit', 'visibility'), canvases: document.querySelectorAll('#flow-canvas').length }), id)

  // Sea currents first, so that ticking Wind has something to switch off.
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForTimeout(1500)
  const start = requests.length
  const hrdps = () => requests.slice(start).filter((u) => u.includes('HRDPS'))
  const wcs = () => hrdps().filter((u) => u.includes('service=WCS'))
  report(hrdps().length === 0 && (await flowStats()).kind === 'currents', t('wind: with Sea currents on, nothing has been requested for wind'), JSON.stringify(hrdps()))
  await setBox(page, 'input[data-overlay=wind]', true)
  await waitStatus(page, 'wind').catch(() => {})
  const st0 = await statusOf(page, 'wind')
  const cur = await ui('currents'), win = await ui('wind')
  const kept = await page.evaluate(() => ({ cache: window.__overlays.sea.cache.size, hours: window.__overlays.sea.hours.length, playing: window.__overlays.sea.playing }))
  report(!cur.box && !cur.status && !cur.controls && cur.layer === 'none' && win.box && win.status && win.controls && win.layer === 'visible' && win.canvases === 1 && kept.cache === 0 && kept.hours === 0 && !kept.playing && (await flowStats()).kind === 'wind', t('wind: ticking it unticks Sea currents (box, status line, controls, credit and the hours kept all go) and leaves one canvas, now showing wind'), JSON.stringify({ cur, win, kept }))
  report(st0.state === 'ok' && WIND_STATUS.test(st0.text), t('wind: the status line names the model hour in Pacific time and the HRDPS model, and says forecast and not for navigation'), st0.text)
  const first = wcs(), caps = hrdps().filter((u) => u.includes('GetCapabilities') && u.includes('HRDPS.CONTINENTAL_WSPD')).length
  const times = [...new Set(first.map((u) => new URL(u).searchParams.get('time')))]
  report(caps === 1 && first.length === 2 && first.some((u) => u.includes('coverageid=HRDPS.CONTINENTAL_WSPD')) && first.some((u) => u.includes('coverageid=HRDPS.CONTINENTAL_WD&')) && times.length === 1 && first.every((u) => u.includes('scalesize=x%2857%29%2Cy%2862%29')) && requests.slice(start).filter((u) => u.includes('CIOPS')).length === 0 && hrdps().length === 3, t('wind: ticking requests the hours on offer once and the speed and the direction of one hour, and nothing else'), JSON.stringify({ caps, first: first.map((u) => u.slice(70, 150)), n: hrdps().length }))
  const uiW = await page.evaluate(() => ({ controls: !document.getElementById('wind-controls').hidden, play: document.getElementById('wind-play').disabled, note: document.getElementById('wind-note').textContent, noteShown: !document.getElementById('wind-note').hidden }))
  report(uiW.controls && !uiW.play && uiW.noteShown && /^Particles are sped up so you can see them: 5 m\/s shows as about 60 px a second at any zoom\. The real air moves much slower than it looks\. Play steps through the next 13 hours\./.test(uiW.note), t('wind: Play is on offer and the note gives the pace on the screen (60 px a second for 5 m/s at any zoom)'), JSON.stringify(uiW))
  const got = (await images.settled()).filter((x) => x.url.includes('HRDPS'))
  const total = got.reduce((a, x) => a + x.bytes, 0)
  console.log(`      (${t(`wind: one hour is ${got.length} images, ${got.map((x) => x.bytes.toLocaleString('en-CA')).join(' + ')} bytes, ${total.toLocaleString('en-CA')} bytes in all`)})`)
  report(got.length === 2 && got.every((x) => x.bytes > 8e3 && x.bytes < 25e3) && total < 40e3, t('wind: one hour is two images of about 15 KB each (57 x 62 cells), under 40 KB in all'), JSON.stringify(got.map((x) => x.bytes)))

  await page.waitForTimeout(2000)
  await waitDrawn(page)
  const st = await flowStats()
  report(st.on && st.kind === 'wind' && st.running && st.attached && st.drawn > 300 && st.particles === (wide ? 4000 : 1500), t(`wind: after about 2 s the canvas has particle pixels (${st.particles} particles, ${wide ? 'wide' : 'narrow'} screen)`), JSON.stringify(st))
  const cover = await drawnOverWaterAndLand(page)
  report(!!cover && cover.water > 150 && cover.land > 150 && cover.waterSquares > 10 && cover.landSquares > 10, t('wind: particles are drawn over land as well as over water'), JSON.stringify(cover))
  const sigA = await canvasSignature(page)
  let sigB = sigA
  for (let i = 0; i < 20 && sigB === sigA; i++) { await page.waitForTimeout(500); sigB = await canvasSignature(page) }
  report(sigA !== null && sigA !== sigB, t('wind: the picture keeps changing while it runs'))
  const con = await canvasContrast(page)
  report(!!con && con.n > 100 && con.median >= 3 && con.p10 >= 2.2, t('wind: the particles are dark enough to read on the pale basemap (median contrast 3 to 1 or better against the sea colour, nearly all 2.2 or better)'), JSON.stringify(con))
  const pace = {}
  for (const z of [8.6, 12.5]) {
    await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [READOUT_VIEW.center, z])
    await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
    await page.waitForTimeout(1200)
    await waitDrawn(page)
    await page.evaluate(() => window.__overlays.flow.pace())
    await page.waitForTimeout(3000)
    pace[z] = await page.evaluate(() => window.__overlays.flow.pace())
  }
  report(Object.values(pace).every((p) => p.samples > 200 && Math.abs(p.pxPerMs - 12) <= 1.2), t('wind: the particles move at the same pace on the screen at zoom 8.6 and 12.5 (12 px a second for each m/s, within 10%)'), JSON.stringify(Object.fromEntries(Object.entries(pace).map(([z, p]) => [z, [+p.pxPerMs.toFixed(2), p.samples]]))))
  await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(1500)
  await waitDrawn(page)
  const dom = await page.evaluate(() => {
    const c = document.getElementById('flow-canvas'), cs = getComputedStyle(c), ratio = Math.min(devicePixelRatio, 2)
    const attrib = document.querySelector('.maplibregl-ctrl-attrib').textContent
    return { events: cs.pointerEvents, z: cs.zIndex, inContainer: c.parentElement === window.__map.getCanvasContainer(), sized: c.width === Math.round(innerWidth * ratio) && c.height === Math.round(innerHeight * ratio), hidden: c.getAttribute('aria-hidden'), credit: attrib.includes('Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.') }
  })
  report(dom.events === 'none' && dom.z === 'auto' && dom.inContainer && dom.sized && dom.hidden === 'true' && dom.credit, t('wind: the canvas sits in the map under its popups and the panel, lets every touch through, matches the window size, and the map carries the Environment Canada credit'), JSON.stringify(dom))
  if (shot) {
    await page.evaluate(() => document.getElementById('wind-controls').scrollIntoView({ block: 'center' }))
    const fit = await page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(), c = document.getElementById('wind-note').getBoundingClientRect(); return { overflowX: document.documentElement.scrollWidth > innerWidth, noteInside: c.left >= p.left && c.right <= p.right + 1 } })
    report(!fit.overflowX && fit.noteInside, t('wind: the controls and the note fit inside the panel, with no horizontal scroll'), JSON.stringify(fit))
    await shot('wind-panel')
    if (!wide) await panel(false)
    await shot('wind-2d')
    await panel(true)
  }

  // the loop stops while the tab is hidden and starts again
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const hid = await flowStats()
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(300)
  const shown = await flowStats()
  report(!hid.running && shown.running, t('wind: the loop stops while the tab is hidden and resumes when it is shown'), JSON.stringify([hid.running, shown.running]))

  // Play: one hour on, the hour after it fetched ahead, nothing more, and Pause stops it
  const hours = () => page.evaluate(() => ({ at: window.__overlays.wind.at, time: window.__overlays.wind.hours[window.__overlays.wind.at], n: window.__overlays.wind.hours.length }))
  const h0 = await hours(), text0 = (await statusOf(page, 'wind')).text
  await page.click('#wind-play')
  const btn = await page.evaluate(() => ({ text: document.getElementById('wind-play').textContent, pressed: document.getElementById('wind-play').getAttribute('aria-pressed') }))
  await page.waitForFunction((t0) => document.getElementById('status-wind').textContent !== t0 && document.getElementById('status-wind').dataset.state === 'ok', text0, { timeout: 90000 })
  const h1 = await hours(), text1 = (await statusOf(page, 'wind')).text
  report(btn.text === 'Pause' && btn.pressed === 'true' && h0.n === 13 && h1.at === h0.at + 1 && Date.parse(h1.time) - Date.parse(h0.time) === 3600000 && text1 !== text0 && WIND_STATUS.test(text1), t('wind: Play steps one hour on and the hour label in the status line follows it'), JSON.stringify({ btn, h0, h1, label: [text0.slice(0, 40), text1.slice(0, 40)] }))
  await page.waitForTimeout(1500)
  await page.click('#wind-play')
  const paused = await hours(), pausedBtn = await page.evaluate(() => document.getElementById('wind-play').textContent)
  const heldAt = wcs().length
  await page.waitForTimeout(3500)
  const still = await hours()
  const asked = [...new Set(wcs().map((u) => new URL(u).searchParams.get('time')))].sort()
  report(pausedBtn === 'Play' && still.at === paused.at && wcs().length === heldAt, t('wind: Pause stops the hours and the button says Play again, with no more requests'), JSON.stringify({ pausedBtn, paused: paused.at, still: still.at, heldAt, now: wcs().length }))
  report(asked[0] === h0.time && Math.max(...asked.map(Date.parse)) <= Date.parse(paused.time) + 3600000 && wcs().length === asked.length * 2, t('wind: each hour is two requests, and only the hour shown and the one after it were asked for'), JSON.stringify({ asked, shown: paused.time, requests: wcs().length }))

  // the click readout is for the sea currents only: a click on the water with wind on shows no current
  await panel(false)
  const clicked = await readoutAt(page, READOUT_SEA)
  report(!clicked.text || !clicked.text.includes('Modelled sea current'), t('wind: a click on the sea shows no sea current (the readout belongs to Sea currents)'), JSON.stringify(clicked.text))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await panel(true)

  // ticking Sea currents switches Wind off, and the same canvas now shows the currents
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForTimeout(1500)
  const w2 = await ui('wind'), c2 = await ui('currents')
  const kept2 = await page.evaluate(() => ({ cache: window.__overlays.wind.cache.size, hours: window.__overlays.wind.hours.length, playing: window.__overlays.wind.playing, play: document.getElementById('wind-play').textContent }))
  report(!w2.box && !w2.status && !w2.controls && !w2.note && w2.layer === 'none' && c2.box && c2.status && c2.controls && c2.layer === 'visible' && c2.canvases === 1 && kept2.cache === 0 && kept2.hours === 0 && !kept2.playing && kept2.play === 'Play' && (await flowStats()).kind === 'currents', t('wind: ticking Sea currents unticks Wind (box, status line, controls, credit and the hours kept all go) and leaves one canvas, now showing the currents'), JSON.stringify({ w2, c2, kept2 }))
  await setBox(page, 'input[data-overlay=currents]', false)

  // Wind again, then unticking it stops the loop, frees the canvas and takes the credit off the map
  await setBox(page, 'input[data-overlay=wind]', true)
  await waitStatus(page, 'wind').catch(() => {})
  await page.waitForTimeout(1500)
  await setBox(page, 'input[data-overlay=wind]', false)
  await page.waitForTimeout(1200)
  const off = await page.evaluate(() => ({ stats: window.__overlays.flow.stats(), canvas: !!document.getElementById('flow-canvas'), status: !document.getElementById('status-wind').hidden, controls: !document.getElementById('wind-controls').hidden, note: !document.getElementById('wind-note').hidden, play: document.getElementById('wind-play').textContent, playing: window.__overlays.wind.playing, kept: window.__overlays.wind.cache.size, layer: window.__map.getLayoutProperty('wind-credit', 'visibility'), attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  const sigOff = await canvasSignature(page)
  report(!off.stats.on && !off.stats.running && !off.canvas && sigOff === null && !off.status && !off.controls && !off.note && off.play === 'Play' && !off.playing && off.kept === 0 && off.layer === 'none' && !off.attrib.includes('Data Server End-use Licenc'), t('wind: unticking stops the loop, removes the canvas and the hours kept in memory, hides the status line and controls and takes the credit off the map'), JSON.stringify({ ...off, attrib: undefined }))
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

// ---- sea temperature and saltiness (the model's numbers for each hour, coloured by the page, from the same model as the currents)
const SCALAR_LAYER = { temperature: 'SeaWaterPotentialTemp', salinity: 'SeaWaterSalinity' }
const SCALAR_WORD = { temperature: 'sea temperature', salinity: 'sea saltiness' }
const SCALARS_UNIT = { temperature: '°C', salinity: 'psu' }
const scalarStatus = (kind) => new RegExp(`^Modelled ${SCALAR_WORD[kind]} for [A-Z][a-z]{2} \\d{1,2}, \\d{1,2}\\s[ap]\\.m\\. P[SD]T, Environment Canada’s CIOPS Salish Sea model \\(experimental, not for navigation\\)\\.$`)
// The number the service itself gives for a place and an hour (a GetFeatureInfo request of the check's own, which the page does not make), in
// degrees Celsius or psu, or null where it has none.
const serviceSays = (page, kind, [lng, lat], time) => page.evaluate(async ([kind, lng, lat, time]) => {
  const layer = { temperature: 'CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m', salinity: 'CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m' }[kind], d = 0.01
  const p = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetFeatureInfo', layers: layer, query_layers: layer, crs: 'EPSG:4326', bbox: [lat - d, lng - d, lat + d, lng + d].map((x) => x.toFixed(5)).join(','), width: '3', height: '3', i: '1', j: '1', info_format: 'application/json', feature_count: '1', time })
  const raw = (await (await fetch(`https://geo.weather.gc.ca/geomet?${p}`)).json())?.features?.[0]?.properties?.value
  return typeof raw === 'number' && raw > 0 ? (kind === 'temperature' ? raw - 273.15 : raw) : null
}, [kind, lng, lat, time])
// Places across the sea, for comparing the picture and the readout with the service.
const SEA_PLACES = [[-123.2, 48.35], [-123.5, 48.25], [-123.1, 48.6], [-123.3, 48.5], [-122.95, 48.4], [-123.6, 48.3], [-123.35, 48.15], [-123.0, 48.7]]
// How much of the sea picture lies over the basemap's water and over its land, asked of the map in a grid of squares.
const pictureOverLand = (page) => page.evaluate(() => {
  const m = window.__map, c = window.__overlays.scalar.canvas, img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  const wl = m.getStyle().layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source && !/mask/.test(l.id))
  const mx = (lng) => lng * 20037508.34 / 180, my = (lat) => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI
  const x0 = mx(-124.4), x1 = mx(-122.7), y0 = my(47.9), y1 = my(49.1)
  let sea = 0, land = 0, bare = 0
  for (let y = 100; y < innerHeight - 40; y += 6) {
    for (let x = 20; x < innerWidth - 60; x += 6) {
      const ll = m.unproject([x, y]), px = Math.floor((mx(ll.lng) - x0) / (x1 - x0) * c.width), py = Math.floor((y1 - my(ll.lat)) / (y1 - y0) * c.height)
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue
      const wet = m.queryRenderedFeatures([x, y], { layers: [wl.id] }).length > 0, drawn = img[(py * c.width + px) * 4 + 3] > 0
      if (drawn) { if (wet) sea++; else land++ } else if (wet) bare++
    }
  }
  return { sea, land, bare }
})
// The popup after a click on a place, once any text it is still waiting for has arrived.
async function seaClick(page, [lng, lat]) {
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  const p = await page.evaluate(([x, y]) => { const q = window.__map.project([x, y]); return { x: Math.round(q.x), y: Math.round(q.y) } }, [lng, lat])
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(400)
  await page.waitForFunction(() => { const c = document.querySelector('.maplibregl-popup-content'); return !c || !/reading the model/.test(c.innerText) }, null, { timeout: 25000 }).catch(() => {})
  const text = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText.replace(/\n+/g, ' ').replace(/×$/, '').trim() || null)
  const at = await page.evaluate(([x, y]) => { const q = window.__map.unproject([x, y]); return [q.lng, q.lat] }, [p.x, p.y])
  return { text, at }
}
async function checkSea(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z }) }, [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await panel(true)
  await page.waitForTimeout(800)
  await setBox(page, '#flow', false)
  const wide = page.viewportSize().width >= 700
  const start = requests.length
  let from = start // requests are counted from here: moved on after the key check, which asks the service for numbers of its own
  const mine = (kind) => requests.slice(from).filter((u) => u.includes(SCALAR_LAYER[kind]))
  const grids = (kind) => mine(kind).filter((u) => u.includes('request=GetCoverage'))
  const images = watchWcs(page) // the grids as they arrive, with their sizes
  const timesOf = (list) => [...new Set(list.map((u) => new URL(u).searchParams.get('time')))].sort()
  const st = (kind) => statusOf(page, kind)
  const ui = (kind) => page.evaluate((kind) => ({ box: document.querySelector(`input[data-overlay=${kind}]`).checked, status: !document.getElementById('status-' + kind).hidden, key: !document.getElementById(kind + '-key').hidden, note: !document.getElementById(kind + '-note').hidden, credit: window.__map.getLayoutProperty(kind + '-credit', 'visibility'), picture: window.__map.getLayer('sea-scalar') ? window.__map.getLayoutProperty('sea-scalar', 'visibility') : 'absent', layers: window.__map.getStyle().layers.filter((l) => l.id === 'sea-scalar').length }), kind)
  report(mine('temperature').length === 0 && mine('salinity').length === 0, t('sea temperature and saltiness: nothing is requested for either before its box is ticked'))

  // Sea temperature on: one description of the hours and one grid of numbers, drawn as a picture under the creeks and parks and over the basemap's sea
  await setBox(page, 'input[data-overlay=temperature]', true)
  await waitStatus(page, 'temperature').catch(() => {})
  await page.waitForFunction(() => !!window.__overlays.scalar.shown, null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const st0 = await st('temperature'), caps = mine('temperature').filter((u) => u.includes('GetCapabilities'))
  report(st0.state === 'ok' && scalarStatus('temperature').test(st0.text), t('sea temperature: the status line names the model hour in Pacific time and the model, and says experimental and not for navigation'), st0.text)
  report(caps.length === 1 && caps[0].includes('LAYER=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && grids('temperature').length === 1 && grids('temperature')[0].includes('coverageid=CIOPS-SalishSea_500m_SeaWaterPotentialTemp_0.5m') && grids('temperature')[0].includes('scalefactor=0.5') && !mine('temperature').some((u) => /GetMap|GetFeatureInfo/.test(u)) && mine('salinity').length === 0 && requests.slice(start).filter((u) => /CIOPS|HRDPS/.test(u) && !u.includes(SCALAR_LAYER.temperature)).length === 0, t('sea temperature: ticking requests the hours on offer once and one grid of one hour (a coverage, not a picture), and nothing else'), JSON.stringify({ caps: caps.length, grids: grids('temperature').map((u) => u.slice(60, 160)) }))
  const gotT = (await images.settled()).filter((x) => x.url.includes(SCALAR_LAYER.temperature))
  console.log(`      (${t(`sea temperature: one hour is one grid of ${gotT.map((x) => x.bytes.toLocaleString('en-CA')).join(' + ')} bytes`)})`)
  report(gotT.length === 1 && gotT[0].bytes > 50e3 && gotT[0].bytes < 100e3, t('sea temperature: one hour is one grid of about 73 KB, the size of one component of the sea currents'), JSON.stringify(gotT.map((x) => x.bytes)))
  const a = await page.evaluate(() => {
    const m = window.__map, ids = m.getStyle().layers.map((l) => l.id), i = ids.indexOf('sea-scalar'), sc = window.__overlays.scalar
    const wl = m.getStyle().layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source && !/mask/.test(l.id))
    const d = sc.canvas.getContext('2d').getImageData(0, 0, sc.canvas.width, sc.canvas.height).data
    let drawn = 0
    for (let k = 3; k < d.length; k += 4) if (d[k] > 0) drawn++
    return { i, order: { water: ids.indexOf(wl.id), becMask: ids.indexOf('bec-sea-mask'), ecoLine: ids.indexOf('ecoregions-line'), watersheds: ids.indexOf('watersheds-fill'), streams: ids.indexOf('streams'), parks: ids.indexOf('parks-local'), pins: ids.indexOf('pins'), label: ids.indexOf('muni-label') }, opacity: m.getPaintProperty('sea-scalar', 'raster-opacity'), type: m.getLayer('sea-scalar')?.type, source: m.getSource('sea-scalar')?.type, share: drawn / (sc.canvas.width * sc.canvas.height), size: [sc.canvas.width, sc.canvas.height], shown: sc.shown && { kind: sc.shown.kind, time: sc.shown.time }, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent,
      key: { gradient: getComputedStyle(document.getElementById('temperature-bar')).backgroundImage.startsWith('linear-gradient'), ticks: [...document.querySelectorAll('#temperature-ticks span')].map((x) => x.textContent).join(' '), title: document.querySelector('#temperature-key .scale-title').textContent }, note: document.getElementById('temperature-note').textContent }
  })
  const o = a.order
  report(a.type === 'raster' && a.source === 'image' && a.opacity <= 0.7 && a.i > o.water && a.i > o.becMask && a.i > o.ecoLine && a.i < o.watersheds && a.i < o.streams && a.i < o.parks && a.i < o.pins && a.i < o.label && a.attrib.includes(ECCC_STATEMENT), t('sea temperature: the picture is a raster at 0.7 opacity or less, above the basemap\'s sea and the sea masks and under the creeks, parks, boundaries and labels, with the Environment Canada credit on the map'), JSON.stringify({ ...a, attrib: undefined, key: undefined, note: undefined }))
  report(a.shown?.kind === 'temperature' && a.size[0] === 480 && a.size[1] === 511 && a.share > 0.35 && a.share < 0.55, t('sea temperature: the picture is drawn at 480 x 511 and about 47% of it is model sea (the rest is land and open ocean the model leaves out)'), JSON.stringify({ share: a.share, size: a.size }))
  report(a.key.gradient && a.key.ticks === '6 8 10 12 14 16 18 20' && a.key.title === 'Surface water, °C' && /^Water 0\.5 m down, coloured here from the model’s numbers on one scale from 6 to 20 °C/.test(a.note), t('sea temperature: the key is a gradient in degrees Celsius (not kelvin) with ticks from 6 to 20, and the note is shown'), JSON.stringify(a.key))
  const over = await pictureOverLand(page)
  console.log(`      (${t(`sea temperature: in this view ${over.sea} sampled places are sea under the picture, ${over.land} are land under it and ${over.bare} are sea with none`)})`)
  report(over.sea > 200 && over.land / (over.sea + over.land) < 0.1 && over.bare / (over.sea + over.bare) < 0.1, t('sea temperature: under one place in ten of the picture lies land, and nearly all the sea in view is covered (the model\'s 500 m cells run a little over the coast)'), JSON.stringify(over))
  if (shot) { await page.evaluate(() => document.getElementById('temperature-key').scrollIntoView({ block: 'center' })); await shot('sea-temperature-panel'); if (!wide) await panel(false); await shot('sea-temperature'); await panel(true) }

  // The key is true. The page colours the picture from its own grid, so at places across the sea each pixel is the ramp's colour for the number the
  // page reads there, and that number is the one the service itself gives for the place. Two comparisons: the picture with the page's numbers, and the page's numbers with the service's.
  if (wide) {
    for (const kind of ['temperature', 'salinity']) {
      if (kind === 'salinity') { await setBox(page, 'input[data-overlay=salinity]', true); await waitStatus(page, 'salinity').catch(() => {}); await page.waitForFunction(() => window.__overlays.scalar.shown?.kind === 'salinity', null, { timeout: 30000 }).catch(() => {}) }
      const rows = await page.evaluate(async ([kind, places]) => {
        const D = await import('/js/overlays-data.js'), geo = D.radarGeometry(), sc = window.__overlays.scalar, g = sc.shown.grid, c = sc.canvas
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data
        const mx = (lng) => lng * 20037508.34 / 180, my = (lat) => Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.34 / Math.PI
        const [lo, hi] = D.SCALE_RANGE[kind], out = []
        for (const [lng, lat] of places) {
          const px = Math.floor((mx(lng) - geo.bbox[0]) / (geo.bbox[2] - geo.bbox[0]) * c.width), py = Math.floor((geo.bbox[3] - my(lat)) / (geo.bbox[3] - geo.bbox[1]) * c.height)
          // The place at the middle of that pixel: the place its colour was made for.
          const cx = ((px + 0.5) / c.width * (geo.bbox[2] - geo.bbox[0]) + geo.bbox[0]) / 20037508.34 * 180
          const cy = (2 * Math.atan(Math.exp((geo.bbox[3] - (py + 0.5) / c.height * (geo.bbox[3] - geo.bbox[1])) / 20037508.34 * Math.PI)) - Math.PI / 2) * 180 / Math.PI
          const v = D.scalarAt(g, cx, cy), pixel = [...d.slice((py * c.width + px) * 4, (py * c.width + px) * 4 + 4)]
          if (v == null) continue
          const key = D.rampColour(kind, Math.min(Math.max(v, lo), hi))
          out.push({ lng, lat, v: +v.toFixed(2), here: D.scalarAt(g, lng, lat), pixel, key, diff: Math.max(...key.map((x, i) => Math.abs(x - pixel[i]))), opaque: pixel[3] === 255 })
        }
        return out
      }, [kind, SEA_PLACES])
      report(rows.length >= 5 && rows.every((r) => r.opaque && r.diff <= 2), t(`${SCALAR_WORD[kind]}: the colour of the picture at ${rows.length} places across the sea is the ramp's colour for the number the page reads there, within 2 of 255 (largest difference ${Math.max(...rows.map((r) => r.diff))})`), JSON.stringify(rows.map((r) => ({ v: r.v, pixel: r.pixel, key: r.key }))))
      const time = await page.evaluate(() => window.__overlays.scalar.shown.time), says = []
      for (const r of rows) {
        const v = await serviceSays(page, kind, [r.lng, r.lat], time).catch(() => null)
        if (v != null && r.here != null) says.push({ place: [r.lng, r.lat], page: +r.here.toFixed(2), service: +v.toFixed(2), diff: Math.abs(r.here - v) })
      }
      // The page reads a 1 km grid (every second cell of the model's 500 m grid) and the service the 500 m cell at the place, so they differ a little where the water changes fast.
      const tol = kind === 'temperature' ? 0.6 : 1.5
      report(says.length >= 5 && says.every((x) => x.diff <= tol), t(`${SCALAR_WORD[kind]}: at ${says.length} places across the sea the page's number is the service's own, within ${tol} ${SCALARS_UNIT[kind]} (largest difference ${Math.max(...says.map((x) => x.diff)).toFixed(2)}), which checks ${kind === 'temperature' ? 'the kelvin to Celsius step and ' : ''}where the grid is placed`), JSON.stringify(says))
    }
    await setBox(page, 'input[data-overlay=temperature]', true) // back to temperature, the other one goes off
    await waitStatus(page, 'temperature').catch(() => {})
    await page.waitForFunction(() => window.__overlays.scalar.shown?.kind === 'temperature', null, { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(1500)
  }
  from = requests.length

  // The readout: a click on the sea gives the number the picture was made from, read from the grid already loaded, and asks the service for nothing
  await panel(false)
  const hour0 = seaHour((await st('temperature')).text)
  const before = requests.length
  const c1 = await seaClick(page, READOUT_SEA)
  const time0 = await page.evaluate(() => window.__overlays.scalar.shown.time)
  const says = await serviceSays(page, 'temperature', c1.at, time0)
  const shownT = Number(c1.text?.match(/Surface sea temperature: (-?\d+\.\d) °C/)?.[1])
  const asked = requests.slice(before).filter((u) => new URL(u).host === 'geo.weather.gc.ca' && !u.includes('GetFeatureInfo')).length // the check's own GetFeatureInfo is not the page's
  report(!!c1.text && c1.text.startsWith('Modelled sea temperature model estimate Surface sea temperature: ') && /Surface sea temperature: -?\d+\.\d °C \(for [A-Z][a-z]{2} \d{1,2}, \d{1,2}\s[ap]\.m\. P[SD]T\)\./.test(c1.text) && c1.text.includes('Model estimate, not for navigation.') && c1.text.includes(`(for ${hour0}).`) && says != null && Math.abs(shownT - says) <= 0.7, t('sea temperature: a click on the sea opens a popup with the temperature, the hour and the not-for-navigation line, and the number is the one the service gives for that place'), JSON.stringify({ text: c1.text, says, hour0 }))
  report(asked === 0, t('sea temperature: the readout makes no request (it reads the grid already loaded)'), String(asked))
  const beforeLand = requests.length
  const cLand = await seaClick(page, READOUT_LAND)
  report(requests.slice(beforeLand).filter((u) => new URL(u).host === 'geo.weather.gc.ca').length === 0 && !(cLand.text || '').includes('Modelled sea'), t('sea temperature: a click on land asks the service nothing and shows no temperature'), JSON.stringify(cLand.text))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())

  // With the sea currents on, the picture shows their hour and follows their Play
  await panel(true)
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForTimeout(1500)
  const curHour0 = seaHour((await statusOf(page, 'currents')).text), tmpHour0 = seaHour((await st('temperature')).text)
  report(!!curHour0 && curHour0 === tmpHour0 && grids('temperature').length <= 2, t('sea temperature: with the sea currents on, the picture shows the hour of the currents'), JSON.stringify({ curHour0, tmpHour0, grids: grids('temperature').length }))
  await panel(false)
  const both = await seaClick(page, READOUT_SEA)
  report(!!both.text && both.text.startsWith('Modelled sea current') && /\d\.\d knots \(\d\.\d\d m\/s\), flowing toward the [a-z-]+\./.test(both.text) && /Surface sea temperature: -?\d+\.\d °C/.test(both.text) && both.text.indexOf('Surface current for') < both.text.indexOf('Surface sea temperature:'), t('sea temperature: with the currents on, one click shows the modelled current and, under it, the temperature'), JSON.stringify(both.text))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await panel(true)
  await page.click('#currents-play')
  await page.waitForFunction((h0) => { const p = document.getElementById('status-currents'); return p.dataset.state === 'ok' && !p.textContent.includes(h0) }, curHour0, { timeout: 90000 }).catch(() => {})
  await page.waitForFunction(() => { const h = (id) => document.getElementById('status-' + id).textContent.match(/for (.+?), Environment Canada/)?.[1]; return !!h('currents') && h('currents') === h('temperature') && document.getElementById('status-temperature').dataset.state === 'ok' }, null, { timeout: 60000 }).catch(() => {})
  const curHour1 = seaHour((await statusOf(page, 'currents')).text), tmpHour1 = seaHour((await st('temperature')).text)
  // While Play steps the picture the map is drawn again at every step, and a busy machine takes one to three seconds to draw it, so the draws come
  // back to back. Playwright's click waits for a free moment that may not come, so Pause is pressed from inside the page, which is the same press.
  await page.evaluate(() => document.getElementById('currents-play').click()) // pause
  await page.waitForTimeout(2500)
  const shownNow = await page.evaluate(() => ({ cur: window.__overlays.sea.hours[window.__overlays.sea.at], tmp: window.__overlays.scalar.shown?.time }))
  const askedGrids = timesOf(grids('temperature'))
  report(curHour1 !== curHour0 && curHour1 === tmpHour1 && shownNow.cur === shownNow.tmp, t('sea temperature: while the currents play the picture steps with them, one hour at a time, and the status lines name the same hour'), JSON.stringify({ curHour0, curHour1, tmpHour1, shownNow }))
  report(askedGrids.length >= 2 && Math.max(...askedGrids.map(Date.parse)) <= Date.parse(shownNow.cur) + 3600000 && grids('temperature').length === askedGrids.length, t('sea temperature: each hour is one grid, and no hour beyond the one shown and the next was asked for'), JSON.stringify({ askedGrids, shown: shownNow.cur, n: grids('temperature').length }))
  const hold = grids('temperature').length
  await page.waitForTimeout(3000)
  report(grids('temperature').length === hold, t('sea temperature: with Play paused no further grid is requested'))
  await setBox(page, 'input[data-overlay=currents]', false)
  await page.waitForFunction((h) => document.getElementById('status-temperature').textContent.includes(h), tmpHour0, { timeout: 60000 }).catch(() => {})
  report(seaHour((await st('temperature')).text) === tmpHour0, t('sea temperature: when the currents go off the picture goes back to the latest hour not after now'), (await st('temperature')).text)

  // Sea saltiness: ticking it unticks the temperature, one picture layer remains, and its key and readout say psu
  from = requests.length
  await setBox(page, 'input[data-overlay=salinity]', true)
  await waitStatus(page, 'salinity').catch(() => {})
  await page.waitForFunction(() => window.__overlays.scalar.shown?.kind === 'salinity', null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const tu = await ui('temperature'), su = await ui('salinity'), sst = await st('salinity')
  const kept = await page.evaluate(() => ({ keys: [...window.__overlays.scalar.grids.keys()], shown: window.__overlays.scalar.shown?.kind, times: window.__overlays.scalar.times.length, key: [...document.querySelectorAll('#salinity-ticks span')].map((x) => x.textContent).join(' '), gradient: getComputedStyle(document.getElementById('salinity-bar')).backgroundImage.startsWith('linear-gradient') }))
  report(!tu.box && !tu.status && !tu.key && !tu.note && tu.credit === 'none' && su.box && su.status && su.key && su.note && su.credit === 'visible' && su.picture === 'visible' && su.layers === 1 && kept.shown === 'salinity' && kept.keys.length > 0 && kept.keys.every((k) => k.startsWith('salinity|')), t('sea saltiness: ticking it unticks Sea temperature (box, status line, key, note, credit and the grids kept all go) and leaves one picture layer, now the saltiness'), JSON.stringify({ tu, su, kept }))
  const gridsS = grids('salinity')
  const gotS = (await images.settled()).filter((x) => x.url.includes(SCALAR_LAYER.salinity))
  console.log(`      (${t(`sea saltiness: one hour is one grid of ${gotS.at(-1).bytes.toLocaleString('en-CA')} bytes`)})`)
  report(sst.state === 'ok' && scalarStatus('salinity').test(sst.text) && gridsS.length === 1 && gridsS[0].includes('coverageid=CIOPS-SalishSea_500m_SeaWaterSalinity_0.5m') && kept.key === '20 22 24 26 28 30 32 34' && kept.gradient && gotS.length >= 1 && gotS.at(-1).bytes > 50e3 && gotS.at(-1).bytes < 100e3, t('sea saltiness: one grid of about 73 KB, a status line that names the hour and the model, and a key in psu from 20 to 34'), JSON.stringify({ sst, grids: gridsS.length, key: kept.key, bytes: gotS.map((x) => x.bytes) }))
  await panel(false)
  const cs = await seaClick(page, READOUT_SEA), timeS = await page.evaluate(() => window.__overlays.scalar.shown.time), saysS = await serviceSays(page, 'salinity', cs.at, timeS)
  const shownS = Number(cs.text?.match(/Surface sea saltiness: (\d+\.\d) psu/)?.[1])
  report(!!cs.text && cs.text.startsWith('Modelled sea saltiness') && saysS != null && Math.abs(shownS - saysS) <= 1.6 && cs.text.includes('Model estimate, not for navigation.'), t('sea saltiness: a click on the sea gives the saltiness in psu, and the number is the one the service gives for that place (within 1.6 psu, the 1 km grid against the 500 m cell)'), JSON.stringify({ text: cs.text, saysS }))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await panel(true)
  if (shot) { await page.evaluate(() => document.getElementById('salinity-key').scrollIntoView({ block: 'center' })); await shot('sea-saltiness-panel'); if (!wide) await panel(false); await shot('sea-saltiness'); await panel(true) }
  const fit = await page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(), n = document.getElementById('salinity-note').getBoundingClientRect(), k = document.getElementById('salinity-key').getBoundingClientRect(); return { overflowX: document.documentElement.scrollWidth > innerWidth, inside: n.left >= p.left && n.right <= p.right + 1 && k.left >= p.left && k.right <= p.right + 1 } })
  report(!fit.overflowX && fit.inside, t('sea saltiness: the key and the note fit inside the panel, with no horizontal scroll'), JSON.stringify(fit))

  // Unticking: the picture, the key, the status line, the credit and the pictures kept all go, and a click on the sea shows nothing of the sea
  await setBox(page, 'input[data-overlay=salinity]', false)
  await page.waitForTimeout(800)
  const off = await page.evaluate(() => ({ picture: window.__map.getLayoutProperty('sea-scalar', 'visibility'), credit: window.__map.getLayoutProperty('salinity-credit', 'visibility'), status: !document.getElementById('status-salinity').hidden, key: !document.getElementById('salinity-key').hidden, note: !document.getElementById('salinity-note').hidden, kept: window.__overlays.scalar.grids.size, shown: window.__overlays.scalar.shown, times: window.__overlays.scalar.times.length, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  report(off.picture === 'none' && off.credit === 'none' && !off.status && !off.key && !off.note && off.kept === 0 && off.shown === null && off.times === 0 && !off.attrib.includes('Data Server End-use Licence'), t('sea temperature and saltiness: unticking hides the picture, key, note, status line and credit and lets go of the grids kept'), JSON.stringify({ ...off, attrib: undefined }))
  await panel(false)
  const beforeOff = requests.length
  const clicked = await seaClick(page, READOUT_SEA)
  report(!(clicked.text || '').includes('Modelled sea') && requests.slice(beforeOff).filter((u) => u.includes('GetFeatureInfo')).length === 0, t('sea temperature and saltiness: with both off a click on the sea shows nothing of the sea and asks the service nothing'), JSON.stringify(clicked.text))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

// ---- tides and tidal currents (NOAA predictions, asked for when a station is clicked)
const TIDE_IDS = ['9444090', '9449880', 'PUG1640', 'PUG1636', 'PUG1718', 'PCT1391', 'PCT1416']
const TIDE_CLOCK = /^(\d{1,2}:\d{2} [ap]\.m\.|[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [ap]\.m\.)$/
async function checkTides(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await page.evaluate(() => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: [-123.28, 48.38], zoom: 8.4 }) })
  await panel(true)
  await setBox(page, '#flow', false)
  const wide = page.viewportSize().width >= 700
  const start = requests.length
  const noaa = (id) => requests.slice(start).filter((u) => new URL(u).host === 'api.tidesandcurrents.noaa.gov' && (!id || new URL(u).searchParams.get('station') === id))
  // The check asks NOAA for each station once itself, to compare, and those requests are not the page's: they are taken off.
  const itself = {}
  const own = (id) => noaa(id).length - (id ? (itself[id] || 0) : Object.values(itself).reduce((a, n) => a + n, 0))
  report(noaa().length === 0, t('tides: nothing is requested from NOAA before the box is ticked'))
  await setBox(page, 'input[data-overlay=tides]', true)
  await waitStatus(page, 'tides').catch(() => {})
  await page.waitForTimeout(1500)
  const st0 = await statusOf(page, 'tides')
  const mk = await page.evaluate(() => ({ vis: window.__map.getLayoutProperty('tides-dot', 'visibility'), n: window.__map.queryRenderedFeatures({ layers: ['tides-dot'] }).length, kinds: [...new Set(window.__map.queryRenderedFeatures({ layers: ['tides-dot'] }).map((f) => f.properties.kind))].sort().join(), attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent, note: !document.getElementById('tides-note').hidden, notice: (() => { const n = document.getElementById('tides-chs-notice'); return { shown: !n.hidden, text: n.textContent, visible: n.getBoundingClientRect().height > 0 } })() }))
  const D = await page.evaluate(async () => { const m = await import('/js/overlays-data.js'); return { iwls: m.IWLS_NOTICE, nonna: m.NONNA_NOTICE } })
  report(st0.state === 'ok' && st0.text === '3 water level stations and 5 tidal current stations. Click one to ask NOAA, or the Canadian Hydrographic Service for Victoria Harbour. Not for navigation.' && mk.vis === 'visible' && mk.n === 8 && mk.kinds === 'current,level' && mk.note && mk.attrib.includes('NOAA/NOS/CO-OPS') && mk.attrib.includes('Canadian Hydrographic Service for Victoria Harbour'), t('tides: ticking shows eight stations (three water level, five current), a status line that says they are not for navigation, and the NOAA and Canadian Hydrographic Service credits on the map'), JSON.stringify({ st0, mk: { ...mk, attrib: undefined } }))
  report(mk.notice.shown && mk.notice.visible && mk.notice.text === D.iwls && /^This product is not to be used for navigation\./.test(mk.notice.text) && mk.notice.text.includes('made by or for the User Darren Zal'), t('tides: while the box is ticked the panel shows the notice the Canadian Hydrographic Service licence requires, word for word, with the name filled in'), JSON.stringify(mk.notice))
  report(noaa().length === 0 && hostCount(requests, IWLS_HOST) === 0, t('tides: ticking the box asks NOAA and the Canadian Hydrographic Service nothing (the stations come from a list in the page)'), String(noaa().length))
  if (shot) { await page.evaluate(() => document.getElementById('tides-note').scrollIntoView({ block: 'center' })); await shot('tides-panel'); if (!wide) await panel(false); await shot('tides'); await panel(true) }
  await panel(false)

  const stationCoords = await page.evaluate(async () => { const D = await import('/js/overlays-data.js'); return Object.fromEntries(D.TIDE_STATIONS.map((s) => [s.id, s.coords])) })
  const click = async (id, zoom = 10.5) => {
    await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z }) }, [stationCoords[id], zoom])
    await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
    await page.waitForTimeout(700)
    // The map's bounds can keep a station near the edge off the middle of the screen, so it is clicked where it is.
    const at = await page.evaluate((c) => { const q = window.__map.project(c); return { x: Math.round(q.x), y: Math.round(q.y) } }, stationCoords[id])
    // The dot is drawn from a source that is cut into tiles again for a new view, so a click waits until the map can find it there.
    await page.waitForFunction(([x, y]) => window.__map.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: ['tides-dot'] }).length > 0, [at.x, at.y], { timeout: 20000 }).catch(() => {})
    await page.mouse.click(at.x, at.y)
    await page.waitForFunction(() => { const b = document.querySelector('.tide-body'); return !!b && !/^Asking /.test(b.textContent) }, null, { timeout: 40000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
  const popup = () => page.evaluate(() => {
    const c = document.querySelector('.maplibregl-popup-content'); if (!c) return null
    const rows = [...c.querySelectorAll('.tide-events tr')].map((r) => [...r.children].map((x) => x.textContent))
    const svg = c.querySelector('svg.tide-curve'), path = svg?.querySelector('path'), circle = svg?.querySelector('circle')
    const r = c.getBoundingClientRect()
    return {
      title: c.querySelector('h3')?.textContent, tag: c.querySelector('.tag')?.textContent, text: c.innerText.replace(/\n+/g, ' | '), rows,
      svg: svg ? { role: svg.getAttribute('role'), label: svg.getAttribute('aria-label'), d: path?.getAttribute('d') || '', paths: svg.querySelectorAll('path').length, dots: svg.querySelectorAll('circle').length, cx: circle ? Number(circle.getAttribute('cx')) : null, ticks: [...svg.querySelectorAll('text')].map((x) => x.textContent), img: svg.querySelectorAll('img, image, script, foreignObject').length } : null,
      links: [...c.querySelectorAll('a')].map((a) => a.href + ' ' + a.rel), within: r.left >= 0 && r.right <= innerWidth,
      notes: [...c.querySelectorAll('.src')].map((x) => x.textContent).join(' '),
    }
  })
  // What NOAA says, asked for directly, to compare with the popup: the next event of each kind.
  const noaaSays = (id) => { itself[id] = (itself[id] || 0) + 1; return noaaAsk(id) }
  const noaaAsk = (id) => page.evaluate(async (id) => {
    const D = await import('/js/overlays-data.js'), s = D.tideStation(id), u = D.tideUrls(s, Date.now()), r = await (await fetch(u.events)).json(), now = Date.now()
    const level = s.kind === 'level', rows = level ? r.predictions : r.current_predictions.cp
    const ms = (x) => Date.parse(`${(level ? x.t : x.Time).replace(' ', 'T')}:00Z`)
    const nextOf = (f) => { const x = rows.find((y) => ms(y) > now && f(y)); return x ? { ms: ms(x), v: level ? x.v : x.Velocity_Major } : null }
    return level ? { 'High tide': nextOf((x) => x.type === 'H'), 'Low tide': nextOf((x) => x.type === 'L') } : { 'Slack water': nextOf((x) => x.Type === 'slack'), 'Max flood': nextOf((x) => x.Type === 'flood'), 'Max ebb': nextOf((x) => x.Type === 'ebb') }
  }, id)
  const soonest = (said) => Object.entries(said).filter(([, v]) => v).sort((a, b) => a[1].ms - b[1].ms).map(([k]) => k)
  const seen = {}
  for (const id of TIDE_IDS) {
    const level = id.length === 7 && /^\d+$/.test(id), sub = id.startsWith('PCT')
    await click(id)
    const p = await popup(); seen[id] = p
    const want = level ? 2 : (sub ? 1 : 2)
    const all = noaa(id)
    const said = await noaaSays(id)
    const reqs = all, kinds = reqs.map((u) => new URL(u).searchParams.get('interval')).sort().join()
    report(reqs.length === want && reqs.every((u) => { const q = new URL(u).searchParams; return q.get('application') === 'greater-victoria-map' && q.get('format') === 'json' && q.get('time_zone') === 'gmt' }) && kinds === (level ? '30,hilo' : sub ? 'MAX_SLACK' : '30,MAX_SLACK'), t(`tides ${id}: clicking the station asks NOAA ${want === 1 ? 'once (this station has no series)' : 'twice (the events and a 30 minute series)'}, naming the application`), JSON.stringify(reqs.map((u) => u.slice(60, 200))))
    const labels = (p?.rows || []).map((r) => r[0]).filter((l) => l !== 'Right now')
    if (level) {
      const high = p?.rows.find((r) => r[0] === 'High tide'), low = p?.rows.find((r) => r[0] === 'Low tide'), now = p?.rows.find((r) => r[0] === 'Right now')
      report(!!p && p.tag === 'tide predictions' && !!high && !!low && TIDE_CLOCK.test(high[1]) && TIDE_CLOCK.test(low[1]) && high[2] === `${Number(said['High tide'].v).toFixed(2)} m` && low[2] === `${Number(said['Low tide'].v).toFixed(2)} m` && !!now && /^\d\.\d\d m$/.test(now[2]) && labels.join() === soonest(said).join(), t(`tides ${id}: the popup gives the next high and low tide, soonest first, in Pacific time, with the heights NOAA gives, and the height now`), JSON.stringify({ rows: p?.rows, said }))
    } else {
      const flood = p?.rows.find((r) => r[0] === 'Max flood'), ebb = p?.rows.find((r) => r[0] === 'Max ebb'), slack = p?.rows.find((r) => r[0] === 'Slack water'), now = p?.rows.find((r) => r[0] === 'Right now')
      report(!!p && p.tag === 'tidal current predictions' && !!flood && !!ebb && !!slack && TIDE_CLOCK.test(flood[1]) && TIDE_CLOCK.test(ebb[1]) && TIDE_CLOCK.test(slack[1]) && flood[2] === `${Math.abs(Number(said['Max flood'].v)).toFixed(1)} knots` && ebb[2] === `${Math.abs(Number(said['Max ebb'].v)).toFixed(1)} knots` && !!now && /^(slack|\d\.\d knots (flood|ebb))$/.test(now[2]) && labels.join() === soonest(said).join(), t(`tides ${id}: the popup gives the next slack, maximum flood and maximum ebb, soonest first, in Pacific time, with the speeds in knots that NOAA gives`), JSON.stringify({ rows: p?.rows, said }))
    }
    const bits = (p?.svg?.d.match(/L/g) || []).length
    report(!!p?.svg && p.svg.role === 'img' && /^Predicted (tide height|current speed) for the 24 hours around now/.test(p.svg.label) && p.svg.d.startsWith('M') && bits >= (sub ? 100 : 40) && p.svg.paths === 1 && p.svg.dots === 1 && p.svg.cx > 30 && p.svg.cx < 47 && p.svg.ticks.includes('now') && ['12 a.m.', '6 a.m.', '12 p.m.', '6 p.m.'].every((x) => p.svg.ticks.includes(x)) && p.svg.img === 0, t(`tides ${id}: the popup has a 24 hour curve drawn as SVG with a now marker at three 24ths of the way across (${bits + 1} points, ${sub ? 'drawn between the events' : "NOAA's own series"}) and the axis in Pacific hours`), JSON.stringify({ ...p?.svg, d: undefined, bits }))
    report(!!p && p.text.includes('Predictions, not for navigation.') && p.text.includes('NOAA/NOS/CO-OPS') && p.text.includes('Not official NOAA material.') && p.links.length === 1 && p.links[0].startsWith('https://tidesandcurrents.noaa.gov/') && p.links[0].includes('noopener') && (sub === /NOAA gives only the times and speeds/.test(p.notes)) && (level || sub ? true : /below the surface/.test(p.notes)) && p.within, t(`tides ${id}: the popup says predictions, not for navigation, names NOAA/NOS/CO-OPS and that it is not official NOAA material, links to the NOAA station page, ${sub ? 'says the curve is drawn between the events,' : ''} and fits the screen`), JSON.stringify({ notes: p?.notes, links: p?.links, within: p?.within }))
    if (shot && ['9444090', 'PUG1640', 'PCT1416'].includes(id)) await shot(`tide-${id}`)
  }
  // Once per station: the same station again, while the box stays ticked, asks NOAA nothing more
  const asked = own()
  await click('PUG1640')
  const again = await popup()
  report(own() === asked && !!again && again.title.startsWith('Race Rocks'), t('tides: opening a station again asks NOAA nothing more while the box stays ticked'), JSON.stringify([asked, own()]))
  const after = await page.evaluate(() => window.__overlays.tideCache.size)
  report(after === 7 && own() === 12, t('tides: seven stations were opened and twelve requests were made in all (2 + 2 + 2 + 2 + 2 + 1 + 1)'), JSON.stringify({ cache: after, n: own() }))
  // The Victoria Harbour gauge of the Canadian Hydrographic Service: nothing is asked until its dot is clicked, then three requests a
  // little apart, no more while the same popup is opened again, and nothing polls. The popup is compared with what the service says.
  const iwls = () => requests.filter((u) => new URL(u).host === IWLS_HOST)
  const iwlsAsk = async (code, minutesBefore, minutesAfter, resolution) => {
    const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 16)}:00Z`, now = Date.now()
    const q = new URLSearchParams({ 'time-series-code': code, from: stamp(now - minutesBefore * 60e3), to: stamp(now + minutesAfter * 60e3), ...(resolution ? { resolution } : {}) })
    const r = await fetch(`https://${IWLS_HOST}/api/v1/stations/5cebf1df3d0f4a073c4bbd1e/data?${q}`, { headers: { 'user-agent': userAgent(page.context().browser()) }, signal: AbortSignal.timeout(30000) })
    return r.ok ? r.json() : null
  }
  report(iwls().length === 0, t('gauge: nothing is requested from the Canadian Hydrographic Service before the dot of Victoria Harbour is clicked'), String(iwls().length))
  // The page's own requests are timed by a note kept of each call of fetch (the browser keeps only 250 resource timings, and a map has more)
  await page.evaluate(() => { const f = window.fetch.bind(window); window.__fetchLog = []; window.fetch = (...a) => { window.__fetchLog.push([String(a[0]), Math.round(performance.now())]); return f(...a) } })
  await click('07120', 11)
  // The popup grew when the levels came, so the map pans it into view. A headless browser draws a frame or two a second, so wait for the pan to end.
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(800)
  const g = await page.evaluate(() => {
    const c = document.querySelector('.maplibregl-popup-content'); if (!c) return null
    const svg = c.querySelector('svg.tide-curve'), paths = svg ? [...svg.querySelectorAll('path')] : [], r = c.getBoundingClientRect()
    const cs = getComputedStyle(c), n = c.querySelector('.notice')
    return {
      title: c.querySelector('h3')?.textContent, tag: c.querySelector('.tag')?.textContent, text: c.innerText.replace(/\s+/g, ' '), rows: [...c.querySelectorAll('.tide-events tr')].map((x) => [...x.children].map((y) => y.textContent)),
      svg: svg ? { label: svg.getAttribute('aria-label'), viewBox: svg.getAttribute('viewBox'), dots: svg.querySelectorAll('circle').length, cx: Number(svg.querySelector('circle')?.getAttribute('cx')), texts: [...svg.querySelectorAll('text')].map((x) => x.textContent), img: svg.querySelectorAll('img, image, script, foreignObject').length,
        paths: paths.map((p) => ({ cls: p.getAttribute('class'), stroke: p.getAttribute('stroke'), points: (p.getAttribute('d').match(/L/g) || []).length + 1, lastX: Number(p.getAttribute('d').match(/L([\d.]+) /g)?.at(-1)?.slice(1)) })) } : null,
      links: [...c.querySelectorAll('a')].map((a) => a.href + ' ' + a.rel), notes: [...c.querySelectorAll('.src')].map((x) => x.textContent).join(' '), notice: n?.textContent, noticeVisible: !!n && n.getBoundingClientRect().height > 10,
      within: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, scrolls: c.scrollHeight > c.clientHeight + 2, maxHeight: cs.maxHeight, box: [Math.round(r.top), Math.round(r.bottom), innerHeight],
      resources: window.__fetchLog.filter((e) => e[0].includes('api-iwls')).map((e) => [e[0].match(/time-series-code=([^&]+)/)?.[1], e[1]]).sort((a, b) => a[1] - b[1]),
    }
  })
  const gaugeReqs = iwls()
  const ps = gaugeReqs.map((u) => Object.fromEntries(new URL(u).searchParams))
  report(gaugeReqs.length === 3 && ps.map((q) => q['time-series-code']).sort().join() === 'wlo,wlp,wlp-hilo' && ps.find((q) => q['time-series-code'] === 'wlo').resolution === 'FIVE_MINUTES' && ps.find((q) => q['time-series-code'] === 'wlp').resolution === 'FIFTEEN_MINUTES' && !ps.find((q) => q['time-series-code'] === 'wlp-hilo').resolution && gaugeReqs.every((u) => u.startsWith('https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/5cebf1df3d0f4a073c4bbd1e/data?')) && ps.every((q) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/.test(q.from) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/.test(q.to)), t('gauge: clicking the dot asks the Canadian Hydrographic Service three times, for the highs and lows, the observed levels (every 5 minutes) and the predicted levels (every 15 minutes), in UTC, for the one station'), JSON.stringify(gaugeReqs.map((u) => u.slice(70, 200))))
  const gaps = g ? g.resources.slice(1).map((x, i) => x[1] - g.resources[i][1]) : []
  report(g && g.resources.length === 3 && gaps.every((x) => x >= 350) && g.resources[0][0] === 'wlp-hilo', t('gauge: the three requests start at least 350 ms apart (the service allows 3 a second and 30 a minute), the highs and lows first'), JSON.stringify(g?.resources))
  const hiloSaid = await iwlsAsk('wlp-hilo', 0, 30 * 60), obsSaid = await iwlsAsk('wlo', 20, 0, 'FIVE_MINUTES')
  if (g && hiloSaid && obsSaid) {
    const ev = hiloSaid.map((e) => ({ ms: Date.parse(e.eventDate), v: e.value })).sort((a, b) => a.ms - b.ms).map((e, i, all) => ({ ...e, type: i < all.length - 1 ? (e.v > all[i + 1].v ? 'High tide' : 'Low tide') : (e.v >= all[i - 1].v ? 'High tide' : 'Low tide') }))
    const next = (type) => ev.find((e) => e.type === type && e.ms > Date.now() - 120e3)
    const want = Object.fromEntries(['High tide', 'Low tide'].map((k) => [k, next(k)]))
    const clockOf = (ms) => page.evaluate(async (ms) => (await import('/js/overlays-data.js')).tideClock(ms, Date.now()), ms)
    const high = g.rows.find((r) => r[0] === 'High tide'), low = g.rows.find((r) => r[0] === 'Low tide'), seen = g.rows.find((r) => r[0] === 'Observed')
    const obsLast = obsSaid.filter((o) => o.qcFlagCode !== '3').at(-1)
    const latest = await page.evaluate(() => window.__overlays.tideCache.get('07120')?.tide.latest ?? null)
    const order = g.rows.map((r) => r[0]).filter((l) => l !== 'Observed')
    report(!!high && !!low && high[2] === `${want['High tide'].v.toFixed(2)} m` && low[2] === `${want['Low tide'].v.toFixed(2)} m` && high[1] === await clockOf(want['High tide'].ms) && low[1] === await clockOf(want['Low tide'].ms) && order.join() === [want['High tide'], want['Low tide']].sort((a, b) => a.ms - b.ms).map((e) => e.type).join(), t('gauge: the popup gives the next high and low tide, soonest first, in Pacific time, with the heights the service gives'), JSON.stringify({ rows: g.rows, want }))
    report(!!seen && /^\d\.\d\d m$/.test(seen[2]) && TIDE_CLOCK.test(seen[1]) && !!latest && !!obsLast && Math.abs(latest.ms - Date.parse(obsLast.eventDate)) <= 10 * 60e3 && Math.abs(Number(seen[2].replace(' m', '')) - obsLast.value) <= 0.25 && Date.now() - latest.ms < 30 * 60e3, t('gauge: the popup gives the latest observed level with its time (within 30 minutes of now, and within 10 minutes and a quarter of a metre of what the service says a moment later)'), JSON.stringify({ seen, latest, obsLast }))
  } else report(false, t('gauge: the check could not ask the Canadian Hydrographic Service itself for the highs, lows and observed levels'), JSON.stringify({ g: !!g, hiloSaid: !!hiloSaid, obsSaid: !!obsSaid }))
  const obsP = g?.svg?.paths.find((x) => x.cls === 'observed'), predP = g?.svg?.paths.find((x) => x.cls === 'predicted')
  report(!!g && g.title === 'Victoria Harbour' && g.tag === 'tide gauge' && g.svg?.viewBox === '0 0 260 106' && /^Predicted tide height for the 24 hours around now, from [\d.]+ to [\d.]+ metres\. The observed height is drawn over it up to now\. A red line marks now\.$/.test(g.svg.label) && g.svg.paths.length === 2 && !!predP && !!obsP && predP.stroke !== obsP.stroke && predP.points >= 90 && obsP.points >= 30 && obsP.points <= 40 && g.svg.dots === 1 && g.svg.cx > 30 && g.svg.cx < 47 && Math.abs(obsP.lastX - g.svg.cx) <= 8 && ['12 a.m.', '6 a.m.', '12 p.m.', '6 p.m.', 'now', 'predicted', 'observed'].every((x) => g.svg.texts.includes(x)) && g.svg.img === 0, t('gauge: the popup has a 24 hour curve as SVG, the predicted levels (about 96 points) with the observed ones (about 36, up to now) drawn over them in another colour, a now marker three 24ths of the way across, the axis in Pacific hours and a key'), JSON.stringify({ ...g?.svg, texts: g?.svg?.texts.join('|') }))
  report(!!g && g.text.includes('Not for navigation.') && g.text.includes('Source: Canadian Hydrographic Service, station 07120') && g.text.includes('chart datum') && g.text.includes('Pacific time') && g.notice === D.iwls && g.noticeVisible && g.links.length === 1 && g.links[0].startsWith('https://tides.gc.ca/en/stations/07120') && g.links[0].includes('noopener') && g.within, t('gauge: the popup says not for navigation, names the Canadian Hydrographic Service and the datum, carries the licence notice word for word where it can be read, links to the station page and sits wholly on the screen'), JSON.stringify({ notice: g?.notice?.slice(0, 60), visible: g?.noticeVisible, links: g?.links, within: g?.within, box: g?.box }))
  if (shot) await shot('tide-gauge')
  const gaugeAsked = iwls().length
  await click('07120', 11)
  report(iwls().length === gaugeAsked && !!(await popup()), t('gauge: opening the popup again asks the service nothing more while the box stays ticked'), String(iwls().length))
  const opened = await page.evaluate(() => window.__overlays.tideCache.size)
  report(opened === 8 && own() === 12 && iwls().length === 3, t('tides: eight stations were opened, seven from NOAA (twelve requests) and the gauge (three requests)'), JSON.stringify({ opened, noaa: own(), chs: iwls().length }))

  // Unticking: markers, note, status line and credit go, the predictions kept go, and nothing more is asked
  await setBox(page, 'input[data-overlay=tides]', false)
  await page.waitForTimeout(800)
  const off = await page.evaluate(() => ({ vis: window.__map.getLayoutProperty('tides-dot', 'visibility'), label: window.__map.getLayoutProperty('tides-label', 'visibility'), status: !document.getElementById('status-tides').hidden, note: !document.getElementById('tides-note').hidden, notice: !document.getElementById('tides-chs-notice').hidden, kept: window.__overlays.tideCache.size, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  report(off.vis === 'none' && off.label === 'none' && !off.status && !off.note && !off.notice && off.kept === 0 && !off.attrib.includes('NOAA/NOS/CO-OPS') && !off.attrib.includes('Canadian Hydrographic Service'), t('tides: unticking hides the markers, note, Canadian Hydrographic Service notice, status line and credits and lets go of the predictions kept'), JSON.stringify({ ...off, attrib: undefined }))
  await page.waitForTimeout(3500)
  report(own() === 12 && iwls().length === gaugeAsked, t('tides: nothing polls NOAA or the Canadian Hydrographic Service, before or after the box is ticked or unticked'), JSON.stringify([own(), iwls().length]))
  // Ticked again, a station is asked for afresh
  await setBox(page, 'input[data-overlay=tides]', true)
  await waitStatus(page, 'tides').catch(() => {})
  await click('9444090')
  report(own('9444090') === 4 && !!(await popup()), t('tides: ticked again, a station is asked for afresh (two more requests)'), String(own('9444090')))
  await click('07120', 11)
  report(iwls().length === gaugeAsked + 3 && !!(await popup()), t('tides: ticked again, the gauge is asked for afresh (three more requests)'), String(iwls().length))
  await setBox(page, 'input[data-overlay=tides]', false)
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

// ---- seafloor depth: ETOPO1 colours drawn in the browser from the elevation tiles, and over them, in Canadian waters, the Canadian
// Hydrographic Service's NONNA tiles, asked for live and painted again in the same colours
// Sample places on the screen, told apart by asking the map: inland squares (no water within 6 px) and the basemap's water.
const seaSamples = (page) => page.evaluate(() => {
  const m = window.__map, wl = m.getStyle().layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source && !/mask/.test(l.id))
  const land = [], sea = []
  for (let y = 110; y < innerHeight - 70; y += 14) for (let x = 24; x < innerWidth - 70; x += 14) {
    const near = m.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [wl.id] }).length, here = m.queryRenderedFeatures([x, y], { layers: [wl.id] }).length
    const corners = [[x - 6, y - 6], [x + 6, y - 6], [x - 6, y + 6], [x + 6, y + 6]].every((q) => m.queryRenderedFeatures(q, { layers: [wl.id] }).length > 0)
    if (!near) land.push([x, y]); else if (here && corners) sea.push([x, y])
  }
  return { land, sea }
})
const pagePixels = async (page, pts) => {
  const png = await page.screenshot({ timeout: 120000 })
  return page.evaluate(async ([b64, pts]) => { const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()), c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]) }, [png.toString('base64'), pts])
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const colourDiff = (p, q) => Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - q[k])))
// The service's own depth grid (WCS) at a place, in metres below chart datum (null on land, or where the service has no data). A 3 by 3 grid
// of `metres` either side of the place, the middle one, asked for from here and not from the page.
const mercator = (lng, lat) => [lng * 20037508.342789244 / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * 20037508.342789244 / Math.PI]
async function chsDepth(res, lng, lat, metres) {
  const [x, y] = mercator(lng, lat)
  const url = `https://${NONNA_HOST}/geoserver/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=nonna__NONNA%20${res}%20Coverage&format=application%2Fgml%2Bxml&subset=X(${(x - metres).toFixed(1)},${(x + metres).toFixed(1)})&subset=Y(${(y - metres).toFixed(1)},${(y + metres).toFixed(1)})&scalesize=i(3),j(3)`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!r.ok) return null
    const v = Number((await r.text()).match(/<tupleList>([^<]*)<\/tupleList>/)?.[1].trim().split(/\s+/)[4])
    return Number.isFinite(v) && Math.abs(v) < 1e5 ? -v : null
  } catch { return null }
}
const NONNA_URL = /^https:\/\/nonna-geoserver\.data\.chs-shc\.ca\/geoserver\/gwc\/service\/wmts\/rest\/nonna:NONNA%20(100|10)\/raster\/EPSG:900913\/EPSG:900913:(\d+)\/(\d+)\/(\d+)\?format=image\/png$/
const SEAFLOOR_STATUS = /^Depth in metres, from the Canadian Hydrographic Service in Canadian waters \(cells of 100 m, and 10 m close up\) and from NOAA’s ETOPO1 grid elsewhere\. Not for navigation\.$/

async function checkSeafloor(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await setBox(page, '#flow', false)
  const wide = page.viewportSize().width >= 700
  const tileZooms = (from) => requests.slice(from).filter((u) => new URL(u).host === 's3.amazonaws.com').map((u) => Number(u.match(/terrarium\/(\d+)\//)?.[1]))
  await panel(false)
  const hillBefore = await page.evaluate(() => ({ hill: window.__map.getLayoutProperty('hillshade', 'visibility'), terrain: !!window.__map.getTerrain() }))
  const layer0 = await page.evaluate(() => {
    const m = window.__map, ids = m.getStyle().layers.map((l) => l.id), nonna = ['seafloor-nonna', 'seafloor-nonna-10'].map((id) => { const l = m.getLayer(id), s = m.getSource(l.source); return { id, type: l.type, vis: m.getLayoutProperty(id, 'visibility'), min: l.minzoom, max: l.maxzoom, srcMax: s.maxzoom, tiles: s.tiles, tileSize: s.tileSize, order: ids.indexOf(id) } })
    return { vis: m.getLayoutProperty('seafloor', 'visibility'), type: m.getLayer('seafloor').type, maxzoom: m.getSource('seafloor').maxzoom, tiles: m.getSource('seafloor').tiles, box: document.querySelector('input[data-overlay=seafloor]').checked, order: ids.indexOf('seafloor'), nonna }
  })
  report(layer0.vis === 'none' && layer0.type === 'color-relief' && layer0.maxzoom === 8 && layer0.tiles[0].startsWith('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/') && !layer0.box && hillBefore.hill === 'none' && !hillBefore.terrain, t('seafloor: off at first, a colour relief on a source of its own capped at tile zoom 8, on the same tile address as the elevation layers (no new host)'), JSON.stringify({ layer0, hillBefore }))
  const [n100, n10] = layer0.nonna
  report(n100.type === 'raster' && n10.type === 'raster' && n100.vis === 'none' && n10.vis === 'none' && n100.max === 11 && n10.min === 11 && n100.srcMax === 11 && n10.srcMax === 14 && n100.tileSize === 256 && n10.tileSize === 256 && n100.tiles[0] === 'nonna://100/{z}/{x}/{y}' && n10.tiles[0] === 'nonna://10/{z}/{x}/{y}' && layer0.order < n100.order && n100.order < n10.order, t('seafloor: the Canadian Hydrographic Service tiles are two raster layers over the ETOPO1 colours, hidden at first, the 100 m ones below map zoom 11 and the 10 m ones from there (to tile zoom 14), asked for by the page’s own "nonna" address and not straight from the server'), JSON.stringify(layer0.nonna))
  const goTo = (z, c) => page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z, pitch: window.__map.getPitch(), bearing: 0 }), [c, z])
  const compare = async (z, label, centre = [-123.40, 48.40], { key = 0 } = {}) => {
    const settle = async (ms = 3500) => {
      await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
      await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {})
      await page.waitForTimeout(ms)
    }
    // Where the places are is asked of the map only once the view has settled, so that every tile of the basemap is in.
    await goTo(z, centre)
    await settle(3000)
    const { land, sea } = await seaSamples(page)
    const pts = [...land, ...sea]
    const off1 = await pagePixels(page, pts)
    const from = requests.length
    await setBox(page, 'input[data-overlay=seafloor]', true)
    await waitStatus(page, 'seafloor').catch(() => {})
    await settle()
    const onL = await pagePixels(page, pts)
    const tiles = requests.slice(from).filter((u) => new URL(u).host === NONNA_HOST)
    // Against the service's own depth grid: the colour in the page at places on the water is the key's colour for the depth the service gives there.
    let keyed = null
    if (key) {
      const step = Math.max(1, Math.floor(sea.length / 18)), picked = sea.map((p, i) => [p, i]).filter((_, i) => i % step === 0).slice(0, 18)
      const lnglat = await page.evaluate((pts) => pts.map(([x, y]) => window.__map.unproject([x, y]).toArray()), picked.map(([p]) => p))
      const rows = []
      for (let i = 0; i < picked.length; i++) {
        const depth = await chsDepth(key, lnglat[i][0], lnglat[i][1], key === 100 ? 150 : 15)
        if (depth != null && depth >= 3 && depth <= 280) rows.push({ depth, colour: onL[land.length + picked[i][1]] })
      }
      const wantColours = await page.evaluate(async (ds) => { const D = await import('/js/overlays-data.js'); return ds.map((d) => D.nonnaColour(d).map((v, k) => Math.round(v * 0.75 + [194, 200, 202][k] * 0.25))) }, rows.map((r) => r.depth))
      const diffs = rows.map((r, i) => colourDiff(r.colour, wantColours[i])).sort((a, b) => a - b)
      keyed = { asked: picked.length, n: rows.length, within: diffs.filter((d) => d <= 30).length, median: diffs[Math.floor(diffs.length / 2)] ?? null, max: diffs.at(-1) ?? null, depths: rows.map((r) => Math.round(r.depth)).join(' ') }
    }
    await setBox(page, 'input[data-overlay=seafloor]', false)
    await settle(2000)
    const off2 = await pagePixels(page, pts)
    // Only places that look the same in both pictures taken with the layer off count: labels and tiles that are still arriving change by themselves.
    const n = land.length, stable = pts.map((_, i) => colourDiff(off1[i], off2[i]) <= 3)
    const landDiff = land.map((_, i) => (stable[i] ? colourDiff(onL[i], off1[i]) : 0)), seaIdx = sea.map((_, i) => n + i).filter((i) => stable[i])
    const seaDiff = seaIdx.map((i) => colourDiff(onL[i], off1[i]))
    const darker = seaIdx.filter((i) => colourDiff(onL[i], off1[i]) > 12 && lum(onL[i]) < lum(off1[i]) && onL[i][2] >= onL[i][0]).length
    return { z, land: stable.slice(0, n).filter(Boolean).length, sea: seaIdx.length, landMax: Math.max(0, ...landDiff), landChanged: landDiff.filter((x) => x > 8).length, seaChanged: seaDiff.filter((x) => x > 12).length, darker, label, tiles, keyed }
  }
  const startReq = requests.length
  const wide9 = await compare(9.6, 'sea basin', undefined, { key: 100 })
  console.log(`      (${t(`seafloor at zoom 9.6: ${wide9.land} inland places, largest change ${wide9.landMax} of 255 (${wide9.landChanged} above 8); ${wide9.sea} places on the basemap's water, ${wide9.seaChanged} coloured, ${wide9.tiles.length} tiles from the Canadian Hydrographic Service`)})`)
  report(wide9.land > 40 && wide9.landChanged === 0 && wide9.sea > 40 && wide9.seaChanged > 0.4 * wide9.sea && wide9.darker >= 0.98 * wide9.seaChanged, t('seafloor: ticking it colours the sea blue (darker and bluer, at 98% or more of the places it changes) at zoom 9.6 and leaves every inland place as it was (no change above 8 of 255, where the same place looks the same in two pictures with the layer off)'), JSON.stringify({ ...wide9, tiles: wide9.tiles.length }))
  const mid = await compare(11.6, 'bays', undefined, { key: 10 })
  const street = await compare(13.6, 'street', [-123.3544, 48.3995], { key: 10 }) // Clover Point, land to the north and water to the south
  console.log(`      (${t(`seafloor at zoom 11.6: ${mid.landChanged} of ${mid.land} inland places changed, ${mid.seaChanged} of ${mid.sea} water places coloured. At zoom 13.6 (a shore): ${street.landChanged} of ${street.land} changed, ${street.seaChanged} of ${street.sea} coloured`)})`)
  report(mid.land > 20 && mid.landChanged === 0 && mid.sea > 100 && mid.seaChanged > 0.2 * mid.sea && street.land > 20 && street.sea > 100 && street.landChanged === 0, t('seafloor: at zoom 11.6 the sea is still coloured, and at 11.6 and street zoom (13.6, at a shore) the land is still left alone'), JSON.stringify({ mid: { ...mid, tiles: mid.tiles.length }, street: { ...street, tiles: street.tiles.length } }))
  // The US side: the service has no tiles there, so the ETOPO1 colours under the Canadian ones are what shows
  const us = await compare(9.6, 'US waters', [-123.0, 48.15])
  console.log(`      (${t(`seafloor in U.S. waters at zoom 9.6: ${us.landChanged} of ${us.land} inland places changed, ${us.seaChanged} of ${us.sea} water places coloured`)})`)
  report(us.sea > 40 && us.seaChanged > 0.4 * us.sea && us.landChanged === 0 && us.darker >= 0.98 * us.seaChanged, t('seafloor: in U.S. waters, where the Canadian Hydrographic Service has no data, the ETOPO1 colours show (darker and bluer than the sea, at 98% or more of the places they change) and the land is left alone'), JSON.stringify({ ...us, tiles: us.tiles.length }))
  for (const [label, r, res] of [['zoom 9.6', wide9, 100], ['zoom 11.6', mid, 10], ['zoom 13.6', street, 10]]) {
    const k = r.keyed
    console.log(`      (${t(`seafloor against the service's own depth grid at ${label}: ${k.within} of ${k.n} places (of ${k.asked} tried, with depths ${k.depths} m) within 30 of 255 of the key's colour, median difference ${k.median}, largest ${k.max}`)})`)
    report(k.n >= 6 && k.within >= 0.85 * k.n && k.median <= 14, t(`seafloor: at ${label} the colour of the sea in the page is the colour of the key for the depth that the service's own depth grid gives there (at least 6 places, 85% within 30 of 255 per channel, median within 14)`), JSON.stringify(k))
  }
  // Which tiles are asked for: only the service's tile addresses, the 100 m layer below map zoom 11 and the 10 m layer from there, a few tiles for a view, and nothing for the US side
  const addr = (r) => r.tiles.map((u) => NONNA_URL.exec(u))
  report(wide9.tiles.length > 0 && wide9.tiles.length <= 60 && addr(wide9).every((m) => m && m[1] === '100' && Number(m[2]) <= 11) && mid.tiles.length > 0 && mid.tiles.length <= 100 && addr(mid).every((m) => m && m[1] === '10' && Number(m[2]) >= 12 && Number(m[2]) <= 14) && street.tiles.length > 0 && street.tiles.length <= 60 && addr(street).every((m) => m && m[1] === '10' && Number(m[2]) >= 12 && Number(m[2]) <= 14), t('seafloor: only tile addresses of the Canadian Hydrographic Service WMTS are asked for, the 100 m layer at map zoom 9.6 (tile zoom 11 at most) and the 10 m layer at 11.6 and 13.6 (tile zoom 12 to 14), a screenful of tiles each time (60, 100 and 60 at most)'), JSON.stringify([wide9.tiles.length, mid.tiles.length, street.tiles.length, addr(wide9).filter((m) => !m).length]))
  const allNonna = requests.slice(startReq).filter((u) => new URL(u).host === NONNA_HOST)
  report(allNonna.length > 0 && allNonna.every((u) => NONNA_URL.test(u)), t('seafloor: nothing but tiles is asked of the Canadian Hydrographic Service (no capabilities, legend, feature info or depth requests from the page)'), String(allNonna.filter((u) => !NONNA_URL.test(u)).slice(0, 2)))
  const zs = tileZooms(startReq)
  report(zs.length > 0 && zs.every((z) => z <= 8), t('seafloor: with the elevation layers off, the only elevation tiles asked for are at zoom 8 or less, wherever the map is zoomed to'), JSON.stringify([...new Set(zs)].sort()))
  report(requests.slice(startReq).filter((u) => !['s3.amazonaws.com', NONNA_HOST].includes(new URL(u).host) && !/openfreemap|127\.0\.0\.1/.test(new URL(u).host)).length === 0, t('seafloor: it contacts no outside host but the elevation tiles and the Canadian Hydrographic Service tile server'))

  // The key, the notice and the credits
  await page.evaluate(() => window.__map.jumpTo({ center: [-123.40, 48.40], zoom: 9.6 }))
  await panel(true)
  await setBox(page, 'input[data-overlay=seafloor]', true)
  await waitStatus(page, 'seafloor').catch(() => {})
  await page.waitForTimeout(1500)
  const D = await page.evaluate(async () => { const m = await import('/js/overlays-data.js'); return { nonna: m.NONNA_NOTICE, gradient: m.nonnaGradient(0, 300) } })
  const k = await page.evaluate(() => ({ key: !document.getElementById('seafloor-key').hidden, note: !document.getElementById('seafloor-note').hidden, status: document.getElementById('status-seafloor').textContent, state: document.getElementById('status-seafloor').dataset.state, gradient: getComputedStyle(document.getElementById('seafloor-bar')).backgroundImage, ticks: [...document.querySelectorAll('#seafloor-ticks span')].map((x) => x.textContent).join(' '), title: document.querySelector('#seafloor-key .scale-title').textContent, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent, notice: (() => { const n = document.getElementById('seafloor-chs-notice'); return { shown: !n.hidden, text: n.textContent, visible: n.getBoundingClientRect().height > 10 } })(), fit: (() => { const p = document.getElementById('panel').getBoundingClientRect(), n = document.getElementById('seafloor-note').getBoundingClientRect(), q = document.getElementById('seafloor-key').getBoundingClientRect(), c = document.getElementById('seafloor-chs-notice').getBoundingClientRect(); return n.right <= p.right + 1 && q.right <= p.right + 1 && c.right <= p.right + 1 && document.documentElement.scrollWidth <= innerWidth })() }))
  const gradientOk = k.gradient.startsWith('linear-gradient') && D.gradient.match(/rgb\(\d+, \d+, \d+\)/g).every((c) => k.gradient.includes(c))
  report(k.key && k.note && gradientOk && k.ticks === '10 50 100 200 300' && k.title === 'Depth below the sea, metres' && SEAFLOOR_STATUS.test(k.status) && k.state === 'ok' && k.attrib.includes('Seafloor depth: ETOPO1, NOAA (coarse, not for navigation)') && k.attrib.includes('Seafloor depth in Canadian waters: Canadian Hydrographic Service (NONNA, not for navigation)') && k.fit, t('seafloor: the key is a gradient in metres (10 to 300, from the colours of the layer), the status line gives the sources and not for navigation, the map carries both credits, and everything fits the panel'), JSON.stringify({ ...k, attrib: k.attrib.slice(0, 120), gradient: k.gradient.slice(0, 80) }))
  report(k.notice.shown && k.notice.visible && k.notice.text === D.nonna && /^This product was made by Darren Zal and contains intellectual property of the Canadian Hydrographic Service \(CHS\)/.test(k.notice.text) && k.notice.text.includes('This product does not meet the requirements of the Navigation Safety Regulations, 2020'), t('seafloor: while the box is ticked the panel shows the notice the Canadian Hydrographic Service licence requires, word for word, with the name filled in'), JSON.stringify(k.notice))
  if (shot) { await page.evaluate(() => document.getElementById('seafloor-chs-notice').scrollIntoView({ block: 'end' })); await shot('seafloor-panel'); if (!wide) await panel(false); await shot('seafloor-2d'); await panel(true) }

  // With 3D terrain on, the colours are draped over the relief, and the land is still left alone
  await panel(false)
  await setBox(page, '#terrain3d', true)
  await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1 && !!window.__map.getTerrain(), null, { timeout: 150000 })
  await page.waitForTimeout(3000)
  await setBox(page, 'input[data-overlay=seafloor]', false)
  await page.waitForTimeout(800)
  const d3 = await compare(9.6, '3d')
  console.log(`      (${t(`seafloor with 3D terrain: ${d3.landChanged} of ${d3.land} inland places changed, ${d3.seaChanged} of ${d3.sea} water places coloured`)})`)
  report(d3.land > 40 && d3.landChanged === 0 && d3.sea > 40 && d3.seaChanged > 0.3 * d3.sea, t('seafloor: with 3D terrain on (pitch 60) the sea is coloured over the relief and the inland places are not'), JSON.stringify({ ...d3, tiles: d3.tiles.length }))
  if (shot) { await setBox(page, 'input[data-overlay=seafloor]', true); await waitStatus(page, 'seafloor').catch(() => {}); await page.waitForTimeout(3500); await shot('seafloor-3d'); await setBox(page, 'input[data-overlay=seafloor]', false) }
  await setBox(page, '#terrain3d', false)
  await page.waitForFunction(() => window.__map.getPitch() < 0.5 && !window.__map.getTerrain(), null, { timeout: 90000 })
  await page.waitForTimeout(800)
  // Unticking leaves no layer shown, no credit, no notice and no key
  const off = await page.evaluate(() => ({ vis: ['seafloor', 'seafloor-nonna', 'seafloor-nonna-10'].map((id) => window.__map.getLayoutProperty(id, 'visibility')), key: !document.getElementById('seafloor-key').hidden, note: !document.getElementById('seafloor-note').hidden, notice: !document.getElementById('seafloor-chs-notice').hidden, status: !document.getElementById('status-seafloor').hidden, attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }))
  report(off.vis.every((v) => v === 'none') && !off.key && !off.note && !off.notice && !off.status && !off.attrib.includes('ETOPO1') && !off.attrib.includes('Canadian Hydrographic Service'), t('seafloor: unticking hides the layers, key, note, notice, status line and credits'), JSON.stringify({ ...off, attrib: undefined }))
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

// Marine life and protection: seven layers drawn from files of this site (no outside host, nothing requested before a box is ticked).
// Checked on both screen sizes: each box on and off (layers, status line, credit, the one file asked for), a popup for each layer, the
// species picker and its key, the panel on a phone, and a popup built from text only. On the desktop run the pixels are also read: the colour
// of each density cell is the colour of its class, and the areas leave the land alone.
const MARINE = {
  protected: { file: 'data/marine-protected.geojson', layers: ['protected-fill', 'protected-line'], credit: 'Protected areas: CPCAD', status: (n) => new RegExp(`^${n} marine zones of protected areas in the area this map reaches\\.$`) },
  srkw: { file: 'data/srkw-habitat.geojson', layers: ['srkw-fill', 'srkw-line'], credit: 'Killer whale critical habitat: Fisheries and Oceans Canada', status: () => /^Shown for the area this map reaches\.$/ },
  cetaceans: { file: 'data/whale-density.geojson', layers: ['cetaceans-fill', 'cetaceans-line'], credit: 'Whale and porpoise model: Fisheries and Oceans Canada', status: (n) => new RegExp(`^Humpback whale: modelled summer density from the 2018 ship surveys, not where animals are now\\. ${n} cells in Canadian waters\\.$`) },
  kelp: { file: 'data/kelp.geojson', layers: ['kelp-fill', 'kelp-line'], credit: 'Coastal habitat: CRIMS', status: (n) => new RegExp(`^${n.toLocaleString('en-CA')} kelp beds\\.$`) },
  eelgrass: { file: 'data/eelgrass.geojson', layers: ['eelgrass-fill', 'eelgrass-line'], credit: 'Coastal habitat: CRIMS', status: (n) => new RegExp(`^${n} eelgrass beds, mapped in 1998\\.$`) },
  herring: { file: 'data/herring-spawn.geojson', layers: ['herring-line'], credit: 'Coastal habitat: CRIMS', status: (n) => new RegExp(`^${n} stretches of shore with herring spawn recorded between 1937 and 1986\\.$`) },
  seabirds: { file: 'data/seabird-colonies.geojson', layers: ['seabirds-dot'], credit: 'Coastal habitat: CRIMS', status: (n) => new RegExp(`^${n} seabird colonies\\. Keep well back from nesting birds\\.$`) },
}
const WHALE_RULES_TEXT = 'Vessels must stay at least 1,000 m from Southern Resident killer whales from June 1, 2026 to May 31, 2027, at least 200 m from all other killer whales and at least 100 m from all other whales, dolphins and porpoises. Some exceptions apply.'
const OGL_CANADA_STATEMENT = 'Contains information licensed under the Open Government Licence – Canada.'
const OGL_BC_STATEMENT = 'Contains information licensed under the Open Government Licence – British Columbia.'
const SPECIES = { humpback: { name: 'Humpback whale', plural: 'humpback whales' }, harbour: { name: 'Harbour porpoise', plural: 'harbour porpoises' }, dalls: { name: 'Dall’s porpoise', plural: 'Dall’s porpoises' } }
const bboxCentre = (g) => {
  const xs = [], ys = []
  const walk = (c) => { if (typeof c[0] === 'number') { xs.push(c[0]); ys.push(c[1]) } else c.forEach(walk) }
  walk(g.coordinates)
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

async function checkMarine(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  const wide = page.viewportSize().width >= 700
  const disk = async (file) => JSON.parse(await readFile(join(ROOT, file), 'utf8')).features
  const data = {}
  for (const [id, m] of Object.entries(MARINE)) data[id] = await disk(m.file)
  const fileRequests = (file) => requests.filter((u) => new URL(u).pathname.endsWith(`/${file}`)).length
  const anyMarineFile = () => Object.values(MARINE).reduce((n, m) => n + fileRequests(m.file), 0)
  const tick = (id, v = true) => setBox(page, `input[data-overlay=${id}]`, v)
  const untickAll = async () => { for (const id of Object.keys(MARINE)) await tick(id, false); await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove()) }
  await setBox(page, '#flow', false)
  await untickAll()
  // On the phone run nothing has been ticked yet, so no marine file can have been asked for. (On the desktop run the same is checked, with the other
  // layers, at the start of the overlay check.)
  if (name === 'phone') report(anyMarineFile() === 0, t('marine layers: nothing is requested for the seven marine files before a box is ticked'), String(anyMarineFile()))
  const baseline = requests.length

  // ---- each box: layers, status line, credit, the one file asked for, and everything off again
  for (const [id, m] of Object.entries(MARINE)) {
    const before = fileRequests(m.file)
    await tick(id, true)
    await waitStatus(page, id, 60000).catch(() => {})
    await page.waitForTimeout(500)
    const st = await statusOf(page, id)
    const vis = await layerStates(page, id)
    const attrib = await page.evaluate(() => document.querySelector('.maplibregl-ctrl-attrib').textContent)
    const ui = await page.evaluate((id) => Object.fromEntries((window.__overlays.defs[id].ui || []).map((u) => [u, !document.getElementById(u).hidden])), id)
    const after = fileRequests(m.file)
    report(st.state === 'ok' && m.status(data[id].length).test(st.text) && vis.length === m.layers.length && vis.every((v) => v === 'visible') && attrib.includes(m.credit) && Object.values(ui).every(Boolean) && before <= 1 && after === 1, t(`marine ${id}: ticking it shows its layer, a status line that counts the file's features, its credit on the map and its own controls, and asks for its one file once`), JSON.stringify({ st, vis, credit: attrib.includes(m.credit), ui, before, after }))
    await tick(id, false)
    await page.waitForTimeout(300)
    const off = await page.evaluate(([id, layers]) => ({ vis: layers.map((l) => window.__map.getLayoutProperty(l, 'visibility')), status: !document.getElementById('status-' + id).hidden, ui: (window.__overlays.defs[id].ui || []).filter((u) => !document.getElementById(u).hidden), attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent }), [id, m.layers])
    report(off.vis.every((v) => v === 'none') && !off.status && off.ui.length === 0 && !off.attrib.includes(m.credit), t(`marine ${id}: unticking hides its layer, status line, controls and credit`), JSON.stringify(off))
  }

  // ---- a popup for each layer, found by looking for the layer on the screen where its data is
  await panel(false)
  const popupInfo = () => page.evaluate(() => {
    const c = document.querySelector('.maplibregl-popup-content'); if (!c) return null
    const r = c.getBoundingClientRect()
    return { title: c.querySelector('h3')?.textContent, titles: [...c.querySelectorAll('h3')].map((h) => h.textContent), tag: c.querySelector('.tag')?.textContent, text: c.innerText.replace(/\n+/g, ' | '), links: [...c.querySelectorAll('a')].map((a) => a.href + ' ' + a.rel), hr: c.querySelectorAll('hr').length, imgs: c.querySelectorAll('img').length, scrollTop: c.scrollTop, within: r.left >= 0 && r.right <= innerWidth }
  })
  const view = async (c, z) => {
    await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z, pitch: 0, bearing: 0 }) }, [c, z])
    await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
    await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 40000 }).catch(() => {})
    await page.waitForTimeout(900)
  }
  // A place on the screen (not under the banner, the buttons or the panel) where every layer in the list is under a 16 px box,
  // the one nearest the middle of the screen, as a visitor would click.
  const scan = (layers) => page.evaluate((layers) => {
    const m = window.__map
    let best = null
    for (let y = 140; y < innerHeight - 110; y += 14) for (let x = 40; x < innerWidth - 60; x += 14) {
      const box = [[x - 8, y - 8], [x + 8, y + 8]]
      if (!layers.every((l) => m.queryRenderedFeatures(box, { layers: [l] }).length > 0)) continue
      const d = Math.hypot(x - innerWidth / 2, y - innerHeight / 2)
      if (!best || d < best.d) best = { d, at: [x, y] }
    }
    return best ? best.at : null
  }, layers)
  // Look for the layer on the screen, bring the place to the middle of the screen (a visitor can pan, and on a phone a popup only fits in full
  // when it opens from near the middle), and click there.
  const clickLayer = async (layers, c, z) => {
    await view(c, z)
    let at = null
    for (let i = 0; i < 4 && !at; i++) { at = await scan(layers); if (!at) await page.waitForTimeout(900) }
    if (!at) return { at: null, pop: null }
    await page.evaluate(([x, y]) => { const m = window.__map; m.jumpTo({ center: m.unproject([x, y]) }) }, at)
    await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
    await page.waitForTimeout(900)
    at = await scan(layers)
    if (!at) return { at: null, pop: null }
    await page.mouse.click(at[0], at[1])
    await page.waitForFunction(() => !!document.querySelector('.maplibregl-popup-content'), null, { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(500)
    return { at, pop: await popupInfo() }
  }
  const featureAt = (id, pick) => { const f = data[id].find(pick) || data[id][0]; return f.geometry.type === 'Point' ? f.geometry.coordinates : bboxCentre(f.geometry) }

  // protected area: Race Rocks
  await tick('protected', true); await waitStatus(page, 'protected').catch(() => {})
  let r = await clickLayer(['protected-fill'], featureAt('protected', (f) => f.properties.name === 'RACE ROCKS ECOLOGICAL RESERVE'), 12.5)
  let p = r.pop
  report(!!p && p.title === 'Race Rocks Ecological Reserve' && p.tag === 'ecological reserve' && p.text.includes('Owner: Government of British Columbia.') && p.text.includes('Established 1980.') && p.text.includes('No-take area, as reported to CPCAD: all of it.') && p.text.includes('Source: Canadian Protected and Conserved Areas Database (CPCAD).') && p.text.includes(OGL_CANADA_STATEMENT) && !p.text.includes('1,000 m') && p.imgs === 0 && p.scrollTop === 0 && p.within, t('marine protected: a click on Race Rocks opens its popup with owner, year, the no-take line, the CPCAD source and the Open Government Licence statement'), JSON.stringify(p))
  if (shot) await shot('marine-protected-popup')
  // The Gulf Islands National Park Reserve reports "None": no part is no-take. A park (class A) has no no-take line at all.
  const gulf = data.protected.find((f) => /Gulf Islands/.test(f.properties.name) && f.properties.no_take === 3)
  const park = data.protected.find((f) => f.properties.type === 'A - Park')
  r = await clickLayer(['protected-fill'], bboxCentre(gulf.geometry), 11)
  p = r.pop
  report(!!p && /Gulf Islands National Park Reserve/.test(p.title) && p.text.includes('No-take area, as reported to CPCAD: none of it.'), t('marine protected: the Gulf Islands marine zone says none of it is no-take, as CPCAD reports'), JSON.stringify(p))
  r = await clickLayer(['protected-fill'], bboxCentre(park.geometry), 14)
  p = r.pop
  report(!!p && p.tag === 'park (class A)' && !p.text.includes('No-take'), t('marine protected: a park (class A) shows no no-take line, because CPCAD gives none'), JSON.stringify(p))
  await tick('protected', false)

  // critical habitat
  await tick('srkw', true); await waitStatus(page, 'srkw').catch(() => {})
  r = await clickLayer(['srkw-fill'], [-123.3, 48.45], 9.6)
  p = r.pop
  report(!!p && p.title === 'Southern Resident killer whale critical habitat' && p.text.includes('A mapped boundary, not a sighting. It does not show where the whales are now.') && p.text.includes(WHALE_RULES_TEXT) && p.text.includes('For general guidance only.') && p.text.includes(OGL_CANADA_STATEMENT) && p.links.length === 2 && p.links.every((l) => l.startsWith('https://') && l.includes('noopener')) && p.links[0].includes('tc.canada.ca') && p.links[1].includes('laws-lois.justice.gc.ca') && p.imgs === 0 && p.scrollTop === 0 && p.within, t('marine critical habitat: the popup says it is a boundary and not a sighting, gives the vessel distances word for word with links to the bulletin and the regulations, and says for general guidance only'), JSON.stringify(p))
  if (shot) await shot('marine-srkw-popup')
  await tick('srkw', false)

  // density: three species
  await tick('cetaceans', true); await waitStatus(page, 'cetaceans').catch(() => {})
  const cells = data.cetaceans
  const dens = (key) => cells.map((f) => f.properties[`${key}_n`] / f.properties.km2 * 100)
  const breaksOf = (key) => page.evaluate(async (values) => (await import('/js/overlays-data.js')).densityBreaks(values), dens(key))
  const keyState = () => page.evaluate(() => ({ title: document.getElementById('cetaceans-key-title').textContent, ticks: [...document.querySelectorAll('#cetaceans-ticks span')].map((x) => x.textContent), lefts: [...document.querySelectorAll('#cetaceans-ticks span')].map((x) => x.style.left), bar: document.getElementById('cetaceans-bar').style.backgroundImage, fill: JSON.stringify(window.__map.getPaintProperty('cetaceans-fill', 'fill-color')), status: document.getElementById('status-cetaceans').textContent, select: document.getElementById('cetaceans-species').value, options: [...document.querySelectorAll('#cetaceans-species option')].map((o) => o.value + ':' + o.textContent), label: document.querySelector('label[for=cetaceans-species]')?.textContent, note: document.getElementById('cetaceans-note').textContent }))
  // The species is picked with the panel open, as a visitor does, and the panel is closed again so the map can be clicked and read.
  const pick = async (key) => { await panel(true); await page.selectOption('#cetaceans-species', key); await panel(false) }
  const seenFills = new Set()
  for (const [key, sp] of Object.entries(SPECIES)) {
    await pick(key)
    await page.waitForTimeout(400)
    const k = await keyState(), want = await breaksOf(key)
    const fmt = (b) => Number(Number(b).toPrecision(2)).toLocaleString('en-CA', { maximumFractionDigits: 6 })
    seenFills.add(k.fill)
    report(k.select === key && k.title === `Modelled ${sp.plural} per 100 km², summer 2018` && k.ticks.join() === want.map(fmt).join() && want.length === 4 && k.lefts.join() === '20%,40%,60%,80%' && k.fill.includes(`"d_${key}"`) && k.fill.includes(want.join(',').split(',')[0]) && k.bar.startsWith('linear-gradient') && k.status.startsWith(`${sp.name}: modelled summer density from the 2018 ship surveys, not where animals are now.`) && k.options.join() === 'humpback:Humpback whale,harbour:Harbour porpoise,dalls:Dall’s porpoise' && k.label === 'Species', t(`marine cetaceans: picking ${sp.name} colours the cells by its density, puts its class limits (${want.map(fmt).join(', ')}) under the key and says so in the status line`), JSON.stringify({ k, want }))
  }
  report(seenFills.size === 3, t('marine cetaceans: each species has its own colour expression'), String(seenFills.size))
  await pick('harbour')
  r = await clickLayer(['cetaceans-fill'], [-123.3, 48.45], 9.6)
  p = r.pop
  report(!!p && p.title === 'Harbour porpoise: modelled summer numbers' && p.tag === 'model of summer 2018 surveys' && /The model predicts about [\d.,]+ harbour porpoises in this cell \(Nhat, for a cell of [\d.,]+ km²\)\./.test(p.text) && /That is about [\d.,]+ per 100 km²\./.test(p.text) && /Uncertainty \(CV\): \d\.\d\d\. Higher means less certain\./.test(p.text) && p.text.includes('July to early September 2018') && p.text.includes('not where animals are now') && p.text.includes(WHALE_RULES_TEXT) && p.text.includes('Source: Fisheries and Oceans Canada, Pacific Region International Survey of Marine Megafauna (PRISMM)') && p.text.includes(OGL_CANADA_STATEMENT) && p.links.length === 2 && p.imgs === 0 && p.scrollTop === 0 && p.within, t('marine cetaceans: a click on a cell gives the species, the model number (Nhat) and area, the density, the uncertainty, the survey months and year, that it is not where animals are now, and the vessel distances'), JSON.stringify(p))
  if (shot) await shot('marine-cetaceans-popup')
  // the number in the popup is the file's number for that cell
  const nums = (p?.text.match(/predicts about ([\d.,]+) harbour porpoises in this cell \(Nhat, for a cell of ([\d.,]+) km²/) || []).slice(1).map((x) => Number(x.replace(/,/g, '')))
  report(nums.length === 2 && cells.some((f) => Math.abs(f.properties.harbour_n - nums[0]) <= Math.abs(f.properties.harbour_n) * 0.06 + 1e-9 && Math.abs(f.properties.km2 - nums[1]) <= f.properties.km2 * 0.06 + 1e-9), t('marine cetaceans: the numbers in the popup are numbers of one cell of the file, to two figures'), JSON.stringify(nums))
  await pick('humpback')

  // the three areas under one click: one popup, the vessel distances and the licence statement said once
  await tick('protected', true); await tick('srkw', true); await waitStatus(page, 'protected').catch(() => {}); await waitStatus(page, 'srkw').catch(() => {})
  r = await clickLayer(['protected-fill', 'srkw-fill', 'cetaceans-fill'], featureAt('protected', (f) => f.properties.name === 'OAK BAY ISLANDS ECOLOGICAL RESERVE'), 12.2)
  p = r.pop
  const count = (text, s) => text.split(s).length - 1
  report(!!p && p.titles.length >= 3 && p.titles.includes('Southern Resident killer whale critical habitat') && p.titles.includes('Humpback whale: modelled summer numbers') && p.titles.some((x) => /Oak Bay Islands|Victoria Harbour/.test(x)) && count(p.text, WHALE_RULES_TEXT) === 1 && count(p.text, OGL_CANADA_STATEMENT) === 1 && p.hr >= 3 && p.links.length === 2 && p.scrollTop === 0 && p.within, t('marine areas together: a click where a protected area, the critical habitat and a density cell overlap gives one popup with all three, the vessel distances once and the licence statement once'), JSON.stringify({ ...p, text: p.text.slice(0, 200) }))
  if (shot) await shot('marine-together-popup')
  // A blank block beside a tall popup, the size of the popup and the colour of the page, was seen in screenshots from Chromium's old headless mode (22 October). It is not in the page:
  // the DOM holds nothing there, and Firefox, WebKit and Chromium's new headless mode draw the map there (see the README). So this checks that the page is as it should be: the popup box is
  // no higher than 60% of the window and scrolls inside, and on the far side of its tip, where the block shows, the topmost thing is the map's own canvas.
  const box = await page.evaluate(() => {
    const pop = document.querySelector('.maplibregl-popup'), c = document.querySelector('.maplibregl-popup-content'), tip = document.querySelector('.maplibregl-popup-tip')
    if (!pop || !c) return null
    const r = pop.getBoundingClientRect(), cr = c.getBoundingClientRect(), tr = tip.getBoundingClientRect(), x = Math.round(r.left + r.width / 2)
    const anchorTop = /maplibregl-popup-anchor-top/.test(pop.className) // content below the tip
    // The places beside the tip, on the side away from the content, in the map and clear of the banner and the attribution.
    const probes = [100, 200, 300].map((d) => [x, Math.round(anchorTop ? r.top - d : r.bottom + d)]).filter(([px, py]) => py > 90 && py < innerHeight - 90)
    const tops = probes.map(([px, py]) => { const e = document.elementsFromPoint(px, py)[0]; return e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') : null })
    return { contentH: Math.round(cr.height), limit: Math.round(innerHeight * 0.6), scroll: c.scrollHeight > c.clientHeight, overflow: getComputedStyle(c).overflowY, tipOutside: tr.top >= cr.bottom - 1 || tr.bottom <= cr.top + 1, probes: probes.length, tops }
  })
  report(!!box && box.contentH <= box.limit + 1 && box.scroll && box.overflow === 'auto' && box.tipOutside && box.probes >= 1 && box.tops.every((x) => x === 'canvas.maplibregl-canvas'), t('marine: a tall popup is at most 60% of the window high and scrolls inside, and on the far side of its tip the topmost thing is the map canvas (no blank block in the page)'), JSON.stringify(box))
  await untickAll()

  // CRIMS layers: a click on each
  // The survey's records near Victoria, not the ones at the west edge of the map, so the view can be centred on them.
  const nearVictoria = (f) => { const [x, y] = f.geometry.type === 'Point' ? f.geometry.coordinates : bboxCentre(f.geometry); return x > -123.5 && x < -123.25 && y > 48.3 && y < 48.5 }
  const crims = [
    ['kelp', ['kelp-fill'], nearVictoria, 13.2, (x) => / bed$/.test(x.title) && x.tag === 'kelp bed' && (!/Density recorded/.test(x.text) || /Density recorded: (low|high)\./.test(x.text)) && x.text.includes('Mapped in a survey that began in 1979')],
    ['eelgrass', ['eelgrass-fill'], nearVictoria, 13, (x) => x.title === 'Eelgrass bed' && x.text.includes('Mapped in 1998.')],
    ['herring', ['herring-line'], nearVictoria, 14, (x) => x.title === 'Herring spawn, shore' && /Spawn magnitude recorded: [a-z ]+\./.test(x.text) && x.text.includes('The records run from 1937 to 1986.') && x.text.includes('These are old records, not this year’s spawn.')],
    ['seabirds', ['seabirds-dot'], (f) => f.properties.name === 'CHAIN ISLETS', 14, (x) => x.title === 'Chain Islets' && x.tag === 'seabird colony' && x.text.includes('Nesting birds are easily disturbed by boats and people. Keep well back.')],
  ]
  for (const [id, layers, pick, z, ok] of crims) {
    await tick(id, true); await waitStatus(page, id).catch(() => {})
    r = await clickLayer(layers, featureAt(id, pick), z)
    p = r.pop
    report(!!p && ok(p) && p.text.includes('legacy survey that began in 1979 and was only updated now and then') && p.text.includes(OGL_BC_STATEMENT) && p.imgs === 0 && p.scrollTop === 0 && p.within, t(`marine ${id}: a click opens a popup that says the survey is old (began in 1979, only updated now and then) and carries the Open Government Licence – British Columbia statement`), JSON.stringify(p))
    if (shot && id === 'seabirds') await shot('marine-seabirds-popup')
    await tick(id, false)
  }

  // popups are text only
  const hostile = await page.evaluate(() => {
    const o = window.__overlays, bad = '<img src=x onerror=alert(1)>'
    const out = {}
    for (const [layer, props] of [['protected-fill', { name: bad, type: bad, owner: '<b>y</b>', year: 1999, no_take: 1 }], ['seabirds-dot', { name: bad }], ['kelp-fill', { species: bad, density: bad }], ['herring-line', { magnitude: bad, consistency: bad, first_year: 1937, last_year: 1986 }]]) {
      const box = o.popupFor({ properties: props }, layer, [{ properties: props }])
      out[layer] = { img: box.querySelectorAll('img, b').length, text: box.textContent.includes('<img src=x onerror=alert(1)>') || box.textContent.toLowerCase().includes('<img') }
    }
    return out
  })
  report(Object.values(hostile).every((h) => h.img === 0 && h.text), t('marine popups: built from text only, markup in a record is shown as text and never run'), JSON.stringify(hostile))

  // ---- the panel: all seven on, the notes, the picker, and nothing too wide for the screen
  await panel(true)
  await view([-123.35, 48.42], 9.6)
  for (const id of Object.keys(MARINE)) await tick(id, true)
  for (const id of Object.keys(MARINE)) await waitStatus(page, id).catch(() => {})
  await page.waitForTimeout(1500)
  const lay = await page.evaluate(() => {
    const pn = document.getElementById('panel-details').getBoundingClientRect(), fs = document.getElementById('marine')
    const inside = [...fs.querySelectorAll('label, p, div, select, summary')].filter((e) => !e.hidden && e.getBoundingClientRect().width > 0).filter((e) => e.getBoundingClientRect().right > pn.right + 1).map((e) => e.id || e.tagName)
    const note = (id) => document.getElementById(id).textContent
    return { overflowPage: document.documentElement.scrollWidth > innerWidth, overflowPanel: document.getElementById('panel-details').scrollWidth > document.getElementById('panel-details').clientWidth + 1, inside, sel: document.getElementById('cetaceans-species').getBoundingClientRect().toJSON(), pn: pn.toJSON(), intro: fs.querySelector('legend + p').textContent, notes: { protected: note('protected-note'), srkw: note('srkw-note'), cetaceans: note('cetaceans-note') }, crims: [...fs.querySelectorAll(':scope > p.empty:not(.sub)')].map((x) => x.textContent), labels: [...fs.querySelectorAll('label > span')].map((x) => x.textContent), hiddenNotes: ['protected-note', 'srkw-note', 'cetaceans-note', 'cetaceans-controls', 'cetaceans-key'].filter((id) => document.getElementById(id).hidden) }
  })
  report(!lay.overflowPage && !lay.overflowPanel && lay.inside.length === 0 && lay.sel.height >= 40 && lay.sel.right <= lay.pn.right && lay.hiddenNotes.length === 0, t('marine panel: with all seven boxes on nothing runs past the panel or the screen, the picker is at least 40 px tall, and every note, the picker and the key are shown'), JSON.stringify({ ...lay, notes: undefined }))
  report(lay.intro === 'Protected areas, a mapped boundary, a model and an old survey. Nothing here shows where an animal is now. Not for navigation.' && lay.crims.includes('Coastal habitat comes from the Province’s Coastal Resource Information Management System (CRIMS). It is a legacy survey that began in 1979 and was only updated now and then, so it is not a current record.') && lay.labels.join('|') === 'Protected marine areas|Southern Resident killer whale critical habitat|Whale and porpoise density (model)|Kelp beds|Eelgrass|Herring spawn|Seabird colonies', t('marine panel: the intro says nothing here shows where an animal is now, the CRIMS sentence says legacy and not a current record, and the seven boxes are named plainly'), JSON.stringify(lay.labels))
  report(lay.notes.srkw.includes(WHALE_RULES_TEXT) && lay.notes.cetaceans.includes(WHALE_RULES_TEXT) && lay.notes.cetaceans.includes('A model of summer 2018 ship surveys, not where animals are now.') && lay.notes.srkw.includes('It is a boundary, not a sighting') && lay.notes.protected.includes('Not for navigation.'), t('marine panel: the notes of the critical habitat and the density model carry the vessel distances, and say boundary and model, not sighting'), JSON.stringify(lay.notes))
  if (shot) { await page.evaluate(() => document.getElementById('marine').scrollIntoView({ block: 'start' })); await shot('marine-panel'); await page.evaluate(() => document.getElementById('cetaceans-key').scrollIntoView({ block: 'center' })); await shot('marine-panel-key') }
  await panel(false)
  if (shot) await shot('marine-all-on')
  // no outside host was contacted for any of it
  const hostsUsed = [...new Set(requests.slice(baseline).map((u) => new URL(u).host))].filter((h) => !h.startsWith('127.0.0.1') && h !== 'tiles.openfreemap.org' && h !== 's3.amazonaws.com')
  report(hostsUsed.length === 0, t('marine layers: they contact no outside host (only this site, the basemap and the elevation tiles)'), hostsUsed.join(', '))
  await untickAll()

  // ---- pixels, desktop only: the colour of each cell is its class colour, and the areas leave the land alone
  if (wide) {
    await panel(false)
    const goTo = (c, z) => view(c, z)
    const samples = () => page.evaluate(() => {
      const m = window.__map, wl = m.getStyle().layers.find((l) => l.type === 'fill' && l['source-layer'] === 'water' && l.source && !/mask/.test(l.id))
      const land = [], sea = []
      for (let y = 110; y < innerHeight - 70; y += 14) for (let x = 24; x < innerWidth - 70; x += 14) {
        const near = m.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [wl.id] }).length, here = m.queryRenderedFeatures([x, y], { layers: [wl.id] }).length
        if (!near) land.push([x, y]); else if (here) sea.push([x, y])
      }
      return { land, sea }
    })
    const pixels = async (pts) => {
      const png = await page.screenshot({ timeout: 120000 })
      return page.evaluate(async ([b64, pts]) => { const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()), c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]) }, [png.toString('base64'), pts])
    }
    const diff = (a, b) => Math.max(...[0, 1, 2].map((k) => Math.abs(a[k] - b[k])))
    const settle = async (ms = 2500) => { await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 }); await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(ms) }

    // 1. the colour of a full cell in open water is its class colour at 0.75 opacity over the sea of the basemap
    await goTo([-123.3, 48.45], 8.7)
    await settle(3000)
    const centres = cells.filter((f) => f.properties.km2 > 24.9).map((f) => ({ f, c: bboxCentre(f.geometry) }))
    const proj = await page.evaluate((cs) => cs.map(([x, y]) => { const q = window.__map.project([x, y]); return [Math.round(q.x), Math.round(q.y)] }), centres.map((c) => c.c))
    const inView = centres.map((c, i) => ({ ...c, px: proj[i] })).filter((c) => c.px[0] > 30 && c.px[0] < 1280 - 80 && c.px[1] > 130 && c.px[1] < 800 - 90)
    const seaOff = await pixels(inView.map((c) => c.px))
    await tick('cetaceans', true); await waitStatus(page, 'cetaceans').catch(() => {})
    const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
    const colours = await page.evaluate(async () => (await import('/js/overlays-data.js')).DENSITY_COLOURS)
    let worst = 0, mostClasses = 0
    for (const [key, sp] of Object.entries(SPECIES)) {
      await pick(key)
      await settle(2200)
      const b = await breaksOf(key)
      const on = await pixels(inView.map((c) => c.px))
      let good = 0, tested = 0, classes = new Set()
      inView.forEach((c, i) => {
        const d = c.f.properties[`${key}_n`] / c.f.properties.km2 * 100, cls = b.filter((x) => d >= x).length
        const want = hex(colours[cls]).map((v, k) => Math.round(v * 0.75 + seaOff[i][k] * 0.25))
        tested++; classes.add(cls)
        if (diff(on[i], want) <= 8) good++
      })
      worst = Math.max(worst, tested - good)
      console.log(`      (${t(`marine cetaceans, ${sp.name}: ${good} of ${tested} cell centres in view have the colour of their class (${[...classes].sort().join(',')} classes seen)`)})`)
      mostClasses = Math.max(mostClasses, classes.size)
      report(tested >= 12 && good >= 0.9 * tested && classes.size >= 2, t(`marine cetaceans: for ${sp.name} the pixel at the middle of each full cell has the colour of its density class at 0.75 opacity over the sea (at least 90% of the cells in view, two or more classes in view)`), JSON.stringify({ tested, good, classes: [...classes] }))
    }
    report(mostClasses === 5, t('marine cetaceans: all five colours are seen on the screen for at least one species'), String(mostClasses))
    if (shot) { await pick('harbour'); await settle(2200); await shot('marine-cetaceans-harbour'); await pick('dalls'); await settle(2200); await shot('marine-cetaceans-dalls'); await pick('humpback'); await settle(1800) }
    await tick('cetaceans', false)

    // 2. the areas leave the land alone (places with no basemap water within 6 px do not change)
    const landCheck = async (id, c, z, label) => {
      await goTo(c, z); await settle(2800)
      const { land, sea } = await samples()
      const pts = [...land, ...sea]
      const off1 = await pixels(pts)
      await tick(id, true); await waitStatus(page, id).catch(() => {})
      await settle(2500)
      const on = await pixels(pts)
      await tick(id, false); await settle(2000)
      const off2 = await pixels(pts)
      const n = land.length, stable = pts.map((_, i) => diff(off1[i], off2[i]) <= 3)
      const landIdx = land.map((_, i) => i).filter((i) => stable[i]), seaIdx = sea.map((_, i) => n + i).filter((i) => stable[i])
      const landChanged = landIdx.filter((i) => diff(on[i], off1[i]) > 8).length, seaChanged = seaIdx.filter((i) => diff(on[i], off1[i]) > 8).length
      return { id, label, land: landIdx.length, landChanged, sea: seaIdx.length, seaChanged }
    }
    const results = []
    for (const [id, c, z, label] of [['cetaceans', [-123.45, 48.34], 10.2, 'Juan de Fuca and Haro Strait'], ['srkw', [-123.40, 48.42], 10.2, 'the strait off Victoria'], ['protected', [-123.35, 48.43], 11.2, 'Victoria Harbour and the Oak Bay Islands'], ['kelp', [-123.40, 48.37], 11.6, 'kelp off Victoria'], ['eelgrass', [-123.465, 48.428], 12.8, 'Esquimalt Lagoon']]) results.push(await landCheck(id, c, z, label))
    for (const x of results) console.log(`      (${t(`marine ${x.id} over ${x.label}: ${x.landChanged} of ${x.land} inland places changed, ${x.seaChanged} of ${x.sea} water places coloured`)})`)
    const big = results.filter((x) => ['cetaceans', 'srkw', 'protected'].includes(x.id))
    const shown = { cetaceans: 0.3, srkw: 0.3, protected: 0.05 } // the least share of the water places each should colour in its view
    report(big.every((x) => x.land > 150 && x.landChanged <= 0.01 * x.land && x.sea > 150 && x.seaChanged > shown[x.id] * x.sea), t('marine areas: the density cells, the critical habitat and the protected areas leave the land alone (no more than 1% of the inland places change by more than 8 of 255) and colour the water'), JSON.stringify(big))
    const small = results.filter((x) => ['kelp', 'eelgrass'].includes(x.id))
    report(small.every((x) => x.land > 100 && x.landChanged <= 0.02 * x.land && x.seaChanged > 0), t('marine kelp and eelgrass: the beds colour the water and cover under 2% of the inland places'), JSON.stringify(small))
    if (shot) {
      await goTo([-123.35, 48.42], 10.2); await tick('cetaceans', true); await tick('protected', true); await tick('srkw', true); await tick('kelp', true); await tick('herring', true); await tick('seabirds', true)
      await page.waitForTimeout(1500); await settle(3000); await shot('marine-victoria'); await untickAll()
    }
  }

  // ---- with Sea currents on, a click on the sea gives the current first and then the area
  if (wide) {
    await tick('cetaceans', true); await waitStatus(page, 'cetaceans').catch(() => {})
    await setBox(page, 'input[data-overlay=currents]', true)
    await waitStatus(page, 'currents', 90000).catch(() => {})
    await page.waitForTimeout(2500)
    await view([-123.45, 48.34], 10.2)
    const wet = await page.evaluate(async () => {
      const D = await import('/js/overlays-data.js'), m = window.__map, g = window.__overlays.sea.shown?.grid
      if (!g) return null
      for (let y = 160; y < innerHeight - 120; y += 16) for (let x = 60; x < innerWidth - 80; x += 16) {
        const ll = m.unproject([x, y])
        if (D.seaVelocity(g, ll.lng, ll.lat) && m.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: ['cetaceans-fill'] }).length) return [x, y]
      }
      return null
    })
    let pop = null
    if (wet) { await page.mouse.click(wet[0], wet[1]); await page.waitForTimeout(900); pop = await popupInfo() }
    report(!!pop && pop.titles[0] === 'Modelled sea current' && pop.titles.includes('Humpback whale: modelled summer numbers') && pop.hr >= 1, t('marine areas with Sea currents on: a click on the sea gives the modelled current first and then the density cell'), JSON.stringify(pop && { titles: pop.titles, hr: pop.hr }))
    await setBox(page, 'input[data-overlay=currents]', false)
    await untickAll()
  }

  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

const waitStatus = (page, id, timeout = 90000) => page.waitForFunction((id) => { const p = document.getElementById('status-' + id); return !!p && !p.hidden && !!p.dataset.state && p.dataset.state !== 'loading' }, id, { timeout })
const statusOf = (page, id) => page.evaluate((id) => { const p = document.getElementById('status-' + id); return { state: p.dataset.state, text: p.textContent, hidden: p.hidden } }, id)
const hostCount = (requests, host) => requests.filter((u) => new URL(u).host === host).length
const layerStates = (page, id) => page.evaluate((id) => window.__overlays.defs[id].ids.filter((l) => window.__map.getLayer(l)).map((l) => window.__map.getLayoutProperty(l, 'visibility') ?? 'visible'), id)

// The optional layers, each against its real service. Nothing is requested before its box is
// ticked, and ticking one contacts its own host and no other. While a layer is on, the map
// attribution carries its credit.
async function checkOverlays(page, requests, t, shot) {
  await page.evaluate(() => { document.querySelector('.maplibregl-popup')?.remove(); document.getElementById('panel-details').open = true })
  // Sea currents and wind were ticked earlier, in checkCurrents3d, which checked that nothing had been requested before that.
  const idle = LIVE_HOSTS.map((h) => requests.filter((u) => new URL(u).host === h && !u.includes('CIOPS-SalishSea') && !u.includes('HRDPS')).length)
  const files = requests.filter((u) => /data\/(ecoregions|industry-waste|marine-protected|srkw-habitat|whale-density|kelp|eelgrass|herring-spawn|seabird-colonies)\.geojson/.test(u)).length
  report(idle.every((n) => n === 0) && files === 0, t('nothing is requested from Environment Canada, USGS or GBIF (apart from the sea currents and wind ticked earlier), or for the ecoregion, industry and marine life and protection files, until a box is ticked'), JSON.stringify([idle, files]))
  const outcome = {}
  for (const [id, net] of Object.entries(OVERLAY_NET)) {
    const before = Object.fromEntries(LIVE_HOSTS.map((h) => [h, hostCount(requests, h)]))
    const fileBefore = requests.filter((u) => net.file && u.endsWith(net.file)).length
    if (id === 'seafloor') { await page.evaluate(() => window.__map.jumpTo({ center: [-123.40, 48.40], zoom: 10.2 })); await page.waitForTimeout(1500) } // over the Strait, where the service has tiles
    await setBox(page, `input[data-overlay=${id}]`, true)
    if (id === 'seafloor') await page.waitForTimeout(3000) // its tiles are asked for a moment after the box is ticked
    let st
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitStatus(page, id).catch(() => {})
      st = await statusOf(page, id)
      if (st.state !== 'fail') break
      await page.waitForTimeout(8000) // a service may be rate limiting. Try once more.
      await setBox(page, `input[data-overlay=${id}]`, false)
      await setBox(page, `input[data-overlay=${id}]`, true)
    }
    const after = Object.fromEntries(LIVE_HOSTS.map((h) => [h, hostCount(requests, h)]))
    const own = (net.hosts || []).every((h) => after[h] > before[h])
    const others = LIVE_HOSTS.filter((h) => !(net.hosts || []).includes(h)).every((h) => after[h] === before[h])
    const file = net.file ? requests.filter((u) => u.endsWith(net.file)).length > fileBefore : true
    await page.waitForTimeout(900)
    const attrib = await page.evaluate(() => document.querySelector('.maplibregl-ctrl-attrib').textContent)
    const vis = await layerStates(page, id)
    outcome[id] = st
    report(['ok', 'empty'].includes(st.state) && own && others && file && vis.length > 0 && vis.every((v) => v === 'visible') && attrib.includes(OVERLAY_ATTRIB[id]), t(`${id}: ticking it loads from its own service only, shows its layer, a status line (${st.state}) and its credit on the map`), JSON.stringify({ st, own, others, file, vis, hasCredit: attrib.includes(OVERLAY_ATTRIB[id]) }))
    if (id === 'seafloor') await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {}) // so that none of its tiles is still arriving when the next box is ticked
    if (id === 'currents' || id === 'wind' || id === 'seafloor') await setBox(page, `input[data-overlay=${id}]`, false) // their loops and tiles are checked on their own, below
  }
  report(outcome.ecoregions.text.includes('one ecoregion') && /18 sites/.test(outcome.industry.text), t('ecoregions and industry status lines describe what was loaded'), JSON.stringify([outcome.ecoregions.text, outcome.industry.text]))

  // radar: frames, a time label, play and pause, and a colour key fetched only when opened
  const radar = await page.evaluate(() => ({ frames: window.__overlays.radar.frames.length, time: document.getElementById('radar-time').textContent, playing: window.__overlays.radar.playing, button: document.getElementById('radar-play').textContent, layer: !!window.__map.getLayer('radar'), type: window.__map.getSource('radar')?.type, legendSrc: document.getElementById('radar-legend-img').getAttribute('src') }))
  report(radar.frames >= 2 && /^Radar, /.test(radar.time) && radar.layer && radar.type === 'image' && radar.playing && radar.button === 'Pause', t('radar: several frames, a time label, an image layer, and it plays'), JSON.stringify(radar))
  await page.click('#radar-play')
  const paused = await page.evaluate(() => ({ playing: window.__overlays.radar.playing, button: document.getElementById('radar-play').textContent, shown: window.__overlays.radar.shown }))
  await page.waitForTimeout(1500)
  const still = await page.evaluate(() => window.__overlays.radar.shown)
  report(!paused.playing && paused.button === 'Play' && still === paused.shown, t('radar: Pause stops the frames, and the button says Play'), JSON.stringify([paused, still]))
  const legendBefore = requests.filter((u) => u.includes('GetLegendGraphic')).length
  report(legendBefore === 0 && radar.legendSrc === null, t('radar: the colour key is not requested until it is opened'), String(legendBefore))
  await page.evaluate(() => { document.getElementById('radar-legend').open = true })
  await page.waitForTimeout(2500)
  report(requests.some((u) => u.includes('GetLegendGraphic')), t('radar: opening the colour key requests it'))

  // popups are built from text only, and carry each record's licence and source link
  const pop = await page.evaluate(async () => {
    const o = window.__overlays
    const life = { properties: { key: 5938027964, name: '<img src=x onerror=alert(1)>', kingdom: 'Plantae', date: '2026-06-25T10:54:16', dataset: 'iNaturalist research-grade observations', dataset_key: '50c9509d-22c7-4a22-a47d-8c48425ef4a7', licence: 'CC BY 4.0', licence_url: 'https://creativecommons.org/licenses/by/4.0/legalcode', holder: 'A. Person' } }
    const box = o.popupFor(life, 'life-dot', [life])
    const fc = await (await fetch('data/industry-waste.geojson')).json()
    const clover = fc.features.find((f) => f.properties.name === 'Clover Point Pump Station')
    const unnamed = fc.features.find((f) => !f.properties.name)
    const ind = o.popupFor({ properties: clover.properties }, 'industry-dot')
    const loc = o.popupFor({ properties: unnamed.properties }, 'industry-dot')
    return {
      lifeImg: !!box.querySelector('img'), lifeText: box.textContent, lifeLinks: [...box.querySelectorAll('a')].map((a) => a.href + ' ' + a.rel),
      ind: ind.textContent, indLinks: [...ind.querySelectorAll('a')].map((a) => a.href), loc: loc.textContent,
    }
  })
  report(!pop.lifeImg && pop.lifeText.includes('<img src=x onerror=alert(1)>') && pop.lifeText.includes('CC BY 4.0') && pop.lifeText.includes('Credit: A. Person') && pop.lifeLinks.some((l) => l.startsWith('https://www.gbif.org/occurrence/5938027964')) && pop.lifeLinks.every((l) => l.startsWith('https://') && l.includes('noopener')), t('life observation popup: text only (no markup from the record), licence, credit and source link kept, https links with rel=noopener'), JSON.stringify(pop.lifeLinks))
  report(pop.ind.includes('Treated wastewater discharged: 50,000 m3 per day') && pop.ind.includes('modelled, not counted') && pop.ind.includes('Ehalt Macedo, H.') && pop.ind.includes('CC BY 4.0') && pop.indLinks.every((l) => l.startsWith('https://')) && pop.loc.includes('No figures. This is a location only, not an empty site.') && pop.loc.includes('Open Government Licence'), t('industry popups: figures carry their basis, a site with no figures says so, and each carries its source attribution'))
  await page.evaluate(() => window.__map.jumpTo({ center: [-123.349, 48.406], zoom: 14 }))
  await page.waitForTimeout(2500)
  const vp = page.viewportSize()
  await page.mouse.click(vp.width / 2, vp.height / 2)
  await page.waitForTimeout(800)
  const clicked = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText || null)
  report(!!clicked && clicked.includes('Clover Point Pump Station') && clicked.includes('wastewater'), t('a click on an industry site opens its popup'), String(clicked).slice(0, 100))
  if (shot) await shot('overlays-on')
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())

  // untick everything: layers hide, status lines hide, the credits leave the map
  for (const id of Object.keys(OVERLAY_NET)) await setBox(page, `input[data-overlay=${id}]`, false)
  await page.waitForTimeout(1500)
  const off = await page.evaluate(() => ({ attrib: document.querySelector('.maplibregl-ctrl-attrib').textContent, shown: [...document.querySelectorAll('[id^=status-]')].filter((p) => !p.hidden).length, radarControls: !document.getElementById('radar-controls').hidden, playing: window.__overlays.radar.playing }))
  const hidden = []
  for (const id of Object.keys(OVERLAY_NET)) hidden.push(...(await layerStates(page, id)))
  report(hidden.every((v) => v === 'none') && off.shown === 0 && !off.radarControls && !off.attrib.includes('Data Server End-use Licence') && !off.attrib.includes('GBIF') && !off.attrib.includes('HydroWASTE'), t('unticking every new layer hides it, its status line and its credit'), JSON.stringify({ ...off, attrib: off.attrib.slice(0, 120), hidden: [...new Set(hidden)] }))
}

// With every outside service blocked: ticking a live layer makes its own request and then shows a
// plain failure line, nothing else breaks, and an alert from a service is shown unchanged.
async function checkOverlaysBlocked(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const requests = [], errors = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))
  for (const h of LIVE_HOSTS) await page.route(`https://${h}/**`, (r) => r.abort())
  await page.goto(base + '/index.html?test', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready, null, { timeout: 180000 })
  // 3D terrain is on at load, so the map tilts to 60 degrees at once. A busy machine draws a frame in a second or more, so wait for it to end.
  await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1 && !window.__map.isMoving(), null, { timeout: 150000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  const t = (s) => `hosts blocked: ${s}`
  for (const id of ['radar', 'currents', 'wind', 'temperature', 'salinity', 'alerts', 'aqhi', 'conditions', 'water', 'quakes', 'life']) {
    const before = Object.fromEntries(LIVE_HOSTS.map((h) => [h, hostCount(requests, h)]))
    await setBox(page, `input[data-overlay=${id}]`, true)
    await waitStatus(page, id, 60000).catch(() => {})
    const st = await statusOf(page, id)
    const own = OVERLAY_NET[id].hosts.every((h) => hostCount(requests, h) > before[h])
    const others = LIVE_HOSTS.filter((h) => !OVERLAY_NET[id].hosts.includes(h)).every((h) => hostCount(requests, h) === before[h])
    const empty = await page.evaluate((id) => { const src = window.__overlays.defs[id].source; return src ? window.__map.querySourceFeatures(src).length === 0 : true }, id)
    // The layers from Environment Canada's GeoMet server (every one here but the alerts, the air quality, the conditions, the gauges, the quakes and the life observations) are asked for twice
    // and say the server is not answering.
    const geomet = ['radar', 'currents', 'wind', 'temperature', 'salinity'].includes(id)
    const wording = id === 'alerts' ? st.text.includes('not showing whether any are in effect') : st.text.includes('could not be loaded') && (!geomet || st.text.includes('Environment Canada’s server is not answering.'))
    const tries = hostCount(requests, 'geo.weather.gc.ca') - before['geo.weather.gc.ca']
    report(st.state === 'fail' && !st.hidden && wording && own && others && empty && (!geomet || tries >= 2), t(`${id}: its own request is made${geomet ? ' (and made once more)' : ''}, then a plain failure line shows${geomet ? ' that says the server is not answering' : ''} and the layer stays empty`), JSON.stringify({ st, own, others, empty, tries }))
    if (id === 'currents' || id === 'wind') {
      const sea = await page.evaluate((id) => ({ canvas: !!document.getElementById('flow-canvas'), play: document.getElementById(id + '-play').disabled, stats: window.__overlays.flow.stats() }), id)
      report(!sea.canvas && sea.play && !sea.stats.on && !sea.stats.running && sea.stats.particles === 0, t(`${id}: after the failure no canvas is on the map, Play is disabled and nothing runs`), JSON.stringify(sea))
    }
  }
  // Tides: ticking asks NOAA nothing and shows the stations. A click on a station asks, and with NOAA blocked the popup says so plainly.
  const noaaBefore = hostCount(requests, 'api.tidesandcurrents.noaa.gov')
  await setBox(page, 'input[data-overlay=tides]', true)
  await waitStatus(page, 'tides', 30000).catch(() => {})
  const stT = await statusOf(page, 'tides')
  report(stT.state === 'ok' && hostCount(requests, 'api.tidesandcurrents.noaa.gov') === noaaBefore, t('tides: ticking the box shows the stations and asks NOAA nothing, even when NOAA cannot be reached'), JSON.stringify(stT))
  await page.evaluate(() => { document.getElementById('panel-details').open = false; window.__map.jumpTo({ center: [-123.5323, 48.2232], zoom: 10.5 }) })
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 20000 })
  await page.waitForTimeout(2500)
  await page.mouse.click(640, 400)
  await page.waitForFunction(() => /could not be loaded/.test(document.querySelector('.maplibregl-popup-content')?.textContent || ''), null, { timeout: 30000 }).catch(() => {})
  const failed = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText.replace(/\n+/g, ' | ') || null)
  report(!!failed && failed.includes('Race Rocks') && failed.includes('Predictions for this station could not be loaded just now. Try again later.') && failed.includes('not for navigation') && hostCount(requests, 'api.tidesandcurrents.noaa.gov') > noaaBefore && !failed.includes('Asking NOAA'), t('tides: a click on a station asks NOAA, and with NOAA blocked the popup says plainly that the predictions could not be loaded'), JSON.stringify(failed))
  // The Victoria Harbour gauge with the Canadian Hydrographic Service blocked: its click asks, and the popup says plainly that the levels could not be loaded, and still carries the notice
  const iwlsBefore = hostCount(requests, IWLS_HOST)
  const notices = await page.evaluate(async () => { const m = await import('/js/overlays-data.js'); return { iwls: m.IWLS_NOTICE, nonna: m.NONNA_NOTICE } })
  await page.evaluate(() => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: [-123.370828, 48.424363], zoom: 11 }) })
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 90000 }) // 3D terrain is on here, and one frame can take seconds on a busy machine
  await page.waitForTimeout(2500)
  const gaugeAt = await page.evaluate(() => { const q = window.__map.project([-123.370828, 48.424363]); return { x: Math.round(q.x), y: Math.round(q.y) } })
  await page.waitForFunction(([x, y]) => window.__map.queryRenderedFeatures([[x - 8, y - 8], [x + 8, y + 8]], { layers: ['tides-dot'] }).length > 0, [gaugeAt.x, gaugeAt.y], { timeout: 20000 }).catch(() => {})
  await page.mouse.click(gaugeAt.x, gaugeAt.y)
  await page.waitForFunction(() => /could not be loaded/.test(document.querySelector('.maplibregl-popup-content')?.textContent || ''), null, { timeout: 30000 }).catch(() => {})
  const failedGauge = await page.evaluate(() => document.querySelector('.maplibregl-popup-content')?.innerText.replace(/\s+/g, ' ') || null)
  const gaugeReqs = hostCount(requests, IWLS_HOST) - iwlsBefore
  report(!!failedGauge && failedGauge.includes('Victoria Harbour') && failedGauge.includes('The Canadian Hydrographic Service’s levels for this station could not be loaded just now. Try again later.') && failedGauge.includes('Not for navigation. Source: Canadian Hydrographic Service.') && failedGauge.includes(notices.iwls) && !failedGauge.includes('Asking') && gaugeReqs >= 1 && gaugeReqs <= 3, t('gauge: a click on Victoria Harbour asks the Canadian Hydrographic Service, and with it blocked the popup says plainly that the levels could not be loaded and still carries the licence notice and not for navigation'), JSON.stringify({ failedGauge: failedGauge?.slice(0, 160), gaugeReqs }))
  await page.evaluate(() => document.querySelector('.maplibregl-popup')?.remove())
  // Seafloor depth with the Canadian Hydrographic Service blocked: the ETOPO1 colours still show under it, and the status line says plainly what is missing.
  // The tide stations are put away first: their labels are placed again among the basemap's whenever a layer is switched, which moves a few pixels of text.
  await setBox(page, 'input[data-overlay=tides]', false)
  await setBox(page, '#terrain3d', false)
  await page.waitForFunction(() => window.__map.getPitch() < 0.5 && !window.__map.getTerrain(), null, { timeout: 90000 })
  await page.evaluate(() => { document.getElementById('panel-details').open = true; window.__map.jumpTo({ center: [-123.40, 48.40], zoom: 9.6, pitch: 0, bearing: 0 }) })
  await page.waitForTimeout(3000)
  await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)
  await page.evaluate(() => { document.getElementById('panel-details').open = false })
  await page.waitForTimeout(500)
  const floorSamples = await seaSamples(page), floorPts = [...floorSamples.land, ...floorSamples.sea]
  const floorOff1 = await pagePixels(page, floorPts)
  const nonnaBefore = hostCount(requests, NONNA_HOST)
  await setBox(page, 'input[data-overlay=seafloor]', true)
  await page.waitForFunction(() => document.getElementById('status-seafloor').dataset.state === 'fail', null, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(3000)
  const floorStatus = await statusOf(page, 'seafloor')
  const floorOn = await pagePixels(page, floorPts)
  await page.waitForTimeout(1500)
  const floorOn2 = await pagePixels(page, floorPts) // a place counts as changed only if it differs from the layer-off picture in both pictures taken with the layer on
  const floorVis = await layerStates(page, 'seafloor')
  await setBox(page, 'input[data-overlay=seafloor]', false)
  await page.waitForTimeout(2500)
  const floorOff2 = await pagePixels(page, floorPts)
  const fn = floorSamples.land.length, fStable = floorPts.map((_, i) => colourDiff(floorOff1[i], floorOff2[i]) <= 3)
  const fSea = floorSamples.sea.map((_, i) => fn + i).filter((i) => fStable[i]), fLand = floorSamples.land.map((_, i) => i).filter((i) => fStable[i])
  const fChanged = fSea.filter((i) => colourDiff(floorOn[i], floorOff1[i]) > 12 && lum(floorOn[i]) < lum(floorOff1[i]) && floorOn[i][2] >= floorOn[i][0]).length
  // Between runs on 2026-10-22, 0 to 6 of about 1,090 inland places came out different (0 in some runs), so this allows the 1% that the
  // marine layers' check allows. A tint on the land would move far more of them.
  const fLandBad = fLand.filter((i) => colourDiff(floorOn[i], floorOff1[i]) > 8 && colourDiff(floorOn2[i], floorOff1[i]) > 8), fLandChanged = fLandBad.length
  console.log(`      (${t(`seafloor: ${fChanged} of ${fSea.length} water places coloured by ETOPO1 alone, ${fLandChanged} of ${fLand.length} inland places changed, ${hostCount(requests, NONNA_HOST) - nonnaBefore} tile requests refused`)})`)
  report(floorStatus.state === 'fail' && !floorStatus.hidden && floorStatus.text === 'The Canadian Hydrographic Service’s depths could not be loaded just now, so the coarser ETOPO1 depths from NOAA are shown. Try again later.' && hostCount(requests, NONNA_HOST) > nonnaBefore && floorVis.every((v) => v === 'visible') && fSea.length > 40 && fChanged > 0.4 * fSea.length && fLand.length > 40 && fLandChanged <= 0.01 * fLand.length, t('seafloor: with the Canadian Hydrographic Service blocked, its tiles are asked for, the status line says plainly that its depths could not be loaded and that the coarser ETOPO1 depths are shown, and the sea is still coloured by ETOPO1 (darker and bluer) with the land left alone (no more than 1% of the inland places change)'), JSON.stringify({ floorStatus, fChanged, sea: fSea.length, fLandChanged, land: fLand.length, places: fLandBad.slice(0, 6).map((i) => [floorPts[i], floorOff1[i], floorOn[i]]) }))
  report(errors.length === 0, t('no page errors from the failed requests'), errors.join(' | '))
  // an alert is passed on exactly as the service issued it
  const text = 'WIND WARNING IN EFFECT\n\nSouthwest winds 70 km/h gusting to 90.\n\nThis is a test text. It must not be reworded.'
  const fixture = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'test-1', geometry: { type: 'Polygon', coordinates: [[[-123.6, 48.35], [-123.25, 48.35], [-123.25, 48.6], [-123.6, 48.6], [-123.6, 48.35]]] }, properties: { alert_short_name_en: 'orange warning - wind', feature_name_en: 'Greater Victoria', alert_text_en: text, risk_colour_en: 'orange', publication_datetime: new Date(Date.now() - 3600000).toISOString(), expiration_datetime: new Date(Date.now() + 3600000).toISOString() } }] }
  await page.route('https://api.weather.gc.ca/collections/weather-alerts/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixture) }))
  await setBox(page, 'input[data-overlay=alerts]', false)
  await setBox(page, 'input[data-overlay=alerts]', true)
  await waitStatus(page, 'alerts', 30000).catch(() => {})
  await page.evaluate(() => document.querySelector('#alerts-list details')?.setAttribute('open', ''))
  const shown = await page.evaluate(() => ({ state: document.getElementById('status-alerts').dataset.state, text: document.querySelector('#alerts-list .alert-text')?.textContent, title: document.querySelector('#alerts-list summary')?.textContent, count: window.__map.getSource('ov-alerts') ? window.__map.querySourceFeatures('ov-alerts').length : 0 }))
  report(shown.state === 'ok' && shown.text === text && shown.title.includes('orange warning') && shown.count > 0, t('an alert is shown word for word as issued, with its area drawn on the map'), JSON.stringify(shown))
  // the static layers need no outside service
  for (const id of ['ecoregions', 'industry', 'protected', 'srkw', 'cetaceans', 'kelp', 'eelgrass', 'herring', 'seabirds']) {
    await setBox(page, `input[data-overlay=${id}]`, true)
    await waitStatus(page, id, 30000).catch(() => {})
    const st = await statusOf(page, id)
    report(st.state === 'ok', t(`${id} loads from this site while the outside services are blocked`), JSON.stringify(st))
  }
  await ctx.close()
}

// The GeoMet server is slow or fails now and then. A stand-in answers some requests for Sea currents: one 503 and then a reply, a reply held for 7 s,
// a server that always sends 503 or never answers, and a box unticked between the two tries. The replies are the real service's, read once at the start
// and played back at once, so the checks do not depend on how slow the real server is on the day (it took 8 s to describe its hours on a busy afternoon).
async function checkGeomet(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, userAgent: userAgent(browser) })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))
  const t = (s) => `geomet: ${s}`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const CORS = { 'access-control-allow-origin': '*' }
  const counts = { caps: 0, grid: 0 }
  const played = new Map() // url -> the real reply, kept the first time it is asked for
  let plan = () => 'real' // what to do with a request: 'real', '503', 'abort' or 'hold'
  await page.route('https://geo.weather.gc.ca/**', async (route) => {
    const u = route.request().url(), caps = u.includes('GetCapabilities') && u.includes('SeaWaterVelocity'), grid = u.includes('service=WCS') && u.includes('SeaWaterVelocity')
    if (!caps && !grid) { await route.continue(); return }
    const n = ++counts[caps ? 'caps' : 'grid'], what = plan(caps ? 'caps' : 'grid', n)
    if (what === '503') await route.fulfill({ status: 503, headers: CORS, body: 'busy' })
    else if (what === 'abort') await route.abort()
    else {
      if (what === 'hold') await sleep(7000)
      if (!played.has(u)) { const real = await route.fetch(); played.set(u, { status: real.status(), headers: real.headers(), body: await real.body() }) }
      await route.fulfill(played.get(u))
    }
  })
  await page.goto(base + '/index.html?test', { waitUntil: 'load' })
  await page.waitForFunction(() => window.__ready, null, { timeout: 180000 })
  await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1 && !window.__map.isMoving(), null, { timeout: 150000 }).catch(() => {})
  await page.evaluate(() => {
    document.getElementById('panel-details').open = true
    const b = document.getElementById('flow'); b.checked = false; b.dispatchEvent(new Event('change'))
    window.__lines = []
    new MutationObserver(() => { const p = document.getElementById('status-currents'); window.__lines.push(`${p.dataset.state}|${p.textContent}`) }).observe(document.getElementById('status-currents'), { childList: true, subtree: true, characterData: true, attributes: true })
  })
  const run = async (how, until = 'done') => {
    counts.caps = 0; counts.grid = 0; plan = how
    await page.evaluate(() => { window.__lines.length = 0 })
    await setBox(page, 'input[data-overlay=currents]', true)
    if (until === 'done') await waitStatus(page, 'currents', 120000).catch(() => {})
    return { st: await statusOf(page, 'currents'), lines: await page.evaluate(() => [...window.__lines]), caps: counts.caps, grid: counts.grid }
  }
  const SLOW = 'Environment Canada’s server is slow to answer. Loading sea currents…', RETRY = 'Environment Canada’s server did not answer. Trying once more. Loading sea currents…'
  // Read the real replies once: the description of the hours and the two components of the first hour.
  const primed = await run(() => 'real')
  report(primed.st.state === 'ok' && played.size >= 3, t('currents: the real service describes its hours and gives the first hour, to be played back for the checks below'), JSON.stringify({ st: primed.st, kept: played.size }))
  await setBox(page, 'input[data-overlay=currents]', false)

  // One 503 on the description of the hours, then the real reply: the line says it is trying once more, and the layer loads.
  const a = await run((kind, n) => (kind === 'caps' && n === 1 ? '503' : 'real'))
  report(a.st.state === 'ok' && a.caps === 2 && a.grid === 2 && a.lines.some((l) => l === `loading|${RETRY}`), t('currents: a first try answered with HTTP 503 is tried once more after a short wait, the status line says so while it waits, and the layer then loads with its usual line'), JSON.stringify({ st: a.st, caps: a.caps, grid: a.grid, lines: a.lines.slice(0, 6) }))
  await setBox(page, 'input[data-overlay=currents]', false)

  // A reply held for 7 s: after 6 s the line says the server is slow, the request is not asked again, and the layer loads.
  const b = await run((kind, n) => (kind === 'grid' && n === 1 ? 'hold' : 'real'))
  report(b.st.state === 'ok' && b.grid === 2 && b.caps === 1 && b.lines.some((l) => l === `loading|${SLOW}`) && !b.lines.some((l) => l.includes('Trying once more')), t('currents: a reply held for 7 s makes the status line say the server is slow, is not asked for twice, and the layer loads'), JSON.stringify({ st: b.st, caps: b.caps, grid: b.grid, lines: b.lines.slice(0, 6) }))
  await setBox(page, 'input[data-overlay=currents]', false)

  // Always 503: two tries and a plain failure line that says the server sent an error. Never answering: two tries and the line says it is not answering.
  const c = await run(() => '503')
  report(c.st.state === 'fail' && c.caps === 2 && c.st.text === 'Sea currents could not be loaded just now. Environment Canada’s server sent an error. Try again later.', t('currents: a server that always answers 503 is asked twice, then the failure line says the server sent an error'), JSON.stringify({ st: c.st, caps: c.caps }))
  await setBox(page, 'input[data-overlay=currents]', false)
  const d = await run(() => 'abort')
  report(d.st.state === 'fail' && d.caps === 2 && d.st.text === 'Sea currents could not be loaded just now. Environment Canada’s server is not answering. Try again later.', t('currents: a server that never answers is asked twice, then the failure line says it is not answering'), JSON.stringify({ st: d.st, caps: d.caps }))
  const none = await page.evaluate(() => ({ canvas: !!document.getElementById('flow-canvas'), play: document.getElementById('currents-play').disabled, on: window.__overlays.flow.stats().on }))
  report(!none.canvas && none.play && !none.on, t('currents: after the failure no canvas is on the map and Play is disabled'), JSON.stringify(none))
  await setBox(page, 'input[data-overlay=currents]', false)

  // Unticked between the two tries: the second try is never made, and the status line goes away.
  // The page unticks the box in the same instant the line says "Trying once more", which is at the start of the wait, long before the second try.
  await page.evaluate(() => {
    new MutationObserver(() => {
      const p = document.getElementById('status-currents'), b = document.querySelector('input[data-overlay=currents]')
      if (window.__untickOnRetry && p.textContent.includes('Trying once more') && b.checked) { b.checked = false; b.dispatchEvent(new Event('change')) }
    }).observe(document.getElementById('status-currents'), { childList: true, subtree: true, characterData: true })
    window.__untickOnRetry = true
  })
  const e = await run((kind, n) => (n === 1 ? '503' : 'real'), 'tick')
  await sleep(5000)
  const shown = await page.evaluate(() => !document.getElementById('status-currents').hidden)
  report(counts.caps === 1 && counts.grid === 0 && !shown, t('currents: a box unticked while the second try waits makes no second request and leaves no status line'), JSON.stringify({ caps: counts.caps, grid: counts.grid, shown, lines: e.lines.slice(0, 3) }))
  report(errors.length === 0, t('no page errors from the failed and slow requests'), errors.join(' | '))
  await ctx.close()
}

// Play blends the flow from one hour to the next, so it changes smoothly. Sea currents on the flat map with Play running: the blend factor is sampled
// every moment, together with the flow the particles feel at a lattice of places, and the flow at a place has to move in a straight line with the factor.
async function checkBlend(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z }); document.getElementById('panel-details').open = false }, [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await setBox(page, '#flow', false)
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await page.waitForFunction(() => !window.__map.isMoving(), null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  await waitDrawn(page)
  // The places: a lattice over the screen where the flow is, found while the hour stands still.
  const points = await page.evaluate(() => {
    const f = window.__overlays.flow, out = []
    for (let y = 120; y < innerHeight - 80; y += 40) for (let x = 40; x < innerWidth - 80; x += 40) { const v = f.probe(x, y); if (v && v[2] > 0.05) out.push([x, y]) }
    return out
  })
  const still = await page.evaluate(() => window.__overlays.flow.stats())
  report(points.length >= 20 && !still.blending && still.blend === 0, t(`currents: before Play the hour stands still (no blend) and the lattice finds ${points.length} places with flow`), JSON.stringify({ points: points.length, still: [still.blending, still.blend] }))
  await page.evaluate(() => document.getElementById('currents-play').click())
  // Sampled until four hours have gone by (the first one is cut short), or half a minute: a busy machine takes a while to step.
  const samples = [], t0 = Date.now()
  while (Date.now() - t0 < 30000 && new Set(samples.map((x) => x.at)).size < 5) {
    samples.push(await page.evaluate((pts) => { const f = window.__overlays.flow, st = f.stats(); return { at: window.__overlays.sea.at, f: st.blend, blending: st.blending, v: pts.map(([x, y]) => f.probe(x, y)) } }, points))
    await page.waitForTimeout(60)
  }
  await page.evaluate(() => document.getElementById('currents-play').click()) // pause
  await page.waitForTimeout(500)
  const paused = await page.evaluate(() => ({ stats: window.__overlays.flow.stats(), hour: window.__overlays.sea.at }))
  // Cycles: the samples of one hour shown, in order. A cycle counts when it has samples across most of the way.
  const cycles = []
  for (const sm of samples) { const last = cycles.at(-1); if (last && last[0].at === sm.at) last.push(sm); else cycles.push([sm]) }
  const blended = cycles.map((c) => c.filter((x) => x.blending)) // the samples taken while a blend was running
  const usable = blended.filter((c) => c.length >= 3 && c.at(-1).f - c[0].f > 0.3)
  const rises = usable.every((c) => c.every((x, i) => i === 0 || x.f >= c[i - 1].f - 1e-9))
  console.log(`      (${t(`currents: ${samples.length} samples over ${cycles.length} hours, ${usable.length} of them sampled across the blend; the factor ran ${usable.map((c) => `${c[0].f.toFixed(2)} to ${c.at(-1).f.toFixed(2)}`).join(', ')}`)})`)
  report(usable.length >= 2 && rises && usable.every((c) => c[0].f < 0.45 && c.at(-1).f > 0.55), t('currents: while Play runs the blend factor rises from the start of each hour toward the next, hour after hour'), JSON.stringify(cycles.map((c) => [c[0].at, c.length, +c[0].f.toFixed(2), +c.at(-1).f.toFixed(2)])))
  // The flow at a place against the factor. Along a cycle, the flow at a place is (1 - f) of one hour plus f of the next, so for a place whose flow differs between the hours it is a
  // straight line in f. The places that differ most are tested: each sample must lie on the line through the first and last of its cycle, within a tenth of the way along it.
  const delta = (c, k) => { const a = c[0].v[k], b = c.at(-1).v[k]; return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1e-9, c.at(-1).f - c[0].f) : 0 }
  const best = points.map((_, k) => ({ k, d: Math.max(0, ...usable.map((c) => delta(c, k))) })).sort((a, b) => b.d - a.d).slice(0, 6)
  const off = best.map(({ k }) => Math.max(0, ...usable.flatMap((c) => { const a = c[0], b = c.at(-1), full = Math.max(1e-9, delta(c, k)); return c.slice(1, -1).map((x) => { const w = (x.f - a.f) / (b.f - a.f), want = [a.v[k][0] + w * (b.v[k][0] - a.v[k][0]), a.v[k][1] + w * (b.v[k][1] - a.v[k][1])]; return Math.hypot(x.v[k][0] - want[0], x.v[k][1] - want[1]) / (full * (b.f - a.f)) }) })))
  console.log(`      (${t(`currents: the six places where the flow changes most change by ${best.map((b) => b.d.toFixed(1)).join(', ')} px a second between two hours, and lie off the straight line by at most ${(Math.max(...off) * 100).toFixed(1)}% of that`)})`)
  report(best.length === 6 && best[0].d > 3 && best[5].d > 0.5 && off.every((o) => o < 0.1), t('currents: the flow at the places that change most between two hours moves in a straight line with the blend factor, a little at a time and not in one jump (and it does change, by several pixels a second)'), JSON.stringify({ best, off }))
  report(!paused.stats.blending && paused.stats.blend === 0, t('currents: Pause goes back to the hour named in the status line, with no blend left'), JSON.stringify([paused.stats.blending, paused.stats.blend, paused.hour]))
  if (shot) await shot('currents-blend')
  await setBox(page, 'input[data-overlay=currents]', false)
  await setBox(page, '#flow', true)
  await page.evaluate((o) => { document.getElementById('panel-details').open = o }, panelWas)
}

// The Night look: a dark basemap and light labels by darkening the colours of the style that is loaded, light trails for the currents and the wind,
// and everything put back when it is switched off.
const cssRgb = (c) => { const m = String(c).match(/[\d.]+/g); if (String(c).startsWith('#')) { const h = c.slice(1), f = h.length === 3 ? h.split('').map((x) => x + x) : h.match(/../g); return f.map((x) => parseInt(x, 16)) } return m.slice(0, 3).map(Number) }
const relLum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
const contrastOf = (a, b) => { const [hi, lo] = [relLum(cssRgb(a)), relLum(cssRgb(b))].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
async function checkNight(page, requests, t, name, shot) {
  const panelWas = await page.evaluate(() => document.getElementById('panel-details').open)
  const panel = (open) => page.evaluate((o) => { document.getElementById('panel-details').open = o }, open)
  await page.evaluate(([c, z]) => { document.querySelector('.maplibregl-popup')?.remove(); window.__map.jumpTo({ center: c, zoom: z }) }, [READOUT_VIEW.center, READOUT_VIEW.zoom])
  await panel(true)
  await setBox(page, '#flow', false)
  const look = () => page.evaluate(() => {
    const m = window.__map, get = (id, p) => (m.getLayer(id) ? m.getPaintProperty(id, p) : null)
    return { ground: get('background', 'background-color'), water: get('water', 'fill-color'), becMask: get('bec-sea-mask', 'fill-color'), ecoMask: get('ecoregions-sea-mask', 'fill-color'), road: get('highway_minor', 'line-color'),
      text: get('label_city', 'text-color'), halo: get('label_city', 'text-halo-color'), pageText: get('muni-label', 'text-color'), pageHalo: get('muni-label', 'text-halo-color'), lakes: get('lakes', 'fill-color'), shade: get('hillshade', 'hillshade-highlight-color'),
      scalar: m.getLayer('sea-scalar') ? m.getPaintProperty('sea-scalar', 'raster-opacity') : null, layers: m.getStyle().layers.map((l) => l.id).join(), box: document.getElementById('night').checked, flowNight: window.__overlays.flow.stats().night }
  })
  const day = await look()
  report(!day.box && !day.flowNight && cssRgb(day.water).join() === '194,200,202' && cssRgb(day.ground).join() === '242,243,240', t('night: the Night look is off when the page opens (the box is unticked and the basemap is the pale one)'), JSON.stringify(day))
  const before = requests.length
  await setBox(page, '#night', true)
  await page.waitForTimeout(1500)
  const dark = await look()
  const ground = cssRgb(dark.ground), seaRgb = cssRgb(dark.water)
  report(relLum(ground) < 0.03 && relLum(seaRgb) < 0.03 && relLum(seaRgb) < relLum(ground) && dark.becMask === dark.water && dark.ecoMask === dark.water, t('night: the ground and the sea of the basemap are dark (the sea darker), and the masks that redraw the sea over the ecosystem zones and ecoregions are the same dark sea'), JSON.stringify(dark))
  report(contrastOf(dark.text, dark.ground) >= 7 && contrastOf(dark.pageText, dark.ground) >= 4.5 && relLum(cssRgb(dark.halo)) < relLum(ground) * 1.5 && relLum(cssRgb(dark.pageHalo)) < relLum(ground) * 1.5 && relLum(cssRgb(dark.lakes)) < 0.15 && relLum(cssRgb(dark.shade)) < 0.2, t('night: the labels are light on dark halos (the basemap\'s place names 7 to 1 or better against the ground, the page\'s own names 4.5 to 1), and the lakes and the hillshade are not bright patches'), JSON.stringify({ text: contrastOf(dark.text, dark.ground), page: contrastOf(dark.pageText, dark.ground) }))
  // The road shields are left as they are (their text is black on a white picture), so a text layer with a picture and no text colour is not counted.
  const labels = await page.evaluate(() => { const m = window.__map; return m.getStyle().layers.filter((l) => l.type === 'symbol' && l.layout?.['text-field'] && !(l.layout['icon-image'] && !(l.paint && 'text-color' in l.paint))).map((l) => ({ id: l.id, text: m.getPaintProperty(l.id, 'text-color'), halo: m.getPaintProperty(l.id, 'text-halo-color') })) })
  const lamps = labels.filter((l) => !l.text || contrastOf(l.text, dark.ground) < 4.5)
  report(labels.length >= 10 && lamps.length === 0, t(`night: every one of the ${labels.length} text layers, the basemap's and the page's, has a text colour that reads on the dark ground (4.5 to 1 or better)`), JSON.stringify(lamps))
  report(dark.layers === day.layers, t('night: no layer is added or taken away by the switch'))
  const asked = requests.slice(before).filter((u) => LIVE_HOSTS.includes(new URL(u).host) || /\/styles\//.test(u))
  report(asked.length === 0, t('night: switching it on asks no service for anything (the basemap is darkened where it is, and its style is not fetched again)'), asked.join(' '))
  if (shot) await shot('night-flat')

  // The trails of the currents and the wind are pale, and readable on the dark sea.
  for (const id of ['currents', 'wind']) {
    await setBox(page, `input[data-overlay=${id}]`, true)
    await waitStatus(page, id).catch(() => {})
    await panel(false)
    await page.waitForTimeout(2000)
    await waitDrawn(page)
    const st = await currentsStats(page), con = await canvasContrast(page, seaRgb)
    report(st.running && st.night && st.drawn > 300 && !!con && con.n > 100 && con.median >= 5 && con.p10 >= 3.5, t(`night: the ${id} ${id === 'currents' ? 'are' : 'is'} drawn as pale trails on the dark sea (the pixels drawn at half opacity or more have a median contrast of 5 to 1 or better against the sea, and nearly all 3.5 or better, the trails being faded and thin)`), JSON.stringify({ st: { running: st.running, night: st.night, drawn: st.drawn }, con }))
    if (shot) await shot(`night-${id}`)
    await panel(true)
    await setBox(page, `input[data-overlay=${id}]`, false)
  }

  // The temperature picture takes more paint on the dark sea, with the currents' trails over it.
  await setBox(page, 'input[data-overlay=temperature]', true)
  await waitStatus(page, 'temperature').catch(() => {})
  await page.waitForFunction(() => !!window.__overlays.scalar.shown, null, { timeout: 30000 }).catch(() => {})
  const withScalar = await look()
  report(withScalar.scalar > 0.7 && withScalar.scalar <= 0.9, t('night: the sea temperature picture is drawn with more opacity over the dark sea (0.8) than over the pale one (0.65)'), String(withScalar.scalar))
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await panel(false)
  await page.waitForTimeout(2000)
  await waitDrawn(page)
  if (shot) await shot('night-temperature')
  await panel(true)
  await setBox(page, 'input[data-overlay=currents]', false)
  await setBox(page, 'input[data-overlay=temperature]', false)

  // Seafloor depth: the CHS tiles carry the colour of the water, so they are asked for again and painted on the dark water, in the same place in the stack.
  await page.evaluate(() => { window.__map.jumpTo({ center: [-123.40, 48.40], zoom: 10.2 }) })
  await page.waitForTimeout(1500)
  await setBox(page, 'input[data-overlay=seafloor]', true)
  await page.waitForTimeout(3500)
  await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 90000 }).catch(() => {})
  const orderOf = () => page.evaluate(() => { const ids = window.__map.getStyle().layers.map((l) => l.id); return { nonna: ids.indexOf('seafloor-nonna'), nonna10: ids.indexOf('seafloor-nonna-10'), etopo: ids.indexOf('seafloor'), eco: ids.indexOf('ecoregions-fill'), watersheds: ids.indexOf('watersheds-fill'), vis: window.__map.getLayoutProperty('seafloor-nonna', 'visibility') } })
  const o1 = await orderOf(), tilesBefore = hostCount(requests, NONNA_HOST)
  await setBox(page, '#night', false)
  await setBox(page, '#night', true)
  await page.waitForTimeout(3500)
  await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 90000 }).catch(() => {})
  const o2 = await orderOf()
  report(JSON.stringify(o1) === JSON.stringify(o2) && o2.vis === 'visible' && o2.etopo < o2.nonna && o2.nonna < o2.nonna10 && o2.nonna10 < o2.eco && o2.nonna10 < o2.watersheds && hostCount(requests, NONNA_HOST) > tilesBefore, t('night: with Seafloor depth on, switching the look asks the Canadian Hydrographic Service for its tiles again and keeps them in their place in the stack, under the ecoregions and above the ETOPO1 colours'), JSON.stringify({ o1, o2, again: hostCount(requests, NONNA_HOST) - tilesBefore }))
  const samples = await seaSamples(page), sea = samples.sea.slice(0, 600)
  await panel(false)
  await page.waitForTimeout(500)
  const nightPix = await pagePixels(page, sea)
  await setBox(page, '#night', false)
  await page.waitForTimeout(3500)
  await page.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 90000 }).catch(() => {})
  const dayPix = await pagePixels(page, sea)
  const darker = sea.filter((_, i) => lum(nightPix[i]) < lum(dayPix[i]) - 30).length
  console.log(`      (${t(`night: ${darker} of ${sea.length} water places are darker at night with Seafloor depth on`)})`)
  report(sea.length > 80 && darker > 0.8 * sea.length, t('night: with Seafloor depth on, the sea is darker in the Night look than in the day look at nearly every water place (the tiles were painted again on the dark water, not left pale)'), `${darker} of ${sea.length}`)
  await panel(true)
  await setBox(page, 'input[data-overlay=seafloor]', false)
  await page.waitForTimeout(800)

  // 3D terrain gets a dark sky at night, and the pale one by day.
  if (name === 'desktop') {
    await setBox(page, '#night', true)
    await setBox(page, '#terrain3d', true)
    await page.waitForFunction(() => Math.abs(window.__map.getPitch() - 60) < 1 && !window.__map.isMoving(), null, { timeout: 150000 })
    const skyNight = await page.evaluate(() => window.__map.getSky()['sky-color'])
    await setBox(page, '#night', false)
    const skyDay = await page.evaluate(() => window.__map.getSky()['sky-color'])
    report(relLum(cssRgb(skyNight)) < 0.03 && relLum(cssRgb(skyDay)) > 0.2, t('night: the sky of the 3D view is dark in the Night look and pale by day, and follows the box while 3D terrain is on'), JSON.stringify([skyNight, skyDay]))
    await setBox(page, '#terrain3d', false)
    await page.waitForFunction(() => window.__map.getPitch() < 0.5 && !window.__map.getTerrain(), null, { timeout: 120000 })
    await setBox(page, '#night', true)
  }

  // Back to day: everything is put back exactly, the particles are dark again, and the box and the flow agree.
  await setBox(page, 'input[data-overlay=currents]', true)
  await waitStatus(page, 'currents').catch(() => {})
  await setBox(page, '#night', false)
  await panel(false)
  await page.waitForTimeout(2000)
  await waitDrawn(page)
  const back = await look(), stBack = await currentsStats(page), conBack = await canvasContrast(page, [194, 200, 202])
  // The list of layers is left out of the comparison: the sea picture and the radar are made the first time they are used, and "no layer is added or taken away" is checked at the switch.
  const same = (({ scalar, flowNight, layers, ...rest }) => JSON.stringify(rest))(back) === (({ scalar, flowNight, layers, ...rest }) => JSON.stringify(rest))(day)
  report(same && !back.flowNight && !stBack.night && !!conBack && conBack.median >= 3 && conBack.p10 >= 2.2, t('night: switched off again, every colour of the basemap and the page is exactly what it was, the currents are drawn dark again (contrast 3 to 1 or better on the pale sea) and nothing was added or lost'), JSON.stringify({ back, day, conBack }))
  await panel(true)
  await setBox(page, 'input[data-overlay=currents]', false)
  await setBox(page, '#flow', true)
  await panel(panelWas)
}

// Reduced motion: Flow is off and disabled, nothing animates, and the page follows the setting live.
async function checkReducedMotion(browser, base) {
  const { ctx, page, problems } = await openPage(browser, base, { width: 1280, height: 800 }, { reducedMotion: 'reduce' })
  const get = () => page.evaluate(() => {
    const m = window.__map, b = document.getElementById('flow')
    return { checked: b.checked, disabled: b.disabled, vis: m.getLayoutProperty('streams-flow', 'visibility') ?? 'visible', running: window.__flow.running(), why: !document.getElementById('flow-paused').hidden, dash: JSON.stringify(m.getPaintProperty('streams-flow', 'line-dasharray')) }
  })
  // The browser reports a media setting change on its next rendered frame, so ask
  // for frames while waiting.
  const settle = async (want) => {
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const st = await get()
      if (want(st)) return st
      await page.waitForTimeout(100)
    }
    return get()
  }
  const a = await get()
  const tilt = await page.evaluate(() => ({ pitch: window.__map.getPitch(), terrain: !!window.__map.getTerrain() }))
  report(Math.abs(tilt.pitch - 60) < 1 && tilt.terrain, 'reduced motion: 3D terrain is on at load and the map is already tilted', JSON.stringify(tilt))
  await page.waitForTimeout(600)
  const b = await get()
  report(a.disabled && !a.checked && a.vis === 'none' && !a.running && a.why, 'reduced motion: Flow box is off and disabled, dashes hidden, loop not running, reason shown', JSON.stringify(a))
  report(a.dash === b.dash, 'reduced motion: the dash pattern never changes')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const c = await settle((st) => st.running)
  report(!c.disabled && c.checked && c.vis === 'visible' && c.running && !c.why, 'reduced motion switched off while the page is open: Flow starts', JSON.stringify(c))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const d = await settle((st) => !st.running)
  report(d.disabled && !d.checked && d.vis === 'none' && !d.running, 'reduced motion switched on while the page is open: Flow stops', JSON.stringify(d))
  // Sea currents and wind: still streaks that show the direction, no loop, no Play, and the page follows the setting live.
  await page.evaluate(() => { document.getElementById('panel-details').open = true })
  await setBox(page, '#flow', false)
  for (const id of ['currents', 'wind']) {
    const what = id === 'currents' ? 'sea currents' : 'wind'
    await setBox(page, `input[data-overlay=${id}]`, true)
    await waitStatus(page, id).catch(() => {})
    await page.waitForTimeout(2000)
    const sea = () => page.evaluate((id) => ({ stats: window.__overlays.flow.stats(), play: document.getElementById(id + '-play').disabled, why: !document.getElementById(id + '-paused').hidden, playing: window.__overlays[id === 'currents' ? 'sea' : 'wind'].playing }), id)
    const drawnOk = (st) => (id === 'currents' ? drawnOverSea(st) : st.kind === 'wind' && st.drawn > 300)
    const r1 = await sea(), sigR1 = await canvasSignature(page)
    await page.waitForTimeout(1500)
    const r2 = await sea(), sigR2 = await canvasSignature(page)
    report(r1.stats.on && !r1.stats.running && r1.stats.frames === 0 && r2.stats.frames === 0 && sigR1 !== null && sigR1 === sigR2 && drawnOk(r1.stats) && r1.play && r1.why && !r1.playing, `reduced motion: ${what} ${id === 'currents' ? 'are' : 'is'} drawn as still streaks${id === 'currents' ? ' over the sea' : ''}, the loop never runs, the picture never changes, and Play is disabled with the reason shown`, JSON.stringify({ r1, sigR1, sigR2 }))
    report(!r1.stats.blending && r1.stats.blend === 0, `reduced motion: ${what} stay one hour, with no blend (Play is disabled, so nothing steps)`, JSON.stringify(r1.stats))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    // The browser reports a media setting change on its next rendered frame, and waitForFunction asks for frames while it waits.
    const live = await page.waitForFunction(() => window.__overlays.flow.stats().running, null, { timeout: 15000 }).then(() => sea(), () => sea())
    report(live.stats.running && !live.play && !live.why, `reduced motion switched off while the page is open: ${what} start${id === 'currents' ? '' : 's'} moving and Play is offered`, JSON.stringify(live))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const dead = await page.waitForFunction(() => !window.__overlays.flow.stats().running, null, { timeout: 15000 }).then(() => sea(), () => sea())
    report(!dead.stats.running && dead.play && dead.why && dead.stats.drawn > 0, `reduced motion switched on while the page is open: ${what} stop${id === 'currents' ? '' : 's'} and stay${id === 'currents' ? '' : 's'} as still streaks, Play is disabled`, JSON.stringify(dead))
    await setBox(page, `input[data-overlay=${id}]`, false)
  }
  const hard = problems.filter((p) => !/openfreemap/i.test(p) || /HTTP|page error/.test(p))
  report(hard.length === 0, 'reduced motion: no page errors', hard.slice(0, 3).join(' | '))
  await ctx.close()
}

async function checkBasemapDown(browser, base, shots) {
  const { ctx, page, problems } = await openPage(browser, base, { width: 1280, height: 800 }, { blockTiles: true })
  const info = await page.evaluate(() => ({
    banner: document.getElementById('demo-banner').innerText,
    layers: ['parks-local', 'streams', 'muni-line', 'pins'].filter((id) => !window.__map.getLayer(id)),
    labelLayers: ['streams-label', 'pins-label'].filter((id) => window.__map.getLayer(id)),
  }))
  report(info.banner.includes('could not be reached'), 'basemap blocked: banner says the basemap could not be reached', info.banner)
  report(info.layers.length === 0, 'basemap blocked: data layers still added', info.layers.join(', '))
  report(info.labelLayers.length === 0, 'basemap blocked: text layers skipped (no glyph server)')
  const hard = problems.filter((p) => /page error/.test(p))
  report(hard.length === 0, 'basemap blocked: no page errors', hard.join(' | '))
  if (shots) await page.screenshot({ timeout: 120000, path: join(shots, 'desktop-5-basemap-down.png') })
  await ctx.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bad = await runBrowserChecks()
  process.exitCode = bad ? 1 : 0
}
