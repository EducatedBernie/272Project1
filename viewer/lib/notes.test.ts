import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { isUuid, parseNotesRequest, enqueueNotes, getNotesJob, getNotesSourceRun } from "./notes";
import { getPool, getLatestRunId, getPublicRunsForVideo } from "./db";

const sourceRunId = randomUUID();
const videoId = randomUUID();

test("notes requests require UUIDs and reject malformed bodies", () => {
  assert.deepEqual(parseNotesRequest({ video_id: videoId, source_run_id: sourceRunId }), {
    video_id: videoId, source_run_id: sourceRunId,
  });
  for (const body of [null, [], {}, { video_id: "bad", source_run_id: sourceRunId }, { video_id: videoId }]) {
    assert.throws(() => parseNotesRequest(body), /video_id and source_run_id/);
  }
  assert.equal(isUuid("../notes.json"), false);
});

test("generation requires login while saved notes status is public", async () => {
  const previousDisabled = process.env.DASHBOARD_AUTH_DISABLED;
  const previousPassword = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_AUTH_DISABLED;
  delete process.env.DASHBOARD_PASSWORD;
  try {
    const post = await middleware(new NextRequest("http://localhost/api/notes", { method: "POST" }));
    assert.equal(post.status, 401);
    const get = await middleware(new NextRequest(`http://localhost/api/notes/${sourceRunId}`));
    assert.equal(get.headers.get("x-middleware-next"), "1");
    const mutate = await middleware(new NextRequest(`http://localhost/api/notes/${sourceRunId}`, { method: "POST" }));
    assert.equal(mutate.status, 401);
  } finally {
    if (previousDisabled === undefined) delete process.env.DASHBOARD_AUTH_DISABLED;
    else process.env.DASHBOARD_AUTH_DISABLED = previousDisabled;
    if (previousPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = previousPassword;
  }
});

test("notes jobs deduplicate, retry failures, pin sources and never replace extraction runs", {
  skip: !process.env.NOTES_TEST_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.NOTES_TEST_DATABASE_URL;
  const pool = getPool();
  try {
    await pool.query("INSERT INTO videos (id,title,youtube_url,duration,status,created_at) VALUES ($1,'Notes test',$2,600,'complete',NOW())", [videoId, `https://youtube.com/watch?v=${videoId}`]);
    await pool.query("INSERT INTO pipeline_runs (id,video_id,status,run_type,pipeline_version,created_at) VALUES ($1,$2,'complete','process','v2',NOW() - INTERVAL '1 minute')", [sourceRunId, videoId]);
    await assert.rejects(enqueueNotes(videoId, sourceRunId), /transcript/);
    await pool.query("INSERT INTO transcript_segments (id,video_id,run_id,text,timestamp_start,timestamp_end,created_at) VALUES ($1,$2,$3,'A cited explanation.',1,8,NOW())", [randomUUID(), videoId, sourceRunId]);
    assert.equal((await getNotesSourceRun(videoId))?.id, sourceRunId);
    await assert.rejects(enqueueNotes(randomUUID(), sourceRunId), /not found/);
    const [first, duplicate] = await Promise.all([enqueueNotes(videoId, sourceRunId), enqueueNotes(videoId, sourceRunId)]);
    assert.equal(first.id, duplicate.id);
    assert.equal(first.source_run_id, sourceRunId);
    assert.equal(first.status, "queued");
    assert.equal(await getLatestRunId(videoId), sourceRunId);
    assert.deepEqual((await getPublicRunsForVideo(videoId)).map(r => r.id), [sourceRunId]);
    assert.equal(await getNotesJob(sourceRunId), null);
    await pool.query("UPDATE pipeline_runs SET status='failed', error='private traceback and provider details' WHERE id=$1", [first.id]);
    assert.equal((await getNotesJob(first.id))?.error, "Notes could not be generated. Please try again.");
    const retry = await enqueueNotes(videoId, sourceRunId);
    assert.notEqual(retry.id, first.id);
    await pool.query("UPDATE pipeline_runs SET status='complete' WHERE id=$1", [retry.id]);
    assert.equal((await enqueueNotes(videoId, sourceRunId)).id, retry.id);
    assert.equal(await getLatestRunId(videoId), sourceRunId);
    await pool.query("UPDATE pipeline_runs SET progress='{\"scope\":\"section\"}'::jsonb WHERE id=$1", [sourceRunId]);
    assert.equal(await getNotesSourceRun(videoId), null);
    await assert.rejects(enqueueNotes(videoId, sourceRunId), /full lecture/);
    await pool.query("UPDATE pipeline_runs SET progress='{}', run_type='reprocess_section' WHERE id=$1", [sourceRunId]);
    await assert.rejects(enqueueNotes(videoId, sourceRunId), /full lecture/);
  } finally {
    await pool.query("DELETE FROM transcript_segments WHERE video_id=$1", [videoId]);
    await pool.query("DELETE FROM pipeline_runs WHERE video_id=$1", [videoId]);
    await pool.query("DELETE FROM videos WHERE id=$1", [videoId]);
    await pool.end();
  }
});
