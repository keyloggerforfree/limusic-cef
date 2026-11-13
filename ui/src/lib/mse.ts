// limusic-cef: the music video as an adaptive stream, over Media Source Extensions.
//
// Upstream plays one VP9 format as a plain `<video src>`, sized once to the player view's box. On
// the CEF build that one element is the only picture there is, cinema mode included, so one size
// is always wrong somewhere: a 1080p stream shimmers when Chromium shrinks it into the small view,
// and a box-sized one is soft fullscreen. So `video_stream` resolves every quality up to what the
// screen shows (src-tauri/src/cef.rs, orchestrator/mse.rs) and hands back `limusic-mse:<videoId>`,
// and this turns that into a MediaSource fed segment by segment, in the quality the picture is
// drawn at, the way YouTube's own player does. A quality change lands at a segment boundary with
// no re-buffer.
//
// VideoSurface.svelte keeps the element in step with mpv exactly as before: seeks, rate trims and
// the readyState it waits on all behave on a MediaSource as on a file. It only reaches the source
// through the four functions below, which do what the element itself did for any other URL.

import { invoke } from '@tauri-apps/api/core';
import {
	classOf,
	isStale,
	nextSegment,
	pickQuality,
	segments,
	tooSlow,
	type Segment
} from './mseplan';

type Rendition = {
	url: string;
	itag: number;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	mime: string;
	length: number;
	init: [number, number];
	index: [number, number];
};
type Manifest = { duration: number; renditions: Rendition[] };

type Track = { r: Rendition; init?: Uint8Array; segments?: Segment[]; header?: Promise<void> };

const PREFIX = 'limusic-mse:';
/** How far ahead of the playhead to hold, and how much behind it to keep before evicting. */
const AHEAD = 30;
const BEHIND = 20;
/** A quality change takes over at the first segment boundary at least this far past the playhead:
 *  what is buffered up to there keeps playing while the first segment in the new quality arrives.
 *  Never inside the segment being shown, or the picture stalls until its replacement lands. */
const SWITCH_LEAD = 1;
/** How long the picture's box has to hold still before a quality is picked for it: opening the
 *  view or cinema animates it through several sizes on the way. */
const SETTLE = 250;
/** After falling back for bandwidth, don't climb again for this long (ms). */
const DOWNGRADE_HOLD = 60000;
const RETRIES = 3;

const players = new WeakMap<HTMLVideoElement, Player>();

/** The source the element was given: the `limusic-mse:` one for an adaptive stream, else `src`. */
export function videoSource(el: HTMLVideoElement): string | null {
	return players.get(el)?.source ?? el.getAttribute('src');
}

/** Give the element a source, as setting `src` would. A `limusic-mse:` one plays adaptively. */
export function setVideoSource(el: HTMLVideoElement, url: string) {
	if (videoSource(el) === url) return;
	players.get(el)?.close();
	players.delete(el);
	if (url.startsWith(PREFIX)) players.set(el, new Player(el, url));
	else el.setAttribute('src', url);
}

/** Take the source away, as removing `src` does. The caller's `load()` then releases the
 *  pipeline, as it must after removing `src` from any element. */
export function clearVideoSource(el: HTMLVideoElement) {
	players.get(el)?.close();
	players.delete(el);
	el.removeAttribute('src');
}

/** How far past the music to aim a seek that has to fetch: what one costs here. VideoSurface's
 *  SEEK_COST, a second, is WebKit's GStreamer re-buffer; a segment through the proxy is a tenth of
 *  that, so leading by a second landed the picture almost a second early and the trim then took
 *  seconds to close it. Measured per stream, `fallback` until a seek has been timed. */
export function seekLead(el: HTMLVideoElement, fallback: number): number {
	return players.get(el)?.seekCost ?? fallback;
}

/** Reload the source for a `crossOrigin` change. A MediaSource is same-origin already, so the
 *  ambient light can read it either way and there is nothing to reload. */
export function reloadVideoSource(el: HTMLVideoElement) {
	if (!players.has(el)) el.load();
}

class Player {
	readonly source: string;
	private readonly el: HTMLVideoElement;
	private readonly videoId: string;
	private readonly ms = new MediaSource();
	private readonly objectUrl: string;
	private readonly fetches = new AbortController();
	private readonly resize: ResizeObserver;
	private sb: SourceBuffer | null = null;
	private tracks: Track[] = [];
	private duration = 0;
	/** The rendition whose header the buffer last took, and the one the picture wants now. */
	private appended = -1;
	private want = 0;
	/** Set by a quality change: drop what is buffered past the first boundary after this point and
	 *  refill it at `want`. */
	private replaceFrom: number | null = null;
	/** Set by a seek into a segment buffered in another quality: drop from that segment on, so the
	 *  seek fetches the quality the picture wants instead of playing the stale one. */
	private dropFrom: number | null = null;
	/** Which quality each buffered segment was appended in, by its start (ms). */
	private appendedAs = new Map<number, number>();
	/** No climbing above this until the time it holds: set when a segment came in too slow. */
	private ceiling = Infinity;
	private ceilingUntil = 0;
	private pumping = false;
	private again = false;
	private closed = false;
	private seekAbort: AbortController | null = null;
	private settle: ReturnType<typeof setTimeout> | undefined;
	/** Seconds an unbuffered seek takes to land (seeking to seeked), averaged; and the one timing. */
	seekCost = 0.25;
	private seekStarted = 0;

	constructor(el: HTMLVideoElement, source: string) {
		this.el = el;
		this.source = source;
		this.videoId = source.slice(PREFIX.length);
		this.objectUrl = URL.createObjectURL(this.ms);
		this.ms.addEventListener('sourceopen', () => this.open(), { once: true });
		el.addEventListener('seeking', this.onSeeking);
		el.addEventListener('seeked', this.onSeeked);
		el.addEventListener('timeupdate', this.wake);
		el.addEventListener('waiting', this.wake);
		this.resize = new ResizeObserver(() => {
			clearTimeout(this.settle);
			this.settle = setTimeout(() => this.pick(), SETTLE);
		});
		this.resize.observe(el);
		el.setAttribute('src', this.objectUrl);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.fetches.abort();
		this.seekAbort?.abort();
		this.resize.disconnect();
		clearTimeout(this.settle);
		this.el.removeEventListener('seeking', this.onSeeking);
		this.el.removeEventListener('seeked', this.onSeeked);
		this.el.removeEventListener('timeupdate', this.wake);
		this.el.removeEventListener('waiting', this.wake);
		URL.revokeObjectURL(this.objectUrl);
	}

	private async open() {
		const manifest = await invoke<Manifest | null>('cef_video_manifest', {
			videoId: this.videoId
		}).catch(() => null);
		if (this.closed) return;
		const renditions = manifest?.renditions.filter((r) => MediaSource.isTypeSupported(r.mime));
		if (!manifest || !renditions?.length) return this.fail('no manifest');
		this.tracks = renditions.sort((a, b) => classOf(a) - classOf(b)).map((r) => ({ r }));
		this.duration = manifest.duration;
		try {
			this.sb = this.ms.addSourceBuffer(this.tracks[0].r.mime);
			if (this.duration > 0) this.ms.duration = this.duration;
		} catch (e) {
			return this.fail(e);
		}
		this.want = this.wanted();
		this.wake();
	}

	/** The smallest quality that covers the picture as drawn, in device pixels: the element's box,
	 *  as `object-contain` fits a 16:9 frame into it. Parked at 0x0, that is the smallest one. */
	private wanted(): number {
		const px =
			Math.min(this.el.clientHeight, (this.el.clientWidth * 9) / 16) * devicePixelRatio;
		const ceiling = performance.now() < this.ceilingUntil ? this.ceiling : undefined;
		return pickQuality(
			this.tracks.map((t) => classOf(t.r)),
			px,
			ceiling
		);
	}

	/** The box changed (the view opened, cinema toggled, the window resized): follow it. */
	private pick() {
		if (!this.tracks.length || this.closed) return;
		const want = this.wanted();
		if (want === this.want) return;
		// Either way the buffered stretch ahead is replaced: up so the sharper picture arrives in
		// seconds, down because what is buffered (up to AHEAD of it) is what shimmers.
		this.replaceFrom = this.el.currentTime + SWITCH_LEAD;
		this.want = want;
		this.wake();
	}

	private onSeeking = () => {
		// A seek outside the buffer needs the segment it landed in, not the one in flight. So does
		// one into a stretch buffered before the last quality change (the small view's 360p, met
		// again from cinema): it is dropped and fetched again, which costs the seek a segment.
		const t = this.el.currentTime;
		let cold = !this.bufferedAt(t);
		if (!cold && this.staleAt(t)) {
			this.dropFrom = t;
			cold = true;
		}
		this.seekStarted = cold ? performance.now() : 0;
		if (cold) this.seekAbort?.abort();
		this.wake();
	};

	private onSeeked = () => {
		if (!this.seekStarted) return;
		const took = (performance.now() - this.seekStarted) / 1000;
		this.seekStarted = 0;
		// A slow outlier (a stalled request) should not swing the next lead by itself.
		this.seekCost = Math.min(1, this.seekCost * 0.7 + took * 0.3);
	};

	private wake = () => {
		if (this.closed || !this.sb) return;
		if (this.pumping) {
			this.again = true;
			return;
		}
		this.pumping = true;
		void this.pump().finally(() => (this.pumping = false));
	};

	private async pump() {
		do {
			this.again = false;
			try {
				while (!this.closed && (await this.step()));
			} catch (e) {
				if (this.closed) return;
				if ((e as Error)?.name !== 'AbortError') return this.fail(e);
			}
		} while (this.again && !this.closed);
	}

	/** One unit of work: a header, a segment, or nothing to do. True if it did something. */
	private async step(): Promise<boolean> {
		const sb = this.sb!;
		const t = this.el.currentTime;
		const track = this.tracks[this.want];
		await this.header(track);
		const segs = track.segments!;

		if (this.dropFrom !== null) {
			const at = segs.find((s) => s.start <= this.dropFrom! && s.end > this.dropFrom!);
			this.dropFrom = null;
			this.replaceFrom = null; // everything from here on goes anyway
			if (at) {
				await this.op(() => sb.remove(at.start, Infinity));
				return true;
			}
		}

		if (this.replaceFrom !== null) {
			const at = segs.find((s) => s.start >= this.replaceFrom!);
			this.replaceFrom = null;
			if (at && this.bufferedEnd(t) > at.start) {
				await this.op(() => sb.remove(at.start, Infinity));
				return true;
			}
		}

		const ahead = this.bufferedEnd(t);
		if (ahead - t >= AHEAD) return this.evict(t);
		const seg = nextSegment(
			segs,
			ahead,
			(s) =>
				this.appendedAs.get(Math.round(s.start * 1000)) === this.want &&
				this.bufferedAt(s.start + 0.01)
		);
		if (!seg) {
			if (this.ms.readyState === 'open' && !sb.updating) this.ms.endOfStream();
			return this.evict(t);
		}
		if (this.appended !== this.want) {
			await this.append(track.init!);
			this.appended = this.want;
		}
		const as = this.want;
		const began = performance.now();
		const data = await this.fetchRange(track.r.url, seg.from, seg.to);
		this.judge(performance.now() - began, seg);
		await this.append(data);
		this.appendedAs.set(Math.round(seg.start * 1000), as);
		return true;
	}

	/** Whether the segment `t` is in was buffered in a quality other than the one wanted now. */
	private staleAt(t: number) {
		return isStale(this.appendedAs, this.tracks[this.want]?.segments, this.want, t);
	}

	/** A segment that took longer to arrive than it lasts means this quality can't be kept up:
	 *  step down one, and hold there a while before climbing again. */
	private judge(ms: number, seg: Segment) {
		if (this.want === 0 || !tooSlow(ms, seg)) return;
		this.ceiling = this.want - 1;
		this.ceilingUntil = performance.now() + DOWNGRADE_HOLD;
		this.want = this.ceiling;
		this.replaceFrom = this.el.currentTime + SWITCH_LEAD;
	}

	/** Drop what is well behind the playhead. Returns false: there was nothing else to do. */
	private async evict(t: number): Promise<boolean> {
		const sb = this.sb!;
		if (sb.buffered.length && t - sb.buffered.start(0) > BEHIND + 10) {
			await this.op(() => sb.remove(0, t - BEHIND));
		}
		return false;
	}

	/** The rendition's header and segment index, fetched once. */
	private header(track: Track): Promise<void> {
		track.header ??= (async () => {
			const [i0, i1] = track.r.init;
			const [x0, x1] = track.r.index;
			// Usually back to back (WebM puts the Cues right after the header), so one request.
			const together = Math.abs(x0 - i1) < 65536;
			const head = together
				? await this.fetchRange(track.r.url, Math.min(i0, x0), Math.max(i1, x1))
				: await this.fetchRange(track.r.url, i0, i1);
			const base = together ? Math.min(i0, x0) : i0;
			track.init = head.slice(i0 - base, i1 - base + 1);
			const index = together
				? head.subarray(x0 - base, x1 - base + 1)
				: await this.fetchRange(track.r.url, x0, x1);
			track.segments = segments(track.init, i0, index, track.r.length, this.duration);
			if (!track.segments.length) throw new Error(`no segment index for itag ${track.r.itag}`);
		})();
		return track.header.catch((e) => {
			track.header = undefined; // a failed fetch may be retried on the next step
			throw e;
		});
	}

	private async fetchRange(url: string, from: number, to: number): Promise<Uint8Array> {
		for (let attempt = 0; ; attempt++) {
			this.seekAbort = new AbortController();
			const signal = AbortSignal.any([this.fetches.signal, this.seekAbort.signal]);
			try {
				const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return new Uint8Array(await res.arrayBuffer());
			} catch (e) {
				if ((e as Error)?.name === 'AbortError' || attempt + 1 >= RETRIES) throw e;
				await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
			}
		}
	}

	/** Append, evicting what is behind once if the buffer is full. */
	private async append(data: Uint8Array) {
		const sb = this.sb!;
		try {
			await this.op(() => sb.appendBuffer(data as BufferSource));
		} catch (e) {
			if ((e as Error)?.name !== 'QuotaExceededError') throw e;
			const t = this.el.currentTime;
			await this.op(() => sb.remove(0, Math.max(0, t - 2)));
			await this.op(() => sb.appendBuffer(data as BufferSource));
		}
	}

	/** Run one SourceBuffer operation and wait for it to finish. */
	private op(run: () => void): Promise<void> {
		const sb = this.sb!;
		return new Promise((resolve, reject) => {
			const done = () => {
				sb.removeEventListener('updateend', done);
				sb.removeEventListener('error', failed);
				resolve();
			};
			const failed = () => {
				sb.removeEventListener('updateend', done);
				sb.removeEventListener('error', failed);
				reject(new Error('SourceBuffer error'));
			};
			sb.addEventListener('updateend', done);
			sb.addEventListener('error', failed);
			try {
				run();
			} catch (e) {
				sb.removeEventListener('updateend', done);
				sb.removeEventListener('error', failed);
				reject(e);
			}
		});
	}

	private bufferedAt(t: number) {
		const b = this.el.buffered;
		for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t < b.end(i)) return true;
		return false;
	}

	/** Where the buffered stretch the playhead is in ends, or the playhead if it is in none. */
	private bufferedEnd(t: number) {
		const b = this.sb?.buffered;
		if (!b) return t;
		for (let i = 0; i < b.length; i++) {
			if (t >= b.start(i) - 0.1 && t < b.end(i)) return b.end(i);
		}
		return t;
	}

	/** Give up on this video the way a broken file does: an `error` on the element, which
	 *  VideoSurface answers by forgetting the URL and falling back to the artwork. */
	private fail(why: unknown) {
		if (this.closed) return;
		console.warn('music video (mse):', why);
		this.close();
		this.el.dispatchEvent(new Event('error'));
	}
}
