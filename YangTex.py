#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YangTex — 轻量级 LaTeX 实时 / 自动编译系统
==========================================
零第三方依赖（仅 Python 标准库）；靠本机 TeX 发行版编译，靠浏览器呈现界面。
双击启动器后：无终端窗口、自动打开操作页面、自动编译、SyncTeX 双向逐行同步。

作者：为 杨建伟 老师定制（数学 / PDE 写作场景）
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

APP_NAME = "YangTex"
VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
TEMPLATES_DIR = ROOT / "templates"
PROJECTS_DIR = ROOT / "projects"
ASSETS = ROOT / "assets"
CONFIG_FILE = ROOT / "config.json"
RUNTIME_FILE = ROOT / ".runtime.json"
STATE_FILE = ROOT / ".state.json"
# 内置 Markdown → LaTeX 转换器与后端同目录。启动器以 importlib 加载本文件时
# sys.path 未必含 ROOT，显式补上，保证 Mac / Windows 双击启动都能导入。
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from markdown_tex import (  # noqa: E402
    md_to_latex, md_fragment_to_latex, md_engine_of, parse_front_matter,
    BASE_PACKAGES,
)
import scholar_tools as scholar  # noqa: E402  编号索引 / 文献 / 投稿包，零第三方依赖
import pdf_incremental as pdf_inc  # noqa: E402  PDF 页级失效分析，零第三方依赖
MD_TEMPLATE_SUFFIXES = {".md", ".mdtex"}
TEMPLATE_SUFFIXES = {".tex", ".md", ".mdtex"}
# 期刊官方 .cls / .sty 放在这里即可对本机所有项目生效；YangTex 不随分发包
# 再分发第三方类文件，避免许可问题，用户从期刊官网自行下载后放入即可。
CLASSES_DIR = TEMPLATES_DIR / "classes"
try:
    if not CLASSES_DIR.is_dir():
        CLASSES_DIR.mkdir(parents=True, exist_ok=True)
    _cls_readme = CLASSES_DIR / "README.txt"
    if not _cls_readme.exists():
        _cls_readme.write_text(
            "把期刊官方 LaTeX 类文件（.cls / .sty / .bst / .clo）放在本目录，\n"
            "YangTex 编译与模板可用性检测会自动找到它们，所有项目都能用。\n\n"
            "例如：siamart251216.cls（SIAM）、svjour3.cls（Springer）、\n"
            "AIMS.cls（AIMS）、jems.cls（EMS）。请从各期刊官网的\n"
            "“Information for Authors / LaTeX templates” 页面下载官方文件。\n"
            "未放类文件时，YangTex 官方模板会自动降级为 article 预览排版，\n"
            "仍可正常编译、实时预览与双向逐行同步。\n",
            encoding="utf-8", newline="\n")
except OSError:
    pass
DEFAULT_PORT = 17865  # 高位端口，避免与本机其他本地服务（如学术平台 8765）冲突

# Windows 下子进程不弹控制台窗口（用户要求"打开后终端关闭"）
NO_WINDOW = 0x08000000 if sys.platform.startswith("win") else 0
CREATE_FLAGS = {"creationflags": NO_WINDOW} if sys.platform.startswith("win") else {}

COMPILE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
START_TIME = time.time()

# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------

def jdump(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def ensure_dir(path: Path) -> None:
    """先判断再创建。Path.mkdir(exist_ok=True) 在部分运行环境（含本机
    Python 3.13 的 pathlib broker）对已存在目录仍会抛 FileExistsError。"""
    try:
        if not path.is_dir():
            os.makedirs(str(path), exist_ok=True)
    except FileExistsError:
        pass


def write_json(path: Path, data) -> None:
    try:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def safe_slug(name: str) -> str:
    """项目名 / 模板名转安全目录名（保留中文）。"""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", str(name)).strip().strip(".")
    return (s or "未命名")[:80]


def tex_bin_dirs() -> list[str]:
    dirs = [
        "/Library/TeX/texbin", "/usr/texbin",
        "/usr/local/texlive/2026/bin/universal-darwin",
        "/usr/local/texlive/2025/bin/universal-darwin",
        "/usr/local/texlive/2024/bin/universal-darwin",
        "/opt/homebrew/bin", "/usr/local/bin",
        r"C:\texlive\2026\bin\windows", r"C:\texlive\2025\bin\windows",
        r"C:\texlive\2024\bin\windows",
        r"C:\Program Files\MiKTeX\miktex\bin\x64",
        r"C:\Program Files (x86)\MiKTeX\miktex\bin",
    ]
    try:
        for d in sorted(Path("/usr/local/texlive").glob("*/bin/*"), reverse=True):
            if d.is_dir():
                dirs.insert(0, str(d))
    except Exception:
        pass
    cfg = read_json(CONFIG_FILE, {})
    dirs = list(cfg.get("tex_bin_dirs", [])) + dirs
    return dirs


def find_tex_bin(name: str) -> str | None:
    exe = name + (".exe" if sys.platform.startswith("win") else "")
    p = shutil.which(name) or shutil.which(exe)
    if p:
        return p
    for d in tex_bin_dirs():
        cand = Path(d) / exe
        if cand.is_file():
            return str(cand)
    return None


# TeX 子进程的环境变量白名单。实测：把宿主环境（约 190 个变量、21KB）整个
# 传给 pdflatex，比只传必要变量慢约 38ms —— 不是某个大变量，而是变量条数本身
# 拖慢了进程初始化。这里按「精确名 + 前缀」保留所有与 TeX / 平台有关的变量，
# 其余（IDE 注入的调试 / 配置变量）一律不带进子进程。
# 出问题时设 YANGTEX_FULL_ENV=1 可完整回退到原行为。
_TEX_ENV_EXACT = {
    "path", "home", "user", "logname", "shell", "tmpdir", "tmp", "temp",
    "lang", "lc_all", "lc_ctype", "lc_messages", "lc_numeric", "lc_time",
    "texmfhome", "texmfvar", "texmfconfig", "texmfcnf", "texmflocal",
    "texinputs", "texoutputs", "texfontmaps", "texformats", "texpicttype",
    "bibinputs", "bstinputs", "mfinputs", "mpinputs", "vffonts", "t1fonts",
    "osfontdir", "fontconfig_path", "fontconfig_file", "gs_lib", "gs_fonts",
    "source_date_epoch", "force_source_date",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "display", "xdg_runtime_dir", "dbus_session_bus_address",
    "__cf_user_text_encoding", "pythonpath",
    # Windows / MiKTeX：这些变量决定发行版到哪找宏包树，绝不能丢
    "systemroot", "windir", "comspec", "pathext", "userprofile",
    "appdata", "localappdata", "programdata", "programfiles", "temp", "tmp",
    "homedrive", "homepath", "username", "os", "number_of_processors",
    "processor_architecture", "commonprogramfiles",
}
_TEX_ENV_PREFIX = (
    "tex", "kpse", "miktex", "yangtex", "bib", "bst", "luatex",
    "pdf", "gs_", "ghostscript", "fontconfig", "fc_", "xdg_",
)


def _subprocess_env(extra: dict | None = None) -> dict:
    """给 TeX / synctex / bibtex 子进程用的精简环境。大小写不敏感（Windows）。"""
    if os.environ.get("YANGTEX_FULL_ENV") == "1":
        e = os.environ.copy()
    elif sys.platform.startswith("win") and os.environ.get("YANGTEX_SLIM_ENV") != "1":
        # Windows 只有静态 / 模拟验证、未真机实测。为不引入未经验证的风险，
        # 默认沿用完整环境；确认无问题后可用 YANGTEX_SLIM_ENV=1 开启。
        e = os.environ.copy()
    else:
        e = {}
        for k, v in os.environ.items():
            lk = k.lower()
            if lk in _TEX_ENV_EXACT or lk.startswith(_TEX_ENV_PREFIX):
                e[k] = v
        # 少数发行版靠 HOME 定位 ~/texmf，缺了会退回默认树
        if "HOME" not in e and "USERPROFILE" not in e:
            home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
            if home:
                e["HOME"] = home
    if extra:
        e.update(extra)
    return e


def run_cmd(cmd, cwd=None, timeout=90, env=None) -> subprocess.CompletedProcess:
    e = _subprocess_env(env)
    # templates/classes/ 里的期刊官方类对所有项目生效。末尾的空路径项表示
    # 继续沿 TeX 发行版默认搜索树查找，不会破坏原有宏包/字体查找。
    if not (env and "TEXINPUTS" in env):
        base = e.get("TEXINPUTS", "")
        tail = (base.rstrip(os.pathsep) + os.pathsep) if base.strip(os.pathsep) else ""
        e["TEXINPUTS"] = str(CLASSES_DIR) + os.pathsep + tail
    return subprocess.run(
        cmd, cwd=str(cwd) if cwd else None, capture_output=True,
        timeout=timeout, env=e, **CREATE_FLAGS,
    )


def detect_engines() -> dict:
    out = {}
    for n in ("xelatex", "pdflatex", "lualatex", "latexmk", "synctex", "bibtex", "kpsewhich"):
        out[n] = find_tex_bin(n)
    return out


ENGINES = detect_engines()


def ensure_tex_path():
    """GUI 双击启动时 PATH 很窄，把检测到的 TeX 目录注入，保证引擎子进程能找到配套工具。"""
    global ENGINES
    dirs = []
    for p in list(ENGINES.values()) + [str(Path(d) / "xelatex") for d in tex_bin_dirs()]:
        if p:
            d = os.path.dirname(p)
            if d and os.path.isdir(d) and d not in dirs:
                dirs.append(d)
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])


ensure_tex_path()


def strip_tex_comments(source: str) -> str:
    """去掉未转义的 % 注释；模板里的中文说明不能影响引擎选择。"""
    out = []
    for line in source.splitlines():
        i = 0
        while True:
            i = line.find("%", i)
            if i < 0:
                out.append(line)
                break
            j, bs = i - 1, 0
            while j >= 0 and line[j] == "\\":
                bs += 1
                j -= 1
            if bs % 2:                      # \% 是字面百分号，继续找
                i += 1
                continue
            out.append(line[:i])
            break
    return "\n".join(out)


def guess_engine(source: str) -> str:
    """中文 / 字体 / 非拉丁字符文档一律用 xelatex，其余用 pdflatex（更快）。"""
    marks = ("ctex", "xeCJK", "fontspec", "CJK", "\\setCJK", "fontset=", "beamer",
             "unicode-math", "polyglossia", "mathspec", "\\setmainfont",
             "\\setsansfont", "\\setmonofont", "\\XeTeX", "\\LuaTeX")
    code = strip_tex_comments(source)
    if any(m in code for m in marks):
        return "xelatex"
    # 拉丁-1 区域的 é/ü 等 pdflatex(UTF-8) 能处理；从这里往上（希腊字母、
    # 箭头、CJK、中文标点、全角字符）交给 xelatex，宁可慢一点也不编坏文档。
    if re.search(r"[\u0100-\uffff]", code):
        return "xelatex"
    return "pdflatex"


# --------------------------------------------------------------------------
# 环境联想 / 模板可用性：本机宏包探测
# kpsewhich 单次约 0.16s；旧实现每个模板的每个 requires 都单独起一次子进程，
# 24 个模板 × 最多 9 个依赖 ≈ 120 次调用 ≈ 20 秒，会把 /api/init 卡到近 20 秒。
# kpsewhich 支持一次传多个文件名：找到的逐行输出路径，找不到的不输出，
# 去重后一次调用约 0.2 秒即可覆盖全部模板，结果再按进程缓存。
# --------------------------------------------------------------------------
ENV_PROBE_PKGS = (
    "amsmath", "mathtools", "amsthm", "ctex", "tikz", "pgfplots",
    "subcaption", "wrapfig", "tabularx", "longtable", "listings",
    "algorithm", "algpseudocode", "graphicx", "hyperref",
)
_ENV_PROBE_CACHE: dict | None = None
_PKG_PROBE_CACHE: dict[str, bool] = {}
_PKG_PROBE_LOCK = threading.RLock()


def probe_packages(names) -> dict[str, bool]:
    """批量探测宏包 / 文档类是否存在，结果缓存在进程内。

    没有 kpsewhich 时全部视为可用，保持旧行为（不做可用性判定）。
    批量调用整体失败时退回逐个查询，避免把全部模板误判为不可用。
    """
    wanted = {str(n).strip() for n in names if n}
    if not wanted:
        return {}
    kp = ENGINES.get("kpsewhich")
    with _PKG_PROBE_LOCK:
        unknown = [n for n in sorted(wanted) if n not in _PKG_PROBE_CACHE]
        # 用户放进 templates/classes/ 的官方类直接判定为已就绪
        local = [n for n in unknown if (CLASSES_DIR / n).is_file()]
        for n in local:
            _PKG_PROBE_CACHE[n] = True
        unknown = [n for n in unknown if n not in local]
        if unknown:
            found: set[str] = set()
            if kp:
                try:
                    cp = run_cmd([kp, *unknown], timeout=20)
                    out = cp.stdout
                    if isinstance(out, (bytes, bytearray)):
                        out = out.decode("utf-8", "replace")
                    for line in str(out).splitlines():
                        line = line.strip().replace("\\", "/")
                        if line:
                            found.add(line.rsplit("/", 1)[-1])
                except Exception:
                    for n in unknown:
                        try:
                            if run_cmd([kp, n], timeout=8).stdout.strip():
                                found.add(n)
                        except Exception:
                            pass
            for n in unknown:
                # 没装 kpsewhich 时不判定；装了则以批量输出为准
                _PKG_PROBE_CACHE[n] = (n in found) if kp else True
        return {n: _PKG_PROBE_CACHE[n] for n in wanted}


def env_pkg_probe() -> dict:
    global _ENV_PROBE_CACHE
    if _ENV_PROBE_CACHE is not None:
        return _ENV_PROBE_CACHE
    status = probe_packages([n + ".sty" for n in ENV_PROBE_PKGS])
    _ENV_PROBE_CACHE = {n: status.get(n + ".sty", True) for n in ENV_PROBE_PKGS}
    return _ENV_PROBE_CACHE


def sanitize_env_prefs(v) -> dict:
    """env_prefs 会被写进 .state.json，只收已知字段 + 合法环境名，避免脏数据落盘。"""
    if not isinstance(v, dict):
        return STATE.get("env_prefs") or {}
    out = {
        "hint": bool(v.get("hint", True)),
        "auto_close": bool(v.get("auto_close", True)),
        "math_wrap": bool(v.get("math_wrap", True)),
        "group": bool(v.get("group", True)),
        "recent": [],
    }
    seen = set()
    for n in (v.get("recent") or [])[:12]:
        if not isinstance(n, str) or not re.fullmatch(r"[A-Za-z@*][A-Za-z0-9@*]{0,31}", n):
            continue
        if n not in seen:
            seen.add(n)
            out["recent"].append(n)
    return out


# --------------------------------------------------------------------------
# 状态 / 项目
# --------------------------------------------------------------------------

def load_state() -> dict:
    st = read_json(STATE_FILE, {})
    st.setdefault("project", "欢迎使用 YangTex")
    st.setdefault("engine", "auto")
    st.setdefault("auto_compile", True)
    st.setdefault("sync_enabled", True)
    st.setdefault("theme", "light")
    st.setdefault("welcome_shown", False)
    st.setdefault("font_size", 14)
    st.setdefault("auto_packages", True)
    st.setdefault("turbo", True)          # ⚡ 极速模式（预编译导言 + 更短防抖）
    st.setdefault("continuous", True)     # ⇶ 连续编译：边打字边编译（不等停手）
    prefs = st.get("env_prefs")
    if not isinstance(prefs, dict):
        prefs = {}
    recent = prefs.get("recent")
    if not isinstance(recent, list):
        recent = []
    st["env_prefs"] = {
        "hint": bool(prefs.get("hint", True)),
        "auto_close": bool(prefs.get("auto_close", True)),
        "math_wrap": bool(prefs.get("math_wrap", True)),
        "group": bool(prefs.get("group", True)),
        "recent": [str(x) for x in recent[:12]],
    }
    # 补齐的默认值立刻落盘，保证「所有偏好都在 .state.json」不只是内存状态
    save_state(st)
    return st


def save_state(st: dict) -> None:
    with STATE_LOCK:
        write_json(STATE_FILE, st)


STATE = load_state()


def project_dir(name: str) -> Path:
    return PROJECTS_DIR / safe_slug(name)


def project_main(name: str) -> Path:
    return project_dir(name) / "main.tex"


# --------------------------------------------------------------------------
# Markdown 主编辑源
# --------------------------------------------------------------------------
# 「Markdown 模板要用 Markdown 语法」：编辑器里装的是 main.md / main.mdtex，
# main.tex 只是交给 TeX 引擎的编译产物，每次保存自动重新生成。linemap 把
# SyncTeX 与编译日志里的 .tex 行号换算回编辑器里看得见的 Markdown 行号。
SOURCE_META_FILE = ".yangtex-source.json"
SOURCE_FILES = {"markdown": "main.md", "mixed": "main.mdtex", "tex": "main.tex"}
MAP_FILE = "main.map.json"


def source_meta(d: Path) -> dict:
    mf = d / SOURCE_META_FILE
    if mf.is_file():
        try:
            j = json.loads(mf.read_text(encoding="utf-8"))
            if j.get("kind") in SOURCE_FILES:
                return {"kind": j["kind"],
                        "file": j.get("file") or SOURCE_FILES[j["kind"]],
                        "engine": j.get("engine", "")}
        except Exception:
            pass
    # 兼容旧项目：早期版本只把 Markdown 另存为 main.md，主文档仍是 main.tex。
    # 现在这类项目自动升级成「以 Markdown 为主源」，符合用户的编辑预期。
    for fn, kind in (("main.mdtex", "mixed"), ("main.md", "markdown")):
        if (d / fn).is_file():
            return {"kind": kind, "file": fn, "engine": ""}
    return {"kind": "tex", "file": "main.tex", "engine": ""}


def set_source_meta(d: Path, kind: str, engine: str = "") -> dict:
    kind = kind if kind in SOURCE_FILES else "tex"
    meta = {"kind": kind, "file": SOURCE_FILES[kind], "engine": engine or ""}
    (d / SOURCE_META_FILE).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return meta


def sync_tex_from_source(d: Path, content: str | None = None) -> tuple[dict, dict | None]:
    """用 Markdown 主源重新生成 main.tex 与行号映射。"""
    meta = source_meta(d)
    if meta["kind"] == "tex":
        return meta, None
    sf = d / meta["file"]
    if content is not None:
        sf.write_text(content, encoding="utf-8", newline="\n")
    if not sf.is_file():
        return meta, None
    raw = sf.read_text(encoding="utf-8", errors="replace")
    tex, info = md_to_latex(raw, meta["file"])
    write_main(d, tex)
    (d / MAP_FILE).write_text(json.dumps(info["linemap"]), encoding="utf-8")
    return meta, info


def read_line_map(d: Path) -> list[int]:
    try:
        v = json.loads((d / MAP_FILE).read_text(encoding="utf-8"))
        return v if isinstance(v, list) else []
    except Exception:
        return []


def md_line_to_tex(name: str, md_line: int) -> int:
    """编辑器 Markdown 行号 → 生成的 main.tex 行号（供 synctex view）。"""
    d = project_dir(name)
    if source_meta(d)["kind"] == "tex":
        return md_line
    m = read_line_map(d)
    if not m:
        return md_line + 28
    for i, v in enumerate(m):
        if v >= md_line:
            return i + 1
    return max(1, len(m))


def tex_line_to_md(name: str, tex_line: int) -> int:
    """生成的 main.tex 行号 → 编辑器 Markdown 行号（供 synctex edit / 错误列表）。"""
    d = project_dir(name)
    if source_meta(d)["kind"] == "tex":
        return tex_line
    m = read_line_map(d)
    if not m:
        return max(1, tex_line - 28)
    k = max(0, min(len(m) - 1, tex_line - 1))
    if m[k]:
        return m[k]
    for step in range(1, 12):
        for j in (k - step, k + step):
            if 0 <= j < len(m) and m[j]:
                return m[j]
    return 1


def scholar_ctx(name: str) -> tuple[Path, dict]:
    """学术功能统一取当前项目目录 + 主编辑源信息。"""
    d = project_dir(name)
    return d, source_meta(d)


def list_projects() -> list[dict]:
    ensure_dir(PROJECTS_DIR)
    res = []
    for d in sorted(PROJECTS_DIR.iterdir(), key=lambda p: p.name):
        if d.is_dir() and not d.name.startswith("."):
            f = d / "main.tex"
            meta = source_meta(d)
            res.append({
                "name": d.name,
                "has_tex": f.exists(),
                "pdf": (d / "main.pdf").exists(),
                "mtime": (f.stat().st_mtime if f.exists() else 0),
                "source": meta["kind"],
                "source_file": meta["file"],
            })
    return res


def ensure_default_project() -> None:
    ensure_dir(PROJECTS_DIR)
    name = STATE.get("project", "欢迎使用 YangTex")
    d = project_dir(name)
    if not (d / "main.tex").exists():
        ensure_dir(d)
        tpl = TEMPLATES_DIR / "welcome.tex"
        content = tpl.read_text(encoding="utf-8") if tpl.exists() else (
            "\\documentclass{ctexart}\n\\begin{document}\n欢迎使用 YangTex！\n\\end{document}\n"
        )
        (d / "main.tex").write_text(content, encoding="utf-8")
    if not list_projects():
        (d / "main.tex").write_text(
            (d / "main.tex").read_text(encoding="utf-8"), encoding="utf-8")


def create_project(name: str, template_id: str | None = None) -> dict:
    name = safe_slug(name)
    d = project_dir(name)
    if d.exists() and (d / "main.tex").exists():
        # 同名项目不覆盖，自动加序号
        i = 2
        while project_dir(f"{name} ({i})").exists():
            i += 1
        name = f"{name} ({i})"
        d = project_dir(name)
    ensure_dir(d)
    tpls = list_templates()
    tpl = next((t for t in tpls if t["id"] == template_id), None)
    engine = "xelatex"
    kind = "tex"
    if tpl and tpl.get("file"):
        raw = (TEMPLATES_DIR / tpl["file"]).read_text(encoding="utf-8")
        kind = tpl.get("kind", "tex")
        if kind in ("markdown", "mixed"):
            # Markdown 是主文档：编辑器里写的就是这份 Markdown 语法；
            # main.tex 只是同步生成的编译产物，用户不需要去改它。
            (d / SOURCE_FILES[kind]).write_text(raw, encoding="utf-8", newline="\n")
            content, info = md_to_latex(raw, tpl["file"])
            engine = info["engine"]
        else:
            content = raw
            engine = tpl.get("engine") or "xelatex"
    else:
        content = "\\documentclass[11pt]{article}\n\\usepackage{amsmath,amssymb}\n\\begin{document}\n\n\\end{document}\n"
    write_main(d, content)
    set_source_meta(d, kind, engine)
    if kind != "tex":
        sync_tex_from_source(d)   # 同时写出 main.map.json 行号映射
    # 用户放进 templates/classes/ 的官方类一并复制进项目目录，
    # 方便把整个项目打包投稿；编译本身走 TEXINPUTS，不依赖这一步。
    if tpl:
        for req in tpl.get("requires", []):
            src = CLASSES_DIR / req
            try:
                if src.is_file() and not (d / req).exists():
                    shutil.copy2(src, d / req)
            except OSError:
                pass
    return {"name": name, "engine": engine, "source": kind,
            "source_file": SOURCE_FILES[kind], "source_kind": kind}


# --------------------------------------------------------------------------
# 模板库
# --------------------------------------------------------------------------

def list_templates() -> list[dict]:
    ensure_dir(TEMPLATES_DIR)
    meta = read_json(TEMPLATES_DIR / "_index.json", {})
    kp = ENGINES.get("kpsewhich")
    result = []
    all_reqs: set[str] = set()
    files = sorted([p for ext in ("*.tex", "*.md", "*.mdtex")
                    for p in TEMPLATES_DIR.glob(ext)])
    for f in files:
        m = meta.get(f.name, {})
        suffix = f.suffix.lower()
        kind = "tex" if suffix == ".tex" else ("mixed" if suffix == ".mdtex" else "markdown")
        fm = {}
        if kind != "tex":
            try:
                fm, _ = parse_front_matter(f.read_text(encoding="utf-8"))
            except OSError:
                pass
        if kind == "markdown":
            default_desc = "Markdown 模板 · 套用时自动转成可编译 LaTeX"
        elif kind == "mixed":
            default_desc = "Markdown + LaTeX 混排 · 结构用 Markdown、公式定理用 LaTeX"
        else:
            default_desc = "拖入 templates 目录即可自动识别的自定义模板"
        engine = m.get("engine") or (md_engine_of(fm) if kind != "tex" else "xelatex")
        lang = ((m.get("lang") or ("中文" if engine == "xelatex" else "英文"))
                if kind != "tex" else m.get("lang", "中 / 英"))
        # 转换产物只依赖基础宏包，逐项实测可避免「看起来可用其实编译不了」
        reqs = m.get("requires", []) if kind == "tex" else \
            [p + ".sty" for p in BASE_PACKAGES]
        info = {
            "id": f.stem,
            "file": f.name,
            "name": m.get("name", f.stem),
            "category": m.get("category", "自定义模板"),
            "publisher": m.get("publisher", "我的模板" if not m else "其他"),
            "journal": m.get("journal", ""),
            "tags": m.get("tags", []),
            "official": bool(m.get("official", False)),
            "doc_class": m.get("doc_class", ""),
            "class_url": m.get("class_url", ""),
            "engine": engine,
            "description": m.get("description", default_desc),
            "lang": lang,
            "requires": reqs,
            "kind": kind,
            "builtin": bool(m),
            "available": True,
            "missing": [],
            "fallback": bool(m.get("fallback", False)),
            "preview": False,
            "custom": not bool(m),
            # 用户原稿全量保留模板：前端显示「原稿全量」徽标与源码行数
            "full_source": bool(m.get("full_source", False)),
            "source_lines": int(m.get("source_lines", 0) or 0),
            "origin": m.get("origin", ""),
        }
        all_reqs.update(info["requires"])
        result.append(info)
    # 一次性批量探测全部去重依赖：21 个宏包一次 kpsewhich ≈ 0.2s，
    # 取代旧版每个模板逐个起子进程（≈ 20s）
    if kp:
        status = probe_packages(all_reqs)
        for info in result:
            # classes/ 里的类按当前磁盘状态实时判定：用户刚放入官方类时
            # 不必重启 YangTex，模板卡片状态也会立刻刷新。
            miss = [r for r in info["requires"]
                    if not (CLASSES_DIR / r).is_file() and not status.get(r, True)]
            info["missing"] = miss
            info["preview"] = bool(miss and info["fallback"])
            info["available"] = (not miss) or info["fallback"]
    # 内建模板排在前面，其余按名称
    result.sort(key=lambda x: (not x["builtin"], x["category"], x["name"]))
    return result


def add_template(name: str, content: str, engine: str = "xelatex",
                 category: str = "我的模板", description: str = "",
                 kind: str = "tex") -> dict:
    stem = safe_slug(name).replace(" ", "_")
    ext = {"markdown": ".md", "mixed": ".mdtex"}.get(kind, ".tex")
    # 没写 front matter 的 Markdown 模板补一段，保证套用后立刻能编译
    if kind in ("markdown", "mixed") and not content.lstrip().startswith("---"):
        lang = "en" if engine == "pdflatex" else "zh"
        content = (f"---\ntitle: {name}\nlang: {lang}\nengine: {engine}\n---\n\n"
                   + content)
    f = TEMPLATES_DIR / f"custom_{stem}{ext}"
    f.write_text(content, encoding="utf-8")
    meta = read_json(TEMPLATES_DIR / "_index.json", {})
    meta[f.name] = {
        "name": name, "category": category, "engine": engine,
        "description": description or "用户添加的模板", "lang": "中 / 英",
        "requires": [], "kind": kind,
    }
    write_json(TEMPLATES_DIR / "_index.json", meta)
    return {"ok": True, "file": f.name, "kind": kind}


# --------------------------------------------------------------------------
# 编译
# --------------------------------------------------------------------------

FILE_LINE_RE = re.compile(r"^(.*?):(\d+):\s*(.+)$", re.M)
ERR_RE = re.compile(r"^!\s*(.+)$", re.M)
WARN_RE = re.compile(r"^(?:LaTeX|Package|Class)\s+Warning:\s*(.+)$", re.M)


def parse_log(text: str, project: str | None = None) -> list[dict]:
    issues, seen = [], set()
    for m in FILE_LINE_RE.finditer(text):
        f, ln, msg = m.group(1), int(m.group(2)), m.group(3).strip()
        # Markdown 项目里编译的是生成的 main.tex：错误行号要换算回编辑器里
        # 看得见的 Markdown 行，文件名也要显示成主源，否则「main.tex:46」
        # 会让用户以为自己编辑的就是 .tex。
        shown = os.path.basename(f)
        if project and shown in ("main.tex", "./main.tex"):
            ln = tex_line_to_md(project, ln)
            shown = source_meta(project_dir(project)).get("file", "main.tex")
        msg = re.sub(r"\s+", " ", msg)
        key = (shown, ln, msg[:60])
        if key in seen or len(msg) < 3:
            continue
        seen.add(key)
        kind = "warning" if ("Warning" in msg or "warning" in msg) else "error"
        issues.append({"file": shown, "line": ln, "message": msg[:300], "kind": kind})
        if len(issues) >= 60:
            break
    for m in ERR_RE.finditer(text):
        msg = re.sub(r"\s+", " ", m.group(1)).strip()
        if msg and not any(msg[:40] in i["message"] for i in issues):
            issues.insert(0, {"file": "", "line": 0, "message": msg[:300], "kind": "error"})
    return issues[:40]


def engine_for(source: str, requested: str | None, smart: bool = False) -> str:
    e = requested or STATE.get("engine", "auto")
    # 极速模式：忽略 .state.json / 模板里钉死的慢引擎，按当前源码自动选最快的
    if smart:
        e = "auto"
    if e in ("auto", "", None):
        e = guess_engine(source)
    if e == "lualatex":
        e = "xelatex" if not ENGINES.get("lualatex") else e
    if not ENGINES.get(e):
        e = "xelatex" if ENGINES.get("xelatex") else "pdflatex"
    return e


DOC_WRITE_LOCK = threading.Lock()


def write_main(d: Path, content: str) -> None:
    """原子写 main.tex。临时文件名带线程号 + 写锁：/api/doc 与 /api/compile
    同时到达时，不会互相 os.replace 掉同一个 .main.tex.tmp 而抛 500。"""
    ensure_dir(d)
    tmp = d / f".main.tex.{os.getpid()}.{threading.get_ident()}.tmp"
    with DOC_WRITE_LOCK:
        tmp.write_text(content, encoding="utf-8", newline="\n")
        os.replace(tmp, d / "main.tex")


# --------------------------------------------------------------------------
# 极速编译（预编译导言 .fmt）
# --------------------------------------------------------------------------
# TeX Live 的 pdflatex 每次启动都要重新读 documentclass + 全部宏包，实测约
# 0.8s，其中约 0.5s 是引擎/格式的硬开销，0.2–0.3s 是导言。把导言用
# `pdflatex -ini &pdflatex ... \dump` 预编译成 .fmt 后，每轮只排版正文，
# 实测 0.838s → 0.590s（约 30%）。
#
# 关键约束：SyncTeX 必须仍然逐行精确。做法是正文文件里把「导言的每一行」
# 换成空行，\begin{document} 以及所有正文行保持原始行号；导言放进 .fmt。
# 实测同一行的 synctex view 坐标与全量编译完全一致（Page=1 y=372.208588）。
#
# xelatex + ctex/fontspec 的导言不能安全 \dump（-ini 失败、加载 .fmt 段错误），
# 因此只对 pdflatex 启用；中文 / 字体类文档自动走标准编译，不影响正确性。
# --------------------------------------------------------------------------
FMT_CACHE_DIR = ROOT / ".fmt_cache"
FMT_NAME = "ytfast"
FMT_ENGINES = {"pdflatex"}
FMT_AUX_FILES = ("main.aux", "main.out", "main.toc", "main.lof", "main.lot",
                 "main.bbl", "main.nav", "main.snm")
FMT_OUT_FILES = ("main.pdf", "main.synctex.gz", "main.synctex")
_FMT_LOCK = threading.RLock()
_FMT_BAD: dict[str, str] = {}
# 已确认就绪的 .fmt：build 路径 -> 导言键。省掉热路径每次 read_text('.fmt-key')，
# 仍保留 is_file() 校验，外部删掉格式文件时会自然回落到重建分支。
_FMT_READY: dict[str, str] = {}
# 记录每个项目上一轮的编译模式：连续极速编译时不必反复同步 aux
_TURBO_LAST: dict[str, str] = {}
# 这些声明放进正文而不是 .fmt：改标题 / 作者 / 日期时不重建格式文件
FMT_VOLATILE = re.compile(r"^\s*\\(?:title|author|date|thanks|hypersetup)\b")
FMT_BEGIN = re.compile(r"\\begin\s*\{document\}")


def fmt_volatile(line: str) -> bool:
    """只把「单行且花括号配平」的可变声明留在正文；跨行 \title{...} 仍进 .fmt。"""
    if not FMT_VOLATILE.match(line):
        return False
    return line.count("{") > 0 and line.count("{") == line.count("}")


def fmt_cache_key(engine: str, preamble: str) -> str:
    # TeX 发行版升级后旧 .fmt 会失效，把引擎可执行文件的 mtime 纳入缓存键
    try:
        stamp = str(int(os.stat(ENGINES.get(engine, "")).st_mtime))
    except OSError:
        stamp = "0"
    return hashlib.sha256((engine + "\x00" + stamp + "\x00" + preamble)
                          .encode("utf-8")).hexdigest()[:24]


def split_preamble(source: str):
    """定位 \begin{document}，返回 (导言行列表, 正文, 导言行数)。找不到返回 None。"""
    lines = source.splitlines(keepends=True)
    for i, line in enumerate(lines):
        s = line.lstrip()
        if s.startswith("%") or not s.strip():
            continue
        if FMT_BEGIN.match(s):
            return lines[:i], "".join(lines[i:]), i
    return None


def fmt_texinputs(d: Path) -> str:
    # 开头的 "." 必须排在前面：否则 kpathsea 会先在项目目录找到真正的
    # main.tex（带 \documentclass），与预编译格式冲突报 "Two \documentclass"。
    # 项目目录加 // 让图片 / .bib / 子目录资源仍能被找到。
    return ("." + os.pathsep + str(d) + "//" + os.pathsep
            + str(CLASSES_DIR) + os.pathsep)


def ensure_fmt(engine: str, preamble_lines: list[str], build: Path, d: Path) -> bool:
    """保证 build/ytfast.fmt 就绪；导言不可预编译时缓存失败，避免每键重试。"""
    stable = "".join("\n" if fmt_volatile(x) else x for x in preamble_lines)
    key = fmt_cache_key(engine, stable)
    stamp = build / ".fmt-key"
    with _FMT_LOCK:
        if key in _FMT_BAD:
            return False
        # 热路径：导言没变就完全跳过硬链接 / 拷贝（部分文件系统上这两步
        # 每次几十毫秒，足以吃掉 .fmt 省下的时间）。内存里已确认过就直接
        # 检查格式文件是否还在，连 .fmt-key 的一次读盘都省了。
        fmt_file = build / (FMT_NAME + ".fmt")
        if _FMT_READY.get(str(build)) == key and fmt_file.is_file():
            return True
        try:
            if (stamp.read_text(encoding="utf-8").strip() == key and fmt_file.is_file()):
                _FMT_READY[str(build)] = key
                return True
        except OSError:
            pass
        cache = FMT_CACHE_DIR / (key + ".fmt")
        if not cache.is_file():
            try:
                ensure_dir(FMT_CACHE_DIR)
                (build / "_preamble.tex").write_text(
                    stable.rstrip("\n") + "\n\\dump\n", encoding="utf-8", newline="\n")
                cp = run_cmd(
                    [ENGINES[engine], "-ini", "-interaction=nonstopmode",
                     "-jobname=" + FMT_NAME, "&" + engine, "_preamble.tex"],
                    cwd=build, timeout=45, env={"TEXINPUTS": fmt_texinputs(d)})
                made = build / (FMT_NAME + ".fmt")
                if cp.returncode != 0 or not made.is_file():
                    _FMT_BAD[key] = "导言含无法预编译的内容"
                    return False
                shutil.copy2(made, cache)
                made.unlink(missing_ok=True)
                # 每个 4.5MB，控制缓存总量，避免长期使用后无限增长
                files = sorted(FMT_CACHE_DIR.glob("*.fmt"),
                               key=lambda p: p.stat().st_mtime)
                for old in files[:-32]:
                    old.unlink(missing_ok=True)
            except Exception:
                _FMT_BAD[key] = "导言预编译失败"
                return False
        target = build / (FMT_NAME + ".fmt")
        try:
            if target.exists() or target.is_symlink():
                target.unlink()
            os.link(cache, target)       # 同盘硬链接，零拷贝；Windows 也可用
        except OSError:
            try:
                shutil.copy2(cache, target)
            except OSError:
                return False
        try:
            stamp.write_text(key, encoding="utf-8", newline="\n")
        except OSError:
            pass
        _FMT_READY[str(build)] = key
        return True


def turbo_compile(d: Path, source: str, engine: str, base: list,
                  mark=None) -> dict | None:
    """
    返回 {"ok", "log_text", "mode"}；返回 None 表示不适用（自动回退标准编译）。
    用户源码错误会正常返回 ok=False 并带正确行号，不会触发二次全量编译。
    mark 是可选的分段计时回调，仅供基准 / 诊断使用。
    """
    if engine not in FMT_ENGINES or not ENGINES.get(engine):
        return None
    parts = split_preamble(source)
    if not parts:
        return None
    pre_lines, body, n_pre = parts
    if not "".join(pre_lines).strip() or n_pre > 400:
        return None
    build = d / ".turbo"
    try:
        ensure_dir(build)
    except OSError:
        return None
    if not ensure_fmt(engine, pre_lines, build, d):
        return None
    if mark:
        mark("fmt")

    # 导言行留空保行号；可变的 title/author/date 留在原行，改标题不重建 .fmt
    kept = []
    for line in pre_lines:
        if fmt_volatile(line):
            kept.append(line if line.endswith("\n") else line + "\n")
        else:
            kept.append("\n")
    (build / "main.tex").write_text("".join(kept) + body,
                                    encoding="utf-8", newline="\n")

    # 连续极速编译时 aux 一直留在 build 目录，无需来回同步；
    # 只有刚从标准编译切过来才把项目目录里较新的 aux 带进来。
    steady = _TURBO_LAST.get(str(d)) == "turbo"
    if not steady:
        for f in FMT_AUX_FILES:
            a, b = d / f, build / f
            try:
                if a.exists() and (not b.exists() or a.stat().st_mtime > b.stat().st_mtime):
                    shutil.copy2(a, b)
            except OSError:
                pass

    cmd = [base[0], "-fmt=" + FMT_NAME] + base[1:-1] + ["main.tex"]
    try:
        cp = run_cmd(cmd, cwd=build, timeout=90, env={"TEXINPUTS": fmt_texinputs(d)})
    except subprocess.TimeoutExpired:
        return None
    if mark:
        mark("tex")
    log_text = (cp.stdout.decode("utf-8", "replace") + "\n"
                + cp.stderr.decode("utf-8", "replace"))
    ok = cp.returncode == 0 and (build / "main.pdf").exists()
    if not ok:
        # 有明确 TeX 错误 → 源码问题，按正常失败返回（行号仍与原文件一致）
        if re.search(r"^! ", log_text, re.M) or re.search(r":\d+:", log_text):
            return {"ok": False, "log_text": log_text, "mode": "turbo"}
        return None                       # 引擎级异常 → 回退标准全量编译
    for f in FMT_OUT_FILES:
        src = build / f
        if src.exists():
            try:
                # copy2 会连带复制权限 / 扩展属性（macOS 上实测比纯内容复制
                # 慢约 8ms/文件）；这里只需要字节一致，元数据由 write 自己生成。
                shutil.copyfile(src, d / f)
            except OSError:
                pass
    if mark:
        mark("copyout")
    return {"ok": True, "log_text": log_text, "mode": "turbo"}


# --------------------------------------------------------------------------
# 编译产物内存流 + 页级失效索引（准增量预览的后端部分）
# --------------------------------------------------------------------------
# TeX 每轮都会在 PDF 里写 /CreationDate 与 /ID，整文件哈希恒变；pdf_incremental
# 改成比较「除 Info / XRef 外所有对象」的全局 rev 与「每页内容流」指纹。
# 编译成功后直接把新 PDF 留在内存里，/api/pdf 无需再读一次盘。
_PDF_MEM_LOCK = threading.Lock()
_PDF_MEM: dict[str, tuple] = {}          # path -> (mtime_ns, size, bytes, rev, pages)


def _publish_pdf(f: Path, data: bytes, info: dict | None) -> tuple[str, list]:
    rev = info["rev"] if info else hashlib.sha256(data).hexdigest()[:20]
    pages = info["pages"] if info else []
    try:
        st = f.stat()
    except OSError:
        return rev, pages
    with _PDF_MEM_LOCK:
        _PDF_MEM[str(f)] = (st.st_mtime_ns, st.st_size, data, rev, pages)
        if len(_PDF_MEM) > 24:
            _PDF_MEM.pop(next(iter(_PDF_MEM)))
    return rev, pages


def pdf_payload(f: Path) -> tuple[bytes, str, list]:
    """返回 (PDF 字节, 全局 rev, 每页指纹)。优先命中编译刚写入的内存流。

    外部改过文件（mtime/size 不一致）时重新读盘并重新分析，绝不返回过期内容。
    """
    try:
        st = f.stat()
    except OSError:
        return b"", "", []
    with _PDF_MEM_LOCK:
        hit = _PDF_MEM.get(str(f))
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2], hit[3], hit[4]
    try:
        data = f.read_bytes()
    except OSError:
        return b"", "", []
    return (data,) + _publish_pdf(f, data, pdf_inc.analyze(data))


# --------------------------------------------------------------------------
# 语义无变化跳过编译：算出「TeX 真正看得见的字符流」，若与上次成功编译一致
# 就整轮 TeX 都不跑（注释改写、行尾空格、撤回绕回等常见编辑从 ~0.5s 降到 ~0）。
# 设计原则：宁可保守地多跑一次 TeX，绝不因误判显示过期画面。
# --------------------------------------------------------------------------
_SKIP_LOCK = threading.Lock()
_SKIP_CACHE: dict[str, dict] = {}        # 项目目录 -> {"key":..., "result":...}

# 出现这些构造时无法安全推断字符流，直接关闭跳过：
#   verbatim 系里 % 是普通字符；\input 等会引入目录外的文件；
#   \url / \href 的参数里 % 不参与注释；\today / \time 与时钟有关；
#   \write18 / \openin / \read 有外部副作用。
_SKIP_UNSAFE = re.compile(
    r"\\(?:begin|end)\s*\{\s*(?:verbatim\*?|lstlisting|minted|alltt|comment|Verbatim\*?)"
    r"|\\(?:verb|lstinline|verbatiminput|lstinputlisting)\b"
    r"|\\(?:input|include|import|subfile|includeonly)\b"
    r"|\\(?:url|path|nolinkurl|href)\s*\{"
    r"|\\(?:today|write18|ShellEscape|openin|read)\b"
    r"|\\the\s*(?:time|day|month|year)\b",
    re.X)

# 编译生成物不参与「外部资源」指纹；它们的 mtime 每轮都变，纳入后缓存永远不命中。
_SKIP_GENERATED = {
    "main.tex", "main.pdf", "main.aux", "main.log", "main.out", "main.toc",
    "main.bbl", "main.blg", "main.synctex.gz", "main.synctex", "main.fls",
    "main.fdb_latexmk", "main.nav", "main.snm", "main.vrb", "main.map.json",
    "main.lof", "main.lot", "main.idx", "main.ilg", "main.ind", "main.bcf",
    "main.run.xml", "main.xdv", "main.thm", "main.ent", "main.lg",
    "compile.log", ".state.json", ".runtime.json", ".fmt-key", "_preamble.tex",
}
_SKIP_GENERATED_DIRS = {".turbo", ".fmt_cache", "__pycache__"}


def effective_tex_lines(source: str) -> list[str] | None:
    """按行还原 TeX 的可见输入；None = 无法安全推断。

    逐行保留一行一个元素 ⇒ 行数天然进入指纹，行号不会因增删注释行而错位，
    SyncTeX 映射依旧精确。行尾未转义的 % 会吞掉换行，用 \\x00 标记区分。
    """
    if _SKIP_UNSAFE.search(source):
        return None
    out = []
    for line in source.splitlines():
        i = 0
        while i < len(line):
            if line[i] == "%":
                j, bs = i - 1, 0
                while j >= 0 and line[j] == "\\":
                    bs += 1
                    j -= 1
                if bs % 2 == 0:          # 前面是偶数个反斜杠 ⇒ 真注释
                    break
            i += 1
        had_comment = i < len(line)
        visible = (line[:i] if had_comment else line).rstrip(" \t")
        out.append(visible + ("\x00" if had_comment else ""))
    return out


def _external_fingerprint(d: Path) -> str:
    """项目目录里除生成物外的文件（图片 / .bib / 自定义 .sty …）指纹。"""
    parts = []
    try:
        for p in sorted(d.iterdir()):
            if p.name in _SKIP_GENERATED:
                continue
            if p.is_dir():
                if p.name not in _SKIP_GENERATED_DIRS:
                    parts.append("D:" + p.name)
                continue
            if p.is_file():
                st = p.stat()
                parts.append(f"{p.name}:{st.st_mtime_ns}:{st.st_size}")
    except OSError:
        return "?"
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:20]


def semantic_skip_key(d: Path, source: str, engine: str, turbo: bool,
                      kind: str, full: bool) -> str | None:
    """本轮可否与上次成功编译共用结果。诊断时设 YANGTEX_NO_SKIP=1 关闭。"""
    if full or kind != "tex" or os.environ.get("YANGTEX_NO_SKIP") == "1":
        return None
    lines = effective_tex_lines(source)
    if lines is None:
        return None
    raw = ("\x01".join(lines) + "\x02" + engine + "\x02" + str(bool(turbo))
           + "\x02" + _external_fingerprint(d)).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def compile_project(name: str, content: str | None = None,
                    requested_engine: str | None = None, full: bool = False,
                    turbo: bool = True) -> dict:
    _T0 = time.perf_counter()
    _marks: dict[str, float] = {}

    def mark(k: str) -> None:
        _marks[k] = round((time.perf_counter() - _T0) * 1000, 2)

    d = project_dir(name)
    ensure_dir(d)
    main = d / "main.tex"
    meta = source_meta(d)
    if meta["kind"] == "tex":
        if content is not None:
            write_main(d, content)  # 原子写入，避免编译过程读到半截文件
    else:
        # Markdown 主源：content（若带）是 Markdown，绝不能直接写进 main.tex。
        # 先写主源，再重新生成编译产物与行号映射，保证 PDF / SyncTeX 与编辑器一致。
        _, info = sync_tex_from_source(d, content)
        if info and (not requested_engine or requested_engine == "auto"):
            requested_engine = info["engine"]
    if not main.exists():
        return {"ok": False, "error": "找不到 main.tex"}
    source = main.read_text(encoding="utf-8", errors="replace")
    eng = engine_for(source, requested_engine, smart=turbo)
    exe = ENGINES.get(eng)
    if not exe:
        return {"ok": False, "error": f"未找到 {eng}。请安装 TeX Live 或 MiKTeX，或在 config.json 中指定路径。"}

    mark("prep")
    # 语义无变化（只改注释 / 行尾空白 / 绕回旧内容）：直接复用上次成功的产物。
    # main.tex 已按最新内容写盘，行数未变，SyncTeX 行号映射依旧精确。
    skip_key = semantic_skip_key(d, source, eng, turbo, meta["kind"], full)
    if skip_key:
        with _SKIP_LOCK:
            hit = _SKIP_CACHE.get(str(d))
        if hit and hit["key"] == skip_key and (d / "main.pdf").exists():
            cached = dict(hit["result"])
            cached["cached"] = True
            cached["duration"] = 0
            cached["timings"] = {"prep": _marks["prep"], "skipped": 0.0,
                                 "total": round((time.perf_counter() - _T0) * 1000, 2)}
            return cached
    t0 = time.time()
    base = [
        exe, "-synctex=1", "-interaction=nonstopmode",
        "-file-line-error", "-halt-on-error", "main.tex",
    ]
    log_text = ""
    mode = "standard"
    with COMPILE_LOCK:
        try:
            # 极速通道：导言已在 .fmt 里，只排版正文。失败或不可用时自动回退，
            # 「完整编译」（bibtex / 多轮交叉引用）始终走标准通道。
            fast = turbo_compile(d, source, eng, base, mark) if (turbo and not full) else None
            if fast is not None:
                mode = "turbo"
                log_text, ok = fast["log_text"], fast["ok"]
            else:
                # 刚从极速切回标准：把 build 目录里最新的 aux 带回来，
                # 交叉引用编号不会因为编译目录不同而退回上一轮。
                tb = d / ".turbo"
                for f in FMT_AUX_FILES:
                    a, b = tb / f, d / f
                    try:
                        if a.exists() and (not b.exists()
                                           or a.stat().st_mtime > b.stat().st_mtime):
                            shutil.copy2(a, b)
                    except OSError:
                        pass
                cp = run_cmd(base, cwd=d, timeout=90)
                log_text = cp.stdout.decode("utf-8", "replace") + "\n" + cp.stderr.decode("utf-8", "replace")
                ok = (d / "main.pdf").exists() and cp.returncode == 0
                # 实时自动编译只跑一轮（最快）；只有「完整编译」才处理 bibtex 与多轮交叉引用。
                # 由于 .aux 会被保留，下一次编译自然得到正确的引用编号。
                need_bib = bool(re.search(r"\\bibliography\s*\{", source)) and bool(list(d.glob("*.bib")))
                if full and ok:
                    if need_bib and ENGINES.get("bibtex"):
                        try:
                            run_cmd([ENGINES["bibtex"], "main"], cwd=d, timeout=40)
                        except Exception:
                            pass
                    cp2 = run_cmd(base, cwd=d, timeout=90)
                    log2 = cp2.stdout.decode("utf-8", "replace")
                    log_text += "\n" + log2
                    ok = (d / "main.pdf").exists() and cp2.returncode == 0
                    if ok and (need_bib or "Rerun" in log2):
                        cp3 = run_cmd(base, cwd=d, timeout=90)
                        log_text += "\n" + cp3.stdout.decode("utf-8", "replace")
                        ok = cp3.returncode == 0
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "编译超时（90 秒），请检查是否有死循环的宏或过大的图片。", "duration": 90}
        except Exception as ex:
            return {"ok": False, "error": f"编译异常：{ex}", "trace": traceback.format_exc()[-800:]}

    mark("compile_done")
    try:
        (d / "compile.log").write_text(log_text, encoding="utf-8")
    except Exception:
        pass
    issues = parse_log(log_text, name)
    mark("logparse")
    pdf = d / "main.pdf"
    _TURBO_LAST[str(d)] = mode

    # 成功后分析页级失效并留一份内存 PDF 流。失败时前端本来就保留上一份
    # 预览，不需要指纹；解析不出来（结构异常）时 pages=[] 让前端退化为全量。
    pages: list[str] = []
    pdf_rev = ""
    if ok and pdf.exists():
        try:
            data = pdf.read_bytes()
            info = pdf_inc.analyze(data)
            pdf_rev, pages = _publish_pdf(pdf, data, info)
        except Exception:
            pages, pdf_rev = [], ""
    mark("fingerprint")
    mark("total")
    _result = {
        "ok": bool(ok and pdf.exists()),
        "engine": eng,
        "mode": mode,
        "duration": round(time.time() - t0, 2),
        "pdf": pdf.exists(),
        "pdf_size": pdf.stat().st_size if pdf.exists() else 0,
        "mtime": int(pdf.stat().st_mtime) if pdf.exists() else 0,
        "synctex": (d / "main.synctex.gz").exists() or (d / "main.synctex").exists(),
        "issues": issues,
        "log_tail": "\n".join(log_text.splitlines()[-25:]),
        # 准增量预览：全局 rev 相同 ⇒ 画面一定相同；否则只重画指纹变化的页
        "pdf_rev": pdf_rev,
        "pages": pages,
        "timings": _marks,
    }
    # 只缓存真正跑过 TeX 且成功的结果；失败 / 完整编译一律清掉，
    # 避免下一轮把「上次失败的旧 PDF」当成可复用的成果。
    with _SKIP_LOCK:
        if skip_key and ok and pdf.exists():
            _SKIP_CACHE[str(d)] = {"key": skip_key, "result": dict(_result)}
            if len(_SKIP_CACHE) > 24:
                _SKIP_CACHE.pop(next(iter(_SKIP_CACHE)))
        else:
            _SKIP_CACHE.pop(str(d), None)
    return _result


# --------------------------------------------------------------------------
# SyncTeX —— 双向逐行精确定位
# --------------------------------------------------------------------------

def synctex_file(d: Path) -> str:
    return "main.pdf"


def parse_view_output(text: str) -> list[dict]:
    """解析 synctex view 的多个结果块。坐标：页面左上角原点，单位 bp。"""
    boxes = []
    for block in re.split(r"SyncTeX result begin", text)[1:]:
        block = block.split("SyncTeX result end")[0]
        pg = re.search(r"^Page:(\d+)", block, re.M)
        if not pg:
            continue
        nums = {}
        for k in ("x", "y", "W", "H", "h", "v"):
            m = re.search(rf"^{k}:([-\d.]+)", block, re.M)
            if m:
                nums[k] = float(m.group(1))
        if "x" in nums and "y" in nums:
            boxes.append({
                "page": int(pg.group(1)),
                "x": nums["x"], "y": nums["y"],
                "w": nums.get("W", 40), "h": nums.get("H", 12),
                "hx": nums.get("h", nums["x"]), "v": nums.get("v", nums["y"]),
            })
    return boxes


def synctex_view(name: str, line: int, col: int = 1) -> dict:
    d = project_dir(name)
    exe = ENGINES.get("synctex")
    if not exe or not (d / "main.pdf").exists():
        return {"ok": False, "error": "SyncTeX 工具或 PDF 不存在"}
    # 命令行工具用编译时的相对名；逐步尝试多种写法以适配不同 TeX 发行版
    candidates = ["main.tex", "./main.tex", str(d / "main.tex")]

    def query(cand, ln):
        try:
            cp = run_cmd([exe, "view", "-i", f"{ln}:{max(1, col)}:{cand}",
                          "-o", synctex_file(d)], cwd=d, timeout=8)
            return parse_view_output(cp.stdout.decode("utf-8", "replace"))
        except Exception:
            return []

    # 阶段 1：精确行 × 各种文件名写法（绝不先退让到相邻行，保证定位准确）
    boxes, used_line = [], line
    for cand in candidates:
        boxes = query(cand, line)
        if boxes:
            break
    # 阶段 2：注释 / 空行 / 导言区没有排版盒时，才取最近的有内容行
    if not boxes:
        for delta in (-1, 1, -2, 2, -3, 3):
            ln = line + delta
            if ln < 1:
                continue
            boxes = query("main.tex", ln)
            if boxes:
                used_line = ln
                break
    if not boxes:
        return {"ok": False, "error": "该行没有对应的排版位置（可能是注释、空行或导言区）"}

    page = boxes[0]["page"]
    same = [b for b in boxes if b["page"] == page]
    x0 = min(min(b["x"], b["hx"]) for b in same)
    y0 = min(b["y"] for b in same)
    x1 = max(b["x"] + b["w"] for b in same)
    y1 = max(b["y"] + b["h"] for b in same)
    return {
        "ok": True, "page": page, "line": used_line, "requested_line": line,
        "boxes": same,
        "rect": [round(x0, 2), round(y0, 2),
                 round(max(x1, x0 + 6), 2), round(max(y1, y0 + 8), 2)],
    }


def _synctex_edit_raw(d: Path, exe: str, page: int, x: float, y: float) -> dict:
    """调用 synctex edit 单点查询。"""
    arg = f"{int(page)}:{float(x):.3f}:{float(y):.3f}:{synctex_file(d)}"
    try:
        cp = run_cmd([exe, "edit", "-o", arg], cwd=d, timeout=8)
        txt = cp.stdout.decode("utf-8", "replace")
        inp = re.search(r"^Input:(.+)$", txt, re.M)
        ln = re.search(r"^Line:(-?\d+)", txt, re.M)
        colm = re.search(r"^Column:(-?\d+)", txt, re.M)
        line = int(ln.group(1)) if ln else 0
        if line <= 0:
            return {"ok": False, "error": "该位置没有对应的源码行"}
        f = inp.group(1).strip() if inp else ""
        return {
            "ok": True, "line": line,
            "column": max(1, int(colm.group(1))) if colm else 1,
            "file": os.path.basename(f), "main": ("main.tex" in f or not f),
        }
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


def synctex_edit(name: str, page: int, x: float, y: float,
                 ox: float | None = None, oy: float | None = None) -> dict:
    """
    PDF → 源码反向定位。x,y 是前端吸附后的精确锚点；ox,oy 是用户真正点击的位置。
    用「原始点击点是否落在该行的 SyncTeX 排版盒内」做自洽校验，
    公式行 / 行间空白处的偏差可被自动纠正，定位可精确到行。
    """
    d = project_dir(name)
    exe = ENGINES.get("synctex")
    if not exe or not (d / "main.pdf").exists():
        return {"ok": False, "error": "SyncTeX 工具或 PDF 不存在"}
    tx = ox if ox is not None else x
    ty = oy if oy is not None else y
    base = _synctex_edit_raw(d, exe, page, x, y)
    if not base.get("ok"):
        # 吸附点没命中时，直接用原始点击点再试一次
        if (tx, ty) != (x, y):
            base = _synctex_edit_raw(d, exe, page, tx, ty)
        if not base.get("ok"):
            return base
    if not base.get("main"):
        return base

    def fits(line: int) -> float:
        """返回该行排版盒对原始点击点的贴合度（越大越好，盒内为强信号）。"""
        v = synctex_view(name, line, 1)
        if not v.get("ok"):
            return -1000.0
        x0, y0, x1, y1 = v["rect"]
        inside = (x0 - 12 <= tx <= x1 + 12) and (y0 - 5 <= ty <= y1 + 5)
        return (100.0 if inside else 0.0) - abs((y0 + y1) / 2 - ty) * 0.6

    if fits(base["line"]) >= 95:
        return {**base, "verified": True}

    # 不自洽：围绕原始点击点采样，挑出真正覆盖点击位置的源码行
    cands = [base["line"]]
    for dx, dy in ((0, -3), (0, 3), (0, -6), (0, 6), (-10, 0), (10, 0), (0, -9), (0, 9)):
        r = _synctex_edit_raw(d, exe, page, tx + dx, ty + dy)
        if r.get("ok") and r.get("main") and r["line"] not in cands:
            cands.append(r["line"])
    best_line, best_score = base["line"], -1e9
    for ln in cands:
        score = fits(ln)
        if score > best_score:
            best_line, best_score = ln, score
    return {"ok": True, "line": best_line, "column": base.get("column", 1),
            "file": base.get("file", "main.tex"), "main": True, "verified": True}


# --------------------------------------------------------------------------
# AI 助手：免费无 Key 大模型 + 完全离线降级
# --------------------------------------------------------------------------

AI_ENDPOINTS = [
    "https://text.pollinations.ai/v1/chat/completions",
    "https://text.pollinations.ai/openai/chat/completions",
]
AI_MODEL = "openai-fast"  # 匿名免费层当前唯一模型：GPT-OSS 20B，无需任何 Key / 注册
# 官方 Classic API：文本请求「同一时刻仅一个，且间隔 30 秒」（不是 45 秒，45 秒是图片）
AI_COOLDOWN_MS = 31000
AI_MODEL_URLS = [
    "https://text.pollinations.ai/models",
    "https://text.pollinations.ai/openai/models",
]
AI_MODEL_FALLBACK = [{
    "name": AI_MODEL, "aliases": ["openai", "gpt-oss", "gpt-oss-20b", "ovh-reasoning"],
    "description": "GPT-OSS 20B Reasoning LLM (OVH)", "tier": "anonymous",
    "input_modalities": ["text"], "output_modalities": ["text"],
}]
AI_MODELS_CACHE: dict = {"ts": 0.0, "data": None}

# 前端可选通道（与 web/app.js 的 AI_CHANNELS 保持一致）
AI_CHANNELS = [
    {"id": "v1-stream", "label": "GPT-OSS 20B · 流式（首字最快）", "mode": "sse"},
    {"id": "v1", "label": "GPT-OSS 20B · 标准", "mode": "json"},
    {"id": "text", "label": "GPT-OSS 20B · 纯文本", "mode": "text"},
    {"id": "openai", "label": "GPT-OSS 20B · 兼容端点", "mode": "json"},
    {"id": "local", "label": "本地服务代理", "mode": "local"},
]


def ai_models(force: bool = False) -> dict:
    """动态发现当前可用的免费无 Key 模型；官方开放新匿名模型时无需升级 YangTex。"""
    now = time.time()
    if (not force and AI_MODELS_CACHE["data"]
            and now - AI_MODELS_CACHE["ts"] < 300):
        return AI_MODELS_CACHE["data"]
    found = []
    for ep in AI_MODEL_URLS:
        try:
            req = urllib.request.Request(ep, headers={"User-Agent": "YangTex/1.0"})
            with urllib.request.urlopen(req, timeout=6) as r:
                raw = json.loads(r.read().decode("utf-8", "replace"))
            items = raw if isinstance(raw, list) else (raw.get("data") or raw.get("models") or [])
            for m in items:
                if not isinstance(m, dict):
                    continue
                mid = str(m.get("name") or m.get("id") or "").strip()
                if not mid:
                    continue
                found.append({
                    "name": mid,
                    "aliases": m.get("aliases") or [],
                    "description": m.get("description") or mid,
                    "tier": m.get("tier") or "anonymous",
                    "input_modalities": m.get("input_modalities") or ["text"],
                    "output_modalities": m.get("output_modalities") or ["text"],
                })
            if found:
                break
        except Exception:
            continue
    if not found:
        found = AI_MODEL_FALLBACK
    out = {"ok": True, "models": found, "default": AI_MODEL, "needs_key": False,
           "cooldown_ms": AI_COOLDOWN_MS, "channels": AI_CHANNELS,
           "updated": int(now)}
    AI_MODELS_CACHE.update({"ts": now, "data": out})   # 原地更新，避免局部变量遮蔽
    return out


AI_SYSTEM = (
    "你是 YangTex 内置的 LaTeX 与数学写作助手，服务对象是偏微分方程(PDE)方向的数学学者。"
    "规则：1) 回答用简体中文，简洁、专业、可直接行动；2) 涉及 LaTeX 代码时给出完整可编译片段，"
    "用 ```latex 代码块包裹；3) 优先使用 amsmath/amssymb/amsthm/mathtools 等标准宏包，"
    "中英文混排时用 ctex + xelatex；4) 解释编译错误时先给原因，再给最小修改方案；"
    "5) 不臆造文献与定理，不确定的地方明确说明；6) 不要输出多余的寒暄。"
)


def offline_ai(action: str, text: str, issues: list[dict] | None = None) -> str:
    """无网络时的内置规则助手，保证 AI 功能永远可用。"""
    issues = issues or []
    if action == "generate":
        return ("【YangTex 内置助手 · 常用可编译骨架】\n\n"
                "```latex\n"
                "\\documentclass[11pt,a4paper,fontset=fandol]{ctexart}\n"
                "\\usepackage{amsmath,amssymb,amsthm,mathtools}\n"
                "\\newtheorem{theorem}{定理}[section]\n"
                "\\newcommand{\\R}{\\mathbb{R}}\n"
                "\\newcommand{\\Om}{\\Omega}\n"
                "\\begin{document}\n"
                "\\section{引言}\n"
                "\\begin{theorem}\n"
                "  设 $f\\in L^2(\\Om)$，则方程 $-\\Delta u=f$ 存在唯一弱解。\n"
                "\\end{theorem}\n"
                "\\end{document}\n"
                "```\n\n"
                "点「插入代码块到光标处」即可套用；联网后可用免费大模型按你的具体需求生成。")
    if action == "fix" and issues:
        out = ["【离线 LaTeX 诊断】根据最近一次编译日志：\n"]
        for i, it in enumerate(issues[:5], 1):
            msg = it["message"]
            hint = ""
            if "Undefined control sequence" in msg:
                hint = "→ 通常是缺少宏包或命令拼写错误；检查导言区，例如 \\usepackage{amsmath,amssymb,amsthm}。"
            elif "Missing $ inserted" in msg or "Math" in msg:
                hint = "→ 数学符号必须放在 $...$、\\[...\\] 或 equation 环境中。"
            elif "File `.*' not found" in msg or "not found" in msg.lower():
                hint = "→ 缺少文档类/宏包或图片文件；用 kpsewhich 检查，或安装对应宏包。"
            elif "Missing \\end" in msg or "begin{" in msg:
                hint = "→ 环境未闭合，检查 \\begin{...} / \\end{...} 是否配对。"
            elif "Unicode" in msg or "character" in msg.lower():
                hint = "→ 中文需要 xelatex + ctex（\\documentclass[fontset=fandol]{ctexart}）。"
            else:
                hint = "→ 定位到日志给出的行，检查括号、环境、宏包是否配对。"
            out.append(f"{i}. 第 {it['line']} 行：{msg}\n   {hint}\n")
        return "\n".join(out)
    if action == "explain" and text.strip():
        t = text.strip()
        cmds = sorted(set(re.findall(r"\\([A-Za-z]+)", t)))[:12]
        envs = re.findall(r"\\begin\{([^}]+)\}", t)
        return ("【离线解析】\n"
                f"• 片段共 {len(t.splitlines())} 行、{len(t)} 字符。\n"
                f"• 使用的命令：{', '.join('\\\\' + c for c in cmds) or '（无）'}\n"
                f"• 环境：{', '.join(envs) or '（无）'}\n"
                "• 数学模式：检查 $...$ / \\[...\\] / equation 是否成对。\n\n"
                "需要逐句翻译、润色或改写时请联网，AI 会自动切换到免费大模型。")
    return ("【YangTex 离线助手】当前网络不可用，已切换为内置助手。\n\n"
            "可直接使用的能力：\n"
            "• 编译错误诊断（点「修复错误」）\n"
            "• 选中代码的命令 / 环境解析（点「解释」）\n"
            "• 常用片段：定理、公式、PDE 宏包导言区、中文模板等，见「模板库」\n\n"
            "联网后无需任何设置，AI 会自动接入免费大模型（无需 API Key）。")


def call_ai(payload: dict) -> dict:
    action = payload.get("action", "chat")
    text = payload.get("text", "") or ""
    issues = payload.get("issues", []) or []
    user_msg = payload.get("message", "") or ""
    history = payload.get("messages", [])[-8:]

    # 前端已确认在线通道不可达时，直接给离线诊断，避免后端再耗 25s 重试同一端点
    if payload.get("prefer_offline"):
        return {"ok": True, "reply": offline_ai(action, text, issues),
                "source": "offline", "error": "online channel unreachable from browser"}

    if action == "fix":
        brief = "\n".join(f"{i['line']}: {i['message']}" for i in issues[:8])
        user_msg = f"请诊断并修复以下 LaTeX 编译错误，给出最小改动方案：\n{brief}\n\n相关源码：\n{text[:3000]}"
    elif action == "explain":
        user_msg = f"请解释这段 LaTeX / 数学公式的含义，并指出可改进之处：\n```latex\n{text[:3000]}\n```"
    elif action == "polish":
        user_msg = f"请在保持原意的前提下润色下面这段学术文字（中文或英文），只输出润色后的正文：\n{text[:3000]}"
    elif action == "translate":
        user_msg = f"请把下面这段文字在中文与英文之间互译，保持学术书面语，只输出译文：\n{text[:3000]}"
    elif action == "generate":
        user_msg = f"请根据需求写出可直接编译的 LaTeX 代码（含必要导言区）：\n{text[:2000]}"
    if not user_msg.strip():
        user_msg = "请用一句话介绍你自己，并说明能帮我做什么。"

    messages = [{"role": "system", "content": AI_SYSTEM}]
    for m in history:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:4000]})
    messages.append({"role": "user", "content": user_msg[:12000]})

    # 允许前端指定模型；只接受官方模型列表里的名字/别名，避免注入任意值
    allowed = {AI_MODEL}
    for m in ai_models().get("models", []):
        allowed.add(m["name"])
        allowed.update(str(a) for a in (m.get("aliases") or []))
    asked = str(payload.get("model") or AI_MODEL)
    model = asked if asked in allowed else AI_MODEL

    body = json.dumps({"model": model, "messages": messages,
                       "max_tokens": 1800, "temperature": 0.3}).encode("utf-8")
    last_err = ""
    last_rate = 0
    busy = False
    for ep in AI_ENDPOINTS:
        try:
            req = urllib.request.Request(
                ep, data=body,
                headers={"Content-Type": "application/json",
                         "Referer": "https://yangtex.local",
                         "User-Agent": "YangTex/1.0"},
                method="POST")
            # 快速失败：前端还有其它通道可切换，后端代理不要拖到 25 秒
            with urllib.request.urlopen(req, timeout=14) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            reply = data["choices"][0]["message"]["content"]
            if isinstance(reply, list):
                reply = "".join(p.get("text", "") for p in reply if isinstance(p, dict))
            reply = str(reply).strip()
            if reply:
                return {"ok": True, "reply": reply, "source": "free-online",
                        "model": data.get("model", model)}
            last_err = "空回复"
        except urllib.error.HTTPError as he:
            msg = ""
            try:
                detail = json.loads(he.read().decode("utf-8", "replace"))
                msg = (detail.get("error") or {}).get("message", "")
            except Exception:
                pass
            # 官方 402 会带 Retry-After 头（秒），文本里也有 "Retry after Ns"
            m = re.search(r"Retry after\s+(\d+)\s*s", str(msg), re.I)
            hdr = he.headers.get("Retry-After")
            try:
                hdr_s = int(float(hdr)) if hdr else 0
            except Exception:
                hdr_s = 0
            last_rate = int(m.group(1)) if m else (hdr_s or (31 if he.code == 402 else 0))
            if he.code == 429 and "still running" in str(msg).lower():
                busy = True   # 同一 IP 只允许一个在途请求，稍后重试即可，不是故障
                last_rate = 2
            last_err = f"HTTP {he.code}: {msg or he.reason}"
        except Exception as ex:
            last_err = f"{type(ex).__name__}: {ex}"
    if last_rate:
        return {"ok": True, "reply": offline_ai(action, text, issues),
                "source": "rate-limited", "retry_after": last_rate,
                "busy": busy, "error": last_err[:200]}
    return {"ok": True, "reply": offline_ai(action, text, issues),
            "source": "offline", "error": last_err[:200]}


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

def build_hash() -> str:
    """前端文件指纹：已打开的标签页据此提示「有新版本，点此刷新」，避免一直停留在旧界面。"""
    h = hashlib.sha256()
    for f in (WEB / "index.html", WEB / "app.js", WEB / "app.css", Path(__file__)):
        try:
            st = f.stat()
            h.update(f"{f.name}:{int(st.st_mtime)}:{st.st_size};".encode())
        except OSError:
            pass
    return h.hexdigest()[:12]


class Handler(BaseHTTPRequestHandler):
    server_version = "YangTex/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 静默：双击启动后没有任何终端输出
        pass

    @staticmethod
    def _hdr(value: str) -> str:
        """HTTP 头只允许 latin-1。中文文件名等一律降级为 ASCII，避免 send_header 抛
        UnicodeEncodeError 造成「响应头发出一半、正文永远不写、浏览器一直转圈」。"""
        try:
            str(value).encode("latin-1", "strict")
            return str(value)
        except (UnicodeEncodeError, UnicodeError):
            return re.sub(r"[^\x20-\x7e]", "_", str(value))

    def _send(self, code: int, data: bytes, ctype: str = "application/json; charset=utf-8",
              extra: dict | None = None, cache: str | None = None):
        try:
            self.send_response(code)
            self.send_header("Content-Type", self._hdr(ctype))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache or "no-store, max-age=0")
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (extra or {}).items():
                self.send_header(self._hdr(k), self._hdr(v))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, OSError, UnicodeError, ValueError):
            pass

    def _json(self, obj, code: int = 200):
        self._send(code, jdump(obj))

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0:
                return {}
            return json.loads(self.rfile.read(n).decode("utf-8", "replace"))
        except Exception:
            return {}

    @staticmethod
    def _disposition(kind: str, filename: str) -> str:
        """RFC 5987：ASCII 兜底文件名 + UTF-8 百分号编码文件名，中文项目名也能正确下载。"""
        ascii_name = re.sub(r'[^\x20-\x7e]', '_', filename).replace('"', '_').replace('\\', '_')
        return (f'{kind}; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(filename, safe='')}")

    def _file(self, path: Path, ctype: str | None = None,
              attachment: str | None = None, inline_name: str | None = None):
        if not path.is_file():
            return self._json({"error": "not found"}, 404)
        try:
            data = path.read_bytes()
        except Exception:
            return self._json({"error": "read failed"}, 500)
        extra = {}
        if attachment:
            extra["Content-Disposition"] = self._disposition("attachment", attachment)
        elif inline_name:
            extra["Content-Disposition"] = self._disposition("inline", inline_name)
        ct = ctype or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ct.startswith("text/") or ct in ("application/javascript", "image/svg+xml"):
            ct += "; charset=utf-8"
        self._send(200, data, ct, extra)

    # ---------------- GET ----------------
    def do_GET(self):
        u = urlparse(self.path)
        p, q = unquote(u.path), parse_qs(u.query)
        try:
            if p == "/" or p == "/index.html":
                return self._file(WEB / "index.html", "text/html")
            if p.startswith("/api/"):
                return self.api_get(p, q)
            # 静态文件（严格限制在 web 目录内）
            rel = p.lstrip("/")
            f = (WEB / rel).resolve()
            if not str(f).startswith(str(WEB.resolve())):
                return self._json({"error": "forbidden"}, 403)
            return self._file(f)
        except Exception as ex:
            return self._json({"error": str(ex), "trace": traceback.format_exc()[-600:]}, 500)

    def api_get(self, p: str, q: dict):
        one = lambda k, d=None: (q.get(k) or [d])[0]
        name = one("project", STATE.get("project"))
        if p == "/api/health":
            return self._json({"ok": True, "app": APP_NAME, "version": VERSION,
                               "uptime": round(time.time() - START_TIME, 1),
                               "build": build_hash()})
        if p == "/api/init":
            ensure_default_project()
            return self._json({
                "app": APP_NAME, "version": VERSION,
                "welcome": "欢迎使用 YangTex",
                "tagline": "轻量 · 实时 · 中英文 · 精确双向同步",
                "state": STATE,
                "engines": {k: bool(v) for k, v in ENGINES.items()},
                "engine_paths": {k: v for k, v in ENGINES.items() if v},
                "tex_ready": bool(ENGINES.get("xelatex") or ENGINES.get("pdflatex")),
                "synctex_ready": bool(ENGINES.get("synctex")),
                "env_pkgs": env_pkg_probe(),
                "projects": list_projects(),
                "templates": list_templates(),
                "class_dir": "templates/classes/",
                "ai": {"model": AI_MODEL, "needs_key": False,
                       "endpoints": len(AI_ENDPOINTS), "cooldown_ms": AI_COOLDOWN_MS,
                       "models_url": AI_MODEL_URLS[0]},
                "platform": sys.platform,
            })
        if p == "/api/doc":
            d = project_dir(name)
            meta = source_meta(d)
            if meta["kind"] != "tex":
                sync_tex_from_source(d)   # 打开项目时先让编译产物与行号映射跟主源一致
            f = d / meta["file"]
            if not f.exists():
                return self._json({"ok": False, "content": "", "source_kind": meta["kind"]})
            out = {"ok": True, "content": f.read_text(encoding="utf-8", errors="replace"),
                   "mtime": int(f.stat().st_mtime), "project": name,
                   "source_kind": meta["kind"], "source_file": meta["file"],
                   "engine": meta.get("engine", "")}
            if one("tex", "") in ("1", "true", "yes"):
                tf = d / "main.tex"
                out["tex_content"] = tf.read_text(encoding="utf-8", errors="replace") if tf.exists() else ""
            return self._json(out)
        if p in ("/api/pdf", "/api/download"):
            f = project_dir(name) / "main.pdf"
            if not f.exists():
                return self._json({"error": "PDF 尚未生成，请先编译"}, 404)
            pdf_name = f"{safe_slug(name)}.pdf"
            # 明确 inline / attachment：浏览器标签页里打开，或作为文件下载
            if p == "/api/download" or one("dl", "") in ("1", "true", "yes"):
                return self._file(f, "application/pdf", attachment=pdf_name)
            # 预览通道：走编译后留在内存里的 PDF 流（省一次磁盘读），
            # 并带上页级指纹 ETag；内容没变时客户端可直接复用已渲染画面。
            data, rev, pages = pdf_payload(f)
            extra = {
                "Content-Disposition": self._disposition("inline", pdf_name),
                "ETag": '"' + (rev or "none") + '"',
                "X-YangTex-Pages": str(len(pages)),
            }
            if rev and self.headers.get("If-None-Match", "").strip() == '"' + rev + '"':
                return self._send(304, b"", "application/pdf", extra,
                                  cache="no-cache, max-age=0")
            return self._send(200, data, "application/pdf", extra,
                              cache="no-cache, max-age=0")
        if p == "/api/ai-models":
            # 前端优先直连官方模型列表；本接口作为 CORS / 代理受限时的兜底
            return self._json(ai_models())
        if p == "/api/log":
            f = project_dir(name) / "compile.log"
            return self._json({"ok": True, "text": f.read_text(encoding="utf-8", errors="replace")[-60000:] if f.exists() else ""})
        if p == "/api/templates":
            return self._json({"ok": True, "templates": list_templates()})
        if p == "/api/template-content":
            fn = Path(one("file", "")).name
            f = TEMPLATES_DIR / fn
            if not f.is_file() or f.suffix.lower() not in TEMPLATE_SUFFIXES:
                return self._json({"ok": False, "error": "模板不存在"}, 404)
            raw = f.read_text(encoding="utf-8", errors="replace")
            if f.suffix.lower() in MD_TEMPLATE_SUFFIXES:
                # 用户要的是「Markdown 模板用 Markdown 语法」：编辑器里直接装
                # Markdown 源；后端保存时自动生成 main.tex。latex 仅供查看。
                try:
                    latex, info = md_to_latex(raw, fn)
                except Exception as ex:
                    return self._json({"ok": False, "error": f"Markdown 转换失败：{ex}"}, 500)
                return self._json({
                    "ok": True, "content": raw, "latex": latex, "source": raw,
                    "kind": "mixed" if f.suffix.lower() == ".mdtex" else "markdown",
                    "engine": info["engine"],
                })
            return self._json({"ok": True, "content": raw, "kind": "tex"})
        # ---------------- 公式/引用编号悬停、文献管理、投稿包 ----------------
        if p == "/api/hover-index":
            d, meta = scholar_ctx(name)
            return self._json(scholar.build_hover_index(
                d, meta["kind"], meta["file"],
                lambda ln: tex_line_to_md(name, ln)))
        if p == "/api/bib":
            d, meta = scholar_ctx(name)
            return self._json(scholar.bib_state(d, meta["file"]))
        if p == "/api/ref-check":
            d, meta = scholar_ctx(name)
            return self._json(scholar.ref_check(
                d, meta["file"], lambda ln: tex_line_to_md(name, ln)))
        if p == "/api/ref-verify":
            # 面板打开时只读缓存，不触发网络；真正核验走 POST
            d, _ = scholar_ctx(name)
            cache = read_json(d / scholar.VERIFY_CACHE, {})
            keys = [k.strip() for k in one("keys", "").split(",") if k.strip()]
            out = [{"key": k, **cache[k]["result"], "cached": True}
                   for k in keys if k in cache and isinstance(cache[k], dict)]
            return self._json({"ok": True, "results": out,
                               "total": len(keys), "cached": True})
        if p == "/api/submission":
            d, meta = scholar_ctx(name)
            opts = {"strip_comments": one("strip", "1") not in ("0", "false", "no"),
                    "include_pdf": one("pdf", "1") not in ("0", "false", "no"),
                    "squeeze_blank": one("squeeze", "1") not in ("0", "false", "no")}
            if one("info", "") in ("1", "true", "yes"):
                return self._json(scholar.submission_preview(
                    d, name, meta["file"], opts))
            blob, info = scholar.build_submission(d, name, meta["file"], opts)
            return self._send(200, blob, "application/zip", {
                "Content-Disposition": self._disposition(
                    "attachment", f"{safe_slug(name)}_投稿包.zip"),
                "X-YangTex-Submission": str(info["files"]),
            })
        if p == "/api/projects":
            return self._json({"ok": True, "projects": list_projects()})
        if p == "/api/open-folder":
            folder = project_dir(name)
            try:
                if sys.platform == "darwin":
                    subprocess.Popen(["open", str(folder)], **CREATE_FLAGS)
                elif sys.platform.startswith("win"):
                    subprocess.Popen(["explorer", str(folder)], **CREATE_FLAGS)
                else:
                    subprocess.Popen(["xdg-open", str(folder)], **CREATE_FLAGS)
                return self._json({"ok": True})
            except Exception as ex:
                return self._json({"ok": False, "error": str(ex)})
        return self._json({"error": "unknown endpoint " + p}, 404)

    # ---------------- POST ----------------
    def do_POST(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        b = self._body()
        try:
            name = b.get("project") or STATE.get("project")
            if p == "/api/doc":
                content = b.get("content")
                if content is None:
                    return self._json({"ok": False, "error": "missing content"})
                d = project_dir(name)
                # 套用模板时可顺带切换主源类型（tex / markdown / mixed）
                kind = b.get("kind")
                if kind in SOURCE_FILES:
                    set_source_meta(d, kind, source_meta(d).get("engine", ""))
                meta = source_meta(d)
                if meta["kind"] == "tex":
                    write_main(d, str(content))
                else:
                    sync_tex_from_source(d, str(content))
                return self._json({"ok": True, "saved": True,
                                   "source_kind": meta["kind"],
                                   "source_file": meta["file"]})
            if p == "/api/compile":
                return self._json(compile_project(
                    name, b.get("content"), b.get("engine"), bool(b.get("full")),
                    turbo=b.get("turbo", True) is not False))
            if p == "/api/synctex/view":
                line = int(b.get("line", 1))
                # 前端给的是编辑器行号；Markdown 项目要先换算到 main.tex 行号。
                # synctex_edit 内部做自洽校验时直接传 .tex 行，不经过这里。
                return self._json(synctex_view(
                    name, md_line_to_tex(name, line), int(b.get("col", 1))))
            if p == "/api/synctex/edit":
                ox, oy = b.get("ox"), b.get("oy")
                r = synctex_edit(
                    name, int(b.get("page", 1)),
                    float(b.get("x", 0)), float(b.get("y", 0)),
                    float(ox) if ox is not None else None,
                    float(oy) if oy is not None else None)
                if r.get("ok") and r.get("main"):
                    tl = r["line"]
                    r = {**r, "line": tex_line_to_md(name, tl), "tex_line": tl}
                return self._json(r)
            if p == "/api/templates":
                return self._json(add_template(b.get("name", "新模板"),
                                               b.get("content", ""), b.get("engine", "xelatex"),
                                               b.get("category", "我的模板"),
                                               b.get("description", ""),
                                               b.get("kind", "tex")))
            if p == "/api/md-convert":
                # 编辑器里随时把一段 Markdown / 混排文本转成 LaTeX
                text = str(b.get("text", ""))
                if not text.strip():
                    return self._json({"ok": False, "error": "没有可转换的内容"}, 400)
                try:
                    if b.get("fragment"):
                        return self._json({"ok": True,
                                           "content": md_fragment_to_latex(text)})
                    content, info = md_to_latex(text, "编辑器选区")
                    return self._json({"ok": True, "content": content,
                                       "engine": info["engine"]})
                except Exception as ex:
                    return self._json({"ok": False, "error": f"转换失败：{ex}"}, 500)
            if p == "/api/projects":
                r = create_project(b.get("name", "未命名项目"), b.get("template"))
                STATE["project"] = r["name"]
                save_state(STATE)
                return self._json({"ok": True, **r})
            if p == "/api/project/select":
                STATE["project"] = safe_slug(b.get("name", ""))
                save_state(STATE)
                return self._json({"ok": True, "project": STATE["project"]})
            if p == "/api/state":
                for k, v in b.items():
                    if k in ("project", "engine", "auto_compile", "sync_enabled",
                             "theme", "welcome_shown", "font_size", "auto_packages",
                             "turbo", "continuous", "env_prefs"):
                        STATE[k] = sanitize_env_prefs(v) if k == "env_prefs" else v
                save_state(STATE)
                return self._json({"ok": True, "state": STATE})
            if p == "/api/ai":
                return self._json(call_ai(b))
            if p == "/api/upload-image":
                # 拖入的图片保存到当前项目目录，编译时 TeX 以该目录为 cwd，可直接引用文件名
                fn = str(b.get("filename") or "image.png")
                data = str(b.get("data") or "")
                if data.startswith("data:"):
                    data = data.split(",", 1)[-1] if "," in data else ""
                ext = Path(fn).suffix.lower()
                if ext not in (".png", ".jpg", ".jpeg", ".pdf", ".eps", ".gif", ".webp"):
                    return self._json({"ok": False, "error": "仅支持 PNG / JPG / PDF / EPS / GIF / WEBP"}, 400)
                try:
                    raw = base64.b64decode(data)
                except Exception:
                    return self._json({"ok": False, "error": "图片数据解码失败"}, 400)
                if not raw or len(raw) > 25 * 1024 * 1024:
                    return self._json({"ok": False, "error": "图片为空或超过 25 MB"}, 400)
                stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(fn).stem).strip("_") or "figure"
                d = project_dir(name)
                ensure_dir(d)
                target = d / (stem + ext)
                k = 1
                while target.exists():
                    target = d / f"{stem}_{k}{ext}"
                    k += 1
                target.write_bytes(raw)
                return self._json({"ok": True, "file": target.name,
                                   "size": len(raw), "path": str(target)})
            if p == "/api/bib":
                d, meta = scholar_ctx(name)
                action = str(b.get("action") or "save")
                if action == "link":
                    r = scholar.bib_link(d, meta["file"],
                                         str(b.get("bib_file") or "references"))
                elif action in ("save", "raw", "delete"):
                    st = scholar.bib_state(d, meta["file"])
                    mode = str(b.get("mode") or st["mode"])
                    # 项目里还没有任何文献表：新建 references.bib 并自动挂接
                    if mode == "none":
                        mode = "bib"
                    r = scholar.bib_save(
                        d, b.get("entries") or [], mode, meta["file"],
                        str(b.get("file") or "references.bib"), b.get("raw_bib"))
                    if r.get("ok") and mode == "bib" and not st["has_bibliography_cmd"]:
                        link = scholar.bib_link(d, meta["file"])
                        r["note"] = (r.get("note", "") + "；" + link.get("note", link.get("error", ""))).strip("；")
                else:
                    r = {"ok": False, "error": "未知文献操作 " + action}
                # 内嵌文献表被改写后，Markdown 项目要同步编译产物与行号映射
                if r.get("ok") and r.get("mode") == "embedded" and meta["kind"] != "tex":
                    if meta["file"] in r.get("changed", []):
                        sync_tex_from_source(d)
                return self._json({"ok": r.get("ok", False), **r})
            if p == "/api/ref-verify":
                d, meta = scholar_ctx(name)
                return self._json(scholar.ref_verify(
                    d, b.get("keys") or [], bool(b.get("force")), meta["file"]))
            if p == "/api/clean":
                d = project_dir(name)
                for ext in ("aux", "log", "out", "toc", "bbl", "blg", "fls", "fdb_latexmk", "nav", "snm", "vrb"):
                    for f in d.glob("*." + ext):
                        try:
                            f.unlink()
                        except Exception:
                            pass
                return self._json({"ok": True})
            if p == "/api/shutdown":
                self._json({"ok": True, "bye": "感谢使用 YangTex"})
                # os._exit 不会走 main() 的 finally，必须在这里清掉 runtime，
                # 否则下次启动会读到过期的 port/pid（Linux 启动器靠 pid 辨认新实例）。
                try:
                    RUNTIME_FILE.unlink(missing_ok=True)
                except Exception:
                    pass
                threading.Thread(target=lambda: (time.sleep(0.35), os._exit(0)), daemon=True).start()
                return
            return self._json({"error": "unknown endpoint " + p}, 404)
        except Exception as ex:
            return self._json({"ok": False, "error": str(ex),
                               "trace": traceback.format_exc()[-800:]}, 500)

    def do_DELETE(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if unquote(u.path) == "/api/projects":
            name = safe_slug((q.get("name") or [""])[0])
            d = project_dir(name)
            if not d.exists() or d == PROJECTS_DIR:
                return self._json({"ok": False, "error": "项目不存在"}, 404)
            # 仅删除本项目目录内的编译产物与主文件，不动个人文件
            for f in d.iterdir():
                try:
                    if f.is_file():
                        f.unlink()
                except Exception:
                    pass
            try:
                d.rmdir()
            except Exception:
                pass
            rest = list_projects()
            if rest:
                STATE["project"] = rest[0]["name"]
                save_state(STATE)
            return self._json({"ok": True, "projects": rest})
        return self._json({"error": "unknown endpoint"}, 404)


# --------------------------------------------------------------------------
# 启动：复用/重启已有实例 / 自动选端口 / 自动打开浏览器 / 无终端
# --------------------------------------------------------------------------

LAUNCH_LOG = Path.home() / ".yangtex-launch.log"


def log_launch(msg: str) -> None:
    """GUI 启动没有终端：把启动过程写进日志，方便排查「双击没反应」。"""
    try:
        with LAUNCH_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def _as_string(s: str) -> str:
    """把任意文本安全转成 AppleScript 字符串字面量。"""
    return json.dumps(str(s), ensure_ascii=False)


def _osascript(script: str) -> None:
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(["/usr/bin/osascript", "-e", script],
                       timeout=10, **CREATE_FLAGS)
    except Exception:
        pass


def mac_alert(title: str, message: str) -> None:
    """启动失败绝不能静默：LSUIElement 应用没有 Dock / 菜单栏，必须弹窗。"""
    _osascript(f'display alert {_as_string(title)} message {_as_string(message)} '
               f'buttons {{"好"}} default button "好"')


def mac_notify(title: str, message: str) -> None:
    """启动成功也给出可见反馈，避免用户以为「双击没反应」。"""
    _osascript(f'display notification {_as_string(message)} '
               f'with title {_as_string(title)}')


def open_in_browser(url: str) -> None:
    """后台 GUI 进程里 webbrowser.open 不可靠：macOS 直接用 /usr/bin/open。

    Linux 启动器用 nohup 分离服务后自己等端口并调 xdg-open（更可靠），
    此时带 YANGTEX_LAUNCHER_OPENS_BROWSER=1，后端让位，避免开出两个标签页。
    """
    if os.environ.get("YANGTEX_LAUNCHER_OPENS_BROWSER") == "1":
        log_launch("browser handled by launcher; backend skips opening " + url)
        return
    try:
        if sys.platform == "darwin":
            r = subprocess.run(["/usr/bin/open", url], timeout=10, **CREATE_FLAGS)
            log_launch(f"opened browser {url} (rc={r.returncode})")
        elif sys.platform.startswith("win"):
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            webbrowser.open(url)
    except Exception as ex:
        log_launch(f"browser open failed ({ex}); falling back to webbrowser")
        try:
            webbrowser.open(url)
        except Exception:
            pass


def local_opener():
    """本机回环请求必须绕过系统代理，否则 GUI 环境下会拿到 502。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def stop_existing(port: int) -> bool:
    """优雅关闭旧实例并等端口释放，让一次双击就能载入最新代码。"""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/shutdown",
            data=b"{}", method="POST",
            headers={"Content-Type": "application/json"})
        with local_opener().open(req, timeout=2) as resp:
            resp.read()
        log_launch(f"shutdown sent to port {port}")
    except Exception as ex:
        log_launch(f"shutdown request failed: {ex}")
    for _ in range(40):
        if port_free(port):
            log_launch(f"port {port} released")
            return True
        time.sleep(0.15)
    log_launch(f"WARNING: port {port} still busy")
    return False


def running_instance() -> tuple[int, int] | None:
    r = read_json(RUNTIME_FILE, {})
    try:
        port, pid = int(r["port"]), int(r["pid"])
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/health", method="GET")
        with local_opener().open(req, timeout=1.2) as resp:
            d = json.loads(resp.read().decode())
            if d.get("app") == APP_NAME:
                return port, pid
    except Exception:
        pass
    return None


def choose_port() -> int:
    cfg = read_json(CONFIG_FILE, {})
    for p in [int(cfg.get("port", DEFAULT_PORT))] + list(range(DEFAULT_PORT, DEFAULT_PORT + 30)):
        if port_free(p):
            return p
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    global STATE, ENGINES
    # 启动器传 --restart：先关旧实例再起新的，双击永远拿到最新代码。
    restart = "--restart" in sys.argv or os.environ.get("YANGTEX_RESTART") == "1"
    log_launch(f"=== launch === pid={os.getpid()} root={ROOT} "
               f"python={sys.version.split()[0]} restart={restart}")
    try:
        ensure_default_project()
        ENGINES = detect_engines()
        ensure_tex_path()
        STATE = load_state()

        old = running_instance()
        if old and not restart:
            url = f"http://127.0.0.1:{old[0]}/"
            open_in_browser(url)
            mac_notify("YangTex 已在运行", "已为你打开操作页面。")
            log_launch(f"reuse existing instance {url}")
            return 0
        if old:
            log_launch(f"restart: stopping old instance port={old[0]} pid={old[1]}")
            stop_existing(old[0])
            if not port_free(old[0]):
                mac_alert("YangTex 无法重启",
                          f"旧实例仍占用端口 {old[0]} · 详情见 {LAUNCH_LOG}")
                return 1

        port = choose_port()
        write_json(RUNTIME_FILE, {"port": port, "pid": os.getpid(),
                                  "started": time.strftime("%Y-%m-%d %H:%M:%S")})
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        srv.daemon_threads = True
        url = f"http://127.0.0.1:{port}/"
        threading.Timer(0.4, lambda: open_in_browser(url)).start()
        if old and restart:
            threading.Timer(1.2, lambda: mac_notify(
                "YangTex 已重新启动",
                "已载入最新代码，刷新浏览器页面即可继续使用。")).start()
        log_launch(f"serving {url}")
        try:
            srv.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                RUNTIME_FILE.unlink()
            except Exception:
                pass
        return 0
    except Exception:
        err = traceback.format_exc()
        log_launch("FATAL:\n" + err)
        mac_alert("YangTex 启动失败",
                  err.strip().splitlines()[-1][:180] + " · 详情见 " + str(LAUNCH_LOG))
        return 1


if __name__ == "__main__":
    sys.exit(main())
