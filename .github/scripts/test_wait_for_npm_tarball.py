"""Tests for the npm tarball wait. No network.

The publish verify job installs npm@latest, which is npm 12. `npm view --json`
is an array there. The previous jq filter kept only objects, so the URL was
empty and curl never ran.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parent / "wait_for_npm_tarball.sh"
WORKFLOW = ROOT / ".github" / "workflows" / "publish.yml"

NPM12_ARRAY = """[
  {
    "version": "0.32.0",
    "dist.tarball": "https://registry.npmjs.org/@facthouse/mcp/-/mcp-0.32.0.tgz"
  }
]
"""
NPM10_OBJECT = """{
  "version": "0.32.0",
  "dist.tarball": "https://registry.npmjs.org/@facthouse/mcp/-/mcp-0.32.0.tgz"
}
"""
TARBALL = "https://registry.npmjs.org/@facthouse/mcp/-/mcp-0.32.0.tgz"
# Distinct from the canonical registry path so a fallback cannot pass a test
# that claims the parsed dist.tarball was requested.
DISTINCT = "https://example.test/mcp-0.32.0.tgz"
NPM12_DISTINCT = NPM12_ARRAY.replace(TARBALL, DISTINCT)
NPM10_DISTINCT = NPM10_OBJECT.replace(TARBALL, DISTINCT)
# The filter that shipped in the verify step. An array is not an object, so
# this produces an empty string for npm 12 and the step logged HTTP 000.
OBJECT_ONLY_FILTER = (
    'if type == "object" then (.["dist.tarball"] // empty) else empty end'
)


def source_call(function: str, args: list[str]) -> subprocess.CompletedProcess[str]:
    code = f'source "$SCRIPT"; {function} "$@"'
    return subprocess.run(
        ["bash", "-c", code, "bash", *args],
        check=False,
        text=True,
        capture_output=True,
        env={**os.environ, "SCRIPT": str(SCRIPT)},
        timeout=10,
    )


def jq_raw(program: str, payload: str) -> str:
    completed = subprocess.run(
        ["jq", "-r", program],
        check=False,
        text=True,
        capture_output=True,
        input=payload,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr
    return completed.stdout.strip()


def write_exe(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def run_wait(
    tmp_path: Path,
    *,
    version: str = "0.32.0",
    max_wait: str = "1200",
    meta: str = "",
    stderr: str = "",
    codes: str = "200",
    fake_sleep: bool = False,
    timeout: float = 10,
) -> tuple[subprocess.CompletedProcess[str], str, str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    meta_file = tmp_path / "meta.json"
    meta_file.write_text(meta, encoding="utf-8")
    curl_log = tmp_path / "curl.log"
    sleep_log = tmp_path / "sleep.log"
    output = tmp_path / "github_output.txt"
    write_exe(
        bin_dir / "npm",
        """#!/bin/sh
cat "$NPM_META_FILE"
if [ -n "${NPM_STDERR:-}" ]; then
  printf '%s\\n' "$NPM_STDERR" >&2
fi
exit 0
""",
    )
    write_exe(
        bin_dir / "curl",
        """#!/bin/sh
url=
for arg in "$@"; do
  url=$arg
done
printf '%s\\n' "$url" >> "$CURL_LOG"
n=$(wc -l < "$CURL_LOG" | tr -d ' ')
code=$(printf '%s' "$CURL_CODES" | cut -d, -f"$n")
if [ -z "$code" ]; then
  code=$(printf '%s' "$CURL_CODES" | awk -F, '{print $NF}')
fi
printf '%s' "$code"
""",
    )
    if fake_sleep:
        write_exe(
            bin_dir / "sleep",
            """#!/bin/sh
printf '%s\\n' "$1" >> "$SLEEP_LOG"
exit 0
""",
        )
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:/usr/bin:/bin"
    env["NPM_META_FILE"] = str(meta_file)
    env["NPM_STDERR"] = stderr
    env["CURL_LOG"] = str(curl_log)
    env["CURL_CODES"] = codes
    env["SLEEP_LOG"] = str(sleep_log)
    env["GITHUB_OUTPUT"] = str(output)
    completed = subprocess.run(
        ["bash", str(SCRIPT), version, max_wait],
        check=False,
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
    )
    curled = curl_log.read_text(encoding="utf-8") if curl_log.exists() else ""
    slept = sleep_log.read_text(encoding="utf-8") if sleep_log.exists() else ""
    recorded = output.read_text(encoding="utf-8") if output.exists() else ""
    return completed, curled, slept, recorded


def test_npm12_array_is_empty_under_the_old_filter():
    assert jq_raw(OBJECT_ONLY_FILTER, NPM12_ARRAY) == ""
    parsed = source_call("tarball_url_from_meta", ["0.32.0", NPM12_ARRAY])
    assert parsed.returncode == 0, parsed.stderr
    assert parsed.stdout.strip() == TARBALL


def test_npm10_object_still_parses():
    assert jq_raw(OBJECT_ONLY_FILTER, NPM10_OBJECT) == TARBALL
    parsed = source_call("tarball_url_from_meta", ["0.32.0", NPM10_OBJECT])
    assert parsed.returncode == 0, parsed.stderr
    assert parsed.stdout.strip() == TARBALL


def test_parser_picks_the_matching_version_and_nested_tarball():
    multi = """[
      {"version":"0.31.0","dist.tarball":"https://example.test/old.tgz"},
      {"version":"0.32.0","dist.tarball":"https://example.test/new.tgz"}
    ]"""
    parsed = source_call("tarball_url_from_meta", ["0.32.0", multi])
    assert parsed.stdout.strip() == "https://example.test/new.tgz"

    nested = '{"version":"0.32.0","dist":{"tarball":"https://example.test/nested.tgz"}}'
    parsed = source_call("tarball_url_from_meta", ["0.32.0", nested])
    assert parsed.stdout.strip() == "https://example.test/nested.tgz"


def test_parser_rejects_empty_invalid_and_non_https():
    for payload in ("", "not-json", "null", '{"version":"0.32.0"}', '"not-a-url"'):
        parsed = source_call("tarball_url_from_meta", ["0.32.0", payload])
        assert parsed.returncode == 0, parsed.stderr
        assert parsed.stdout.strip() == ""


def test_canonical_url_and_sleep_and_curl_budgets():
    canonical = source_call("canonical_tarball_url", ["0.32.0"])
    assert canonical.stdout.strip() == TARBALL
    assert source_call("poll_sleep_seconds", ["100"]).stdout.strip() == "30"
    assert source_call("poll_sleep_seconds", ["30"]).stdout.strip() == "30"
    assert source_call("poll_sleep_seconds", ["10"]).stdout.strip() == "10"
    assert source_call("poll_sleep_seconds", ["0"]).stdout.strip() == "0"
    assert source_call("curl_max_seconds", ["100"]).stdout.strip() == "20"
    assert source_call("curl_max_seconds", ["7"]).stdout.strip() == "7"
    assert source_call("curl_max_seconds", ["0"]).stdout.strip() == "0"


def test_sourcing_does_not_start_the_wait():
    completed = subprocess.run(
        ["bash", "-c", 'source "$SCRIPT"; echo sourced'],
        check=False,
        text=True,
        capture_output=True,
        env={**os.environ, "SCRIPT": str(SCRIPT)},
        timeout=5,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "sourced"


def test_npm12_array_is_the_url_curl_requests(tmp_path: Path):
    completed, curled, slept, recorded = run_wait(
        tmp_path, meta=NPM12_DISTINCT, max_wait="1200"
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert curled.strip() == DISTINCT
    assert slept == ""
    assert "resolved=true" in recorded
    assert "tarball is HTTP 200 after" in completed.stdout
    assert "HTTP 000" not in completed.stdout
    assert "fallback=canonical" not in completed.stdout


def test_npm10_object_is_the_url_curl_requests(tmp_path: Path):
    completed, curled, _, recorded = run_wait(tmp_path, meta=NPM10_DISTINCT)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert curled.strip() == DISTINCT
    assert "resolved=true" in recorded


def test_empty_npm_view_falls_back_to_the_canonical_url(tmp_path: Path):
    completed, curled, _, _ = run_wait(tmp_path, meta="", codes="200")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert curled.strip() == TARBALL


def test_retries_then_succeeds_without_waiting_out_the_budget(tmp_path: Path):
    completed, curled, slept, recorded = run_wait(
        tmp_path,
        meta=NPM12_DISTINCT,
        codes="404,200",
        fake_sleep=True,
        max_wait="1200",
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert curled.splitlines() == [DISTINCT, DISTINCT]
    assert slept.strip() == "30"
    assert "resolved=true" in recorded
    assert "HTTP 404" in completed.stdout


def test_final_attempt_shows_stderr_and_keeps_the_error_text(tmp_path: Path):
    completed, curled, _, recorded = run_wait(
        tmp_path,
        meta="",
        stderr="synthetic-registry-down",
        codes="404",
        fake_sleep=True,
        max_wait="1",
        timeout=15,
    )
    assert completed.returncode == 1
    assert completed.stdout.count("npm view stderr on final attempt:") == 1
    assert "synthetic-registry-down" in completed.stdout
    assert "(empty)" in completed.stdout
    assert curled.strip().splitlines()[0] == TARBALL
    assert "HTTP 000" not in completed.stdout
    assert "HTTP 404" in completed.stdout
    assert "resolved=false" in recorded
    assert "waited=" in recorded
    assert (
        "::error::Release 0.32.0 tarball was not HTTP 200 after" in completed.stdout
    )
    assert "npm view can resolve while the tarball URL still 404s." in completed.stdout


def test_refuses_a_version_that_cannot_be_a_path_segment(tmp_path: Path):
    completed, curled, _, _ = run_wait(tmp_path, version="0.32.0/../other", timeout=5)
    assert completed.returncode == 2
    assert curled == ""
    assert "Refusing tarball URL" in completed.stderr


def test_workflow_keeps_deadline_and_issue_wording():
    text = WORKFLOW.read_text(encoding="utf-8")
    assert 'if [ "$ACCEPTED" = "true" ] || [ "$PROCESSING" = "true" ]; then' in text
    assert "MAX_WAIT=1200" in text
    assert "MAX_WAIT=180" in text
    assert "wait_for_npm_tarball.sh" in text
    assert OBJECT_ONLY_FILTER not in text
    assert (
        "The GitHub release **${TAG}** exists, but the dist.tarball URL for "
        "@facthouse/mcp@${VERSION} was not HTTP 200 after waiting **${WAITED:-?}s** "
        "(budget ${MAX_WAIT:-?}s)."
    ) in text
    assert "Publish job result: ${PUBLISH_RESULT}. This run accepted a publish: ${ACCEPTED:-false}. Dist-tag showed an in-flight version: ${PROCESSING:-false}." in text
    assert "2. Is npm view @facthouse/mcp@${VERSION} version empty *now*?" in text
