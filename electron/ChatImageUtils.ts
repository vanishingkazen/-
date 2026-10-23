import fs from "node:fs"
import path from "node:path"
import { nativeImage } from "electron"

export type ChatImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

export interface ChatImageMetadata {
  mimeType: ChatImageMimeType
  width?: number
  height?: number
  bytes: number
}

export interface PreparedTransportImage {
  path: string
  mimeType: ChatImageMimeType
  width?: number
  height?: number
  resized: boolean
}

const MAX_TRANSPORT_DIMENSION = 1650

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  }
}

function gifDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "GIF") return null
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8)
  }
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null
  }

  const format = buffer.toString("ascii", 12, 16)
  if (format === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    }
  }
  if (format === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    }
  }
  if (format === "VP8L" && buffer.length >= 25) {
    const b0 = buffer[21]
    const b1 = buffer[22]
    const b2 = buffer[23]
    const b3 = buffer[24]
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    }
  }
  return null
}

export function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 2 > buffer.length) return null
    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null
    const isStartOfFrame = (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    )
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3)
      }
    }
    offset += segmentLength
  }
  return null
}

export function detectImageMime(filePath: string): ChatImageMimeType {
  const fd = fs.openSync(filePath, "r")
  try {
    const header = Buffer.alloc(32)
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0)
    const buffer = header.subarray(0, bytesRead)
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
      return "image/png"
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg"
    }
    if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif"
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      return "image/webp"
    }
  } finally {
    fs.closeSync(fd)
  }

  const extension = path.extname(filePath).toLowerCase()
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".gif") return "image/gif"
  if (extension === ".webp") return "image/webp"
  return "image/png"
}

export function readImageMetadata(filePath: string): ChatImageMetadata {
  const buffer = fs.readFileSync(filePath)
  const mimeType = detectImageMime(filePath)
  const dimensions = mimeType === "image/png"
    ? pngDimensions(buffer)
    : mimeType === "image/jpeg"
      ? jpegDimensions(buffer)
      : mimeType === "image/gif"
        ? gifDimensions(buffer)
        : webpDimensions(buffer)

  return {
    mimeType,
    ...(dimensions || {}),
    bytes: buffer.length
  }
}

export function resizeImageToPng(
  sourcePath: string,
  targetPath: string,
  metadata: ChatImageMetadata
): PreparedTransportImage | null {
  if (!metadata.width || !metadata.height) return null

  const maxDimension = Math.max(metadata.width, metadata.height)
  const needsResize = maxDimension > MAX_TRANSPORT_DIMENSION
  const needsPngConversion = metadata.mimeType !== "image/png"
  if (!needsResize && !needsPngConversion) {
    return {
      path: sourcePath,
      mimeType: metadata.mimeType,
      width: metadata.width,
      height: metadata.height,
      resized: false
    }
  }

  const source = nativeImage.createFromPath(sourcePath)
  if (source.isEmpty()) return null

  let width = metadata.width
  let height = metadata.height
  let output = source
  if (needsResize) {
    const scale = MAX_TRANSPORT_DIMENSION / maxDimension
    width = Math.max(1, Math.round(metadata.width * scale))
    height = Math.max(1, Math.round(metadata.height * scale))
    output = source.resize({ width, height, quality: "best" })
  }

  const png = output.toPNG()
  if (!png.length) return null
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, png)
  return {
    path: targetPath,
    mimeType: "image/png",
    width,
    height,
    resized: needsResize
  }
}

export function imageDataUrl(filePath: string, mimeType?: ChatImageMimeType): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const resolvedMimeType = mimeType || detectImageMime(filePath)
    const data = fs.readFileSync(filePath).toString("base64")
    return `data:${resolvedMimeType};base64,${data}`
  } catch {
    return null
  }
}
