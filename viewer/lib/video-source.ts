import type { VideoSource } from "@/lib/types";
import { extractYouTubeId } from "@/lib/youtube-url";

export { extractYouTubeId };

export function getVideoSource(video: { youtube_url: string; r2_url?: string | null }): VideoSource | null {
  if (video.r2_url) {
    return { type: "upload", videoUrl: video.r2_url };
  }
  const ytId = extractYouTubeId(video.youtube_url);
  if (ytId) {
    return { type: "youtube", videoId: ytId };
  }
  if (video.youtube_url.startsWith("/") || video.youtube_url.startsWith("http")) {
    return { type: "upload", videoUrl: `/api/video-file?path=${encodeURIComponent(video.youtube_url)}` };
  }
  return null;
}
