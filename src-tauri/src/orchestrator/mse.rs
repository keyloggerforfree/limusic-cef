//! limusic-cef: the music video as a ladder of qualities, for the CEF build's MSE player
//! (ui/src/lib/mse.ts), where upstream resolves one format for one `<video src>`.
//!
//! The same two clients in the same order as [`Orchestrator::resolve_video`], and the same steps
//! per URL (decipher, `n`, PoToken, the tail probe for WEB_REMIX), only for every VP9 format the
//! player could switch to rather than the one that fits a box. A switch then costs the page a
//! segment, not a re-resolve.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

use futures_util::future::join_all;
use innertube::{Format, StreamingData, MAIN_CLIENT};

use super::{blacklist_blocks, content_length, Orchestrator};

/// One quality of the video: its format (sizes, ranges) and the URL googlevideo serves it at.
pub struct Rendition {
    pub format: Format,
    pub url: String,
}

/// The quality class a format fills as a 16:9 frame: a wide cinematic encode (2560x1068) is the
/// 1440p its width says, not the 1068 its height does, so it never outgrows a screen's width.
pub fn class(f: &Format) -> i32 {
    f.height.unwrap_or(0).max(f.width.unwrap_or(0) * 9 / 16)
}

/// The formats the player can switch between: VP9 video-only (the codec upstream picks too, for
/// the same reason: a stock Fedora has no High-profile H.264), with the header and index ranges
/// MSE needs, at most `max_height` by [`class`]. One per class: the smoother of a 30/60 fps pair,
/// then the better encode, as `find_video_format` breaks ties. Smallest first.
pub fn ladder(sd: &StreamingData, max_height: i32) -> Vec<&Format> {
    let mut best: BTreeMap<i32, &Format> = BTreeMap::new();
    let usable = sd.adaptive_formats.iter().filter(|f| {
        !f.is_audio()
            && f.mime_type.contains("vp9")
            && f.height.is_some()
            && class(f) <= max_height
            && f.init_range.as_ref().and_then(|r| r.bounds()).is_some()
            && f.index_range.as_ref().and_then(|r| r.bounds()).is_some()
            && content_length(f).is_some()
    });
    for f in usable {
        let key = |f: &Format| (f.fps.unwrap_or(30), f.bitrate);
        best.entry(class(f))
            .and_modify(|b| {
                if key(f) > key(b) {
                    *b = f;
                }
            })
            .or_insert(f);
    }
    best.into_values().collect()
}

impl Orchestrator {
    /// Every quality of `video_id`'s music video up to `max_height`, smallest first, or none when
    /// neither client has one. See the module docs.
    pub async fn resolve_video_ladder(
        &self,
        video_id: &str,
        max_height: i32,
        disabled: &HashSet<String>,
    ) -> Vec<Rendition> {
        let failed =
            self.video_failed.lock().is_ok_and(|m| blacklist_blocks(&m, video_id, Instant::now()));
        let order = if failed { ["VISIONOS", MAIN_CLIENT] } else { [MAIN_CLIENT, "VISIONOS"] };
        for key in order {
            if disabled.contains(key) {
                continue;
            }
            let renditions = if key == MAIN_CLIENT {
                self.web_remix_ladder(video_id, max_height).await
            } else {
                self.direct_ladder(key, video_id, max_height).await
            };
            if !renditions.is_empty() {
                tracing::debug!(
                    video_id,
                    client = key,
                    qualities = renditions.len(),
                    "video: ladder resolved"
                );
                return renditions;
            }
        }
        tracing::debug!(video_id, "video: no usable ladder");
        Vec::new()
    }

    /// [`Orchestrator::web_remix_video`] for every rung: the kept reply when there is one, else a
    /// `/player` of its own, and each URL signed and tail-probed like the single one. A rung that
    /// fails its probe is left out rather than failing the ladder.
    async fn web_remix_ladder(&self, video_id: &str, max_height: i32) -> Vec<Rendition> {
        let Some(client) = self.clients.get(MAIN_CLIENT) else { return Vec::new() };
        let visitor = self.it.visitor_data();
        let kept = self.video_replies.lock().ok().and_then(|mut m| m.remove(video_id));
        let sd = match kept.filter(|(until, _)| *until > Instant::now()) {
            Some((_, sd)) => sd,
            None => {
                let sts = self.cipher.signature_timestamp().await;
                let pot = match &visitor {
                    Some(vd) => self.potoken.get_session_po_token(vd).await,
                    None => None,
                };
                let Ok(resp) = self.it.player(client, video_id, None, sts, pot.as_deref()).await
                else {
                    return Vec::new();
                };
                if !resp.playability_status.is_ok() {
                    crate::import::note_playability(resp.playability_status.reason.as_deref());
                    tracing::debug!(video_id, status = %resp.playability_status.status, "video: WEB_REMIX not OK");
                    return Vec::new();
                }
                let Some(sd) = resp.streaming_data else { return Vec::new() };
                sd
            }
        };
        // Deciphered and signed one at a time: both go through the cipher webview, which upstream
        // only ever asks one question at a time, and asked six at once it dropped most of them.
        // Only the tail probes, plain network round trips, run together.
        let mut signed = Vec::new();
        for format in ladder(&sd, max_height) {
            let Some(url) = self.find_url(format, video_id).await else {
                tracing::debug!(
                    video_id,
                    itag = format.itag,
                    "video: WEB_REMIX URL not deciphered"
                );
                continue;
            };
            let url = self.sign(url, Some(client), video_id, visitor.as_deref()).await;
            signed.push((format, url));
        }
        let probes = signed.into_iter().map(|(format, url)| async move {
            if !self.validate_stream(&url, &HashMap::new(), content_length(format)).await {
                tracing::debug!(video_id, itag = format.itag, "video: WEB_REMIX URL refused");
                return None;
            }
            Some(Rendition { format: format.clone(), url })
        });
        join_all(probes).await.into_iter().flatten().collect()
    }

    /// [`Orchestrator::direct_video`] for every rung: nothing to decipher or sign.
    async fn direct_ladder(&self, key: &str, video_id: &str, max_height: i32) -> Vec<Rendition> {
        let Some(client) = self.clients.get(key) else { return Vec::new() };
        let resp = match self.it.player(client, video_id, None, None, None).await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(video_id, client = key, error = %e, "video: /player failed");
                return Vec::new();
            }
        };
        if !resp.playability_status.is_ok() {
            crate::import::note_playability(resp.playability_status.reason.as_deref());
            return Vec::new();
        }
        let Some(sd) = resp.streaming_data.as_ref() else { return Vec::new() };
        ladder(sd, max_height)
            .into_iter()
            .filter_map(|f| Some(Rendition { format: f.clone(), url: f.direct_url()?.to_owned() }))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use innertube::PlayerResponse;

    fn sd(formats: &str) -> StreamingData {
        let json = format!(
            r#"{{ "playabilityStatus": {{ "status": "OK" }},
                  "streamingData": {{ "adaptiveFormats": [{formats}] }} }}"#
        );
        serde_json::from_str::<PlayerResponse>(&json).unwrap().streaming_data.unwrap()
    }

    fn vp9(itag: i32, w: i32, h: i32, fps: i32) -> String {
        format!(
            r#"{{ "itag": {itag}, "url": "u{itag}", "mimeType": "video/webm; codecs=\"vp9\"",
                 "bitrate": {}, "width": {w}, "height": {h}, "fps": {fps}, "contentLength": "1000",
                 "initRange": {{ "start": "0", "end": "219" }},
                 "indexRange": {{ "start": "220", "end": "999" }} }}"#,
            w * h
        )
    }

    #[test]
    fn ladder_keeps_one_vp9_per_class_under_the_cap() {
        let formats = [
            vp9(243, 640, 360, 30),
            vp9(247, 1280, 720, 30),
            vp9(302, 1280, 720, 60),
            vp9(248, 1920, 1080, 30),
            vp9(271, 2560, 1440, 30),
            // H.264 and an audio stream never make the ladder.
            r#"{ "itag": 137, "url": "h", "mimeType": "video/mp4; codecs=\"avc1.640028\"", "bitrate": 1, "width": 1920, "height": 1080 }"#.into(),
            r#"{ "itag": 251, "url": "a", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 1 }"#.into(),
        ]
        .join(",");
        let sd = sd(&formats);
        let itags: Vec<i32> = ladder(&sd, 1080).iter().map(|f| f.itag).collect();
        assert_eq!(itags, [243, 302, 248]); // 720p60 over 720p30, no 1440p under a 1080 cap
    }

    /// A 1920x1200 screen caps at 1080, which must not let in a 2560-wide cinematic "1440p".
    #[test]
    fn ladder_measures_wide_encodes_by_width() {
        let sd = sd(&[vp9(248, 1920, 800, 24), vp9(271, 2560, 1068, 24)].join(","));
        let itags: Vec<i32> = ladder(&sd, 1080).iter().map(|f| f.itag).collect();
        assert_eq!(itags, [248]);
    }

    /// MSE cannot fetch a format whose header or index it cannot find.
    #[test]
    fn ladder_needs_the_ranges() {
        let bare = r#"{ "itag": 248, "url": "u", "mimeType": "video/webm; codecs=\"vp9\"", "bitrate": 1, "width": 1920, "height": 1080, "contentLength": "1000" }"#;
        assert!(ladder(&sd(bare), 1080).is_empty());
    }
}
