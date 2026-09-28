import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const imageExtensions = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png', '.webp'])

const valueFrom = (xml, name) => {
  const match = xml.match(new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, 'i'))
  return match?.[1]?.trim() ?? null
}

const parseDate = (value) => {
  if (!value) return null
  const normalised = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const timestamp = Date.parse(normalised)
  return Number.isFinite(timestamp) ? timestamp : null
}

export const capturedAtFromFilename = (filename) => {
  const match = path.basename(filename).match(
    /^(\d{4})-(\d{2})-(\d{2})[ _](\d{2})[.:](\d{2})[.:](\d{2})/,
  )
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export const haversineMetres = (first, second) => {
  const radius = 6371000
  const radians = (degrees) => (degrees * Math.PI) / 180
  const latitudeDelta = radians(second[1] - first[1])
  const longitudeDelta = radians(second[0] - first[0])
  const firstLatitude = radians(first[1])
  const secondLatitude = radians(second[1])
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const flattenCoordinates = (geometry) => {
  if (!geometry) return []
  if (geometry.type === 'LineString') return geometry.coordinates
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat()
  if (geometry.type === 'Feature') return flattenCoordinates(geometry.geometry)
  if (geometry.type === 'FeatureCollection') {
    return geometry.features.flatMap((feature) => flattenCoordinates(feature))
  }
  return []
}

export const routeCoordinatesFrom = (geojson) => flattenCoordinates(geojson)

export const distanceToRoute = (point, coordinates) => {
  if (!point || coordinates.length === 0) return null
  return coordinates.reduce(
    (minimum, coordinate) => Math.min(minimum, haversineMetres(point, coordinate)),
    Infinity,
  )
}

export const readPhotoMetadata = (xmpPath, archiveRoot) => {
  const mediaPath = xmpPath.slice(0, -4)
  const extension = path.extname(mediaPath).toLowerCase()
  if (!imageExtensions.has(extension) || !fs.existsSync(mediaPath)) return null

  const xml = fs.readFileSync(xmpPath, 'utf8')
  const capturedAt =
    parseDate(valueFrom(xml, 'photoshop:DateCreated')) ??
    parseDate(valueFrom(xml, 'xmp:CreateDate')) ??
    parseDate(valueFrom(xml, 'exif:DateTimeOriginal'))
  if (!capturedAt) return null

  const latitude = Number(valueFrom(xml, 'exif:GPSLatitude'))
  const longitude = Number(valueFrom(xml, 'exif:GPSLongitude'))
  const location =
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [longitude, latitude]
      : null
  const archiveRelativePath = path.relative(archiveRoot, mediaPath)

  return {
    id: crypto.createHash('sha256').update(archiveRelativePath).digest('hex').slice(0, 24),
    archiveRelativePath,
    mediaPath,
    capturedAt,
    capturedAtIso: new Date(capturedAt).toISOString(),
    location,
    extension,
  }
}

const readFilenamePhotoMetadata = (mediaPath, archiveRoot) => {
  const extension = path.extname(mediaPath).toLowerCase()
  if (!imageExtensions.has(extension)) return null
  if (fs.existsSync(`${mediaPath}.xmp`)) return null
  const capturedAt = capturedAtFromFilename(mediaPath)
  if (!capturedAt) return null

  const archiveRelativePath = path.relative(archiveRoot, mediaPath)
  return {
    id: crypto.createHash('sha256').update(archiveRelativePath).digest('hex').slice(0, 24),
    archiveRelativePath,
    mediaPath,
    capturedAt,
    capturedAtIso: new Date(capturedAt).toISOString(),
    location: null,
    extension,
  }
}

export const matchPhotoCandidates = ({
  photos,
  routeCoordinates,
  startTime,
  endTime,
  beforeHours = 6,
  afterHours = 3,
  maximumRouteDistanceM = 5000,
}) => {
  const earliest = startTime - beforeHours * 3600000
  const latest = endTime + afterHours * 3600000

  return photos
    .map((photo) => {
      const routeDistanceM = distanceToRoute(photo.location, routeCoordinates)
      const duringWalk = photo.capturedAt >= startTime && photo.capturedAt <= endTime
      const closeToRoute =
        routeDistanceM != null && routeDistanceM <= maximumRouteDistanceM
      const insideWindow = photo.capturedAt >= earliest && photo.capturedAt <= latest
      if (!insideWindow || (!closeToRoute && !duringWalk)) return null

      return {
        ...photo,
        routeDistanceM: routeDistanceM == null ? null : Math.round(routeDistanceM),
        matchReason: duringWalk
          ? closeToRoute
            ? 'During walk and near route'
            : 'During walk; no nearby GPS match'
          : photo.capturedAt < startTime
            ? 'Before walk and near route'
            : 'After walk and near route',
      }
    })
    .filter(Boolean)
    .sort((first, second) => first.capturedAt - second.capturedAt)
}

export const scanMonth = (monthDirectory, archiveRoot) =>
  fs
    .readdirSync(monthDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const entryPath = path.join(monthDirectory, entry.name)
      if (entry.name.toLowerCase().endsWith('.xmp')) {
        return [readPhotoMetadata(entryPath, archiveRoot)]
      }
      return [readFilenamePhotoMetadata(entryPath, archiveRoot)]
    })
    .filter(Boolean)
