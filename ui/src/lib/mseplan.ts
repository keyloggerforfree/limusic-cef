// limusic-cef: the decisions behind the MSE music-video player (mse.ts), as pure functions with no
// imports, so mseplan.check.ts can run them under plain Node: which quality a picture wants, when a
// buffered stretch is stale, when a quality can't be kept up, and how a WebM rendition's header
// and Cues turn into segments.

/** One cluster of a rendition: its time span (seconds) and its bytes in the file (inclusive). */
export type Segment = { start: number; end: number; from: number; to: number };

/** A picture's quality class as a 16:9 frame, as the Rust ladder measures it (orchestrator/mse.rs):
 *  a wide cinematic encode (2560x1068) is the 1440p its width says, not the 1068 its height does. */
export function classOf(r: { width: number; height: number }): number {
	return Math.max(r.height, Math.floor((r.width * 9) / 16));
}

/** Which quality to play, by index into `classes` (ascending): the smallest that covers `px`, the
 *  picture's drawn height in device pixels, with 5% to spare so a box a few pixels over a class
 *  doesn't pull in the next one. The largest when none does. Never above `ceiling`, the cap after
 *  falling back for bandwidth. */
export function pickQuality(classes: number[], px: number, ceiling?: number): number {
	let i = classes.findIndex((c) => c >= px * 0.95);
	if (i < 0) i = classes.length - 1;
	if (ceiling !== undefined) i = Math.min(i, ceiling);
	return Math.max(i, 0);
}

/** Whether the segment `t` falls in, by the wanted quality's own segments, was buffered in another
 *  quality: `appendedAs` maps a segment's start (ms) to the quality it was appended in. */
export function isStale(
	appendedAs: Map<number, number>,
	segs: Segment[] | undefined,
	want: number,
	t: number
): boolean {
	const seg = segs?.find((s) => s.start <= t && s.end > t);
	if (!seg) return false;
	const as = appendedAs.get(Math.round(seg.start * 1000));
	return as !== undefined && as !== want;
}

/** The next segment to fetch: the first that ends past `ahead`, the end of the buffered stretch
 *  the playhead is in, and is not `done` (already appended in the wanted quality and still
 *  buffered). Not by time alone: the media can end short of the duration YouTube gives, and then
 *  the last segment looked unfetched and was fetched again and again until the video ended. */
export function nextSegment(
	segs: Segment[],
	ahead: number,
	done: (s: Segment) => boolean
): Segment | undefined {
	return segs.find((s) => s.end > ahead + 0.05 && !done(s));
}

/** A segment that took (nearly) as long to arrive as it plays for means its quality can't be kept
 *  up: 90% of its length or more. */
export function tooSlow(downloadMs: number, seg: Segment): boolean {
	return downloadMs >= (seg.end - seg.start) * 900;
}

// --- WebM ------------------------------------------------------------------------------------
// Just enough EBML to turn a rendition's header and Cues into segments: where the Segment's data
// starts (the Cues count from there), the timecode scale, and each cue's time and cluster offset.

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_CLUSTER_POSITION = 0xf1;

type Element = { id: number; start: number; end: number; next: number };

/** The element at `at`: its id, where its data starts and ends (clamped to the buffer), and where
 *  the next sibling begins. An unknown size runs to the end of the buffer. */
function element(b: Uint8Array, at: number): Element | null {
	const id = vint(b, at, true);
	if (!id) return null;
	const size = vint(b, at + id.len, false);
	if (!size) return null;
	const start = at + id.len + size.len;
	const end = size.value < 0 ? b.length : Math.min(b.length, start + size.value);
	return { id: id.value, start, end, next: size.value < 0 ? b.length : start + size.value };
}

/** A variable-length integer: an element id keeps its length marker, a size drops it and reads
 *  all-ones as unknown (-1). */
function vint(b: Uint8Array, at: number, keepMarker: boolean) {
	if (at >= b.length) return null;
	const first = b[at];
	let len = 1;
	while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
	if (len > 8 || at + len > b.length) return null;
	let value = keepMarker ? first : first & (0xff >> len);
	let allOnes = value === 0xff >> len;
	for (let i = 1; i < len; i++) {
		value = value * 256 + b[at + i];
		if (b[at + i] !== 0xff) allOnes = false;
	}
	return { value: !keepMarker && allOnes ? -1 : value, len };
}

function uint(b: Uint8Array, e: Element) {
	let v = 0;
	for (let i = e.start; i < e.end; i++) v = v * 256 + b[i];
	return v;
}

/** The children of `parent` (or of the whole buffer from `from`) with id `id`. */
function* children(b: Uint8Array, from: number, end: number, id?: number) {
	for (let at = from; at < end; ) {
		const e = element(b, at);
		if (!e || e.next <= at) return;
		if (id === undefined || e.id === id) yield e;
		at = e.next;
	}
}

/** The rendition's clusters, from its header (`init`, which starts at byte `initAt` of the file)
 *  and its Cues. Cue positions count from the Segment's data, so that is found in the header. */
export function segments(
	init: Uint8Array,
	initAt: number,
	index: Uint8Array,
	length: number,
	duration: number
): Segment[] {
	let segmentStart = -1;
	let scale = 1e6;
	for (const e of children(init, 0, init.length)) {
		if (e.id !== SEGMENT) continue;
		segmentStart = initAt + e.start;
		for (const info of children(init, e.start, e.end, INFO)) {
			for (const s of children(init, info.start, info.end, TIMECODE_SCALE)) scale = uint(init, s);
		}
		break;
	}
	const cues = children(index, 0, index.length, CUES).next().value as Element | undefined;
	if (segmentStart < 0 || !cues) return [];
	const points: { time: number; pos: number }[] = [];
	for (const p of children(index, cues.start, cues.end, CUE_POINT)) {
		let time = -1;
		let pos = -1;
		for (const c of children(index, p.start, p.end)) {
			if (c.id === CUE_TIME) time = (uint(index, c) * scale) / 1e9;
			if (c.id === CUE_TRACK_POSITIONS && pos < 0) {
				for (const q of children(index, c.start, c.end, CUE_CLUSTER_POSITION)) pos = uint(index, q);
			}
		}
		if (time >= 0 && pos >= 0) points.push({ time, pos: segmentStart + pos });
	}
	points.sort((a, b) => a.time - b.time);
	return points.map((p, i): Segment => {
		const next = points[i + 1];
		return {
			start: p.time,
			// The last one ends with the video; ten seconds on when the length is unknown or short of
			// the cue (a stale duration), never past a known end.
			end: next ? next.time : duration > p.time ? duration : p.time + 10,
			from: p.pos,
			to: (next ? next.pos : length) - 1
		};
	});
}
