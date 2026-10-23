// Paints a tile of the Canadian Hydrographic Service's seafloor depth (NONNA) again in this map's colours, off the main thread.
// A module worker of js/overlays.js. The painting itself is nonnaPaint in js/overlays-data.js, which the checks run in Node.
// It holds the tile only while it works: nothing is kept but the answer for each colour met, and nothing is sent anywhere.
import { nonnaPaint } from './overlays-data.js'

const seen = new Map() // colour of the server's picture -> colour of this map's (see nonnaPaint)

self.onmessage = async ({ data: { id, buffer, sea, opacity } }) => {
  try {
    // No colour management and no premultiplying, so the pixels are the ones the server drew.
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext('2d', { willReadFrequently: true })
    g.drawImage(bitmap, 0, 0)
    bitmap.close()
    const image = g.getImageData(0, 0, canvas.width, canvas.height)
    const painted = nonnaPaint(image.data, sea, opacity, seen)
    g.putImageData(image, 0, 0)
    const out = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    self.postMessage({ id, buffer: out, painted }, [out])
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e).slice(0, 120) })
  }
}
