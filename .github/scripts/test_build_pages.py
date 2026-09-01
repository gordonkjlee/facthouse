"""Tests for the Pages builder. No network."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import build_pages

ROOT = Path(__file__).resolve().parents[2]
README_PITCH = (
    "A local memory engine any AI tool can use. "
    "GitHub [`gordonkjlee/factmem`](https://github.com/gordonkjlee/factmem), "
    "npm [`@factmem/mcp`](https://www.npmjs.com/package/@factmem/mcp)."
)


def test_rewrite_contributing_to_github():
    src = ROOT / "README.md"
    assert (
        build_pages.rewrite_url("CONTRIBUTING.md", src)
        == "https://github.com/gordonkjlee/factmem/blob/main/CONTRIBUTING.md"
    )


def test_rewrite_source_file_to_github():
    src = ROOT / "README.md"
    assert (
        build_pages.rewrite_url("src/cli/query.ts", src)
        == "https://github.com/gordonkjlee/factmem/blob/main/src/cli/query.ts"
    )


def test_rewrite_leaves_external_and_anchors():
    src = ROOT / "README.md"
    assert build_pages.rewrite_url(
        "https://www.npmjs.com/package/@factmem/mcp", src
    ) == ("https://www.npmjs.com/package/@factmem/mcp")
    assert build_pages.rewrite_url("#quick-start", src) == "#quick-start"


def test_builds_site_from_readme(tmp_path: Path):
    site = build_pages.build(tmp_path)

    index = (site / "index.html").read_text(encoding="utf-8")
    assert "<title>FactMem</title>" in index
    assert "A local memory engine any AI tool can use." in index
    assert "[`gordonkjlee/factmem`]" not in index
    assert "npm install -g @factmem/mcp" in index
    assert "https://github.com/gordonkjlee/factmem" in index
    assert "https://www.npmjs.com/package/@factmem/mcp" in index
    assert "What you get" in index
    assert "You own the SQLite file" in index
    assert "<table>" in index
    assert 'href="CONTRIBUTING.md"' not in index
    assert (
        "https://github.com/gordonkjlee/factmem/blob/main/CONTRIBUTING.md"
        in index
    )
    assert 'src="assets/logo.png"' in index
    assert "brand/mascot-right.png" not in index
    assert list(site.glob("*.html")) == [site / "index.html"]

    assert (site / "CNAME").read_text(encoding="utf-8") == "factmem.dev\n"
    assert (site / ".nojekyll").is_file()
    assert (site / "assets" / "logo.png").is_file()

    robots = (site / "robots.txt").read_text(encoding="utf-8")
    assert "User-agent: *" in robots
    assert "Allow: /" in robots
    assert "Disallow:" not in robots
    assert "Sitemap: https://factmem.dev/sitemap.xml" in robots

    sitemap = (site / "sitemap.xml").read_text(encoding="utf-8")
    assert "<loc>https://factmem.dev</loc>" in sitemap
    assert "www.factmem.dev" not in sitemap
    assert sitemap.count("<loc>") == 1

    key_name = f"{build_pages.INDEXNOW_KEY}.txt"
    assert (site / key_name).read_text(encoding="utf-8") == f"{build_pages.INDEXNOW_KEY}\n"

    assert ">gordonkjlee/openmemory<" not in index
    assert ">gordonkjlee/factmem<" in index


def test_pitch_helpers_keep_readme_lede():
    assert build_pages.pitch_plain(README_PITCH) == (
        "A local memory engine any AI tool can use. "
        "GitHub gordonkjlee/factmem, "
        "npm @factmem/mcp."
    )
    html = build_pages.pitch_html(README_PITCH)
    assert html.startswith("A local memory engine any AI tool can use.")
    assert 'href="https://github.com/gordonkjlee/factmem"' in html
    assert 'href="https://www.npmjs.com/package/@factmem/mcp"' in html


def test_split_readme_uses_lede_and_keeps_image():
    pitch, rest = build_pages.split_readme((ROOT / "README.md").read_text(encoding="utf-8"))
    assert pitch == README_PITCH
    assert rest.startswith("<img ")
    assert "# FactMem" not in rest.splitlines()[0]
    assert "# OpenMemory" not in rest.splitlines()[0]
    assert "## Quick Start" in rest
    assert "## What you get" in rest


def test_cname_must_match_domain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(build_pages, "ROOT", tmp_path)
    (tmp_path / "CNAME").write_text("example.com\n", encoding="utf-8")
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(SystemExit, match="CNAME must be"):
        build_pages.write_cname(dest)


def test_copy_root_files_requires_robots_and_sitemap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(build_pages, "ROOT", tmp_path)
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(SystemExit, match="missing robots.txt"):
        build_pages.copy_root_files(dest)
    (tmp_path / "robots.txt").write_text("User-agent: *\nAllow: /\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="missing sitemap.xml"):
        build_pages.copy_root_files(dest)


def test_index_has_software_application_json_ld(tmp_path: Path):
    site = build_pages.build(tmp_path)
    index = (site / "index.html").read_text(encoding="utf-8")
    match = re.search(
        r'<script type="application/ld\+json">\s*(.*?)\s*</script>',
        index,
        re.DOTALL,
    )
    assert match, "missing JSON-LD script"
    body = match.group(1)
    data = json.loads(body)
    assert data["name"] == "FactMem"
    assert data["url"] == "https://factmem.dev"
    assert data["sameAs"] == [
        "https://github.com/gordonkjlee/factmem",
        "https://www.npmjs.com/package/@factmem/mcp",
    ]
    assert data["description"] == (
        "A local memory engine any AI tool can use. You own the SQLite file."
    )
    assert "www.factmem.dev" not in body
    assert "openmemory" not in body.lower()
    assert "mem0" not in body.lower()


def test_footer_no_longer_says_openmemory(tmp_path: Path):
    site = build_pages.build(tmp_path)
    index = (site / "index.html").read_text(encoding="utf-8")
    assert "gordonkjlee/openmemory" not in index


def test_indexnow_key_is_public_hex_file():
    key = build_pages.INDEXNOW_KEY
    assert re.fullmatch(r"[0-9a-f]{32}", key)
    committed = (ROOT / f"{key}.txt").read_text(encoding="utf-8")
    assert committed == f"{key}\n"
    assert f"{key}.txt" in build_pages.ROOT_FILES
