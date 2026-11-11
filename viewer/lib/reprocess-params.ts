import { canonicalizeYouTubeUrlIfPossible } from "./youtube-url";

type ReprocessVideoRow = {
  youtube_url: string;
  title: string | null;
  r2_key?: string | null;
  r2_url?: string | null;
};

type ReprocessParams = {
  source: string;
  title: string | null;
  video_url?: string;
  raw_source?: string;
};

export function buildFullReprocessParams(video: ReprocessVideoRow): ReprocessParams {
  if (video.r2_key) {
    return {
      source: video.r2_key,
      title: video.title,
      video_url: video.r2_url || video.youtube_url,
    };
  }

  const source = canonicalizeYouTubeUrlIfPossible(video.youtube_url);
  return {
    source,
    title: video.title,
    ...(source !== video.youtube_url ? { raw_source: video.youtube_url } : {}),
  };
}
