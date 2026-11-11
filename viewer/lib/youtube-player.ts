declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReady: Promise<void> | undefined;

function loadYouTubeAPI(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiReady) return apiReady;
  apiReady = new Promise<void>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    let settled = false;
    const script = document.createElement("script");
    const cleanup = () => {
      settled = true;
      if (window.onYouTubeIframeAPIReady === onReady) window.onYouTubeIframeAPIReady = previousReady;
    };
    const onReady = () => {
      if (settled) return;
      cleanup();
      try { previousReady?.(); } finally { resolve(); }
    };
    const fail = () => {
      if (settled) return;
      cleanup();
      apiReady = undefined;
      script.remove();
      reject(new Error("YouTube player could not load"));
    };
    window.onYouTubeIframeAPIReady = onReady;
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return apiReady;
}

/** Own YouTube's replaceable DOM and asynchronous lifecycle outside React's host. */
export function mountYouTubePlayer(host: HTMLElement, options: {
  videoId: string;
  title: string;
  startAt?: number;
  onTimeUpdate: (seconds: number) => void;
  onError: (code?: number) => void;
  onDelayed?: () => void;
  onReady?: () => void;
}) {
  let disposed = false;
  let instance: YT.Player | null = null;
  let readyPlayer: YT.Player | null = null;
  let pendingSeek: number | undefined = options.startAt;
  let interval: ReturnType<typeof setInterval> | undefined;
  const readyTimeout = setTimeout(() => { if (!disposed) options.onDelayed?.(); }, 15_000);

  const seekTo = (seconds: number) => {
    if (disposed || !Number.isFinite(seconds) || seconds < 0) return;
    pendingSeek = seconds;
    if (readyPlayer) {
      readyPlayer.seekTo(seconds, true);
      pendingSeek = undefined;
    }
  };

  // Load a normal embed first, then attach the API. Playback still works if its
  // bootstrap is blocked, and React never owns the element the API destroys.
  const target = document.createElement("iframe");
  const params = new URLSearchParams({
    autoplay: "0", modestbranding: "1", rel: "0", enablejsapi: "1",
    cc_load_policy: "1", playsinline: "1", origin: window.location.origin,
  });
  if (options.startAt) params.set("start", String(options.startAt));
  target.className = "w-full h-full border-0";
  target.title = options.title;
  target.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  target.allowFullscreen = true;
  target.referrerPolicy = "strict-origin-when-cross-origin";
  target.src = `https://www.youtube.com/embed/${encodeURIComponent(options.videoId)}?${params}`;
  host.replaceChildren(target);

  loadYouTubeAPI().then(() => {
    if (disposed) return;
    instance = new window.YT.Player(target, {
      videoId: options.videoId,
      events: {
        onReady: ({ target: player }) => {
          if (disposed) return;
          clearTimeout(readyTimeout);
          readyPlayer = player;
          options.onReady?.();
          player.getIframe().setAttribute("title", options.title);
          if (pendingSeek !== undefined) seekTo(pendingSeek);
          interval = setInterval(() => {
            if (!disposed && readyPlayer) options.onTimeUpdate(readyPlayer.getCurrentTime());
          }, 250);
        },
        onError: (event) => {
          clearTimeout(readyTimeout);
          if (!disposed) options.onError(event.data);
        },
      },
    });
  }).catch(() => {
    clearTimeout(readyTimeout);
    if (!disposed) options.onError();
  });

  return {
    seekTo,
    destroy() {
      if (disposed) return;
      disposed = true;
      readyPlayer = null;
      pendingSeek = undefined;
      clearTimeout(readyTimeout);
      clearInterval(interval);
      instance?.destroy();
      host.replaceChildren();
    },
  };
}
