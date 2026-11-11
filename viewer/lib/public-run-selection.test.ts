import assert from "node:assert/strict";
import test from "node:test";

import { selectPublicRunId } from "./public-run-selection";

const runs = [{ id: "run-public-1" }, { id: "run-public-2" }];

test("honors a requested run only when it is public for the video", () => {
  assert.equal(selectPublicRunId(runs, "run-public-2", "run-public-1"), "run-public-2");
});

test("falls back when requested run is not in the public run list", () => {
  assert.equal(selectPublicRunId(runs, "qa-private-run", "run-public-1"), "run-public-1");
});

test("falls back to newest public row when latest complete run is unavailable", () => {
  assert.equal(selectPublicRunId(runs, "qa-private-run", null), "run-public-1");
});

test("returns null when no public runs are available", () => {
  assert.equal(selectPublicRunId([], "qa-private-run", null), null);
});
