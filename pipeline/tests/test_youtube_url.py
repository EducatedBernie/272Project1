from src.youtube import canonicalize_youtube_url, canonicalize_youtube_url_if_possible, extract_youtube_id


def test_canonicalizes_playlist_watch_url():
    assert (
        canonicalize_youtube_url(
            "https://www.youtube.com/watch?v=hXDIZnfCRws&list=PL6539BAED55972D64&index=8"
        )
        == "https://www.youtube.com/watch?v=hXDIZnfCRws"
    )


def test_extracts_common_youtube_url_forms():
    cases = [
        "https://youtu.be/hXDIZnfCRws?t=30",
        "https://www.youtube.com/embed/hXDIZnfCRws?start=30",
        "https://m.youtube.com/shorts/hXDIZnfCRws?feature=share",
        "https://www.youtube-nocookie.com/embed/hXDIZnfCRws",
        "www.youtube.com/watch?v=hXDIZnfCRws",
        "youtube.com/watch?feature=share&v=hXDIZnfCRws",
    ]

    for value in cases:
        assert extract_youtube_id(value) == "hXDIZnfCRws"
        assert canonicalize_youtube_url(value) == "https://www.youtube.com/watch?v=hXDIZnfCRws"


def test_non_youtube_url_is_not_rewritten():
    source = "https://pub.example.r2.dev/uploads/abc/lecture.mp4"
    assert canonicalize_youtube_url(source) is None
    assert canonicalize_youtube_url_if_possible(source) == source


def test_non_youtube_url_with_v_query_param_is_not_rewritten():
    cases = [
        "https://example.com/watch?v=notyoutube",
        "https://pub.example.r2.dev/uploads/lecture.mp4?v=cachebuster",
        "example.com/watch?v=notyoutube",
    ]

    for source in cases:
        assert canonicalize_youtube_url(source) is None
        assert canonicalize_youtube_url_if_possible(source) == source
