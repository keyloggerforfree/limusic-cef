// limusic-cef: self-check for the MSE music-video player's decisions in `mseplan.ts`:
//
//     node --experimental-strip-types ui/src/lib/mseplan.check.ts
//
// A misread WebM header gives a quality no segments, and it drops out of the ladder without a word:
// the video just plays lower. A wrong pick shimmers in the small view or goes soft in cinema. Prints
// "ok" and exits 0, or throws on the first broken invariant.
import {
	classOf,
	isStale,
	nextSegment,
	pickQuality,
	segments,
	tooSlow,
	type Segment
} from './mseplan.ts';

function ok(cond: boolean, what: string): void {
	if (!cond) throw new Error(`FAIL: ${what}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- A tiny EBML writer: just enough to build a rendition's header and Cues ------------------

const cat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) out.set(p, (at += p.length) - p.length);
	return out;
};
/** An element id, which keeps its length marker: written as its own bytes. */
const id = (v: number) => {
	const out: number[] = [];
	for (; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
	return new Uint8Array(out);
};
/** A size as a `len`-byte vint (the marker bit set). `unknown` writes all ones. */
const size = (n: number, len: number, unknown = false) => {
	const out = new Uint8Array(len);
	if (unknown) out.fill(0xff);
	else for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
	out[0] = unknown ? 0xff >> (len - 1) : out[0] | (0x80 >> (len - 1));
	return out;
};
const uint = (v: number, len = 4) => size(v, len).map((b, i) => (i === 0 ? b & ~(0x80 >> (len - 1)) : b));
const el = (eid: number, payload: Uint8Array, sizeLen = 4) =>
	cat(id(eid), size(payload.length, sizeLen), payload);

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const TRACKS = 0x1654ae6b;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

const ebmlHeader = el(EBML, el(0x4286, uint(1, 1)));

/** A rendition's header: the EBML header, then a Segment whose size runs past what was fetched
 *  (as in a real file, it covers every cluster), holding a SeekHead, an Info and Tracks. Returns
 *  the bytes and where the Segment's data starts in them. */
function header(scale?: number, segmentSize: { len: number; unknown?: boolean } = { len: 8 }) {
	const info = el(INFO, scale === undefined ? el(0x4489, uint(0, 4)) : el(TIMECODE_SCALE, uint(scale)));
	const body = cat(el(SEEK_HEAD, new Uint8Array(12)), info, el(TRACKS, new Uint8Array(30)));
	const segHead = cat(id(SEGMENT), size(50_000_000, segmentSize.len, segmentSize.unknown));
	return { bytes: cat(ebmlHeader, segHead, body), dataAt: ebmlHeader.length + segHead.length };
}

/** A Cues element: one CuePoint per [time, cluster position], each position counted from the
 *  Segment's data, as a muxer writes them. `extra` adds a second CueTrackPositions per point. */
function cues(points: [number, number][], extra = false) {
	const point = ([time, pos]: [number, number]) => {
		const positions = el(CUE_TRACK_POSITIONS, cat(el(CUE_TRACK, uint(1, 1)), el(CUE_CLUSTER_POSITION, uint(pos))));
		const second = el(CUE_TRACK_POSITIONS, cat(el(CUE_TRACK, uint(2, 1)), el(CUE_CLUSTER_POSITION, uint(pos + 999))));
		return el(CUE_POINT, cat(el(CUE_TIME, uint(time)), positions, extra ? second : new Uint8Array()));
	};
	return el(CUES, cat(...points.map(point)));
}

// --- segments() ------------------------------------------------------------------------------

// The ordinary case: the default timecode scale (1 ms), the header at byte 0, three clusters.
{
	const h = header();
	const length = 100_000;
	const segs = segments(h.bytes, 0, cues([[0, 400], [5000, 30000], [9500, 61000]]), length, 14.2);
	ok(segs.length === 3, 'three cue points, three segments');
	ok(same(segs.map((s) => s.start), [0, 5, 9.5]), 'cue times in seconds at the default 1 ms scale');
	ok(same(segs.map((s) => s.end), [5, 9.5, 14.2]), 'each ends where the next starts, the last at the duration');
	ok(segs[0].from === h.dataAt + 400, 'positions count from the Segment data, not the file start');
	ok(segs[0].to === segs[1].from - 1 && segs[1].to === segs[2].from - 1, 'byte ranges are contiguous and inclusive');
	ok(segs[2].to === length - 1, 'the last segment runs to the end of the file');
}

// A different timecode scale changes the times, not the bytes.
{
	const h = header(500_000); // half a millisecond per tick
	const segs = segments(h.bytes, 0, cues([[0, 400], [10000, 30000]]), 50_000, 20);
	ok(same(segs.map((s) => s.start), [0, 5]), 'cue times follow TimecodeScale');
}

// A header fetched from somewhere other than byte 0 shifts every position by as much.
{
	const h = header();
	const at0 = segments(h.bytes, 0, cues([[0, 400], [5000, 9000]]), 20_000, 10);
	const at300 = segments(h.bytes, 300, cues([[0, 400], [5000, 9000]]), 20_000, 10);
	ok(at300[0].from === at0[0].from + 300 && at300[1].from === at0[1].from + 300, 'initAt shifts the byte positions');
}

// A Segment of unknown size (all ones), and sizes written wider than they need, still parse.
{
	const unknown = header(1_000_000, { len: 8, unknown: true });
	const segs = segments(unknown.bytes, 0, cues([[0, 400], [4000, 8000]]), 10_000, 8);
	ok(segs.length === 2 && segs[1].start === 4, 'an unknown-size Segment still yields its Info and segments');
	ok(segs[0].from === unknown.dataAt + 400, 'and its data start');
	const narrow = header(1_000_000, { len: 4 });
	ok(segments(narrow.bytes, 0, cues([[0, 1]]), 100, 1)[0].from === narrow.dataAt + 1, 'a 4-byte Segment size');
}

// Cue points out of order come back sorted; a second track's positions are not taken.
{
	const h = header();
	const segs = segments(h.bytes, 0, cues([[8000, 60000], [0, 400], [4000, 30000]], true), 90_000, 12);
	ok(same(segs.map((s) => s.start), [0, 4, 8]), 'segments sorted by time');
	ok(segs[0].from === h.dataAt + 400, "the first CueTrackPositions wins, not the second track's");
}

// Nothing to go on: no Cues, no Segment, empty input.
{
	const h = header();
	ok(segments(h.bytes, 0, el(TRACKS, new Uint8Array(4)), 1000, 5).length === 0, 'no Cues element, no segments');
	ok(segments(ebmlHeader, 0, cues([[0, 400]]), 1000, 5).length === 0, 'no Segment in the header, no segments');
	ok(segments(new Uint8Array(), 0, new Uint8Array(), 0, 0).length === 0, 'empty input');
	const cut = cues([[0, 400], [5000, 9000]]);
	ok(segments(h.bytes, 0, cut.subarray(0, cut.length - 3), 20_000, 10).length <= 2, 'a truncated index does not throw');
}

// --- classOf() -------------------------------------------------------------------------------

ok(classOf({ width: 1920, height: 1080 }) === 1080, '16:9 1080p is 1080');
ok(classOf({ width: 2560, height: 1068 }) === 1440, 'a cinematic 2560-wide encode is 1440p');
ok(classOf({ width: 1920, height: 800 }) === 1080, 'a cinematic 1920-wide encode is 1080p');
ok(classOf({ width: 1080, height: 1920 }) === 1920, 'a portrait video goes by its height');

// --- pickQuality() ---------------------------------------------------------------------------

const ladder = [144, 240, 360, 480, 720, 1080];
ok(pickQuality(ladder, 0) === 0, 'a parked 0x0 element takes the smallest');
ok(pickQuality(ladder, 236 * 1.17) === 2, 'the small view (236 px at 117%) takes 360p, not 240p');
ok(pickQuality(ladder, 1028 * 1.17) === 5, 'cinema on a 1200-high screen takes 1080p');
ok(pickQuality(ladder, 1050) === 5, 'within 5% under a class takes that class');
ok(pickQuality(ladder, 365) === 2, 'just over a class, within 5%, keeps it');
ok(pickQuality(ladder, 400) === 3, 'past the 5% margin goes up one');
ok(pickQuality(ladder, 5000) === 5, 'bigger than every quality takes the largest');
ok(pickQuality(ladder, 5000, 3) === 3, 'never above the bandwidth ceiling');
ok(pickQuality(ladder, 100, 3) === 0, 'the ceiling does not raise a small pick');
ok(pickQuality([], 500) === 0, 'an empty ladder still answers an index');

// --- isStale() -------------------------------------------------------------------------------

const segs: Segment[] = [
	{ start: 0, end: 5, from: 0, to: 99 },
	{ start: 5, end: 10.5, from: 100, to: 199 }
];
const as = new Map([[0, 2], [5000, 5]]);
ok(isStale(as, segs, 5, 2) === true, 'a 360p segment met while 1080p is wanted is stale');
ok(isStale(as, segs, 5, 7) === false, 'a 1080p segment is not');
ok(isStale(as, segs, 2, 7) === true, 'staleness goes both ways');
ok(isStale(as, segs, 5, 20) === false, 'past the last segment, nothing to judge');
ok(isStale(new Map(), segs, 5, 2) === false, 'never appended (buffered by something else) is not stale');
ok(isStale(as, undefined, 5, 2) === false, 'no index yet, not stale');
ok(isStale(as, segs, 5, 5) === false, 'a boundary belongs to the segment it starts');

// Without a duration (or one short of the last cue), the last segment gets ten seconds.
{
	const h = header();
	ok(segments(h.bytes, 0, cues([[0, 400], [5000, 9000]]), 20_000, 0)[1].end === 15, 'no duration: last cue + 10 s');
	ok(segments(h.bytes, 0, cues([[0, 400], [5000, 9000]]), 20_000, 4)[1].end === 15, 'a duration short of the last cue: + 10 s');
}

// --- nextSegment() ---------------------------------------------------------------------------

{
	const ladderSegs: Segment[] = [
		{ start: 0, end: 5, from: 0, to: 99 },
		{ start: 5, end: 9.5, from: 100, to: 199 },
		{ start: 9.5, end: 14.2, from: 200, to: 299 }
	];
	const none = () => false;
	ok(nextSegment(ladderSegs, 0, none)?.start === 0, 'nothing buffered: the first');
	ok(nextSegment(ladderSegs, 5, none)?.start === 5, 'buffered to a boundary: the one after it');
	ok(nextSegment(ladderSegs, 7, none)?.start === 5, 'buffered into a segment: that segment');
	ok(nextSegment(ladderSegs, 14.2, none) === undefined, 'buffered to the end: nothing, end of stream');
	// The loop this guards against: the media ends short of the duration YouTube gave (its
	// approxDurationMs), so by time alone the last segment never looks fetched.
	const fetched = new Set([0, 5, 9.5]);
	ok(nextSegment(ladderSegs, 14.0, none)?.start === 9.5, 'by time alone the last segment looks unfetched');
	ok(nextSegment(ladderSegs, 14.0, (s) => fetched.has(s.start)) === undefined, 'appended and buffered, it is not fetched again');
}

// --- tooSlow() -------------------------------------------------------------------------------

const six: Segment = { start: 10, end: 16, from: 0, to: 0 };
ok(!tooSlow(150, six), 'a 6 s segment in 150 ms keeps up');
ok(!tooSlow(5300, six), 'just under 90% still keeps up');
ok(tooSlow(5400, six), '90% of its length is too slow');
ok(tooSlow(9000, six), 'longer than it plays is too slow');

console.log('ok');
