export type RemuxTrackCandidate = {
  id: number;
  type: "video" | "audio" | "subtitle";
  codec: string | null;
  /** Exact RFC 6381 codec string reported by the Matroska demuxer. */
  codecParameter?: string | null;
  language: string;
  primary: boolean;
};

export type BrowserRemuxPlan = {
  videoId: number | null;
  audioId: number | null;
  /** Dolby audio must be decoded and encoded as AAC for reliable MSE playback. */
  transcodeAudio: boolean;
  mime: string;
};

export const PASSTHROUGH_VIDEO_CODECS = ["avc", "hevc", "av1", "vp9"];
export const PASSTHROUGH_AUDIO_CODECS = ["aac", "ac3", "eac3", "mp3"];

const RELIABLE_MSE_AUDIO_CODECS = ["aac", "mp3"];
const DOLBY_AUDIO_CODECS = ["ac3", "eac3"];

const FALLBACK_CODEC_PARAMETERS: Record<string, string> = {
  avc: "avc1.640028",
  hevc: "hvc1.1.6.L93.B0",
  av1: "av01.0.08M.08",
  vp9: "vp09.00.10.08",
  aac: "mp4a.40.2",
  mp3: "mp4a.40.34",
  ac3: "ac-3",
  eac3: "ec-3",
};

const ISO_639_ALIASES: Record<string, string> = {
  eng: "en",
  spa: "es",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  ita: "it",
  por: "pt",
  jpn: "ja",
  zho: "zh",
  chi: "zh",
  kor: "ko",
};

export function remuxLanguageRoot(value: string | null | undefined) {
  const root = (value || "").trim().toLowerCase().split(/[-_]/, 1)[0] || "";
  return ISO_639_ALIASES[root] || root;
}

function orderedVideos(tracks: RemuxTrackCandidate[]) {
  return tracks
    .filter(
      (track) =>
        track.type === "video" &&
        track.codec !== null &&
        PASSTHROUGH_VIDEO_CODECS.includes(track.codec),
    )
    .sort((left, right) => {
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      return (
        PASSTHROUGH_VIDEO_CODECS.indexOf(left.codec!) -
        PASSTHROUGH_VIDEO_CODECS.indexOf(right.codec!)
      );
    });
}

function orderedAudios(
  tracks: RemuxTrackCandidate[],
  preference?: string,
  deviceLanguage?: string,
) {
  const audios = tracks.filter(
    (track) =>
      track.type === "audio" &&
      track.codec !== null &&
      PASSTHROUGH_AUDIO_CODECS.includes(track.codec),
  );
  const preferredLanguage =
    preference === "device"
      ? remuxLanguageRoot(deviceLanguage)
      : ["", "default", "original", "none"].includes(preference || "")
        ? ""
        : remuxLanguageRoot(preference);

  return audios
    .map((track, index) => ({
      track,
      index,
      languageMatch:
        preferredLanguage &&
        remuxLanguageRoot(track.language) === preferredLanguage,
    }))
    .sort((left, right) => {
      if (left.languageMatch !== right.languageMatch)
        return left.languageMatch ? -1 : 1;
      if (left.track.primary !== right.track.primary)
        return left.track.primary ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ track }) => track);
}

function codecParameter(track: RemuxTrackCandidate) {
  const exact = track.codecParameter?.trim();
  return exact || (track.codec ? FALLBACK_CODEC_PARAMETERS[track.codec] : "") || "";
}

export function remuxMime(
  video: RemuxTrackCandidate,
  audioCodecParameter: string,
) {
  const videoCodecParameter = codecParameter(video);
  if (!videoCodecParameter || !audioCodecParameter) return "";
  return `video/mp4; codecs="${videoCodecParameter},${audioCodecParameter}"`;
}

/**
 * Builds a plan for the current browser instead of treating every codec that
 * MP4 can contain as one the browser can decode. AAC/MP3 are copied as-is.
 * AC-3/E-AC-3 are converted to AAC because Chromium does not reliably expose
 * Dolby audio to MSE, while Safari's support varies by device/output route.
 */
export function selectBrowserRemuxPlan(
  tracks: RemuxTrackCandidate[],
  preference: string | undefined,
  deviceLanguage: string | undefined,
  isTypeSupported: (mime: string) => boolean,
): BrowserRemuxPlan {
  const videos = orderedVideos(tracks);
  const audios = orderedAudios(tracks, preference, deviceLanguage);

  // Avoid a costly WASM transcode when a preferred/primary browser-safe
  // audio track can be copied directly.
  for (const video of videos) {
    for (const audio of audios) {
      if (!audio.codec || !RELIABLE_MSE_AUDIO_CODECS.includes(audio.codec))
        continue;
      const mime = remuxMime(video, codecParameter(audio));
      if (mime && isTypeSupported(mime)) {
        return {
          videoId: video.id,
          audioId: audio.id,
          transcodeAudio: false,
          mime,
        };
      }
    }
  }

  // Re-encoding only the audio keeps H.264/HEVC packets untouched and is
  // dramatically cheaper than transcoding the whole video.
  for (const video of videos) {
    const mime = remuxMime(video, FALLBACK_CODEC_PARAMETERS.aac);
    if (!mime || !isTypeSupported(mime)) continue;
    const audio = audios.find(
      (candidate) =>
        candidate.codec !== null && DOLBY_AUDIO_CODECS.includes(candidate.codec),
    );
    if (audio) {
      return {
        videoId: video.id,
        audioId: audio.id,
        transcodeAudio: true,
        mime,
      };
    }
  }

  return { videoId: null, audioId: null, transcodeAudio: false, mime: "" };
}

export function selectRemuxTrackPair(
  tracks: RemuxTrackCandidate[],
  preference?: string,
  deviceLanguage?: string,
) {
  const videos = orderedVideos(tracks);
  const audio = orderedAudios(tracks, preference, deviceLanguage)[0];

  return { videoId: videos[0]?.id ?? null, audioId: audio?.id ?? null };
}
