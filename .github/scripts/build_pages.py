"""Build the GitHub Pages site from project markdown.

README.md is the source of truth. This script wraps it in a small HTML
shell. Do not add a second hand-written marketing page — change the
README instead.
"""

from __future__ import annotations

import argparse
import html
import re
import shutil
import sys
from pathlib import Path

try:
    import markdown
except ImportError as exc:  # pragma: no cover - CI installs markdown
    raise SystemExit(
        "build_pages.py needs the markdown package. "
        "Install it with: pip install 'markdown>=3.6.0'"
    ) from exc

ROOT = Path(__file__).resolve().parents[2]
DOMAIN = "factmem.dev"
SITE_ORIGIN = f"https://{DOMAIN}"
GITHUB = "https://github.com/gordonkjlee/factmem"
NPM = "https://www.npmjs.com/package/@factmem/mcp"
PITCH = "A local memory engine any AI tool can use."
MARKDOWN_EXTENSIONS = ("fenced_code", "tables")

# Repo-relative source → published path. Anything else that exists in the
# repo is rewritten to a GitHub blob URL so the site does not 404.
PAGES = (
    {
        "source": "README.md",
        "output": "index.html",
        "title": "FactMem",
        "canonical": "/",
        "description": PITCH,
    },
)

ASSETS = (
    ("brand/mascot-right.png", "assets/logo.png"),
)

_ATTR = re.compile(
    r"""(?P<attr>href|src)=(?P<q>["'])(?P<url>[^"']*)(?P=q)""",
    re.IGNORECASE,
)


def page_hrefs() -> dict[str, str]:
    return {page["source"]: page["output"] for page in PAGES}


def asset_hrefs() -> dict[str, str]:
    return {src: dest for src, dest in ASSETS}


def rewrite_url(url: str, source_file: Path) -> str:
    """Turn a repo-relative link into a site path or a GitHub blob URL."""
    if not url or url.startswith(("#", "mailto:", "http://", "https://", "data:", "//")):
        return url
    raw, frag = (url.split("#", 1) + [""])[:2]
    raw = raw.strip()
    if not raw or raw.startswith("?"):
        return url
    resolved = (source_file.parent / raw).resolve()
    try:
        rel = resolved.relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return url
    dest = page_hrefs().get(rel) or asset_hrefs().get(rel)
    if dest is None and resolved.is_file():
        dest = f"{GITHUB}/blob/main/{rel}"
    if dest is None:
        return url
    return f"{dest}#{frag}" if frag else dest


def rewrite_html(html: str, source_file: Path) -> str:
    def repl(match: re.Match[str]) -> str:
        url = rewrite_url(match["url"], source_file)
        return f"{match['attr']}={match['q']}{url}{match['q']}"

    return _ATTR.sub(repl, html)


def render_markdown(text: str) -> str:
    return markdown.markdown(text, extensions=list(MARKDOWN_EXTENSIONS))


def pitch_html(md: str) -> str:
    """README lede may contain links; render them in the landing chrome."""
    rendered = render_markdown(md).strip()
    if rendered.startswith("<p>") and rendered.endswith("</p>"):
        inner = rendered[len("<p>") : -len("</p>")]
        if "<p>" not in inner:
            return inner
    return rendered


def pitch_plain(md: str) -> str:
    """Same lede, without markdown, for meta description."""
    text = re.sub(r"\[`([^`]+)`\]\([^)]+\)", r"\1", md)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.replace("`", "")


def split_readme(text: str) -> tuple[str, str]:
    """Take title/pitch from the README; return (pitch, remaining markdown).

    The landing chrome already prints the H1 and one-line pitch, so those
    lines are not repeated in the article. The hero image stays.
    """
    lines = text.splitlines()
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and lines[i].startswith("# "):
        i += 1
    while i < len(lines) and not lines[i].strip():
        i += 1

    kept: list[str] = []
    if i < len(lines) and "<img" in lines[i]:
        chunk = [lines[i]]
        while i < len(lines) and ">" not in lines[i]:
            i += 1
            if i < len(lines):
                chunk.append(lines[i])
        kept.extend(chunk)
        i += 1

    while i < len(lines) and not lines[i].strip():
        i += 1
    pitch = PITCH
    if i < len(lines) and not lines[i].startswith("#"):
        pitch = lines[i].strip()
        i += 1
    kept.append("")
    kept.extend(lines[i:])
    return pitch, "\n".join(kept).strip() + "\n"


def wrap_html(
    *,
    title: str,
    description: str,
    canonical: str,
    body: str,
    heading: str | None = "FactMem",
    pitch: str = PITCH,
) -> str:
    canon = SITE_ORIGIN if canonical == "/" else f"{SITE_ORIGIN}{canonical}"
    title_html = f"<h1>{heading}</h1>\n      " if heading else ""
    desc = html.escape(description, quote=True)
    landing = (
        f'<section class="landing">\n'
        f"      {title_html}<p class=\"pitch\">{pitch_html(pitch)}</p>\n"
        f"      <pre class=\"install\"><code>npm install -g @factmem/mcp</code></pre>\n"
        f"    </section>"
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="{canon}">
  <link rel="icon" href="assets/logo.png" type="image/png">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{canon}">
  <meta property="og:image" content="{SITE_ORIGIN}/assets/logo.png">
  <meta name="twitter:card" content="summary_large_image">
  <style>
    :root {{
      --ink: #1C1917;
      --ink-soft: #44403C;
      --paper: #F4EFE6;
      --snow: #FFFCF7;
      --slate: #5C6B73;
      --ochre: #C4841D;
      --line: #E6DCCF;
      font-family: ui-sans-serif, system-ui, sans-serif;
      color: var(--ink);
      line-height: 1.55;
    }}
    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; background: var(--paper); }}
    .wrap {{ max-width: 44rem; margin: 0 auto; padding: 1.25rem 1.15rem 3rem; }}
    header {{
      display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem;
      align-items: center; justify-content: space-between;
      padding-bottom: 1rem; border-bottom: 1px solid var(--line);
      margin-bottom: 1.25rem;
    }}
    .brand {{
      display: flex; align-items: center; gap: 0.5rem;
      color: var(--ink); text-decoration: none; font-weight: 700;
      font-size: 1.05rem;
    }}
    .brand img {{ width: 1.75rem; height: 1.75rem; display: block; }}
    nav {{ display: flex; gap: 1rem; }}
    nav a {{ color: var(--slate); }}
    .landing h1 {{ font-size: 2rem; margin: 0 0 0.5rem; }}
    .pitch {{ margin: 0 0 0.75rem; color: var(--ink-soft); font-size: 1.05rem; }}
    .install {{
      margin: 0 0 1.5rem; padding: 0.65rem 0.85rem;
      background: var(--snow); border: 1px solid var(--line);
      border-radius: 0.3rem; overflow-x: auto;
    }}
    .install code {{ font-size: 0.95rem; }}
    main h1 {{ font-size: 1.85rem; margin: 0 0 0.75rem; }}
    main h2 {{ font-size: 1.2rem; margin: 1.75rem 0 0.6rem; }}
    main h3 {{ font-size: 1.05rem; margin: 1.25rem 0 0.4rem; }}
    main p, main li {{ color: var(--ink); }}
    main a {{ color: var(--ochre); }}
    main img {{ max-width: 100%; height: auto; }}
    pre {{
      overflow: auto; padding: 0.85rem 1rem; background: var(--snow);
      border: 1px solid var(--line); border-radius: 0.3rem;
    }}
    code {{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; }}
    :not(pre) > code {{ background: var(--snow); padding: 0.1em 0.3em; border-radius: 0.2rem; }}
    blockquote {{
      margin: 1rem 0; padding: 0.15rem 0 0.15rem 1rem;
      border-left: 3px solid var(--ochre); color: var(--ink-soft);
    }}
    table {{ border-collapse: collapse; width: 100%; font-size: 0.92rem; margin: 1rem 0; }}
    th, td {{ border-bottom: 1px solid var(--line); padding: 0.4rem 0.6rem 0.4rem 0; text-align: left; vertical-align: top; }}
    footer {{
      margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line);
      color: var(--slate); font-size: 0.85rem;
    }}
    footer a {{ color: var(--slate); }}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="./">
        <img src="assets/logo.png" alt="">
        FactMem
      </a>
      <nav>
        <a href="{GITHUB}">GitHub</a>
        <a href="{NPM}">npm</a>
      </nav>
    </header>
    {landing}
    <main>
{body}
    </main>
    <footer>
      <a href="{GITHUB}">gordonkjlee/openmemory</a> · MIT
    </footer>
  </div>
</body>
</html>
"""


def copy_assets(dest: Path) -> None:
    for src, out in ASSETS:
        target = dest / out
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / src, target)


# Published at the site root. GitHub Pages here deploys _site only, so these
# are not live unless the builder copies them.
ROOT_FILES = (
    "robots.txt",
    "sitemap.xml",
)


def copy_root_files(dest: Path) -> None:
    for name in ROOT_FILES:
        src = ROOT / name
        if not src.is_file():
            raise SystemExit(f"missing {name}")
        shutil.copy2(src, dest / name)


def write_cname(dest: Path) -> None:
    committed = (ROOT / "CNAME").read_text(encoding="utf-8").strip()
    if committed != DOMAIN:
        raise SystemExit(f"CNAME must be {DOMAIN!r}, got {committed!r}")
    (dest / "CNAME").write_text(f"{DOMAIN}\n", encoding="utf-8")


def build(dest: Path | None = None) -> Path:
    dest = dest or (ROOT / "_site")
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    copy_assets(dest)
    copy_root_files(dest)
    write_cname(dest)
    (dest / ".nojekyll").write_text("", encoding="utf-8")

    readme_text = (ROOT / "README.md").read_text(encoding="utf-8")
    pitch, readme_rest = split_readme(readme_text)

    for page in PAGES:
        source = ROOT / page["source"]
        if not source.is_file():
            raise SystemExit(f"missing source page: {page['source']}")
        text = source.read_text(encoding="utf-8")
        heading: str | None = None
        description = page["description"]
        if page["source"] == "README.md":
            text = readme_rest
            heading = "FactMem"
            description = pitch_plain(pitch)
        body = rewrite_html(render_markdown(text), source)
        html = wrap_html(
            title=page["title"],
            description=description,
            canonical=page["canonical"],
            body=body,
            heading=heading,
            pitch=pitch,
        )
        (dest / page["output"]).write_text(html, encoding="utf-8")

    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output directory (default: <repo>/_site)",
    )
    args = parser.parse_args(argv)
    out = build(args.out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
