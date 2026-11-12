/**
 * The pixel size of a WebP file, read from its header.
 *
 * A figure is laid out before its image loads: the paginator measures every block
 * once, and an image of unknown size measures as zero, which put a whole painting
 * on a page that had room for a caption. The figure markup therefore carries the
 * image's width and height, and this reads them at build time without an image
 * library: a WebP names its size in the first thirty bytes.
 *
 * The three encodings each put it somewhere else (RFC 9649 §2.5 to §2.7):
 *
 *   - `VP8 ` (lossy): 14-bit width and height after the frame's start code;
 *   - `VP8L` (lossless): 14-bit width-1 and height-1 packed after a signature byte;
 *   - `VP8X` (extended): 24-bit canvas width-1 and height-1.
 */

import { readFileSync } from "node:fs"

export interface ImageSize {
	readonly width: number
	readonly height: number
}

export const webpSize = (path: string): ImageSize => {
	const bytes = readFileSync(path)
	if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
		throw new Error(`${path} is not a WebP file`)
	}

	const chunk = bytes.toString("ascii", 12, 16)
	switch (chunk) {
		case "VP8 ":
			return {
				width: bytes.readUInt16LE(26) & 0x3fff,
				height: bytes.readUInt16LE(28) & 0x3fff
			}
		case "VP8L": {
			const bits = bytes.readUInt32LE(21)
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
		}
		case "VP8X":
			return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
		default:
			throw new Error(`${path}: unknown WebP chunk "${chunk}"`)
	}
}
