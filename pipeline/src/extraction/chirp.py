"""
Generate SRT captions from a local video file using Google Chirp 3.

Flow:
1. Extract audio from video (ffmpeg → WAV)
2. Upload WAV to GCS staging bucket (BatchRecognize requires gs:// URI)
3. Run BatchRecognize with Chirp 3 + word-level timestamps
4. Convert word-level results to SRT (one block per word)
5. Clean up GCS staging file

The per-word SRT gives parse_srt_to_words() exact timestamps — strictly
better than YouTube's grouped caption blocks.
"""

import logging
import os
import subprocess
import tempfile
import uuid

from google.cloud import speech_v2 as speech
from google.cloud import storage

logger = logging.getLogger("chalkboard")

# Env vars
GCS_BUCKET = os.getenv("CHALKBOARD_GCS_BUCKET", "chalkboard-audio-staging")
STT_REGION = os.getenv("CHALKBOARD_STT_REGION", "us-central1")
STT_MODEL = os.getenv("CHALKBOARD_STT_MODEL", "chirp_2")


def _extract_audio(video_path: str, output_dir: str) -> str:
    """Extract mono 16kHz WAV from video using ffmpeg."""
    wav_path = os.path.join(output_dir, "audio.wav")
    cmd = [
        "ffmpeg", "-i", video_path,
        "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000",
        "-y", wav_path,
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr.decode()[:500]}")
    logger.info(f"  Extracted audio: {wav_path}")
    return wav_path


def _upload_to_gcs(local_path: str, bucket_name: str) -> str:
    """Upload file to GCS using resumable upload, return gs:// URI."""
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob_name = f"staging/{uuid.uuid4().hex}/{os.path.basename(local_path)}"
    blob = bucket.blob(blob_name)
    blob.upload_from_filename(local_path, timeout=300)
    uri = f"gs://{bucket_name}/{blob_name}"
    logger.info(f"  Uploaded to GCS: {uri}")
    return uri


def _delete_from_gcs(gcs_uri: str) -> None:
    """Delete a gs:// file. Best-effort, logs but doesn't raise."""
    try:
        parts = gcs_uri.replace("gs://", "").split("/", 1)
        bucket_name, blob_name = parts[0], parts[1]
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        bucket.blob(blob_name).delete()
        logger.info(f"  Cleaned up GCS: {gcs_uri}")
    except Exception as e:
        logger.warning(f"  Failed to clean up GCS {gcs_uri}: {e}")


def _batch_recognize(gcs_uri: str, project: str) -> list[dict]:
    """Run Chirp 3 BatchRecognize on a GCS audio file.

    Returns list of {word, start, end} dicts with timestamps in seconds.
    """
    client = speech.SpeechClient(
        client_options={"api_endpoint": f"{STT_REGION}-speech.googleapis.com"}
    )

    recognizer = f"projects/{project}/locations/{STT_REGION}/recognizers/_"

    config = speech.RecognitionConfig(
        auto_decoding_config=speech.AutoDetectDecodingConfig(),
        language_codes=["en-US"],
        model=STT_MODEL,
        features=speech.RecognitionFeatures(
            enable_word_time_offsets=True,
            enable_automatic_punctuation=True,
        ),
    )

    output_config = speech.RecognitionOutputConfig(
        inline_response_config=speech.InlineOutputConfig(),
    )

    request = speech.BatchRecognizeRequest(
        recognizer=recognizer,
        config=config,
        files=[speech.BatchRecognizeFileMetadata(uri=gcs_uri)],
        recognition_output_config=output_config,
    )

    logger.info("  Running Chirp 3 BatchRecognize...")
    operation = client.batch_recognize(request=request)
    response = operation.result(timeout=1800)  # 30 min timeout for long lectures

    words = []
    for file_result in response.results.values():
        for result in file_result.transcript.results:
            for alt in result.alternatives:
                for w in alt.words:
                    start_s = w.start_offset.total_seconds()
                    end_s = w.end_offset.total_seconds()
                    words.append({
                        "word": w.word,
                        "start": start_s,
                        "end": end_s,
                    })

    logger.info(f"  Chirp 3: {len(words)} words recognized")
    return words


def _words_to_srt(words: list[dict]) -> str:
    """Convert word list to SRT format — one block per word."""
    lines = []
    for i, w in enumerate(words, 1):
        start = _format_srt_time(w["start"])
        end = _format_srt_time(w["end"])
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(w["word"])
        lines.append("")
    return "\n".join(lines)


def _format_srt_time(seconds: float) -> str:
    """Format seconds as HH:MM:SS,mmm for SRT."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt_from_video(video_path: str, output_dir: str | None = None) -> str:
    """Generate an SRT file from a local video using Chirp 3.

    Args:
        video_path: Path to the video file (MP4, etc.)
        output_dir: Directory to write the SRT file. If None, uses a temp dir
                     (caller must manage the temp dir lifecycle).

    Returns:
        Path to the generated SRT file.
    """
    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise RuntimeError(
            "GOOGLE_CLOUD_PROJECT must be set for Chirp 3 transcription"
        )

    if output_dir is None:
        output_dir = tempfile.mkdtemp()

    gcs_uri = None
    try:
        # 1. Extract audio
        wav_path = _extract_audio(video_path, output_dir)

        # 2. Upload to GCS
        gcs_uri = _upload_to_gcs(wav_path, GCS_BUCKET)

        # 3. Transcribe
        words = _batch_recognize(gcs_uri, project)

        if not words:
            raise RuntimeError("Chirp 3 returned no words — check audio quality and language")

        # 4. Convert to SRT
        srt_content = _words_to_srt(words)
        srt_path = os.path.join(output_dir, "captions.en.srt")
        with open(srt_path, "w") as f:
            f.write(srt_content)

        logger.info(f"  Generated SRT: {srt_path} ({len(words)} words)")
        return srt_path

    finally:
        # 5. Clean up GCS
        if gcs_uri:
            _delete_from_gcs(gcs_uri)
