"""Tests for the Pages builder. No network."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import build_pages

ROOT = Path(__file__).resolve().parents[2]
SHORT_PITCH = (
    "Local AI memory: neuroscience-inspired "
    "Data→Information→Knowledge in SQLite you own."
)
README_PITCH = (
    "Facthouse is a local memory engine for AI tools. Most “memory” products "
    "index chat logs. Facthouse takes agent activity - messages, tool use, "
    "and other MCP traffic - and applies neuroscience-inspired consolidation "
    "so it moves through **Data** (what happened in the session) → "
    "**Information** (extracted facts) → **Knowledge** (integrated beliefs "
    "on an entity graph). During this process, Facthouse links entities, "
    "drops duplicates, reconciles conflicts, and supersedes what is out of "
    "date. Vector embeddings add optional semantic search on top of that "
    "graph. The store is a SQLite file on your disk."
)
# Rival hosted-MCP wording must not appear on public surfaces. Tests fail
# if a disambiguation sentence naming a competitor or mcp.*.ai URL returns.
_RIVAL_COPY = re.compile(
    r"mem0|mcp\.[a-z0-9-]+\.ai|hosted openmemory",
    re.IGNORECASE,
)


def assert_no_rival_copy(text: str, label: str) -> None:
    match = _RIVAL_COPY.search(text)
    assert match is None, f"{label} names a rival product: {match.group(0)!r}"


def test_rewrite_contributing_to_github():
    src = ROOT / "README.md"
    assert (
        build_pages.rewrite_url("CONTRIBUTING.md", src)
        == "https://github.com/gordonkjlee/facthouse/blob/main/CONTRIBUTING.md"
    )


def test_rewrite_source_file_to_github():
    src = ROOT / "README.md"
    assert (
        build_pages.rewrite_url("src/cli/query.ts", src)
        == "https://github.com/gordonkjlee/facthouse/blob/main/src/cli/query.ts"
    )


def test_rewrite_leaves_external_and_anchors():
    src = ROOT / "README.md"
    assert build_pages.rewrite_url(
        "https://www.npmjs.com/package/@facthouse/mcp", src
    ) == ("https://www.npmjs.com/package/@facthouse/mcp")
    assert build_pages.rewrite_url("#quick-start", src) == "#quick-start"


def test_builds_site_from_readme(tmp_path: Path):
    site = build_pages.build(tmp_path)

    index = (site / "index.html").read_text(encoding="utf-8")
    assert "<title>Facthouse</title>" in index
    assert "Facthouse is a local memory engine for AI tools." in index
    assert_no_rival_copy(index, "built site index")
    assert "neuroscience-inspired consolidation" in index
    assert "<strong>Data</strong>" in index
    assert "<strong>Information</strong>" in index
    assert "<strong>Knowledge</strong>" in index
    assert "→" in index
    assert "(what happened in the session)" in index
    assert "(extracted facts)" in index
    assert "(integrated beliefs on an entity graph)" in index
    assert "The store is a SQLite file on your disk." in index
    assert "A local memory engine any AI tool can use." not in index
    assert "paste the snippet it prints" not in index
    assert "Install `@facthouse/mcp`" not in index
    assert "Install <code>@facthouse/mcp</code>" not in index
    assert "facthouse init" in index
    quick_html = index.split("Quick Start", 1)[1].split("What you get", 1)[0]
    assert "facthouse init --web" in quick_html
    assert "same setup as a browser form" in quick_html
    assert "skip the wizard" not in quick_html
    assert "mcpServers" not in quick_html
    assert "Wisdom" not in index
    assert "[`gordonkjlee/facthouse`]" not in index
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    assert f"<code>npm install -g @facthouse/mcp@{version}</code>" in index
    assert "<code>npm install -g @facthouse/mcp</code>" not in index
    assert "https://github.com/gordonkjlee/facthouse" in index
    assert "https://www.npmjs.com/package/@facthouse/mcp" in index
    assert "What you get" in index
    assert "You own the SQLite file" not in index
    assert "You own the file" not in index
    assert "<table>" in index
    assert 'href="CONTRIBUTING.md"' not in index
    assert (
        "https://github.com/gordonkjlee/facthouse/blob/main/CONTRIBUTING.md"
        in index
    )
    assert 'src="assets/logo.png"' in index
    assert "brand/mascot-right.png" not in index
    assert 'property="og:image" content="https://facthouse.dev/assets/logo.png"' in index
    assert '"image": "https://facthouse.dev/assets/logo.png"' in index
    assert sorted(p.name for p in site.glob("*.html")) == ["demo.html", "index.html"]
    demo = (site / "demo.html").read_text(encoding="utf-8")
    assert "Alex" in demo
    assert "superseded" in demo
    assert_no_rival_copy(demo, "demo.html")
    assert "Install @facthouse/mcp" in demo
    assert "index.html#quick-start" in demo
    assert 'id="quick-start"' in index
    assert "node:sqlite" not in demo

    assert (site / "CNAME").read_text(encoding="utf-8") == "facthouse.dev\n"
    assert (site / ".nojekyll").is_file()
    assert (site / "assets" / "logo.png").is_file()

    robots = (site / "robots.txt").read_text(encoding="utf-8")
    assert "User-agent: *" in robots
    assert "Allow: /" in robots
    assert "Disallow:" not in robots
    assert "Sitemap: https://facthouse.dev/sitemap.xml" in robots

    sitemap = (site / "sitemap.xml").read_text(encoding="utf-8")
    assert "<loc>https://facthouse.dev</loc>" in sitemap
    assert "<loc>https://facthouse.dev/demo.html</loc>" in sitemap
    assert "www.facthouse.dev" not in sitemap
    assert sitemap.count("<loc>") == 2

    key_name = f"{build_pages.INDEXNOW_KEY}.txt"
    assert (site / key_name).read_text(encoding="utf-8") == f"{build_pages.INDEXNOW_KEY}\n"

    assert ">gordonkjlee/openmemory<" not in index
    assert ">gordonkjlee/facthouse<" in index
    assert "hosted plane" not in index.lower()
    assert "vendor blob" not in index.lower()
    assert f'content="{SHORT_PITCH}"' in index


def test_npm_global_install_command_matches_package_json():
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    assert build_pages.npm_global_install_command() == (
        f"npm install -g @facthouse/mcp@{version}"
    )


def test_npm_global_install_command_refuses_empty_version(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(build_pages, "package_metadata", lambda: {"version": ""})
    with pytest.raises(SystemExit, match="package.json version"):
        build_pages.npm_global_install_command()


def test_pitch_helpers_keep_readme_lede():
    plain = build_pages.pitch_plain(README_PITCH)
    assert plain.startswith("Facthouse is a local memory engine for AI tools.")
    assert_no_rival_copy(plain, "pitch_plain")
    assert "**" not in plain
    assert "Data (what happened in the session) → Information" in plain
    assert "The store is a SQLite file on your disk." in plain
    assert "facthouse init" not in plain
    assert "Install @facthouse/mcp" not in plain
    html = build_pages.pitch_html(README_PITCH)
    assert html.startswith("Facthouse is a local memory engine for AI tools.")
    assert_no_rival_copy(html, "pitch_html")
    assert "<p>" not in html
    assert "<strong>Data</strong>" in html
    assert "<strong>Information</strong>" in html
    assert "<strong>Knowledge</strong>" in html
    assert "facthouse init" not in html
    assert "<strong>Data (what happened" not in html


def test_public_surfaces_have_no_rival_disambiguation():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    server = json.loads((ROOT / "server.json").read_text(encoding="utf-8"))
    demo = (ROOT / "site" / "demo.html").read_text(encoding="utf-8")
    assert_no_rival_copy(readme, "README.md")
    assert_no_rival_copy(SHORT_PITCH, "SHORT_PITCH")
    assert_no_rival_copy(pkg["description"], "package.json description")
    assert_no_rival_copy(server["description"], "server.json description")
    assert_no_rival_copy(demo, "site/demo.html")
    assert README_PITCH in readme
    assert "The store is a SQLite file on your disk." in readme
    assert "A local memory engine any AI tool can use." not in readme
    assert pkg["description"] == SHORT_PITCH
    assert server["description"] == SHORT_PITCH


def test_listing_description_matches_package_and_registry():
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    server = json.loads((ROOT / "server.json").read_text(encoding="utf-8"))
    assert pkg["description"] == SHORT_PITCH
    assert server["description"] == SHORT_PITCH
    assert build_pages.PITCH == SHORT_PITCH
    assert build_pages.listing_description() == SHORT_PITCH
    # MCP Registry server.schema.json description maxLength is 100.
    assert SHORT_PITCH == (
        "Local AI memory: neuroscience-inspired "
        "Data→Information→Knowledge in SQLite you own."
    )
    assert len(SHORT_PITCH) == 84
    assert len(SHORT_PITCH) <= 100
    assert_no_rival_copy(SHORT_PITCH, "SHORT_PITCH")
    assert_no_rival_copy(pkg["description"], "package.json description")
    assert_no_rival_copy(server["description"], "server.json description")
    assert "neuroscience" in SHORT_PITCH.lower()
    assert "you own" in SHORT_PITCH.lower()
    assert "Wisdom" not in SHORT_PITCH


def test_split_readme_uses_lede_and_keeps_image():
    pitch, rest = build_pages.split_readme((ROOT / "README.md").read_text(encoding="utf-8"))
    assert pitch == README_PITCH
    assert pitch != SHORT_PITCH
    assert pitch.endswith("The store is a SQLite file on your disk.")
    assert_no_rival_copy(pitch, "README lede")
    assert "facthouse init" not in pitch
    assert "Install `@facthouse/mcp`" not in pitch
    assert rest.startswith("<img ")
    assert "# Facthouse" not in rest.splitlines()[0]
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
    assert data["name"] == "Facthouse"
    assert data["url"] == "https://facthouse.dev"
    assert data["sameAs"] == [
        "https://github.com/gordonkjlee/facthouse",
        "https://www.npmjs.com/package/@facthouse/mcp",
    ]
    assert data["description"] == SHORT_PITCH
    assert "www.facthouse.dev" not in body
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
