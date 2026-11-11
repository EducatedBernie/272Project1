"use client";

import { forwardRef } from "react";
import YouTubePlayer from "./YouTubePlayer";
import HTML5Player from "./HTML5Player";
import type { VideoSource } from "@/lib/types";

export interface PlayerHandle {
  seekTo: (seconds: number) => void;
}

interface VideoPlayerProps {
  source: VideoSource;
  onTimeUpdate: (time: number) => void;
  startAt?: number;
  title?: string;
}

const VideoPlayer = forwardRef<PlayerHandle, VideoPlayerProps>(
  function VideoPlayer({ source, onTimeUpdate, startAt, title }, ref) {
    if (source.type === "upload") {
      return (
        <HTML5Player
          ref={ref}
          videoUrl={source.videoUrl}
          onTimeUpdate={onTimeUpdate}
          startAt={startAt}
          title={title}
        />
      );
    }

    return (
      <YouTubePlayer
        ref={ref}
        videoId={source.videoId}
        onTimeUpdate={onTimeUpdate}
        startAt={startAt}
        title={title}
      />
    );
  }
);

export default VideoPlayer;
