declare namespace YT {
  class Player {
    constructor(
      element: HTMLElement | string,
      config: {
        videoId: string;
        playerVars?: Record<string, unknown>;
        events?: {
          onError?: (event: { target: Player; data: number }) => void;
          onReady?: (event: { target: Player }) => void;
          onStateChange?: (event: OnStateChangeEvent) => void;
        };
      }
    );
    getCurrentTime(): number;
    getIframe(): HTMLIFrameElement;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    destroy(): void;
  }

  interface OnStateChangeEvent {
    data: number;
    target: Player;
  }

  enum PlayerState {
    UNSTARTED = -1,
    ENDED = 0,
    PLAYING = 1,
    PAUSED = 2,
    BUFFERING = 3,
    CUED = 5,
  }
}
