// The time line of the Greater Victoria demo map: the years of each layer that changes over time, which of its pictures a year shows, and
// the text of its popups and readouts. Plain ES module with no DOM code, so scripts/check-demo.mjs can run it in Node. js/timeline.js is the
// control and js/time-layers.js draws the layers.
import { OGL_CANADA_LINE } from './overlays-data.js'

export const OGL_BC_LINE = 'Contains information licensed under the Open Government Licence – British Columbia.'
export const OGL_VICTORIA_LINE = 'Contains information licensed under the Open Government Licence – City of Victoria.'
export { OGL_CANADA_LINE }

// ---- steps and the time line
// A step is one picture of a layer: `t` is the year it stands for, a number that sorts, and `label` is how the page says it ("1994-95").
// The control only sorts steps by `t` and shows their labels, so a later round can add years after today (a scenario, "2050") as steps,
// and another past (what if) as a second list of steps that a layer registers in place of its first.
export const step = (t, label = String(t)) => {
  if (!Number.isFinite(t)) throw new Error('a step needs a year')
  return { t, label: String(label) }
}

// How a layer answers a year of the time line:
// - event: only what happened in that year (herring spawn in one season). A year it has no record of shows nothing.
// - snapshot: the latest picture taken in or before that year (an air photo, a land cover map). A year before the first shows nothing.
// - cumulative: everything up to that year (forest lost from 2001 to that year).
export const KINDS = ['event', 'snapshot', 'cumulative']

// The steps of the time line: every step of the layers that are on, once each, in order of year. Where the layers label a year the same
// way the label is kept ("1994-95" while only the ecosystem mapping is on), and where they differ the year is said as a number.
export function timeAxis(lists) {
  const byT = new Map()
  for (const list of lists) for (const s of list || []) {
    if (!Number.isFinite(s?.t)) throw new Error('a step needs a year')
    const have = byT.get(s.t)
    if (!have) byT.set(s.t, { t: s.t, label: s.label })
    else if (have.label !== s.label) have.label = String(s.t)
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
}

// The position on `axis` for year `t`: the step of that year, or else the last step before it, or else the first step.
export function axisIndex(axis, t) {
  if (!axis.length) return -1
  let at = 0
  for (let i = 0; i < axis.length; i++) if (axis[i].t <= t) at = i
  return at
}

// The step of a layer that year `t` shows, or null when it shows nothing. For a cumulative layer it is the last step included.
export function frameAt(steps, kind, t) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`)
  if (kind === 'event') return steps.find((s) => s.t === t) || null
  let out = null
  for (const s of steps) if (s.t <= t) out = s
  return out
}

// The line a snapshot layer adds to the readout under the slider.
export function snapshotLine(name, steps, frame, t) {
  if (!frame) return `${name}: the first is from ${steps[0].label}.`
  if (frame.t === t) return `${name}: ${frame.label}.`
  return `${name}: ${frame.label}, the latest before ${t}.`
}

// ---- herring spawn by year (Fisheries and Oceans Canada, Pacific Herring Spawn Index Data)
// One point per spawn location and herring season, built by scripts/make-herring-years.mjs. DFO's data dictionary says the year is the herring
// season, 1 July to 30 June, so 2020 is the 2019/2020 season.
export const HERRING_YEARS_FILE = 'data/herring-spawn-years.geojson'
export const HERRING_RECORD = 'https://open.canada.ca/data/en/dataset/d892511c-d851-4f85-a0ec-708bc05d2810'
export const herringSeason = (year) => {
  if (!Number.isInteger(year)) throw new Error('a herring year is a whole number')
  return `${year - 1}/${year}`
}
export const herringSteps = (features) => [...new Set(features.map((f) => f.properties?.year).filter(Number.isInteger))].sort((a, b) => a - b).map((y) => step(y))
export const HERRING_CAVEAT = 'The spawn index is a relative index of spawning biomass and a minimum estimate, not a count of fish. Surveys were made from the surface until 1987 and by divers from 1988, and the surface method changed in 1969 and 1979, so fewer places in later years is partly a change in how much was surveyed.'
const HERRING_METHOD = { Surface: 'Surveyed from the surface.', Dive: 'Surveyed by divers.', Mixed: 'Surveyed from the surface and by divers.', Incomplete: 'The survey was incomplete.' }
const fmt = (n, d = 0) => Number(n).toLocaleString('en-CA', { maximumFractionDigits: d })
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`
export function herringYearInfo(p) {
  const year = Number.isInteger(p.year) ? p.year : null
  const spawns = Number.isInteger(p.spawns) && p.spawns > 0 ? p.spawns : null
  const index = typeof p.index_t === 'number' && p.index_t > 0 ? p.index_t : null
  const missing = Number.isInteger(p.no_index) && p.no_index > 0 ? p.no_index : 0
  return {
    title: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Herring spawn',
    tag: year ? `herring spawn, ${herringSeason(year)} season` : 'herring spawn',
    lines: [
      index != null ? `Spawn index: ${fmt(index, index < 10 ? 2 : 0)} tonnes${missing && spawns ? `, from ${spawns - missing} of ${spawns} records (the others have none)` : ''}.` : 'No spawn index was recorded for this place and season.',
      spawns ? `${plural(spawns, 'spawn record', 'spawn records')} this season${typeof p.length_m === 'number' && p.length_m > 0 ? `, along about ${fmt(p.length_m)} m of shore` : ''}.` : null,
      HERRING_METHOD[p.method] || null,
      HERRING_CAVEAT,
    ].filter(Boolean),
    source: `Source: Fisheries and Oceans Canada, Pacific Herring Spawn Index Data. The name is as DFO publishes it. ${OGL_CANADA_LINE}`,
  }
}
// `count` is the places of DFO's data that season and `sections` the shore sections of the 1989 report (seasons before 1951).
export function herringLine(year, count, first, sections = 0) {
  if (year < first) return `Herring spawn: the records begin with the ${herringSeason(first)} season.`
  if (sections) return `Herring spawn, ${herringSeason(year)} season: records for ${plural(sections, 'shore section', 'shore sections')}, with no places (DFO report of 1989).`
  if (!count && year < HERRING_TABLES_FROM) return `Herring spawn, ${herringSeason(year)} season: no record. The yearly records begin with the ${herringSeason(HERRING_TABLES_FROM)} season.`
  if (!count) return `Herring spawn, ${herringSeason(year)} season: none recorded in the area this map reaches.`
  return `Herring spawn, ${herringSeason(year)} season: ${plural(count, 'place', 'places')}.`
}
// Circle size by the spawn index in tonnes (0.04 to 36,200 in the file, median about 150), on a square-root scale. No index: the smallest.
export const herringRadius = () => ['interpolate', ['linear'], ['sqrt', ['coalesce', ['get', 'index_t'], 0]], 0, 3.5, 10, 6, 40, 11, 190, 24]

// ---- herring spawn before 1951, by shore section (Hay, McCarter, Kronlund and Roy 1989)
// DFO's spawn index data begin with the 1951 season. For earlier seasons a DFO report of 1989 gives each shore section's spawn records, with
// no places, made into a file by scripts/make-herring-early.mjs. The map draws a ring over the section's spawning area. The report states
// no licence. The Government of Canada's terms (https://www.canada.ca/en/transparency/terms.html) allow non-commercial reproduction with
// the title, the author and the address of the version copied.
export const HERRING_EARLY_FILE = 'data/herring-spawn-before-1951.geojson'
export const HERRING_EARLY_REPORT = 'https://publications.gc.ca/collections/collection_2026/mpo-dfo/fs97-4/Fs97-4-2019-5-eng.pdf'
export const HERRING_EARLY_TITLE = 'Spawning areas of British Columbia herring: a review, geographical analysis and classification. Volume V. Strait of Georgia'
export const HERRING_EARLY_AUTHORS = 'D. E. Hay, P. B. McCarter, R. Kronlund and C. Roy'
// The first year of the report's tables. Before it the report has one dated record, Sidney Channel in 1932.
export const HERRING_TABLES_FROM = 1937
export const HERRING_EARLY_CAVEAT = 'DFO treats spawn records before 1951 as unreliable for indexing and leaves them out of its stock assessments. These are survey records, not amounts of fish.'
const HERRING_EARLY_WHERE = {
  'Victoria Harbour': 'Portage Inlet and Esquimalt Harbour, where the report says this section spawns',
  'Saanich Inlet': 'Saanich Inlet from Patricia Bay to Goldstream Flats, the two areas the report names',
  'Sidney Channel': 'Sidney Channel at the position DFO lists for it',
}
// The report counts days from 1 January, day 1.
const dayDate = (year, day) => new Date(Date.UTC(year, 0, day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
export function herringEarlyInfo(p) {
  const year = Number.isInteger(p.year) ? p.year : null
  const records = Number.isInteger(p.records) && p.records > 0 ? p.records : null
  const dated = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? new Date(`${p.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null
  const days = year && Number.isInteger(p.first_day) && Number.isInteger(p.last_day) ? [dayDate(year, p.first_day), dayDate(year, p.last_day)] : null
  return {
    title: `${p.name}, whole shore section`,
    tag: year ? `herring spawn, ${herringSeason(year)} season` : 'herring spawn',
    lines: [
      records ? `${plural(records, 'spawn record', 'spawn records')} this season${Number.isInteger(p.places) && p.places > 0 ? ` at ${plural(p.places, 'location', 'locations')}` : ''}${typeof p.length_m === 'number' && p.length_m > 0 ? `, along about ${fmt(p.length_m)} m of shore in all` : ''}.` : null,
      dated ? `Recorded on ${dated}. The report's yearly tables begin in ${HERRING_TABLES_FROM}, and its notes give this one earlier record.` : null,
      days ? (days[0] === days[1] ? `Spawn on about ${days[0]}.` : `Spawn between about ${days[0]} and ${days[1]}.`) : null,
      typeof p.width_m === 'number' && p.width_m > 0 ? `Average width about ${fmt(p.width_m)} m.` : null,
      typeof p.intensity === 'number' && p.intensity > 0 ? `Average intensity ${fmt(p.intensity, 1)}. Until 1968 surveyors rated spawn in five categories, from 1 (very light) to 5 (very heavy).` : null,
      HERRING_EARLY_WHERE[p.name] ? `The report gives these figures for the whole section, not by place, so the ring covers ${HERRING_EARLY_WHERE[p.name]}. It does not show where the spawn was.` : null,
      HERRING_EARLY_CAVEAT,
    ].filter(Boolean),
    source: `Source: ${HERRING_EARLY_AUTHORS}, ${HERRING_EARLY_TITLE}, Fisheries and Oceans Canada, 1989${p.table ? `, table ${p.table}` : ''}. The figures are copied from the version at publications.gc.ca.`,
  }
}
// The ring's radius in pixels for its radius on the ground (`r_m`), so it covers the same shore at every zoom. At this latitude a pixel of
// zoom 0 is about 51,860 m (512-pixel tiles).
export const herringEarlyRadius = () => ['interpolate', ['exponential', 2], ['zoom'], 0, ['/', ['get', 'r_m'], 51860], 22, ['/', ['*', ['get', 'r_m'], 4194304], 51860]]

// ---- aerial photos of Victoria, 1932 and 1950 (Natural Resources Canada, National Air Photo Library)
// The two greyscale mosaics of the federal datacube, made into WebP tiles by scripts/build-aerial-tiles.sh and kept as one PMTiles file per
// year on the map's own server, which the page reads by range requests. The record says the photos of one year are "not necessarily
// coregistrated" with the other's, so the two may not line up exactly.
export const AERIAL_TILES = 'https://map-api.regeneratevictoria.org/tiles'
export const AERIAL_RECORD = 'https://open.canada.ca/data/en/dataset/d8627209-bda2-436f-b22b-0eb19fdc6660'
export const AERIAL_YEARS = [step(1932), step(1950)]
// [west, south, east, north] of each mosaic, from its STAC item, so no tile is asked for outside it.
export const AERIAL_BOUNDS = { 1932: [-123.4397, 48.3927, -123.2759, 48.4793], 1950: [-123.4379, 48.4021, -123.2867, 48.4792] }
export function aerialTileUrl(year) {
  if (!AERIAL_BOUNDS[year]) throw new Error('no photo for that year')
  return `pmtiles://${AERIAL_TILES}/aerial-${year}.pmtiles/{z}/{x}/{y}`
}

// ---- Sensitive Ecosystems Inventory, mapped in 1994-95 and updated in 2002, and the Garry oak mapping of 2014 (Province of British Columbia)
// The 2002 update kept the polygons of the 1990s and marked the parts disturbed since the 1992 air photos as not sensitive (NS). So the two
// steps are the same ground, and what changes is the disturbed patches. The 2014 mapping is a different survey on different ground and is a
// layer of its own, never a third step.
export const SEI_RECORD = 'https://catalogue.data.gov.bc.ca/dataset/b00fd09f-ebe1-4b52-9717-6ef9c243d52e'
export const SEI_FILES = { 1994: 'data/sei-garry-oak-1994-95.geojson', 2002: 'data/sei-garry-oak-2002.geojson', 2014: 'data/sei-garry-oak-2014.geojson' }
export const SEI_YEARS = [step(1994, '1994-95'), step(2002)]
// The Province's class codes (TEI domain tables, read 2026-10-22). The inventory has no Garry oak class: woodland includes Garry oak stands.
export const SEI_CLASSES = {
  WD: { name: 'Woodland', note: 'Dry open woodland with 10 to 25% tree cover, including Garry oak, arbutus and Douglas-fir stands.', colour: '#7a5a12' },
  HT: { name: 'Terrestrial herbaceous', note: 'Open herbaceous ground and rock outcrops. Garry oak meadows are among them.', colour: '#d9a520' },
  HB: { name: 'Herbaceous', note: 'Open herbaceous ground and rock outcrops. Garry oak meadows are among them.', colour: '#d9a520' },
  CB: { name: 'Coastal bluff', note: null, colour: '#c46a3a' },
  SV: { name: 'Sparsely vegetated', note: null, colour: '#9c8f80' },
  BW: { name: 'Broadleaf woodland', note: null, colour: '#7a5a12' },
  MF: { name: 'Mature forest', note: null, colour: '#5f7f55' },
  SG: { name: 'Older second growth forest', note: null, colour: '#5f7f55' },
  OF: { name: 'Old forest', note: null, colour: '#5f7f55' },
  WN: { name: 'Wetland', note: null, colour: '#5f7f55' },
  RI: { name: 'Riparian', note: null, colour: '#5f7f55' },
  NS: { name: 'Not sensitive', note: null, colour: '#b3261e' },
}
// Subclass codes, read with their class because some codes mean different things in different classes.
const SEI_SUB = { co: 'coniferous', mx: 'mixed', ro: 'rock outcrop', hb: 'herbaceous', cs: 'coastal', sh: 'shrub', cl: 'cliff', sd: 'sand dunes', ms: 'marsh', wm: 'wet meadow' }
export const seiSub = (cls, sub) => (sub === 'sp' ? (cls === 'SV' ? 'spit' : cls === 'WN' ? 'swamp' : null) : SEI_SUB[sub] || null)
export const SEI_KEY = [['WD', 'Woodland, including Garry oak'], ['HT', 'Herbaceous and rock outcrop'], ['CB', 'Coastal bluff'], ['SV', 'Sparsely vegetated'], ['SG', 'Forest, wetland or riparian, kept with the others'], ['NS', 'Disturbed between 1992 and 2002']]
export const seiColour = () => ['match', ['get', 'class'], ...Object.entries(SEI_CLASSES).flatMap(([k, v]) => [k, v.colour]), '#777777']
const SEI_SOURCE = `Source: Sensitive Ecosystems Inventory, Province of British Columbia. ${OGL_BC_LINE}`
// `vintage` is 1994, 2002 or 2014.
export function seiInfo(p, vintage) {
  const c = SEI_CLASSES[p.class]
  const sub = seiSub(p.class, p.sub)
  const also = typeof p.also === 'string' ? p.also.split('+').map((k) => SEI_CLASSES[k]?.name.toLowerCase()).filter(Boolean) : []
  const dist = typeof p.dist === 'string' && p.dist.trim() ? p.dist.trim().toLowerCase() : null
  const disturbed = p.class === 'NS' && vintage === 2002
  const when = { 1994: 'Mapped in 1994 and 1995 from air photos of 1992.', 2002: 'From the 2002 update, which used air photos of 2002 and marked what had been disturbed since 1992.', 2014: 'Mapped from air photos of 2014, in a project completed in 2021, at a finer scale (1:10,000) than the 1990s inventory.' }[vintage]
  if (!when) throw new Error('unknown vintage')
  return {
    title: disturbed ? 'Disturbed between 1992 and 2002' : c ? `${c.name}${sub ? `, ${sub}` : ''}` : 'Sensitive ecosystem',
    tag: vintage === 2014 ? 'Garry oak ecosystems mapping, 2014' : `sensitive ecosystems, ${vintage === 1994 ? '1994-95' : '2002'}`,
    lines: [
      disturbed ? 'Part of a sensitive ecosystem mapped in 1994-95 that the 2002 update found disturbed.' : null,
      disturbed && dist ? `Kind of disturbance, as the update records it: ${dist}.` : null,
      !disturbed && dist ? `The 2002 update notes a disturbance here: ${dist}.` : null,
      !disturbed && c?.note ? c.note : null,
      also.length ? `Also in this polygon: ${also.join(' and ')}.` : null,
      Number.isInteger(p.tenths) && p.tenths > 0 && p.tenths <= 10 ? `The main ecosystem covers about ${p.tenths * 10}% of the polygon.` : null,
      when,
      vintage === 2014 ? 'A different survey from the 1990s inventory, with other methods and scale. It covers the west of the map area only, so it does not measure change.' : 'The inventory has no Garry oak class. Woodland includes Garry oak, arbutus and Douglas-fir stands.',
    ].filter(Boolean),
    source: SEI_SOURCE,
  }
}

// ---- City of Victoria tree canopy from LiDAR, 2013, 2019 and 2023, one picture each (made by scripts/fetch-time-rasters.sh). The City's files
// hold a value where they found canopy and no value elsewhere, and do not say what the values are, so the pictures are one colour where there is a value.
export const CANOPY_YEARS = [step(2013), step(2019), step(2023, '2023 (draft)')]
export const CANOPY_FILES = { 2013: 'data/canopy-2013.png', 2019: 'data/canopy-2019.png', 2023: 'data/canopy-2023.png' }
export const CANOPY_ITEMS = {
  2013: 'https://www.arcgis.com/home/item.html?id=c064dcd2d10b4d6092f069e7db89abbf',
  2019: 'https://www.arcgis.com/home/item.html?id=ee10f28fcef8490e87da5e7f010701b5',
  2023: 'https://www.arcgis.com/home/item.html?id=2f6665924f5747b69c07f103930ba77d',
}
// The corners of the three pictures, which share one grid in Web Mercator: top left, top right, bottom right, bottom left.
export const CANOPY_CORNERS = [[-123.394492, 48.450584], [-123.322213, 48.450584], [-123.322213, 48.402741], [-123.394492, 48.402741]]

// ---- Hansen Global Forest Change, loss year 2001 to 2025 (University of Maryland)
// One picture of the demo box in Web Mercator (made by scripts/fetch-time-rasters.sh from the 30 m loss-year grid, nearest neighbour), in which
// a pixel's red value is ten times its loss year after 2000 (10 for 2001 to 250 for 2025) and a pixel with no loss is clear. The page reads the
// years from it once and paints the loss up to the year of the slider itself, so no file per year is needed.
export const LOSS_FILE = 'data/forest-loss.png'
export const LOSS_YEARS = Array.from({ length: 25 }, (_, i) => step(2001 + i))
export const LOSS_PAGE = 'https://glad.earthengine.app/view/global-forest-change'
export const LOSS_DOWNLOAD = 'https://storage.googleapis.com/earthenginepartners-hansen/GFC-2025-v1.13/download.html'
// The picture covers the demo box exactly: west -123.75, south 48.28, east -123.20, north 48.70, in the order top left, top right, bottom right, bottom left.
export const LOSS_CORNERS = [[-123.75, 48.7], [-123.2, 48.7], [-123.2, 48.28], [-123.75, 48.28]]
// The year of a pixel from its red value and its alpha, or 0 for none.
export function lossYearOf(r, a) {
  if (a < 128) return 0
  const i = Math.round(r / 10)
  return i >= 1 && i <= 25 ? 2000 + i : 0
}
// The pixel of the picture under a place, or null outside it. The rows of a Web Mercator picture are even in Mercator y, not in latitude.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
export function lossPixel(lng, lat, width, height) {
  const [[w, n], , [e, s]] = LOSS_CORNERS
  if (!(lng >= w && lng < e && lat > s && lat <= n)) return null
  return [Math.min(width - 1, Math.floor((lng - w) / (e - w) * width)), Math.min(height - 1, Math.floor((mercY(n) - mercY(lat)) / (mercY(n) - mercY(s)) * height))]
}
// Older loss is pale and recent loss is dark, so the newest years stand out as the slider moves: pale yellow in 2001, orange in 2013, dark red in 2025.
const LOSS_STOPS = [[2001, [246, 213, 92]], [2013, [232, 131, 58]], [2025, [122, 16, 16]]]
export function lossRgb(year) {
  const y = Math.min(2025, Math.max(2001, year))
  for (let i = 1; i < LOSS_STOPS.length; i++) {
    const [y1, c1] = LOSS_STOPS[i]
    if (y <= y1) {
      const [y0, c0] = LOSS_STOPS[i - 1], f = (y - y0) / (y1 - y0)
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f))
    }
  }
  return LOSS_STOPS.at(-1)[1]
}
export const lossGradient = () => `linear-gradient(to right, ${LOSS_STOPS.map(([y, c]) => `rgb(${c.join(', ')}) ${Math.round((y - 2001) / 24 * 100)}%`).join(', ')})`
export function lossLine(t) {
  if (t < 2001) return 'Forest loss: the satellite record begins in 2001.'
  return `Forest loss seen by satellite: 2001 to ${Math.min(t, 2025)}${t > 2025 ? ', the latest year in the data' : ''}. Darker is more recent.`
}
export function lossInfo(year) {
  const y = Number.isInteger(year) && year >= 2001 && year <= 2025 ? year : null
  return {
    title: y ? `Forest loss in ${y}` : 'Forest loss',
    tag: 'seen by satellite, 30 m',
    lines: [
      'Landsat images show a stand of trees removed here in that year, by logging, clearing for building, fire or another cause. The data does not say which.',
      'It sees stands, not single street trees. Its makers say the years before 2011 were processed differently, so compare years with care.',
    ],
    source: 'Source: Hansen/UMD/Google/USGS/NASA, Global Forest Change 2000 to 2025, version 1.13, clipped to the demo box. Licensed CC BY 4.0.',
  }
}

// ---- Land Cover of Canada, 2010, 2015 and 2020 (Natural Resources Canada), 30 m from satellite
// One picture of the demo box in Web Mercator (made by scripts/fetch-time-rasters.sh from the datacube's files), in which a pixel's red,
// green and blue are its class in 2010, 2015 and 2020, and a pixel with no data is clear. The page reads the classes from it once and colours
// each year itself, so a step to another year waits for nothing.
export const LANDCOVER_RECORD = 'https://open.canada.ca/data/en/dataset/11990a35-912e-4002-b197-d57dd88836d7'
export const LANDCOVER_YEARS = [step(2010), step(2015), step(2020)]
export const LANDCOVER_FILE = 'data/landcover-2010-2020.png'
export const LANDCOVER_CORNERS = LOSS_CORNERS
// The classes found in the demo box: the service's code, the colour it draws the class in (matched to the codes against its own map images
// of the box on 2026-10-25) and the name in its legend.
export const LANDCOVER_CLASSES = [
  [1, '#003c00', 'Temperate or sub-polar needleleaf forest'],
  [5, '#138b04', 'Temperate or sub-polar broadleaf deciduous forest'],
  [6, '#5b742a', 'Mixed forest'],
  [8, '#b29d32', 'Temperate or sub-polar shrubland'],
  [10, '#e0ce89', 'Temperate or sub-polar grassland'],
  [14, '#6aa289', 'Wetland'],
  [15, '#f0b86c', 'Cropland'],
  [16, '#a7aaad', 'Barren land'],
  [17, '#db2025', 'Urban and built-up'],
  [18, '#4b6fa2', 'Water'],
  [19, '#fef9fe', 'Snow and ice'],
]
// A table from class code to the colour drawn: red, green, blue and alpha, four entries a code. No data (0) and a code not in the list are clear.
export function landcoverLut() {
  const lut = new Uint8ClampedArray(256 * 4)
  for (const [code, hex] of LANDCOVER_CLASSES) lut.set([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255), code * 4)
  return lut
}
