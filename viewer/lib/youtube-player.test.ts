import assert from "node:assert/strict";
import test from "node:test";
import { mountYouTubePlayer } from "./youtube-player";

test("slow YouTube readiness recovers without remount; actual errors remain distinguishable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const players: FakePlayer[] = [];
  class FakeElement {
    className = "";
    src = "";
    removed = false;
    onerror: (() => void) | null = null;
    children: FakeElement[] = [];
    appendChild(child: FakeElement) { this.children.push(child); return child; }
    replaceChildren(...children: FakeElement[]) { this.children = children; }
    setAttribute() {}
    remove() { this.removed = true; }
  }
  class FakePlayer {
    seekTo?: (seconds: number, ahead: boolean) => void;
    getCurrentTime?: () => number;
    seeks: number[] = [];
    constructor(readonly element: FakeElement, readonly options: { events: {
      onReady: (event: unknown) => void;
      onError: (event: unknown) => void;
    } }) { players.push(this); }
    getIframe() { return this.element; }
    ready() {
      this.seekTo = seconds => this.seeks.push(seconds);
      this.getCurrentTime = () => this.seeks.at(-1) ?? 0;
      this.options.events.onReady({ target: this });
    }
    destroy() { this.seekTo = undefined; }
  }
  const head = new FakeElement();
  Object.assign(globalThis, {
    window: { location: { origin: "http://localhost" } },
    document: { createElement: () => new FakeElement(), head },
  });
  const host = new FakeElement();
  const errors: (number | undefined)[] = [];
  let delayed = 0;
  let ready = 0;
  const options = {
    videoId: "0JUN9aDxVmI", title: "Lecture video", onTimeUpdate: () => {},
    onError: (code?: number) => errors.push(code), onDelayed: () => delayed++, onReady: () => ready++,
  };
  const handles: ReturnType<typeof mountYouTubePlayer>[] = [];
  try {
    const failed = mountYouTubePlayer(host as unknown as HTMLElement, options);
    handles.push(failed);
    head.children[0].onerror?.();
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(errors, [undefined], "only a real script error rejects the load");
    assert.equal(head.children[0].removed, true);
    failed.destroy();

    const first = mountYouTubePlayer(host as unknown as HTMLElement, options);
    const discarded = mountYouTubePlayer(new FakeElement() as unknown as HTMLElement, options);
    handles.push(first, discarded);
    discarded.destroy();
    const frame = host.children[0];
    first.seekTo(10);
    first.seekTo(30);
    assert.equal(head.children.length, 2, "retry after network failure uses one shared script");
    t.mock.timers.tick(30_000);
    assert.equal(delayed, 1);
    assert.deepEqual(errors, [undefined], "elapsed time is not a YouTube failure");
    assert.equal(head.children[1].removed, false, "slow initialization must stay alive");

    Object.assign(window, { YT: { Player: FakePlayer } });
    window.onYouTubeIframeAPIReady?.();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(players.length, 1, "disposed mounts cannot create late players");
    assert.equal(players[0].element, frame, "late readiness keeps the original frame");
    players[0].ready();
    assert.equal(ready, 1);
    assert.deepEqual(players[0].seeks, [30]);
    first.seekTo(40);
    first.seekTo(Number.NaN);
    first.seekTo(-1);
    assert.deepEqual(players[0].seeks, [30, 40]);
    players[0].options.events.onError({ target: players[0], data: 150 });
    assert.deepEqual(errors, [undefined, 150], "actual YouTube error codes are retained");
    first.destroy();
    assert.equal(host.children.length, 0);
    assert.doesNotThrow(() => first.seekTo(50));

    const remounted = mountYouTubePlayer(host as unknown as HTMLElement, options);
    handles.push(remounted);
    remounted.seekTo(60);
    await Promise.resolve();
    assert.notEqual(players[1].element, frame);
    players[0].ready();
    assert.equal(ready, 1, "stale ready callbacks remain inactive");
    players[1].ready();
    assert.deepEqual(players[1].seeks, [60]);
    t.mock.timers.tick(30_000);
    assert.equal(delayed, 1, "readiness clears the delayed notice timer");
  } finally {
    handles.forEach(handle => handle.destroy());
    Object.assign(globalThis, { window: oldWindow, document: oldDocument });
  }
});
