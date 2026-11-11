"use client";

import { useEffect, useRef, useImperativeHandle, useState, forwardRef } from "react";
import { mountYouTubePlayer } from "@/lib/youtube-player";

export interface YouTubePlayerHandle {
  seekTo: (seconds: number) => void;
}

interface YouTubePlayerProps {
  videoId: string;
  onTimeUpdate: (time: number) => void;
  startAt?: number;
  title?: string;
}

const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function YouTubePlayer({ videoId, onTimeUpdate, startAt, title }, ref) {
    const playerRef = useRef<ReturnType<typeof mountYouTubePlayer> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const pendingSeekRef = useRef<{ videoId: string; seconds: number } | undefined>(undefined);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    const [attempt, setAttempt] = useState(0);
    const [failedVideoId, setFailedVideoId] = useState<string | null>(null);
    const [delayedVideoId, setDelayedVideoId] = useState<string | null>(null);
    const [errorCode, setErrorCode] = useState<number | undefined>();
    const [watchTime, setWatchTime] = useState({ videoId, seconds: startAt ?? 0 });
    const iframeTitle = title?.trim() ? `${title} video` : "Lecture video";
    const watchHref = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(watchTime.videoId === videoId ? watchTime.seconds : startAt ?? 0)}s`;
    const retry = () => {
      if (watchTime.videoId === videoId) pendingSeekRef.current = watchTime;
      setFailedVideoId(null); setDelayedVideoId(null); setErrorCode(undefined);
      setAttempt(value => value + 1);
    };

    useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

    useImperativeHandle(ref, () => ({
      seekTo: (seconds: number) => {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        setWatchTime({ videoId, seconds });
        if (playerRef.current) playerRef.current.seekTo(seconds);
        else pendingSeekRef.current = { videoId, seconds };
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;
      const player = mountYouTubePlayer(containerRef.current, {
        videoId, title: iframeTitle, startAt,
        onTimeUpdate: (time) => onTimeUpdateRef.current(time),
        onError: (code) => { setFailedVideoId(videoId); setErrorCode(code); },
        onDelayed: () => setDelayedVideoId(videoId),
        onReady: () => { setFailedVideoId(null); setDelayedVideoId(null); setErrorCode(undefined); },
      });
      playerRef.current = player;
      if (pendingSeekRef.current?.videoId === videoId) {
        player.seekTo(pendingSeekRef.current.seconds);
      }
      pendingSeekRef.current = undefined;
      return () => {
        playerRef.current = null;
        player.destroy();
      };
    }, [videoId, startAt, iframeTitle, attempt]);

    return (
      <div>
        <div className="aspect-video min-h-[200px] w-full" ref={containerRef} />
        {failedVideoId === videoId ? (
          <p role="status" className="text-sm p-3" style={{ background: "var(--paper)", color: "var(--foreground)" }}>
            The embedded video could not load{errorCode !== undefined ? ` (YouTube error ${errorCode})` : ""}. <button type="button" className="underline" onClick={retry}>Retry video</button> or <a className="underline" href={watchHref} target="_blank" rel="noreferrer">Watch on YouTube</a>.
          </p>
        ) : delayedVideoId === videoId ? (
          <p role="status" className="text-sm p-3" style={{ background: "var(--paper)", color: "var(--foreground)" }}>
            The video hasn’t connected. Your browser or network may be blocking the embed. <button type="button" className="underline" onClick={retry}>Retry video</button> or <a className="underline" href={watchHref} target="_blank" rel="noreferrer">Watch on YouTube</a>.
          </p>
        ) : null}
      </div>
    );
  }
);

export default YouTubePlayer;
