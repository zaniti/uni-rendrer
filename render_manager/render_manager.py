#!/usr/bin/env python3
"""Bulk GitHub Actions render queue for the universal Remotion renderer.

This app is intentionally self-contained: it uses only the Python standard library
so it can run on a Mac without installing extra packages.
"""
from __future__ import annotations

import http.client
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))
try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:
    DND_FILES = "DND_Files"
    TkinterDnD = None

APP_NAME = "GitHub Render Queue"
APP_SUPPORT_NAME = "GitHub Render Queue"
KEYCHAIN_SERVICE = "github-render-queue"
GITHUB_API = "https://api.github.com"
WORKFLOW_FILE = "render-release.yml"
DEFAULT_BRANCH = "main"
DEFAULT_WORKERS = "20"
DEFAULT_SCALE = "1"
RELEASE_TAGS = [f"v{i}" for i in range(1, 11)]
POLL_SECONDS = 20


def split_worker_budget(total: int, count: int) -> list[int]:
    """Split a total worker budget as evenly as possible across selected jobs."""
    if count <= 0:
        return []
    total = max(count, total)
    base, remainder = divmod(total, count)
    return [base + (1 if index < remainder else 0) for index in range(count)]


def display_run_status(status: str) -> str:
    if status == "queued":
        return "waiting for GitHub runner"
    if status == "in_progress":
        return "rendering"
    return status or "submitted"


def app_support_dir(create: bool = True) -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_SUPPORT_NAME
    else:
        base = Path.home() / ".github-render-queue"
    if create:
        base.mkdir(parents=True, exist_ok=True)
    return base


APP_SUPPORT_DIR = app_support_dir(create=False)
SETTINGS_PATH = APP_SUPPORT_DIR / "settings.json"
QUEUE_PATH = APP_SUPPORT_DIR / "queue.json"
LOCAL_TOKEN_PATH = APP_SUPPORT_DIR / "token.local.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_json_load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def safe_json_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def parse_github_remote(repo_root: Path) -> tuple[str, str]:
    default = ("zaniti", "uni-rendrer")
    try:
        out = subprocess.check_output(
            ["git", "-C", str(repo_root), "config", "--get", "remote.origin.url"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
    except Exception:
        return default
    patterns = [
        r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/.]+)(?:\.git)?$",
        r"github\.com/(?P<owner>[^/]+)/(?P<repo>[^/.]+)(?:\.git)?$",
    ]
    for pat in patterns:
        match = re.search(pat, out)
        if match:
            return match.group("owner"), match.group("repo")
    return default


def workflow_stem_for_zip(zip_path: str) -> str:
    stem = Path(zip_path).stem
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip("-") or "video"


class SettingsStore:
    def __init__(self, repo_root: Path):
        owner, repo = parse_github_remote(repo_root)
        self.data = {
            "owner": owner,
            "repo": repo,
            "branch": DEFAULT_BRANCH,
            "workflow_file": WORKFLOW_FILE,
            "username": "",
            "default_workers": DEFAULT_WORKERS,
            "default_scale": DEFAULT_SCALE,
            "download_dir": str(Path.home() / "Downloads"),
            "updated_at": now_iso(),
        }
        self.data.update(safe_json_load(SETTINGS_PATH, {}))

    def save(self) -> None:
        self.data["updated_at"] = now_iso()
        safe_json_write(SETTINGS_PATH, self.data)

    @property
    def owner(self) -> str:
        return str(self.data.get("owner") or "zaniti")

    @property
    def repo(self) -> str:
        return str(self.data.get("repo") or "uni-rendrer")

    @property
    def branch(self) -> str:
        return str(self.data.get("branch") or DEFAULT_BRANCH)

    @property
    def workflow_file(self) -> str:
        return str(self.data.get("workflow_file") or WORKFLOW_FILE)

    @property
    def username(self) -> str:
        return str(self.data.get("username") or "")

    def set_login(self, username: str, token: str) -> None:
        self.data["username"] = username.strip()
        self.save()
        save_token(self.username, token)

    def token(self) -> str:
        if not self.username:
            return ""
        return load_token(self.username)


def run_security(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["security", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
    )


def save_token(username: str, token: str) -> None:
    username = username.strip()
    token = token.strip()
    if not username or not token:
        return
    if sys.platform == "darwin" and shutil.which("security"):
        result = run_security([
            "add-generic-password",
            "-a",
            username,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            token,
            "-U",
        ])
        if result.returncode == 0:
            if LOCAL_TOKEN_PATH.exists():
                try:
                    LOCAL_TOKEN_PATH.unlink()
                except Exception:
                    pass
            return
    safe_json_write(LOCAL_TOKEN_PATH, {"username": username, "token": token})
    try:
        LOCAL_TOKEN_PATH.chmod(0o600)
    except Exception:
        pass


def load_token(username: str) -> str:
    username = username.strip()
    if not username:
        return ""
    if sys.platform == "darwin" and shutil.which("security"):
        result = run_security([
            "find-generic-password",
            "-a",
            username,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        if result.returncode == 0:
            return result.stdout.strip()
    local = safe_json_load(LOCAL_TOKEN_PATH, {})
    if local.get("username") == username:
        return str(local.get("token") or "").strip()
    return ""


class GitHubError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class SafeArtifactRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not leak GitHub authorization headers to artifact storage redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlparse(req.full_url).netloc != urllib.parse.urlparse(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


class GitHubClient:
    def __init__(self, owner: str, repo: str, token: str):
        self.owner = owner
        self.repo = repo
        self.token = token.strip()
        if not self.token:
            raise GitHubError("Missing GitHub token.", status=401)

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "github-render-queue",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if extra:
            headers.update(extra)
        return headers

    def _url(self, path: str) -> str:
        if path.startswith("http"):
            return path
        return GITHUB_API + path

    def request_json(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> Any:
        data = None
        headers = self._headers()
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self._url(path), data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
                if resp.status not in expected:
                    raise GitHubError(f"GitHub returned HTTP {resp.status}.", resp.status)
                if not body:
                    return None
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            message = body
            try:
                parsed = json.loads(body)
                message = parsed.get("message") or body
                if parsed.get("errors"):
                    message += " " + json.dumps(parsed["errors"], ensure_ascii=False)
            except Exception:
                pass
            raise GitHubError(message, exc.code) from exc
        except urllib.error.URLError as exc:
            raise GitHubError(f"Network error: {exc}") from exc

    def repo_path(self, suffix: str = "") -> str:
        return f"/repos/{self.owner}/{self.repo}{suffix}"

    def test_access(self) -> None:
        self.request_json("GET", self.repo_path(), expected=(200,))

    def release_by_tag(self, tag: str) -> dict[str, Any] | None:
        try:
            return self.request_json("GET", self.repo_path(f"/releases/tags/{urllib.parse.quote(tag)}"), expected=(200,))
        except GitHubError as exc:
            if exc.status == 404:
                return None
            raise

    def create_release(self, tag: str, branch: str) -> dict[str, Any]:
        return self.request_json(
            "POST",
            self.repo_path("/releases"),
            {
                "tag_name": tag,
                "target_commitish": branch,
                "name": tag,
                "body": "Temporary input release used by GitHub Render Queue.",
                "draft": False,
                "prerelease": False,
            },
            expected=(201,),
        )

    def ensure_release(self, tag: str, branch: str) -> dict[str, Any]:
        existing = self.release_by_tag(tag)
        if existing:
            return existing
        return self.create_release(tag, branch)

    def delete_release(self, release_id: int) -> None:
        self.request_json("DELETE", self.repo_path(f"/releases/{release_id}"), expected=(204,))

    def list_release_assets(self, release_id: int) -> list[dict[str, Any]]:
        return self.request_json("GET", self.repo_path(f"/releases/{release_id}/assets?per_page=100"), expected=(200,))

    def delete_asset(self, asset_id: int) -> None:
        self.request_json("DELETE", self.repo_path(f"/releases/assets/{asset_id}"), expected=(204,))

    def clear_releases(self, tags: list[str], log) -> None:
        for tag in tags:
            release = self.release_by_tag(tag)
            if not release:
                log(f"{tag}: no release found.")
                continue
            log(f"{tag}: deleting release and its assets...")
            self.delete_release(int(release["id"]))
            log(f"{tag}: cleared.")

    def replace_zip_asset(self, tag: str, branch: str, zip_path: Path, log) -> None:
        release = self.ensure_release(tag, branch)
        release_id = int(release["id"])
        assets = self.list_release_assets(release_id)
        for asset in assets:
            name = str(asset.get("name") or "")
            if name.lower().endswith(".zip"):
                log(f"{tag}: removing old zip asset {name}...")
                self.delete_asset(int(asset["id"]))
        upload_url = str(release["upload_url"]).split("{")[0]
        query = urllib.parse.urlencode({"name": zip_path.name})
        url = f"{upload_url}?{query}"
        self.upload_asset(url, zip_path)

    def upload_asset(self, upload_url: str, file_path: Path) -> dict[str, Any]:
        parsed = urllib.parse.urlparse(upload_url)
        path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        size = file_path.stat().st_size
        headers = self._headers({
            "Content-Type": "application/zip",
            "Content-Length": str(size),
        })
        conn = http.client.HTTPSConnection(parsed.hostname, timeout=900)
        try:
            with file_path.open("rb") as fh:
                conn.request("POST", path, body=fh, headers=headers)
                resp = conn.getresponse()
                body = resp.read()
            if resp.status not in (201,):
                message = body.decode("utf-8", errors="replace")
                try:
                    parsed_body = json.loads(message)
                    message = parsed_body.get("message") or message
                except Exception:
                    pass
                raise GitHubError(message, resp.status)
            return json.loads(body.decode("utf-8"))
        finally:
            conn.close()

    def workflow_runs(self, workflow_file: str, branch: str, per_page: int = 20) -> list[dict[str, Any]]:
        path = self.repo_path(
            f"/actions/workflows/{urllib.parse.quote(workflow_file, safe='')}/runs"
            f"?event=workflow_dispatch&branch={urllib.parse.quote(branch)}&per_page={per_page}"
        )
        data = self.request_json("GET", path, expected=(200,))
        return list(data.get("workflow_runs") or [])

    def all_workflow_runs(self, workflow_file: str) -> list[dict[str, Any]]:
        runs: list[dict[str, Any]] = []
        page = 1
        while True:
            path = self.repo_path(
                f"/actions/workflows/{urllib.parse.quote(workflow_file, safe='')}/runs"
                f"?per_page=100&page={page}"
            )
            data = self.request_json("GET", path, expected=(200,))
            batch = list(data.get("workflow_runs") or [])
            runs.extend(batch)
            if len(batch) < 100:
                return runs
            page += 1

    def delete_workflow_run(self, run_id: int) -> None:
        self.request_json("DELETE", self.repo_path(f"/actions/runs/{run_id}"), expected=(204,))

    def clear_workflow_runs(self, workflow_file: str, log) -> int:
        runs = self.all_workflow_runs(workflow_file)
        if not runs:
            log("No render workflow jobs found.")
            return 0
        for index, run in enumerate(runs, start=1):
            run_id = int(run["id"])
            label = str(run.get("display_title") or run.get("name") or f"run {run_id}")
            log(f"Deleting render job {index}/{len(runs)}: {label} (#{run.get('run_number', run_id)})...")
            self.delete_workflow_run(run_id)
        return len(runs)

    def dispatch_workflow(self, workflow_file: str, branch: str, inputs: dict[str, str]) -> None:
        self.request_json(
            "POST",
            self.repo_path(f"/actions/workflows/{urllib.parse.quote(workflow_file, safe='')}/dispatches"),
            {"ref": branch, "inputs": inputs},
            expected=(204,),
        )

    def find_new_run(self, workflow_file: str, branch: str, previous_ids: set[int], after_timestamp: float) -> dict[str, Any] | None:
        runs = self.workflow_runs(workflow_file, branch, per_page=30)
        for run in runs:
            run_id = int(run.get("id"))
            if run_id in previous_ids:
                continue
            created_at = str(run.get("created_at") or "")
            try:
                created_ts = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
            except Exception:
                created_ts = time.time()
            if created_ts + 10 >= after_timestamp:
                return run
        return None

    def find_batch_runs(
        self,
        workflow_file: str,
        branch: str,
        previous_ids: set[int],
        expected_titles: dict[str, str],
        after_timestamp: float,
    ) -> dict[str, dict[str, Any]]:
        """Match newly dispatched runs to local job IDs by their workflow run title."""
        matches: dict[str, dict[str, Any]] = {}
        title_to_job = {title: job_id for job_id, title in expected_titles.items()}
        for run in self.workflow_runs(workflow_file, branch, per_page=100):
            run_id = int(run.get("id"))
            if run_id in previous_ids:
                continue
            created_at = str(run.get("created_at") or "")
            try:
                created_ts = datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
            except Exception:
                created_ts = time.time()
            if created_ts + 10 < after_timestamp:
                continue
            job_id = title_to_job.get(str(run.get("display_title") or ""))
            if job_id:
                matches[job_id] = run
        return matches

    def get_run(self, run_id: int) -> dict[str, Any]:
        return self.request_json("GET", self.repo_path(f"/actions/runs/{run_id}"), expected=(200,))

    def list_run_artifacts(self, run_id: int) -> list[dict[str, Any]]:
        data = self.request_json("GET", self.repo_path(f"/actions/runs/{run_id}/artifacts?per_page=100"), expected=(200,))
        return list(data.get("artifacts") or [])

    def download_artifact_archive(self, artifact_id: int, dest_zip: Path, progress=None) -> None:
        url = self.repo_path(f"/actions/artifacts/{artifact_id}/zip")
        req = urllib.request.Request(self._url(url), headers=self._headers(), method="GET")
        opener = urllib.request.build_opener(SafeArtifactRedirectHandler())
        with opener.open(req, timeout=900) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            with dest_zip.open("wb") as fh:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    if progress and total:
                        progress(done, total)


@dataclass
class RenderJob:
    id: str
    zip_path: str
    release_tag: str = "v1"
    workers: str = DEFAULT_WORKERS
    scale: str = DEFAULT_SCALE
    enabled: bool = True
    status: str = "waiting"
    run_id: str = ""
    run_url: str = ""
    artifact_id: str = ""
    artifact_name: str = ""
    artifact_api_url: str = ""
    artifact_web_url: str = ""
    error: str = ""
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    @property
    def zip_name(self) -> str:
        return Path(self.zip_path).name

    @property
    def stem(self) -> str:
        return workflow_stem_for_zip(self.zip_path)

    @property
    def result_label(self) -> str:
        if self.artifact_id:
            return "download ready"
        if self.error:
            return "error"
        return "—"

    def to_json(self) -> dict[str, Any]:
        data = asdict(self)
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "RenderJob":
        valid = {f.name for f in cls.__dataclass_fields__.values()}
        kwargs = {k: v for k, v in data.items() if k in valid}
        return cls(**kwargs)


class LoginDialog(tk.Toplevel):
    def __init__(self, parent: tk.Tk, settings: SettingsStore, reason: str = ""):
        super().__init__(parent)
        self.title("GitHub login")
        self.resizable(False, False)
        self.settings = settings
        self.result = False
        self.configure(padx=22, pady=18)
        self.transient(parent)
        self.grab_set()

        title = ttk.Label(self, text="Connect GitHub", font=("Helvetica", 18, "bold"))
        title.grid(row=0, column=0, columnspan=2, sticky="w")

        msg = reason or "Enter a GitHub username and token to control the renderer workflow."
        ttk.Label(self, text=msg, wraplength=420, foreground="#4b5563").grid(row=1, column=0, columnspan=2, sticky="w", pady=(6, 14))

        repo_text = f"Repo: {settings.owner}/{settings.repo}"
        ttk.Label(self, text=repo_text, foreground="#6b7280").grid(row=2, column=0, columnspan=2, sticky="w", pady=(0, 12))

        ttk.Label(self, text="Username").grid(row=3, column=0, sticky="w", pady=4)
        self.username_var = tk.StringVar(value=settings.username)
        username_entry = ttk.Entry(self, textvariable=self.username_var, width=42)
        username_entry.grid(row=3, column=1, sticky="ew", pady=4)

        ttk.Label(self, text="Token").grid(row=4, column=0, sticky="w", pady=4)
        self.token_var = tk.StringVar()
        token_entry = ttk.Entry(self, textvariable=self.token_var, width=42, show="•")
        token_entry.grid(row=4, column=1, sticky="ew", pady=4)

        hint = "Token permissions: Contents read/write + Actions read/write. For private repos, repo scope also works."
        ttk.Label(self, text=hint, wraplength=420, foreground="#6b7280").grid(row=5, column=0, columnspan=2, sticky="w", pady=(8, 14))

        self.error_var = tk.StringVar()
        ttk.Label(self, textvariable=self.error_var, foreground="#b91c1c", wraplength=420).grid(row=6, column=0, columnspan=2, sticky="w")

        buttons = ttk.Frame(self)
        buttons.grid(row=7, column=0, columnspan=2, sticky="e", pady=(16, 0))
        ttk.Button(buttons, text="Cancel", command=self.cancel).pack(side="right", padx=(8, 0))
        ttk.Button(buttons, text="Save and test", command=self.save).pack(side="right")

        self.columnconfigure(1, weight=1)
        token_entry.focus_set() if settings.username else username_entry.focus_set()
        self.bind("<Return>", lambda _e: self.save())
        self.bind("<Escape>", lambda _e: self.cancel())
        self.wait_visibility()
        self.geometry(f"+{parent.winfo_rootx() + 120}+{parent.winfo_rooty() + 120}")

    def save(self) -> None:
        username = self.username_var.get().strip()
        token = self.token_var.get().strip()
        if not username or not token:
            self.error_var.set("Username and token are required.")
            return
        self.error_var.set("Testing token...")
        self.update_idletasks()
        try:
            client = GitHubClient(self.settings.owner, self.settings.repo, token)
            client.test_access()
        except Exception as exc:
            self.error_var.set(f"Login failed: {exc}")
            return
        self.settings.set_login(username, token)
        self.result = True
        self.destroy()

    def cancel(self) -> None:
        self.result = False
        self.destroy()


RenderQueueBase = TkinterDnD.Tk if TkinterDnD is not None else tk.Tk


class RenderQueueApp(RenderQueueBase):
    def __init__(self, repo_root: Path):
        super().__init__()
        self.repo_root = repo_root
        self.settings = SettingsStore(repo_root)
        self.jobs: list[RenderJob] = self.load_queue()
        self.state_lock = threading.Lock()
        self.ui_events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.worker: threading.Thread | None = None
        self.busy = False
        self.client: GitHubClient | None = None
        self.neat_opening = False
        self.neat_download_queue: list[RenderJob] = []

        self.title(APP_NAME)
        self.geometry("1180x760")
        self.minsize(980, 620)
        self.configure(bg="#f6f7fb")
        self.setup_style()
        self.build_ui()
        self.refresh_table()
        self.after(120, self.drain_events)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

        if not self.settings.username or not self.settings.token():
            self.after(250, lambda: self.show_login("First use: connect your GitHub account."))

    def setup_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("TFrame", background="#f6f7fb")
        style.configure("Card.TFrame", background="#ffffff", relief="flat")
        style.configure("TLabel", background="#f6f7fb", foreground="#111827")
        style.configure("Card.TLabel", background="#ffffff", foreground="#111827")
        style.configure("Muted.TLabel", background="#f6f7fb", foreground="#6b7280")
        style.configure("CardMuted.TLabel", background="#ffffff", foreground="#6b7280")
        style.configure("Accent.TButton", padding=(14, 8))
        style.configure("Danger.TButton", foreground="#991b1b")
        style.configure("Treeview", rowheight=30, font=("Helvetica", 12))
        style.configure("Treeview.Heading", font=("Helvetica", 12, "bold"))

    def build_ui(self) -> None:
        outer = ttk.Frame(self, padding=18)
        outer.pack(fill="both", expand=True)

        header = ttk.Frame(outer)
        header.pack(fill="x")
        ttk.Label(header, text="GitHub Render Queue", font=("Helvetica", 24, "bold")).pack(side="left")
        self.repo_var = tk.StringVar(value=f"{self.settings.owner}/{self.settings.repo} · {self.settings.branch} · {self.settings.workflow_file}")
        ttk.Label(header, textvariable=self.repo_var, style="Muted.TLabel").pack(side="left", padx=(18, 0))
        ttk.Button(header, text="Login / token", command=self.show_login).pack(side="right")

        controls = ttk.Frame(outer, padding=(0, 16, 0, 8))
        controls.pack(fill="x")
        ttk.Button(controls, text="Remove selected", command=self.remove_selected).pack(side="left")
        ttk.Button(controls, text="Auto assign v1-v10", command=self.auto_assign).pack(side="left", padx=(8, 0))
        ttk.Button(controls, text="Clear all", command=self.clear_all, style="Danger.TButton").pack(side="left", padx=(8, 0))

        ttk.Label(controls, text="Total workers:").pack(side="left", padx=(28, 4))
        self.default_workers_var = tk.StringVar(value=str(self.settings.data.get("default_workers") or DEFAULT_WORKERS))
        total_workers_entry = ttk.Entry(controls, width=6, textvariable=self.default_workers_var)
        total_workers_entry.pack(side="left")
        total_workers_entry.bind("<Return>", self.on_worker_budget_changed)
        total_workers_entry.bind("<FocusOut>", self.on_worker_budget_changed)
        ttk.Label(controls, text="Scale:").pack(side="left", padx=(12, 4))
        self.default_scale_var = tk.StringVar(value=str(self.settings.data.get("default_scale") or DEFAULT_SCALE))
        ttk.Combobox(controls, width=10, values=["1", "2"], state="readonly", textvariable=self.default_scale_var).pack(side="left")

        self.launch_button = ttk.Button(controls, text="Launch bulk render", command=self.launch_bulk, style="Accent.TButton")
        self.launch_button.pack(side="right")
        self.refresh_button = ttk.Button(controls, text="Refresh jobs", command=self.refresh_jobs)
        self.refresh_button.pack(side="right", padx=(0, 8))

        editor = ttk.Frame(outer, padding=(0, 4, 0, 8))
        editor.pack(fill="x")
        ttk.Label(editor, text="Selected row:").pack(side="left")
        ttk.Label(editor, text="Release").pack(side="left", padx=(12, 4))
        self.row_release_var = tk.StringVar(value="v1")
        ttk.Combobox(editor, width=8, values=RELEASE_TAGS, state="readonly", textvariable=self.row_release_var).pack(side="left")
        ttk.Label(editor, text="Workers").pack(side="left", padx=(12, 4))
        self.row_workers_var = tk.StringVar(value=DEFAULT_WORKERS)
        ttk.Entry(editor, width=6, textvariable=self.row_workers_var).pack(side="left")
        ttk.Label(editor, text="Scale").pack(side="left", padx=(12, 4))
        self.row_scale_var = tk.StringVar(value=DEFAULT_SCALE)
        ttk.Combobox(editor, width=8, values=["1", "2"], state="readonly", textvariable=self.row_scale_var).pack(side="left")
        ttk.Button(editor, text="Apply to selected", command=self.apply_to_selected).pack(side="left", padx=(10, 0))

        self.drop_zone = tk.Label(
            outer,
            text="Drop .zip render packages here — or click to choose files",
            bg="#eef2ff",
            fg="#3730a3",
            activebackground="#e0e7ff",
            cursor="hand2",
            font=("Helvetica", 13, "bold"),
            relief="solid",
            borderwidth=1,
            padx=12,
            pady=10,
        )
        self.drop_zone.pack(fill="x", pady=(0, 8))
        self.drop_zone.bind("<Button-1>", lambda _event: self.add_zips())
        self.setup_zip_drop()

        table_card = ttk.Frame(outer, style="Card.TFrame", padding=10)
        table_card.pack(fill="both", expand=True, pady=(4, 12))
        columns = ("publish", "idx", "zip", "release", "scale", "workers", "status", "run", "result")
        self.tree = ttk.Treeview(table_card, columns=columns, show="headings", selectmode="extended")
        headings = {
            "publish": "Selected",
            "idx": "#",
            "zip": "Zip",
            "release": "Release",
            "scale": "Scale",
            "workers": "Workers",
            "status": "Status",
            "run": "Run",
            "result": "Result",
        }
        widths = {"publish": 70, "idx": 44, "zip": 340, "release": 75, "scale": 60, "workers": 75, "status": 155, "run": 105, "result": 130}
        for col in columns:
            self.tree.heading(col, text=headings[col])
            self.tree.column(col, width=widths[col], anchor="w", stretch=(col == "zip"))
        self.tree.pack(side="left", fill="both", expand=True)
        scrollbar = ttk.Scrollbar(table_card, orient="vertical", command=self.tree.yview)
        scrollbar.pack(side="right", fill="y")
        self.tree.configure(yscrollcommand=scrollbar.set)
        self.tree.bind("<<TreeviewSelect>>", self.on_select)
        self.tree.bind("<Button-1>", self.on_tree_click)
        self.tree.tag_configure("done", background="#ecfdf5")
        self.tree.tag_configure("failed", background="#fef2f2")
        self.tree.tag_configure("running", background="#eff6ff")

        actions = ttk.Frame(outer)
        actions.pack(fill="x", pady=(0, 10))
        ttk.Button(actions, text="Copy download link", command=self.copy_download_link).pack(side="left")
        ttk.Button(actions, text="Download jobs", command=self.download_selected).pack(side="left", padx=(8, 0))
        self.neat_button = ttk.Button(actions, text="Download with Neat (Brave)", command=self.download_with_neat)
        self.neat_button.pack(side="left", padx=(8, 0))
        ttk.Button(actions, text="Select download path", command=self.select_download_path).pack(side="left", padx=(8, 0))
        self.download_path_var = tk.StringVar(value=self.download_path_label())
        ttk.Label(actions, textvariable=self.download_path_var, style="Muted.TLabel").pack(side="left", padx=(10, 0), fill="x", expand=True)

        log_card = ttk.Frame(outer, style="Card.TFrame", padding=8)
        log_card.pack(fill="both", expand=False)
        ttk.Label(log_card, text="Progress", style="Card.TLabel", font=("Helvetica", 13, "bold")).pack(anchor="w")
        self.log_text = tk.Text(log_card, height=8, wrap="word", bg="#111827", fg="#e5e7eb", insertbackground="#e5e7eb", relief="flat")
        self.log_text.pack(fill="both", expand=True, pady=(6, 0))
        self.log("Ready. Checked jobs launch together; reopen later and click Refresh jobs for their latest status.")

    def load_queue(self) -> list[RenderJob]:
        raw = safe_json_load(QUEUE_PATH, [])
        jobs = []
        for item in raw if isinstance(raw, list) else []:
            try:
                jobs.append(RenderJob.from_json(item))
            except Exception:
                pass
        return jobs

    def save_queue(self) -> None:
        with self.state_lock:
            safe_json_write(QUEUE_PATH, [job.to_json() for job in self.jobs])

    def selected_jobs(self) -> list[RenderJob]:
        ids = set(self.tree.selection())
        return [job for job in self.jobs if job.id in ids]

    def first_selected_job(self) -> RenderJob | None:
        selected = self.selected_jobs()
        return selected[0] if selected else None

    def refresh_table(self) -> None:
        selected = set(self.tree.selection()) if hasattr(self, "tree") else set()
        for item in self.tree.get_children():
            self.tree.delete(item)
        for idx, job in enumerate(self.jobs, start=1):
            tag = ""
            if job.status == "done":
                tag = "done"
            elif job.error or job.status in {"failed", "error"}:
                tag = "failed"
            elif job.status not in {"waiting", "skipped"}:
                tag = "running"
            self.tree.insert(
                "",
                "end",
                iid=job.id,
                values=("☑" if job.enabled else "☐", idx, job.zip_name, job.release_tag, job.scale, job.workers, job.status, job.run_id or "—", job.result_label),
                tags=(tag,) if tag else (),
            )
        for item in selected:
            if self.tree.exists(item):
                self.tree.selection_add(item)
        self.save_queue()

    def pending_enabled_jobs(self) -> list[RenderJob]:
        active_or_done = {"done", "submitted", "queued", "in_progress", "rendering", "collecting artifact"}
        retryable = {"failed", "error"}
        return [
            job for job in self.jobs
            if job.enabled
            and job.status not in active_or_done
            and (not job.run_id or job.status in retryable)
        ]

    def on_tree_click(self, event):
        if self.tree.identify_region(event.x, event.y) != "cell" or self.tree.identify_column(event.x) != "#1":
            return None
        item_id = self.tree.identify_row(event.y)
        job = next((candidate for candidate in self.jobs if candidate.id == item_id), None)
        if not job:
            return "break"
        job.enabled = not job.enabled
        job.updated_at = now_iso()
        self.redistribute_workers()
        return "break"

    def on_worker_budget_changed(self, _event=None) -> None:
        self.redistribute_workers()

    def redistribute_workers(self, refresh: bool = True) -> None:
        targets = self.pending_enabled_jobs()
        try:
            total = int(self.default_workers_var.get().strip())
        except (TypeError, ValueError):
            total = int(DEFAULT_WORKERS)
            self.default_workers_var.set(str(total))
        total = max(1, total)
        for job, workers in zip(targets, split_worker_budget(total, len(targets))):
            job.workers = str(workers)
            job.updated_at = now_iso()
        self.settings.data["default_workers"] = str(total)
        self.settings.save()
        if refresh:
            self.refresh_table()

    def log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.insert("end", f"[{stamp}] {message}\n")
        self.log_text.see("end")

    def event_log(self, message: str) -> None:
        self.ui_events.put(("log", message))

    def drain_events(self) -> None:
        try:
            while True:
                kind, payload = self.ui_events.get_nowait()
                if kind == "log":
                    self.log(str(payload))
                elif kind == "refresh":
                    self.refresh_table()
                elif kind == "busy":
                    self.set_busy(bool(payload))
                elif kind == "auth_failed":
                    self.set_busy(False)
                    self.show_login("GitHub token expired or was rejected. Enter a new token to continue.")
                elif kind == "message":
                    title, msg = payload
                    messagebox.showinfo(title, msg)
                elif kind == "error":
                    title, msg = payload
                    messagebox.showerror(title, msg)
        except queue.Empty:
            pass
        self.after(120, self.drain_events)

    def set_busy(self, busy: bool) -> None:
        self.busy = busy
        self.launch_button.configure(state="disabled" if busy else "normal")
        self.refresh_button.configure(state="disabled" if busy else "normal")

    def show_login(self, reason: str = "") -> bool:
        dialog = LoginDialog(self, self.settings, reason)
        self.wait_window(dialog)
        self.repo_var.set(f"{self.settings.owner}/{self.settings.repo} · {self.settings.branch} · {self.settings.workflow_file}")
        self.client = None
        return dialog.result

    def ensure_client(self, interactive: bool = True) -> GitHubClient | None:
        token = self.settings.token()
        if not token:
            if interactive and self.show_login("Connect GitHub before rendering."):
                token = self.settings.token()
        if not token:
            return None
        client = GitHubClient(self.settings.owner, self.settings.repo, token)
        try:
            client.test_access()
        except GitHubError as exc:
            if exc.status == 401 and interactive:
                if self.show_login("GitHub token expired or invalid. Enter a new token."):
                    return self.ensure_client(interactive=False)
            messagebox.showerror("GitHub login failed", str(exc))
            return None
        self.client = client
        return client

    def add_zips(self) -> None:
        files = filedialog.askopenfilenames(title="Choose render zip files", filetypes=[("Zip files", "*.zip")])
        if not files:
            return
        self.add_zip_paths(files)

    def add_zip_paths(self, paths) -> None:
        files: list[Path] = []
        existing = {str(Path(job.zip_path).expanduser().resolve()) for job in self.jobs}
        for raw_path in paths:
            path = Path(str(raw_path)).expanduser()
            if path.suffix.lower() != ".zip" or not path.is_file():
                continue
            resolved = str(path.resolve())
            if resolved in existing:
                continue
            existing.add(resolved)
            files.append(path.resolve())
        if not files:
            self.log("No new .zip files were added.")
            return
        start_index = len(self.jobs)
        for offset, file in enumerate(files):
            release = RELEASE_TAGS[(start_index + offset) % len(RELEASE_TAGS)]
            job = RenderJob(
                id=str(uuid.uuid4()),
                zip_path=str(file),
                release_tag=release,
                workers=str(self.default_workers_var.get() or DEFAULT_WORKERS),
                scale=str(self.default_scale_var.get() or DEFAULT_SCALE),
            )
            self.jobs.append(job)
        assignable = self.pending_enabled_jobs()
        for idx, job in enumerate(assignable):
            job.release_tag = RELEASE_TAGS[idx % len(RELEASE_TAGS)]
        self.redistribute_workers(refresh=False)
        self.settings.data["default_workers"] = str(self.default_workers_var.get() or DEFAULT_WORKERS)
        self.settings.data["default_scale"] = str(self.default_scale_var.get() or DEFAULT_SCALE)
        self.settings.save()
        self.refresh_table()
        self.log(f"Added {len(files)} zip file(s).")

    def setup_zip_drop(self) -> None:
        if TkinterDnD is not None:
            self.drop_zone.drop_target_register(DND_FILES)
            self.drop_zone.dnd_bind("<<Drop>>", self.on_zip_drop_event)
            return
        try:
            self.tk.call("package", "require", "tkdnd")
            self.tk.call("tkdnd::drop_target", "register", self.drop_zone._w, "DND_Files")
            self._zip_drop_command = self.register(self.on_zip_drop_data)
            self.tk.call("bind", self.drop_zone._w, "<<Drop>>", f"{self._zip_drop_command} %D")
        except tk.TclError:
            self.drop_zone.configure(text="Click to choose .zip render packages", fg="#6b7280")

    def on_zip_drop_event(self, event):
        return self.on_zip_drop_data(event.data)

    def on_zip_drop_data(self, data: str):
        self.drop_zone.configure(bg="#eef2ff")
        try:
            paths = self.tk.splitlist(data)
        except tk.TclError:
            paths = ()
        self.add_zip_paths(paths)
        return "copy"

    def remove_selected(self) -> None:
        selected = {job.id for job in self.jobs if job.enabled}
        if not selected:
            messagebox.showinfo("Nothing selected", "Check the Publish box for the rows you want to remove.")
            return
        if not messagebox.askyesno("Remove selected", f"Remove {len(selected)} checked row(s) from the local queue?"):
            return
        self.jobs = [job for job in self.jobs if job.id not in selected]
        self.redistribute_workers()

    def auto_assign(self) -> None:
        targets = self.selected_jobs() or self.pending_enabled_jobs()
        for idx, job in enumerate(targets):
            job.release_tag = RELEASE_TAGS[idx % len(RELEASE_TAGS)]
            job.updated_at = now_iso()
        self.refresh_table()
        self.log(f"Auto-assigned releases for {len(targets)} row(s).")

    def on_select(self, _event=None) -> None:
        job = self.first_selected_job()
        if not job:
            return
        self.row_release_var.set(job.release_tag)
        self.row_workers_var.set(job.workers)
        self.row_scale_var.set(job.scale)

    def apply_to_selected(self) -> None:
        selected = self.selected_jobs()
        if not selected:
            return
        release = self.row_release_var.get() or "v1"
        workers = self.row_workers_var.get().strip() or DEFAULT_WORKERS
        scale = self.row_scale_var.get().strip() or DEFAULT_SCALE
        for job in selected:
            job.release_tag = release
            job.workers = workers
            job.scale = scale
            job.updated_at = now_iso()
        self.refresh_table()
        self.log(f"Updated {len(selected)} selected row(s).")

    def clear_all(self) -> None:
        client = self.ensure_client()
        if not client:
            return
        msg = (
            f"This will permanently delete all Render Release Zips workflow jobs, their artifacts, "
            f"and renderer releases {', '.join(RELEASE_TAGS)} in {self.settings.owner}/{self.settings.repo}.\n\n"
            "It does not delete your local ZIP files or rows from this app. Continue?"
        )
        if not messagebox.askyesno("Clear all renderer data", msg):
            return
        self.set_busy(True)

        def worker() -> None:
            try:
                count = client.clear_workflow_runs(self.settings.workflow_file, self.event_log)
                client.clear_releases(RELEASE_TAGS, self.event_log)
                self.ui_events.put(("message", ("Renderer data cleared", f"Deleted {count} workflow job(s), their artifacts, and releases v1-v10.")))
            except GitHubError as exc:
                if exc.status == 401:
                    self.ui_events.put(("auth_failed", None))
                else:
                    self.ui_events.put(("error", ("Renderer cleanup failed", str(exc))))
            finally:
                self.ui_events.put(("busy", False))

        threading.Thread(target=worker, daemon=True).start()

    def launch_bulk(self) -> None:
        if self.busy:
            return
        client = self.ensure_client()
        if not client:
            return
        targets = self.pending_enabled_jobs()
        if not targets:
            messagebox.showinfo("Nothing to render", "Check at least one waiting or failed row to render.")
            return
        if len(targets) > len(RELEASE_TAGS):
            messagebox.showerror("Too many jobs", f"At most {len(RELEASE_TAGS)} jobs can launch in one batch.")
            return
        missing = [job.zip_path for job in targets if not Path(job.zip_path).exists()]
        if missing:
            messagebox.showerror("Missing zip file", f"This file is missing:\n{missing[0]}")
            return
        for index, job in enumerate(targets):
            job.release_tag = RELEASE_TAGS[index]
        self.redistribute_workers(refresh=False)
        for job in targets:
            job.run_id = ""
            job.run_url = ""
            job.artifact_id = ""
            job.artifact_name = ""
            job.artifact_api_url = ""
            job.artifact_web_url = ""
            job.error = ""
            job.status = "waiting"
        self.refresh_table()
        self.set_busy(True)
        allocation = ", ".join(f"{job.zip_name}: {job.workers}" for job in targets)
        self.log(f"Submitting {len(targets)} checked jobs together. Worker split — {allocation}.")
        self.worker = threading.Thread(target=self.bulk_worker, args=(client, targets), daemon=True)
        self.worker.start()

    def bulk_worker(self, client: GitHubClient, targets: list[RenderJob]) -> None:
        try:
            uploaded: list[RenderJob] = []
            worker_count = min(len(targets), len(RELEASE_TAGS))
            self.event_log(f"Uploading all {len(targets)} release packages in parallel...")
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                futures = {executor.submit(self.upload_one_job, client, job, index, len(targets)): job for index, job in enumerate(targets, start=1)}
                for future in as_completed(futures):
                    job = futures[future]
                    try:
                        future.result()
                        uploaded.append(job)
                    except Exception as exc:
                        self.update_job(job, "failed", str(exc))
                        self.event_log(f"{job.zip_name}: upload failed: {exc}")

            if not uploaded:
                raise GitHubError("None of the release packages could be uploaded.")

            previous_ids = {int(run.get("id")) for run in client.workflow_runs(self.settings.workflow_file, self.settings.branch, per_page=100)}
            started_at = time.time()
            expected_titles: dict[str, str] = {}
            dispatched: list[RenderJob] = []
            for job in uploaded:
                queue_id = job.id[:8]
                title = f"Render {job.release_tag} · {queue_id}"
                inputs = {
                    "release_tag": job.release_tag,
                    "chunk_workers": str(job.workers or DEFAULT_WORKERS),
                    "render_scale": str(job.scale or DEFAULT_SCALE),
                    "queue_id": queue_id,
                }
                try:
                    client.dispatch_workflow(self.settings.workflow_file, self.settings.branch, inputs)
                    expected_titles[job.id] = title
                    dispatched.append(job)
                    self.update_job(job, "submitted")
                    self.event_log(f"{job.zip_name}: workflow submitted with {job.workers} workers.")
                except Exception as exc:
                    self.update_job(job, "failed", f"Workflow dispatch failed: {exc}")
                    self.event_log(f"{job.zip_name}: workflow dispatch failed: {exc}")

            if not dispatched:
                raise GitHubError("The releases uploaded, but none of their workflows could be submitted.")

            unmatched = {job.id for job in dispatched}
            for _ in range(24):
                matches = client.find_batch_runs(
                    self.settings.workflow_file,
                    self.settings.branch,
                    previous_ids,
                    expected_titles,
                    started_at,
                )
                for job in dispatched:
                    run = matches.get(job.id)
                    if not run or job.id not in unmatched:
                        continue
                    job.run_id = str(run["id"])
                    job.run_url = str(run.get("html_url") or "")
                    self.update_job(job, display_run_status(str(run.get("status") or "queued")))
                    self.save_queue()
                    unmatched.remove(job.id)
                    self.event_log(f"{job.zip_name}: GitHub run {job.run_id} linked and saved.")
                if not unmatched:
                    break
                time.sleep(5)

            if unmatched:
                for job in dispatched:
                    if job.id in unmatched:
                        self.update_job(job, "submitted — refresh to link")
                self.event_log("Some run IDs are not visible from GitHub yet. Use Refresh jobs in a moment.")
            self.save_queue()
            self.event_log("All checked jobs were submitted. You can close the app and refresh their status later.")
        except GitHubError as exc:
            if exc.status == 401:
                self.ui_events.put(("auth_failed", None))
            else:
                self.ui_events.put(("error", ("Render queue failed", str(exc))))
        except Exception as exc:
            self.ui_events.put(("error", ("Render queue failed", str(exc))))
        finally:
            self.ui_events.put(("busy", False))
            self.ui_events.put(("refresh", None))

    def update_job(self, job: RenderJob, status: str, error: str = "") -> None:
        job.status = status
        job.error = error
        job.updated_at = now_iso()
        self.ui_events.put(("refresh", None))

    def upload_one_job(self, client: GitHubClient, job: RenderJob, index: int, total: int) -> None:
        zip_path = Path(job.zip_path)
        prefix = f"{index}/{total} {job.zip_name}"
        self.update_job(job, "uploading")
        self.event_log(f"{prefix}: uploading to release {job.release_tag}...")
        client.replace_zip_asset(job.release_tag, self.settings.branch, zip_path, self.event_log)
        self.update_job(job, "uploaded")
        self.event_log(f"{prefix}: release upload complete.")

    def refresh_jobs(self) -> None:
        if self.busy:
            return
        client = self.ensure_client()
        if not client:
            return
        targets = [job for job in self.jobs if job.run_id or job.status.startswith("submitted")]
        if not targets:
            messagebox.showinfo("No submitted jobs", "There are no submitted GitHub jobs to refresh yet.")
            return
        self.set_busy(True)
        self.log(f"Refreshing {len(targets)} submitted job(s) from GitHub...")
        threading.Thread(target=self.refresh_jobs_worker, args=(client, targets), daemon=True).start()

    def refresh_jobs_worker(self, client: GitHubClient, targets: list[RenderJob]) -> None:
        try:
            recent_runs = client.workflow_runs(self.settings.workflow_file, self.settings.branch, per_page=100)
            runs_by_title: dict[str, dict[str, Any]] = {}
            for run in recent_runs:
                title = str(run.get("display_title") or "")
                if title and title not in runs_by_title:
                    runs_by_title[title] = run

            for job in targets:
                try:
                    run = None
                    if job.run_id:
                        run = client.get_run(int(job.run_id))
                    else:
                        run = runs_by_title.get(f"Render {job.release_tag} · {job.id[:8]}")
                        if run:
                            job.run_id = str(run.get("id") or "")
                            job.run_url = str(run.get("html_url") or "")
                    if not run:
                        self.update_job(job, "submitted — run not visible yet")
                        continue

                    status = str(run.get("status") or "queued")
                    conclusion = str(run.get("conclusion") or "")
                    if status != "completed":
                        self.update_job(job, display_run_status(status))
                        continue
                    if conclusion != "success":
                        self.update_job(job, "failed", f"Workflow completed with conclusion: {conclusion or 'unknown'}")
                        continue
                    if self.collect_job_artifact(client, job):
                        self.update_job(job, "done")
                        self.event_log(f"{job.zip_name}: done. Download ready.")
                    else:
                        self.update_job(job, "completed — artifact pending")
                except Exception as exc:
                    self.update_job(job, "refresh error", str(exc))
                    self.event_log(f"{job.zip_name}: refresh failed: {exc}")
            self.save_queue()
            self.event_log("Job status refresh finished.")
        except GitHubError as exc:
            if exc.status == 401:
                self.ui_events.put(("auth_failed", None))
            else:
                self.ui_events.put(("error", ("Refresh failed", str(exc))))
        except Exception as exc:
            self.ui_events.put(("error", ("Refresh failed", str(exc))))
        finally:
            self.ui_events.put(("busy", False))
            self.ui_events.put(("refresh", None))

    def collect_job_artifact(self, client: GitHubClient, job: RenderJob) -> bool:
        artifacts = client.list_run_artifacts(int(job.run_id))
        video_artifacts = [artifact for artifact in artifacts if str(artifact.get("name") or "").startswith("video-")]
        expected_name = f"video-{job.stem}"
        chosen = next((artifact for artifact in video_artifacts if artifact.get("name") == expected_name), None)
        if not chosen and video_artifacts:
            chosen = video_artifacts[0]
        if not chosen:
            return False
        job.artifact_id = str(chosen.get("id") or "")
        job.artifact_name = str(chosen.get("name") or "")
        job.artifact_api_url = str(chosen.get("archive_download_url") or "")
        job.artifact_web_url = f"https://github.com/{self.settings.owner}/{self.settings.repo}/actions/runs/{job.run_id}/artifacts/{job.artifact_id}"
        return True

    def copy_download_link(self) -> None:
        job = self.first_selected_job()
        if not job or not job.artifact_web_url:
            messagebox.showinfo("No download yet", "Highlight one completed row with a download-ready artifact.")
            return
        self.clipboard_clear()
        self.clipboard_append(job.artifact_web_url)
        self.log(f"Copied the download link for {job.zip_name}.")

    def download_with_neat(self) -> None:
        if self.neat_opening:
            return
        jobs = [job for job in self.jobs if job.enabled and job.artifact_web_url]
        if not jobs:
            messagebox.showinfo("No download yet", "Check one or more completed jobs with download-ready artifacts.")
            return
        brave_locations = [Path("/Applications/Brave Browser.app"), Path.home() / "Applications/Brave Browser.app"]
        if sys.platform != "darwin" or not any(path.exists() for path in brave_locations):
            messagebox.showerror("Brave not found", "Brave Browser was not found in Applications.")
            return
        self.neat_opening = True
        self.neat_download_queue = list(jobs)
        self.neat_button.configure(state="disabled")
        self.log(f"Sending {len(jobs)} checked download(s) to Brave one at a time...")
        self.open_next_neat_download()

    def open_next_neat_download(self) -> None:
        if not self.neat_download_queue:
            self.neat_opening = False
            self.neat_button.configure(state="normal")
            messagebox.showinfo(
                "Opened in Brave",
                "Each checked artifact was opened separately in Brave. "
                "The Neat Download Manager extension should list every download.",
            )
            return
        job = self.neat_download_queue.pop(0)
        try:
            result = subprocess.run(
                ["/usr/bin/open", "-a", "Brave Browser", job.artifact_web_url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=10,
            )
        except Exception as exc:
            self.neat_opening = False
            self.neat_download_queue = []
            self.neat_button.configure(state="normal")
            messagebox.showerror("Could not open Brave", str(exc))
            return
        if result.returncode != 0:
            self.neat_opening = False
            self.neat_download_queue = []
            self.neat_button.configure(state="normal")
            messagebox.showerror("Could not open Brave", result.stderr.strip() or "Brave Browser could not be opened.")
            return
        self.log(f"Sent to Brave/Neat: {job.zip_name}")
        self.after(3000, self.open_next_neat_download)

    def download_path_label(self) -> str:
        path = Path(str(self.settings.data.get("download_dir") or Path.home() / "Downloads")).expanduser()
        return f"Download folder: {path}"

    def select_download_path(self) -> None:
        current = Path(str(self.settings.data.get("download_dir") or Path.home() / "Downloads")).expanduser()
        directory = filedialog.askdirectory(title="Choose download folder", initialdir=str(current if current.exists() else Path.home()))
        if not directory:
            return
        self.settings.data["download_dir"] = directory
        self.settings.save()
        self.download_path_var.set(self.download_path_label())
        self.log(f"Download folder set to {directory}.")

    def download_selected(self) -> None:
        jobs = [job for job in self.jobs if job.enabled and job.artifact_id]
        if not jobs:
            messagebox.showinfo("No download yet", "Check one or more completed jobs with download-ready artifacts.")
            return
        client = self.ensure_client()
        if not client:
            return
        directory = Path(str(self.settings.data.get("download_dir") or Path.home() / "Downloads")).expanduser()
        directory.mkdir(parents=True, exist_ok=True)
        self.set_busy(True)

        def worker() -> None:
            outputs: list[Path] = []
            failures: list[str] = []
            try:
                for index, job in enumerate(jobs, start=1):
                    archive = directory / f".{job.stem}-{uuid.uuid4().hex}.download.zip"
                    self.event_log(f"Downloading artifact for {job.zip_name}...")
                    try:
                        client.download_artifact_archive(int(job.artifact_id), archive)
                        with zipfile.ZipFile(archive) as zf:
                            mp4s = [name for name in zf.namelist() if name.lower().endswith(".mp4") and not name.endswith("/")]
                            if not mp4s:
                                raise GitHubError("Artifact contained no MP4 file.")
                            for source_name in mp4s:
                                output = directory / Path(source_name).name
                                if output.exists():
                                    output = directory / f"{output.stem}-{int(time.time())}-{index}{output.suffix}"
                                with zf.open(source_name) as src, output.open("wb") as dst:
                                    shutil.copyfileobj(src, dst)
                                outputs.append(output)
                                self.event_log(f"Downloaded and extracted: {output.name}")
                    except GitHubError as exc:
                        if exc.status == 401:
                            raise
                        failures.append(f"{job.zip_name}: {exc}")
                    except Exception as exc:
                        failures.append(f"{job.zip_name}: {exc}")
                    finally:
                        try:
                            archive.unlink(missing_ok=True)
                        except Exception:
                            pass
                message = f"Saved {len(outputs)} video(s) to:\n{directory}\n\nDownloaded ZIP files were removed automatically."
                if failures:
                    message += "\n\nFailed:\n" + "\n".join(failures)
                self.ui_events.put(("message", ("Downloads finished", message)))
            except GitHubError as exc:
                if exc.status == 401:
                    self.ui_events.put(("auth_failed", None))
                else:
                    self.ui_events.put(("error", ("Download failed", str(exc))))
            except Exception as exc:
                self.ui_events.put(("error", ("Download failed", str(exc))))
            finally:
                self.ui_events.put(("busy", False))
        threading.Thread(target=worker, daemon=True).start()

    def on_close(self) -> None:
        self.save_queue()
        self.settings.data["default_workers"] = self.default_workers_var.get().strip() or DEFAULT_WORKERS
        self.settings.data["default_scale"] = self.default_scale_var.get().strip() or DEFAULT_SCALE
        self.settings.save()
        self.destroy()


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    app = RenderQueueApp(repo_root)
    app.mainloop()


if __name__ == "__main__":
    main()
