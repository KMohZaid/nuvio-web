export type RemuxTrackCandidate = {
  id: number;
  type: "video" | "audio" | "subtitle";
  codec: string | null;
  language: string;
  primary: boolean;
};

export const PASSTHROUGH_VIDEO_CODECS = ["avc", "hevc", "av1", "vp9"];
export const PASSTHROUGH_AUDIO_CODECS = ["aac", "ac3", "eac3", "mp3"];

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

export function selectRemuxTrackPair(
  tracks: RemuxTrackCandidate[],
  preference?: string,
  deviceLanguage?: string,
) {
  const videos = tracks
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
  const audio =
    (preferredLanguage
      ? audios.find(
          (track) => remuxLanguageRoot(track.language) === preferredLanguage,
        )
      : undefined) ??
    audios.find((track) => track.primary) ??
    audios[0];

  return { videoId: videos[0]?.id ?? null, audioId: audio?.id ?? null };
}
