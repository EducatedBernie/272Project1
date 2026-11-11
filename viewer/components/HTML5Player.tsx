"use client";

import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";

export interface HTML5PlayerHandle {
  seekTo: (seconds: number) => void;
}

interface HTML5PlayerProps {
  videoUrl: string;
  onTimeUpdate: (time: number) => void;
  startAt?: number;
  title?: string;
}

const HTML5Player = forwardRef<HTML5PlayerHandle, HTML5PlayerProps>(
  function HTML5Player({ videoUrl, onTimeUpdate, startAt, title }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const onTimeUpdateRef = useRef(onTimeUpdate);

    useEffect(() => {
      onTimeUpdateRef.current = onTimeUpdate;
    }, [onTimeUpdate]);

    useImperativeHandle(ref, () => ({
      seekTo: (seconds: number) => {
        if (videoRef.current) {
          videoRef.current.currentTime = seconds;
        }
      },
    }));

    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      const handleTimeUpdate = () => {
        onTimeUpdateRef.current(video.currentTime);
      };

      const handleLoaded = () => {
        if (startAt) {
          video.currentTime = startAt;
        }
      };

      video.addEventListener("timeupdate", handleTimeUpdate);
      video.addEventListener("loadedmetadata", handleLoaded);

      return () => {
        video.removeEventListener("timeupdate", handleTimeUpdate);
        video.removeEventListener("loadedmetadata", handleLoaded);
      };
    }, [videoUrl, startAt]);

    return (
      <div className="aspect-video w-full">
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          // playsInline keeps the video inline on iOS Safari instead of
          // forcing fullscreen on play (default iPhone behavior pre-attribute).
          playsInline
          preload="metadata"
          className="w-full h-full"
          aria-label={title?.trim() ? `${title} video` : "Lecture video"}
        />
      </div>
    );
  }
);

export default HTML5Player;
