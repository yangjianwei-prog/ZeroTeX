#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YangTex — 学术写作工具层（零第三方依赖）
======================================
1. 编号精确索引：从 main.aux 的 \\newlabel / \\bibcite 读出「PDF 上印的编号」
   → 公式 / 文献条目的真实映射，不靠 OCR、不靠猜正则。
2. 参考文献管理：同时兼容外部 .bib 与源码内嵌 thebibliography / \\bibitem。
3. 引用检查：漏引、未定义引用、未被引用的文献、重复键、字段不全。
4. 真实性核验：CrossRef / Semantic Scholar 免费公开接口，离线优雅降级 + 本地缓存。
5. 投稿包导出：去注释（保护 \\% 与 verbatim / lstlisting / minted）、剔除辅助文件。

本模块只做纯数据处理，不碰 HTTP；由 YangTex.py 的 Handler 调用。
"""
from __future__ import annotations

import difflib
import hashlib
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# --------------------------------------------------------------------------
# 通用小工具
# --------------------------------------------------------------------------

def read_text(path: Path, default: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return default


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def norm(s: str) -> str:
    """标题 / 作者归一化，用于相似度比对。"""
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", str(s or "").lower()).strip()


def sim(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


# --------------------------------------------------------------------------
# 1. .aux 编号索引
# --------------------------------------------------------------------------
# LaTeX 每次编译都会把「最终印在纸上的编号」写进 .aux：
#   \newlabel{eq:main}{{1}{1}{Introduction}{equation.1}{}}
#   \bibcite{GT}{1}
# 这是唯一可靠的编号来源；hover 时用它把 (1) / [1] 反查到标签与文献键。
NEWLABEL_RE = re.compile(
    r"\\newlabel\{([^}]*)\}\{\{([^}]*)\}\{([^}]*)\}"
    r"(?:\{([^}]*)\})?(?:\{([^}]*)\})?")
BIBCITE_RE = re.compile(r"\\bibcite\{([^}]*)\}\{")
NUM_RE = re.compile(r"\d+(?:\.\d+)?[a-zA-Z]?")


def aux_balanced(text: str, start: int) -> str:
    r"""从 text[start] == '{' 起取配对花括号里的内容，支持嵌套。
    beamer 会把编号写成 \bibcite{Key}{\hyperlink {beamerbibKey}{1}}，
    旧的 \{([^}]*)\} 只能吃到 \hyperlink {beamerbibKey 这一段。"""
    if start >= len(text) or text[start] != "{":
        return ""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    return ""


def bib_number(raw: str) -> str:
    r"""只保留真正印在纸上的编号：普通样式是 1，beamer 是超链接里的 1。"""
    s = (raw or "").strip()
    inner = [x.strip() for x in re.findall(r"\{([^{}]*)\}", s)]
    nums = [x for x in inner if NUM_RE.fullmatch(x)]
    cand = nums[0] if nums else (inner[-1] if inner else s)
    return cand if NUM_RE.fullmatch(cand) else s


def parse_aux(text: str) -> tuple[dict, dict]:
    labels: dict = {}
    for m in NEWLABEL_RE.finditer(text or ""):
        key, num, page, cap, typ = (m.group(i) or "" for i in range(1, 6))
        labels[key] = {"num": num.strip(), "page": page.strip(),
                        "caption": cap.strip(), "type": typ.strip()}
    bibcite = {m.group(1).strip(): bib_number(aux_balanced(text or "", m.end() - 1))
               for m in BIBCITE_RE.finditer(text or "")}
    return labels, bibcite


# --------------------------------------------------------------------------
# 2. 公式 / 标签 / 引用命令的源码位置
# --------------------------------------------------------------------------
EQ_ENVS = (r"(?:equation|align|gather|multline|eqnarray|alignat|flalign|dmath|split)"
           r"\*?")
EQ_RE = re.compile(
    r"\\begin\{(?P<env>" + EQ_ENVS + r")\}(?P<body>.*?)\\end\{(?P=env)\}", re.S)
DISPLAY_RE = re.compile(r"\\\[(?P<body>.*?)\\\]", re.S)
LABEL_RE = re.compile(r"\\label\{([^}]*)\}")
CITE_RE = re.compile(
    r"\\(?P<cmd>cite|citep|citet|citeauthor|citeyear|citealp|citealt|"
    r"parencite|textcite|autocite|footcite|nocite|supercite|fullcite)\*?"
    r"(?:\[[^\]]*\])*\{(?P<keys>[^}]*)\}")
REF_RE = re.compile(
    r"\\(?P<cmd>eqref|ref|autoref|cref|Cref|cpageref|pageref|vref|nameref)\*?"
    r"(?:\[[^\]]*\])*\{(?P<keys>[^}]*)\}")


def _src_labels(tex: str) -> dict:
    out = {}
    for m in LABEL_RE.finditer(tex):
        out[m.group(1)] = {"line": line_of(tex, m.start()),
                           "pos": m.start(), "column": m.start() - (tex.rfind("\n", 0, m.start()) + 1) + 1}
    return out


def parse_equations(tex: str) -> dict:
    r"""label → 公式信息（源码片段 + 行号）。带 \label 的公式环境优先，
    其次 \[...\]；最后用 \label 附近 ±3 行兜底（标成 env=label，
    不代表它一定是公式，避免章节编号抢占公式编号）。"""
    out: dict = {}
    spans = [(m.group("env"), m.start(), m.end(), m.group(0))
             for m in EQ_RE.finditer(tex)]
    spans += [("display", m.start(), m.end(), m.group(0))
              for m in DISPLAY_RE.finditer(tex)]
    for env, st, en, raw in spans:
        matches = list(LABEL_RE.finditer(raw))
        snippet = raw.strip()
        if len(snippet) > 1400:
            snippet = snippet[:1400] + " …"
        if not matches:
            # 没写 \label 的公式照样会被 LaTeX 编号；用行号造一个内部键，
            # 这样 PDF 上的 (n) 依然有可悬停的目标（编辑器侧不会引用到它）。
            key = "eq@%d" % line_of(tex, st)
            out[key] = {"label": key, "env": env, "tex": snippet,
                        "line": line_of(tex, st), "synthetic": True}
            continue
        for lm in matches:
            key = lm.group(1)
            if key in out:
                continue
            out[key] = {"label": key, "env": env,
                        "tex": snippet, "line": line_of(tex, st + lm.start())}
    for key, info in _src_labels(tex).items():
        if key in out:
            continue
        lines = tex.splitlines()
        ln = info["line"]
        chunk = "\n".join(lines[max(0, ln - 3):min(len(lines), ln + 2)]).strip()
        out[key] = {"label": key, "env": "label", "tex": chunk[:1400],
                    "line": ln, "maybe_eq": False}
    return out


def _cite_keys(raw: str) -> list[str]:
    r"""拆 \cite{a,b} 的键。宏定义体里的 #1、\foo 之类不是真实引用键，
    否则文献面板会凭空多出「未定义引用 #1」。"""
    out = []
    for k in raw.split(","):
        k = k.strip()
        if not k or k.startswith("#") or k.startswith("\\") or " " in k:
            continue
        out.append(k)
    return out


def parse_commands(tex: str) -> tuple[list, list]:
    cites, refs = [], []
    for m in CITE_RE.finditer(tex):
        keys = _cite_keys(m.group("keys"))
        cites.append({"cmd": m.group("cmd"), "keys": keys,
                      "raw": m.group(0)[:200], "line": line_of(tex, m.start()),
                      "pos": m.start(), "end": m.end()})
    for m in REF_RE.finditer(tex):
        keys = _cite_keys(m.group("keys"))
        refs.append({"cmd": m.group("cmd"), "keys": keys,
                     "raw": m.group(0)[:200], "line": line_of(tex, m.start()),
                     "pos": m.start(), "end": m.end()})
    return cites, refs


# --------------------------------------------------------------------------
# 3. 参考文献：.bib 解析 / 内嵌 bibitem 解析
# --------------------------------------------------------------------------
BIB_HEAD_RE = re.compile(r"@([A-Za-z]+)\s*\{")
BIB_KEY_RE = re.compile(r"^\s*([^,\s]+)\s*,")
FIELD_RE = re.compile(r"^\s*([A-Za-z][\w-]*)\s*=\s*(.*)$", re.S)
BIBITEM_RE = re.compile(r"\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}")


def _split_top(s: str, sep: str = ",") -> list[str]:
    parts, start, depth, quoted = [], 0, 0, False
    for i, c in enumerate(s):
        if c == '"' and (i == 0 or s[i - 1] != "\\"):
            quoted = not quoted
        elif not quoted:
            if c == "{":
                depth += 1
            elif c == "}":
                depth = max(0, depth - 1)
            elif c == sep and depth == 0:
                parts.append(s[start:i])
                start = i + 1
    parts.append(s[start:])
    return parts


def _bib_value(v: str) -> str:
    v = v.strip().rstrip(",").strip()
    if len(v) >= 2 and ((v[0] == "{" and v[-1] == "}") or
                        (v[0] == '"' and v[-1] == '"')):
        v = v[1:-1]
    v = re.sub(r"\s+", " ", v).strip()
    return v


def parse_bib(text: str, filename: str = "references.bib") -> list[dict]:
    entries = []
    for m in BIB_HEAD_RE.finditer(text or ""):
        typ = m.group(1).lower()
        if typ in ("comment", "string", "preamble"):
            continue
        opening = m.end() - 1
        depth, i = 0, opening
        while i < len(text):
            c = text[i]
            if c == "{" and (i == 0 or text[i - 1] != "\\"):
                depth += 1
            elif c == "}" and (i == 0 or text[i - 1] != "\\"):
                depth -= 1
                if depth == 0:
                    break
            i += 1
        if i >= len(text):
            break
        body = text[opening + 1:i]
        km = BIB_KEY_RE.match(body)
        if not km:
            continue
        key = km.group(1).strip()
        fields = {}
        for part in _split_top(body[km.end():]):
            fm = FIELD_RE.match(part)
            if fm:
                fields[fm.group(1).lower()] = _bib_value(fm.group(2))
        entries.append({"key": key, "type": typ, "fields": fields,
                        "raw": text[m.start():i + 1].strip(),
                        "origin": "bib", "file": filename,
                        "line": line_of(text, m.start())})
    return entries


def _guess_fields(raw: str) -> dict:
    r = re.sub(r"\s+", " ", raw).strip()
    f: dict = {}
    em = re.search(r"\\(?:emph|textit|it)\{([^}]*)\}", r)
    if em:
        f["title"] = em.group(1)
    ym = re.search(r"\b(1[5-9]\d{2}|20\d{2})\b", r)
    if ym:
        f["year"] = ym.group(1)
    dm = re.search(r"\b10\.\d{4,9}/[^\s,;}\]]+", r)
    if dm:
        f["doi"] = dm.group(0).rstrip(".,;")
    um = re.search(r"https?://[^\s,;}\]]+", r)
    if um:
        f["url"] = um.group(0).rstrip(".,;")
    first = r.split(",")[0].strip()
    if first and len(first) < 140:
        f["author"] = first
    return f


def parse_embedded_bib(tex: str, filename: str = "main.tex") -> list[dict]:
    ms = list(BIBITEM_RE.finditer(tex or ""))
    out = []
    for idx, m in enumerate(ms):
        end = ms[idx + 1].start() if idx + 1 < len(ms) else len(tex)
        em = re.search(r"\\end\{thebibliography\}", tex[m.end():end])
        stop = m.end() + em.start() if em else end
        raw = tex[m.end():stop].strip()
        out.append({"key": m.group(1).strip(), "type": "misc",
                    "fields": _guess_fields(raw), "raw": raw,
                    "origin": "embedded", "file": filename,
                    "line": line_of(tex, m.start())})
    return out


def bib_state(d: Path, editor_file: str = "main.tex") -> dict:
    """汇总当前项目全部文献条目，并判定管理模式。"""
    tex = read_text(d / "main.tex")
    bib_files = sorted(d.glob("*.bib"), key=lambda p: p.name)
    entries: list[dict] = []
    for f in bib_files:
        entries.extend(parse_bib(read_text(f), f.name))
    embedded = parse_embedded_bib(tex)
    if bib_files:
        mode = "bib"
    elif embedded:
        mode = "embedded"
    else:
        mode = "none"
    # markdown / mixed 主源：编辑器里能改的是主源，而不是生成物 main.tex
    primary = read_text(d / editor_file) if editor_file != "main.tex" else tex
    embedded_in_primary = bool(BIBITEM_RE.search(primary))
    return {"ok": True, "mode": mode, "files": [f.name for f in bib_files],
            "entries": entries + embedded,
            "bib_entries": entries, "embedded": embedded,
            "embedded_in_primary": embedded_in_primary,
            "has_bibliography_cmd": bool(re.search(r"\\bibliography\s*\{", tex)),
            "editor_file": editor_file,
            "counts": {"bib": len(entries), "embedded": len(embedded)}}


def format_bibitem(e: dict) -> str:
    f = e.get("fields") or {}
    raw = (e.get("raw") or "").strip()
    if raw:
        return raw
    bits = [f.get("author", "").strip()]
    title = f.get("title", "").strip()
    if title:
        bits.append("\\emph{%s}" % title if "\\emph" not in title else title)
    for k in ("journal", "booktitle", "publisher", "volume", "number",
              "pages", "year", "doi", "url", "note"):
        v = str(f.get(k, "")).strip()
        if v:
            bits.append(v)
    text = ", ".join(b for b in bits if b).rstrip(".") + "."
    return text


def format_bib_entry(e: dict) -> str:
    typ = (e.get("type") or "misc").strip() or "misc"
    key = (e.get("key") or "").strip()
    f = e.get("fields") or {}
    order = ["author", "title", "journal", "booktitle", "publisher", "year",
             "volume", "number", "pages", "doi", "url", "eprint", "note"]
    lines = ["@%s{%s," % (typ, key)]
    for k in order:
        if f.get(k):
            lines.append("  %-10s = {%s}," % (k, str(f[k]).strip()))
    for k, v in f.items():
        if k not in order and v:
            lines.append("  %-10s = {%s}," % (k, str(v).strip()))
    lines.append("}")
    return "\n".join(lines)


def bib_save(d: Path, entries: list, mode: str, editor_file: str = "main.tex",
             bib_file: str = "references.bib", raw_bib: str | None = None) -> dict:
    """整表写回。前端每次改动都提交完整条目数组，避免并发编辑产生半截文件。"""
    entries = [e for e in entries if isinstance(e, dict) and str(e.get("key", "")).strip()]
    seen, clean = set(), []
    for e in entries:
        k = str(e["key"]).strip()
        if k in seen:
            continue
        seen.add(k)
        clean.append(e)
    if mode == "bib":
        target = d / Path(bib_file).name
        text = (raw_bib if raw_bib is not None
                else "\n\n".join(format_bib_item(e) for e in clean) + "\n")
        target.write_text(text, encoding="utf-8", newline="\n")
        return {"ok": True, "mode": "bib", "file": target.name,
                "count": len(clean), "note": "已写入 " + target.name}

    # 内嵌 thebibliography：优先改主编辑源，再改生成物，保证两边一致
    width = max(9, len(str(len(clean))))
    block = ("\\begin{thebibliography}{%s}\n" % width +
             "\n".join("\\bibitem{%s} %s" % (str(e["key"]).strip(),
                                            format_bibitem(e)) for e in clean) +
             "\n\\end{thebibliography}")
    pat = re.compile(r"\\begin\{thebibliography\}\{[^}]*\}.*?\\end\{thebibliography\}", re.S)
    changed = []
    for fn in dict.fromkeys([editor_file, "main.tex"]):
        f = d / fn
        if not f.is_file():
            continue
        src = f.read_text(encoding="utf-8", errors="replace")
        if pat.search(src):
            f.write_text(pat.sub(lambda _m: block, src, count=1),
                         encoding="utf-8", newline="\n")
            changed.append(fn)
    if not changed:
        return {"ok": False, "error": "源码里没有 thebibliography 环境，请先插入或改用 .bib 模式"}
    return {"ok": True, "mode": "embedded", "changed": changed,
            "count": len(clean), "note": "已更新内嵌文献表：" + "、".join(changed)}


def format_bib_item(e: dict) -> str:
    return format_bib_entry(e)


def bib_link(d: Path, editor_file: str, bib_file: str = "references") -> dict:
    r"""在 \end{document} 之前插入 \bibliography{...}（若尚未存在）。"""
    tex = read_text(d / "main.tex")
    if re.search(r"\\bibliography\s*\{", tex):
        return {"ok": True, "note": "已有 \\bibliography 命令"}
    if BIBITEM_RE.search(tex):
        return {"ok": False, "error": "源码已经用内嵌 thebibliography 管理文献，不能同时挂接 .bib"}
    for fn in dict.fromkeys([editor_file, "main.tex"]):
        f = d / fn
        if not f.is_file():
            continue
        src = f.read_text(encoding="utf-8", errors="replace")
        if re.search(r"\\bibliography\s*\{", src):
            continue
        # Markdown 主源必须包在 :::latex 原样区里，否则会被当成正文排版
        is_md = Path(fn).suffix.lower() in (".md", ".mdtex")
        # BibTeX 必须有 \bibliographystyle，否则 bibtex 直接报错「找不到样式文件」
        style = "" if re.search(r"\\bibliographystyle\s*\{", src) \
                else "\\bibliographystyle{plain}\n"
        if is_md:
            cmd = ("\n:::latex\n" + style + "\\bibliography{%s}\n:::\n" % bib_file)
        else:
            cmd = style + "\\bibliography{%s}\n" % bib_file
        mm = re.search(r"\\end\{document\}", src)
        new = src[:mm.start()] + cmd + src[mm.start():] if mm else src.rstrip() + "\n" + cmd
        f.write_text(new, encoding="utf-8", newline="\n")
    return {"ok": True,
            "note": "已挂接 \\bibliographystyle{plain} + \\bibliography{%s}，"
                    "请执行一次完整编译生成文献表" % bib_file}


# --------------------------------------------------------------------------
# 4. hover 编号索引
# --------------------------------------------------------------------------

def parse_bbl_numbers(d: Path) -> dict:
    """biblatex / BibTeX 生成的 main.bbl：\bibitem[标签]{key} 顺序就是印在纸上的编号。
    项目没跑 bibtex 时 aux 里没有 \bibcite，这一层能把「引用编号」补回来。"""
    seen = []
    for f in [d / "main.bbl"] + sorted(d.glob("*.bbl")):
        text = read_text(f)
        if not text:
            continue
        for i, m in enumerate(re.finditer(
                r"\\bibitem(?:\[([^\]]*)\])?\{([^}]*)\}", text)):
            label = (m.group(1) or "").strip()
            label = label.strip("[]() ") or str(i + 1)
            seen.append((m.group(2).strip(), label))
        if seen:
            break
    return {k: n for k, n in seen}


def parse_aux_citation_order(aux: str) -> list[str]:
    r"""numeric 样式按「首次引用顺序」编号：aux 里的 \citation / biblatex
    的 \abx@aux@cite 就是权威顺序；很多模板的 aux 没有 \bibcite 但有它。"""
    order: list[str] = []
    for m in re.finditer(r"\\(?:citation|abx@aux@cite|abx@aux@segm)\{([^}]*)\}", aux or ""):
        for k in m.group(1).split(","):
            k = k.strip()
            if k and k not in order and not k.isdigit():
                order.append(k)
    return order


def fallback_ref_numbers(d: Path, tex: str, aux: str,
                         entries: dict, cites: list) -> dict:
    """引用编号的四级兜底：.aux \bibcite → .bbl → aux 引用顺序
    → 源码 \bibitem / .bib 条目顺序。任何一层命中都能让 [1] 悬停生效。"""
    _, bibcite = parse_aux(aux)
    if bibcite:
        return dict(bibcite)
    bbl = parse_bbl_numbers(d)
    if bbl:
        return bbl
    order = parse_aux_citation_order(aux)
    if not order:
        for c in cites:
            for k in c.get("keys", []):
                if k not in order:
                    order.append(k)
    if order:
        return {k: str(i + 1) for i, k in enumerate(order)}
    keys = [m.group(1).strip() for m in BIBITEM_RE.finditer(tex)]
    if not keys:
        keys = [str(k) for k in entries]
    return {k: str(i + 1) for i, k in enumerate(keys)}


def fill_eq_numbers(eq_by_num: dict, eq_by_label: dict) -> None:
    r"""aux 缺 \newlabel（没标签 / 没完整编译 / \tag 编号）时，按源码中
    真实「会编号」的公式环境顺序补齐编号，保证每个公式都有 (n) 可悬停。
    \[...\]、equation*、align* 是不编号的，绝不能给它们分配编号，
    否则凭空多出的 (1) 会把后面真公式的编号整体推错。"""
    numbered = re.compile(
        r"^(?:equation|align|gather|multline|eqnarray|alignat|flalign|dmath|split)$")
    used = set(eq_by_num.keys())
    for key in sorted(eq_by_label,
                      key=lambda k: (eq_by_label[k].get("line") or 0)):
        e = eq_by_label[key]
        env = str(e.get("env") or "")
        # 章节 / 定理 / 图片的 \label 兜底项、以及不编号的数学环境都不参与
        if env in ("", "label", "display", "None") or env.endswith("*"):
            continue
        if not numbered.match(env):
            continue
        if e.get("num"):
            n = str(e["num"])
            if n not in used:
                used.add(n)
                eq_by_num[n] = e
            elif eq_by_num.get(n, {}).get("label") != key:
                # 同名编号被章节抢占时，公式优先
                if "equation" in str(e.get("type", "")).lower():
                    eq_by_num[n] = e
            continue
        n = 1
        while str(n) in used:
            n += 1
        used.add(str(n))
        e["num"] = str(n)
        e["num_inferred"] = True
        eq_by_num[str(n)] = e


def build_hover_index(d: Path, source_kind: str = "tex",
                      source_file: str = "main.tex",
                      map_line=None) -> dict:
    """编号 → 公式 / 文献条目的精确反查表。map_line 把 main.tex 行号换算成
    编辑器里看得见的行号（Markdown 主源时必需）。"""
    ml = map_line or (lambda n: n)
    tex = read_text(d / "main.tex")
    aux = read_text(d / "main.aux")
    labels, bibcite = parse_aux(aux)
    equations = parse_equations(tex)
    cites, refs = parse_commands(tex)
    state = bib_state(d, source_file)
    entries = {str(e["key"]): e for e in state["entries"]}
    src_labs = _src_labels(tex)

    def editor_line(n):
        try:
            return int(ml(int(n)))
        except Exception:
            return int(n)

    # 编号 → 公式。同一编号可能同时属于 section / theorem / equation
    # （AMS 项目里 sec:intro 与 eq:main 都印成 "1"），必须让真正的
    # equation. 类型优先，否则 hover (1) 会指到章节标题上去。
    eq_by_num: dict = {}
    eq_rank: dict = {}
    for key, info in labels.items():
        num = info.get("num", "")
        typ = info.get("type", "")
        tl = typ.lower()
        q = equations.get(key) or {}
        is_eq = ("equation" in tl or tl.startswith("h{equation") or
                 (q.get("env") not in (None, "label")) or
                 bool(re.match(r"^(eq|eqn|equation|formula)[:._-]", key, re.I)))
        if not num or not is_eq:
            continue
        rank = 3 if "equation" in tl or tl.startswith("h{equation") else (
            2 if q.get("env") not in (None, "label") else 1)
        if rank < eq_rank.get(num, 0):
            continue
        e = dict(q or {"label": key, "env": "label",
                       "tex": "(aux 有编号，但源码里未找到对应公式)",
                       "line": (src_labs.get(key) or {}).get("line", 1)})
        e.update({"label": key, "num": num, "type": typ or "equation",
                  "page": info.get("page", ""),
                  "caption": info.get("caption", ""),
                  "line": editor_line(e.get("line", 1))})
        eq_by_num[num] = e
        eq_rank[num] = rank

    # 公式本身也按 label 暴露给编辑器侧 hover
    eq_by_label = {}
    for key, e in equations.items():
        eq_by_label[key] = {**e, "line": editor_line(e.get("line", 1)),
                            "num": (labels.get(key) or {}).get("num", ""),
                            "page": (labels.get(key) or {}).get("page", ""),
                            "type": (labels.get(key) or {}).get("type", "")}

    # aux 里没有 \newlabel 时（没标签 / 未完整编译 / \tag 编号），
    # 按源码公式环境顺序补齐编号，保证 PDF 上的 (1) 一定有目标。
    fill_eq_numbers(eq_by_num, eq_by_label)

    # 编号 → 文献：四级兜底，aux 没有 \bibcite 也能反查 [1]
    ref_nums = fallback_ref_numbers(d, tex, aux, entries, cites)
    ref_by_num, ref_by_key = {}, {}

    def missing_ref(k):
        return {"key": k, "type": "misc", "fields": {},
                "raw": "（源码中未找到该条目，请检查引用键或文献表）",
                "origin": "missing", "file": "", "line": 1}

    for key, num in ref_nums.items():
        e = dict(entries.get(key) or missing_ref(key))
        e = {**e, "key": key, "num": num, "line": editor_line(e.get("line", 1))}
        ref_by_num.setdefault(num, e)
        ref_by_key[key] = e
    for key, e in entries.items():
        if key not in ref_by_key:
            ref_by_key[key] = {**e, "line": editor_line(e.get("line", 1)),
                               "num": ref_nums.get(key, "")}
    # 每个 \cite{key} 都必须能弹出卡片：条目缺失时也给一条可点击的提示
    for c in cites:
        for k in c.get("keys", []):
            if k not in ref_by_key:
                e = {**missing_ref(k), "num": ref_nums.get(k, ""),
                     "line": c["line"]}
                ref_by_key[k] = e
    # 每个 \eqref / \ref 的 key 同样要有可反查目标（可能是章节/定理标签）
    for r in refs:
        for k in r.get("keys", []):
            if k in eq_by_label:
                continue
            info = labels.get(k) or {}
            site = src_labs.get(k) or {}
            if site:
                lines = tex.splitlines()
                ln = site["line"]
                snippet = "\n".join(lines[max(0, ln - 2):min(len(lines), ln + 1)]).strip()
            else:
                snippet = "（源码中未找到 \\label{%s}，请检查标签拼写）" % k
            eq_by_label[k] = {
                "label": k, "env": "label", "maybe_eq": False,
                "tex": snippet[:800],
                "line": editor_line(site.get("line", 1)),
                "num": info.get("num", ""), "page": info.get("page", ""),
                "type": info.get("type", "")}
    for e in ref_by_key.values():
        e.setdefault("label", e.get("key", ""))

    return {
        "ok": True, "project": d.name, "source_kind": source_kind,
        "source_file": source_file, "has_aux": bool(aux.strip()),
        "aux_labels": len(labels), "aux_bibcites": len(bibcite),
        "num_source": "aux" if bibcite else ("bbl" if parse_bbl_numbers(d)
                                             else "inferred"),
        "labels": labels,
        "equations": eq_by_label, "eq_by_num": eq_by_num,
        "refs": ref_by_key, "ref_by_num": ref_by_num,
        "bib_mode": state["mode"], "bib_files": state["files"],
        "cites": [{**c, "line": editor_line(c["line"])} for c in cites],
        "ref_cmds": [{**r, "line": editor_line(r["line"])} for r in refs],
        "label_sites": {k: editor_line(v["line"]) for k, v in src_labs.items()},
    }


# --------------------------------------------------------------------------
# 5. 引用检查
# --------------------------------------------------------------------------

def ref_check(d: Path, source_file: str = "main.tex", map_line=None) -> dict:
    ml = map_line or (lambda n: n)
    tex = read_text(d / "main.tex")
    state = bib_state(d, source_file)
    entries = state["entries"]
    keys = [str(e["key"]) for e in entries]
    cites, refs = parse_commands(tex)
    labels, bibcite = parse_aux(read_text(d / "main.aux"))
    src_labs = _src_labels(tex)
    known_labels = set(labels) | set(src_labs)
    issues = []

    def add(kind, severity, key, msg, line=1, fix=""):
        try:
            line = int(ml(int(line)))
        except Exception:
            pass
        issues.append({"kind": kind, "severity": severity, "key": key,
                        "message": msg, "line": line, "fix": fix})

    cited = set()
    for c in cites:
        for k in c["keys"]:
            cited.add(k)
            if k not in keys and k not in bibcite:
                add("missing_cite", "error", k,
                    "引用了不存在的文献键 \\cite{%s}，PDF 里会显示 [?]" % k,
                    c["line"], "在文献面板中添加该键，或改正拼写")
    for r in refs:
        for k in r["keys"]:
            if k not in known_labels:
                add("missing_ref", "error", k,
                    "引用了未定义的标签 \\%s{%s}" % (r["cmd"], k),
                    r["line"], "检查 \\label{%s} 是否拼写一致" % k)
    for e in entries:
        k = str(e["key"])
        if k not in cited:
            add("uncited", "warn", k, "文献 %s 在正文中没有被引用" % k,
                e.get("line", 1), "不需要就从文献表中删除")
        f = e.get("fields") or {}
        miss = [x for x in ("author", "title", "year") if not str(f.get(x, "")).strip()]
        if miss:
            # 内嵌 bibitem 靠启发式猜字段，缺字段只作提示，避免误报
            add("incomplete", "info" if e.get("origin") == "embedded" else "warn",
                k, "文献 %s 缺少字段：%s" % (k, "、".join(miss)),
                e.get("line", 1), "补齐作者 / 标题 / 年份，核验真实性更准确")
    dup = {}
    for k in keys:
        dup[k] = dup.get(k, 0) + 1
    for k, n in dup.items():
        if n > 1:
            add("duplicate", "error", k, "文献键 %s 重复出现 %d 次" % (k, n),
                1, "合并或改名，保证每个键唯一")
    if cites and state["mode"] == "none":
        add("no_bibliography", "error", "", "正文有引用但项目里既没有 .bib 也没有 thebibliography",
            1, "在文献面板新建 references.bib 并挂接")
    if state["mode"] == "bib" and not state["has_bibliography_cmd"] and cites:
        add("not_linked", "warn", "", "已有 .bib 文件，但源码里没有 \\bibliography{...}",
            1, "点「挂接到源码」自动插入 \\bibliography{references}")
    if state["has_bibliography_cmd"] and not re.search(r"\\bibliographystyle\s*\{", tex):
        add("no_bibstyle", "warn", "", "有 \\bibliography 但缺 \\bibliographystyle，BibTeX 会报错",
            1, "在导言区补一行 \\bibliographystyle{plain}")
    if not labels and not bibcite:
        add("no_aux", "info", "", "还没有编译产物 main.aux，编号 / 引用关系以源码扫描结果为准",
            1, "点 ▶ 编译（或 ⌘/Ctrl + Enter 完整编译）生成 .aux")

    order = {"error": 0, "warn": 1, "info": 2}
    issues.sort(key=lambda x: (order.get(x["severity"], 3), x["line"]))
    summary = {"entries": len(entries), "cited": len(cited),
               "cites": sum(len(c["keys"]) for c in cites),
               "labels": len(known_labels),
               "errors": sum(1 for i in issues if i["severity"] == "error"),
               "warnings": sum(1 for i in issues if i["severity"] == "warn"),
               "infos": sum(1 for i in issues if i["severity"] == "info"),
               "issues": len(issues)}
    return {"ok": True, "summary": summary, "issues": issues,
            "entries": entries, "mode": state["mode"], "files": state["files"],
            "bibcite": bibcite, "labels": list(known_labels)}


# --------------------------------------------------------------------------
# 6. 文献真实性核验（CrossRef / Semantic Scholar，离线降级）
# --------------------------------------------------------------------------
VERIFY_CACHE = ".yangtex-refverify.json"
VERIFY_TTL = 7 * 24 * 3600
UA = "YangTex/1.0 (local LaTeX editor; bibliography verification)"


def _http_json(url: str, timeout: float = 6.0):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000).decode("utf-8", "replace"))


def _crossref(e: dict) -> dict | None:
    f = e.get("fields") or {}
    doi = str(f.get("doi", "")).strip()
    if doi:
        try:
            j = _http_json("https://api.crossref.org/works/" +
                           urllib.parse.quote(doi, safe=""))
            m = (j or {}).get("message") or {}
            title = (m.get("title") or [""])[0]
            return {"source": "CrossRef · DOI", "title": title,
                    "doi": m.get("DOI") or doi,
                    "year": str(((m.get("published") or {}).get("date-parts") or [[""]])[0][0] or ""),
                    "journal": ((m.get("container-title") or [""])[0]),
                    "score": 1.0}
        except Exception:
            pass
    q = " ".join(str(f.get(k, "")) for k in ("title", "author", "year")).strip()
    if len(norm(q)) < 8:
        return None
    url = ("https://api.crossref.org/works?rows=3&query.bibliographic=" +
           urllib.parse.quote(q[:300]))
    j = _http_json(url)
    items = ((j or {}).get("message") or {}).get("items") or []
    best, bs = None, 0.0
    for m in items:
        t = (m.get("title") or [""])[0]
        score = sim(f.get("title", ""), t) if f.get("title") else sim(q, t)
        if score > bs:
            best, bs = m, score
    if not best:
        return None
    t = (best.get("title") or [""])[0]
    return {"source": "CrossRef", "title": t, "doi": best.get("DOI", ""),
            "year": str(((best.get("published") or {}).get("date-parts") or [[""]])[0][0] or ""),
            "journal": ((best.get("container-title") or [""])[0]),
            "score": round(bs, 3)}


def _openalex(e: dict) -> dict | None:
    """OpenAlex 免费开放索引：书籍 / 老文献常比 CrossRef 全，且无需 Key。"""
    f = e.get("fields") or {}
    q = (str(f.get("title", "")) or " ".join(
        str(f.get(k, "")) for k in ("author", "year"))).strip()
    if len(norm(q)) < 8:
        return None
    url = ("https://api.openalex.org/works?per-page=3&search=" +
           urllib.parse.quote(q[:250]))
    j = _http_json(url)
    items = (j or {}).get("results") or []
    best, bs = None, 0.0
    for m in items:
        t = m.get("display_name") or m.get("title") or ""
        score = sim(f.get("title", ""), t) if f.get("title") else sim(q, t)
        if score > bs:
            best, bs = m, score
    if not best:
        return None
    return {"source": "OpenAlex",
            "title": best.get("display_name") or best.get("title") or "",
            "doi": (best.get("doi") or "").replace("https://doi.org/", ""),
            "year": str(best.get("publication_year") or ""),
            "journal": (((best.get("primary_location") or {}).get("source") or {}).get("display_name") or ""),
            "score": round(bs, 3)}


def _s2(e: dict) -> dict | None:
    f = e.get("fields") or {}
    q = " ".join(str(f.get(k, "")) for k in ("title", "author", "year")).strip()
    if len(norm(q)) < 8:
        return None
    url = ("https://api.semanticscholar.org/graph/v1/paper/search?limit=2"
           "&fields=title,year,externalIds,venue&query=" +
           urllib.parse.quote(q[:250]))
    j = _http_json(url)
    items = (j or {}).get("data") or []
    best, bs = None, 0.0
    for m in items:
        score = sim(f.get("title", ""), m.get("title", "")) if f.get("title") else sim(q, m.get("title", ""))
        if score > bs:
            best, bs = m, score
    if not best:
        return None
    ext = best.get("externalIds") or {}
    return {"source": "Semantic Scholar", "title": best.get("title", ""),
            "doi": ext.get("DOI", ""), "year": str(best.get("year") or ""),
            "journal": best.get("venue", ""), "score": round(bs, 3)}


def verify_one(e: dict, timeout: float = 6.0) -> dict:
    key = str(e.get("key", ""))
    f = e.get("fields") or {}
    probe = " ".join(str(f.get(k, "")) for k in ("title", "author", "year", "doi")).strip()
    if len(norm(probe)) < 8:
        return {"key": key, "status": "no_query",
                "message": "条目信息不足（至少需要标题或作者），无法在线核验"}
    found, err = [], ""
    for fn in (_crossref, _openalex, _s2):
        try:
            m = fn(e)
            if m:
                found.append(m)
                # DOI 精确命中或标题高度一致就够了，不必再打第二个接口
                if m["score"] >= 0.58 or bool(f.get("doi")):
                    break
        except urllib.error.HTTPError as ex:
            err = "HTTP %s" % ex.code
        except urllib.error.URLError as ex:
            err = str(getattr(ex, "reason", ex))[:80]
        except Exception as ex:
            err = str(ex)[:80]
    match = max(found, key=lambda x: x["score"]) if found else None
    if not match:
        has_net_error = bool(err)
        return {"key": key,
                "status": "offline" if has_net_error else "not_found",
                "message": ("网络不可用，未能访问 CrossRef / Semantic Scholar" if has_net_error
                            else "未在 CrossRef / Semantic Scholar 找到匹配记录"),
                "error": err}
    good = match["score"] >= 0.58 or bool(f.get("doi"))
    return {"key": key, "status": "verified" if good else "not_found",
            "message": ("已核实：%s" % match["source"]) if good else "相似度不足，请人工确认",
            **match, "error": err}


def ref_verify(d: Path, keys: list, force: bool = False,
              source_file: str = "main.tex") -> dict:
    state = bib_state(d, source_file)
    pool = {str(e["key"]): e for e in state["entries"]}
    want = [str(k) for k in (keys or []) if str(k) in pool][:12] or list(pool)[:12]
    cache_file = d / VERIFY_CACHE
    cache = {}
    try:
        cache = json.loads(cache_file.read_text(encoding="utf-8"))
    except Exception:
        pass
    results, pending = {}, []
    for k in want:
        e = pool[k]
        fp = hashlib.md5(("|".join(str((e.get("fields") or {}).get(x, ""))
                               for x in ("title", "author", "year", "doi")) +
                         str(e.get("raw", ""))[:200]).encode("utf-8")).hexdigest()[:10]
        hit = cache.get(k)
        if (not force and hit and hit.get("fp") == fp and
                time.time() - hit.get("at", 0) < VERIFY_TTL):
            results[k] = {**hit["result"], "cached": True}
        else:
            pending.append((k, e, fp))
    if pending:
        with ThreadPoolExecutor(max_workers=min(4, len(pending))) as ex:
            futs = {ex.submit(verify_one, e): (k, fp) for k, e, fp in pending}
            for fut in as_completed(futs):
                k, fp = futs[fut]
                try:
                    r = fut.result(timeout=9)
                except Exception as ex2:
                    r = {"key": k, "status": "offline", "message": "核验请求失败：" + str(ex2)[:80]}
                results[k] = r
                cache[k] = {"fp": fp, "at": time.time(), "result": r}
    try:
        cache_file.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    order = [k for k in want]
    return {"ok": True, "results": [results[k] for k in order if k in results],
            "total": len(order), "checked_now": len(pending),
            "summary": {"verified": sum(1 for r in results.values() if r.get("status") == "verified"),
                        "not_found": sum(1 for r in results.values() if r.get("status") == "not_found"),
                        "offline": sum(1 for r in results.values() if r.get("status") == "offline"),
                        "no_query": sum(1 for r in results.values() if r.get("status") == "no_query")}}


# --------------------------------------------------------------------------
# 7. 去注释投稿包
# --------------------------------------------------------------------------
VERBATIM_ENVS = {"verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim",
                 "lstlisting", "minted", "alltt", "comment", "filecontents",
                 "filecontents*", "sageblock", "pycode"}
SKIP_EXT = {".aux", ".log", ".out", ".toc", ".lof", ".lot", ".blg", ".fls",
            ".fdb_latexmk", ".synctex", ".synctex.gz", ".nav", ".snm", ".vrb",
            ".bcf", ".run.xml", ".dvi", ".xdv", ".fmt", ".pyc"}
SKIP_NAMES = {".ds_store", "thumbs.db", ".runtime.json", ".state.json",
              ".yangtex-source.json", "main.map.json", "compile.log",
              ".yangtex-refverify.json", ".fmt-key"}
TEXT_EXT = {".tex", ".bib", ".cls", ".sty", ".bst", ".clo", ".md", ".mdtex",
            ".txt", ".cfg", ".def", ".ldf", ".fd", ".map", ".enc"}
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".eps", ".pdf", ".svg",
           ".tif", ".tiff", ".bmp", ".ps", ".mps"}


def clean_source(text: str, kind: str = "tex", squeeze: bool = True) -> tuple[str, dict]:
    """去掉 % 注释但保持版面语义：
    · \\% 与 verbatim / lstlisting / minted 内的 % 原样保留
    · comment 环境整块删除（保留空行，不破坏行号）
    · Markdown 的 <!-- --> 注释一并去掉
    · 注释行留空行，连续空行最多留一行，源码干干净净
    """
    lines = text.splitlines()
    out, in_verb = [], None
    removed_lines = removed_chars = protected = 0
    for line in lines:
        mb = re.search(r"\\begin\{([^}]*)\}", line)
        me = re.search(r"\\end\{([^}]*)\}", line)
        if in_verb is None and mb and mb.group(1) in VERBATIM_ENVS:
            name = mb.group(1)
            drop = name == "comment" or name.startswith("filecontents")
            in_verb = None if (me and me.group(1) == name) else name
            if drop:
                # comment / filecontents 整块（含 \end{...}）都要从投稿包里消失；
                # 用空行占位，避免后续行号漂移。
                out.append("")
                removed_lines += 1
                continue
            out.append(line)
            protected += 1
            continue
        if in_verb is not None:
            drop = in_verb == "comment" or in_verb.startswith("filecontents")
            if drop:
                out.append("")
                removed_lines += 1
            else:
                out.append(line)
                protected += 1
            if me and me.group(1) == in_verb:
                in_verb = None
            continue
        if kind != "tex":
            line = re.sub(r"<!--.*?-->", "", line)
        i, cut = 0, -1
        while True:
            i = line.find("%", i)
            if i < 0:
                break
            j, bs = i - 1, 0
            while j >= 0 and line[j] == "\\":
                bs += 1
                j -= 1
            if bs % 2:
                i += 1
                continue
            cut = i
            break
        if cut >= 0:
            removed_chars += len(line) - cut
            if not line[:cut].strip():
                removed_lines += 1
            tail = line[:cut].rstrip()
            # 行尾 % 用于吃掉换行；去注释后把下一行接上会破坏布局，
            # 因此保留一个空位但不做拼接，交由 LaTeX 自己的空白规则处理。
            line = tail
        out.append(line)
    if squeeze:
        squeezed, blank = [], 0
        for ln in out:
            if not ln.strip():
                blank += 1
                if blank > 1:
                    continue
            else:
                blank = 0
            squeezed.append(ln)
        out = squeezed
    return "\n".join(out).rstrip() + "\n", {
        "removed_lines": removed_lines,
        "removed_chars": removed_chars,
        "protected_lines": protected,
        "lines_before": len(lines), "lines_after": len(out)}


def _include_file(p: Path, rel: str) -> bool:
    name, ext = p.name.lower(), p.suffix.lower()
    if name in SKIP_NAMES or name.startswith(".yangtex") or name.startswith("._"):
        return False
    if ext in SKIP_EXT or name.endswith(".synctex.gz"):
        return False
    if ext == ".pdf" and name != "main.pdf":
        return True
    if ext in TEXT_EXT or ext in IMG_EXT:
        return True
    # 未知小文件（期刊给的 .bst / 数据文件等）也带上，避免投稿时缺文件
    return p.stat().st_size < 2 * 1024 * 1024 and ext not in {".exe", ".dll", ".so"}


def submission_files(d: Path, source_file: str, opts: dict) -> tuple[list, dict]:
    strip = opts.get("strip_comments", True) is not False
    squeeze = opts.get("squeeze_blank", True) is not False
    include_pdf = opts.get("include_pdf", True) is not False
    files, stats = [], {}
    total = 0
    for root, dirs, names in os.walk(str(d)):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "__pycache__"]
        for nm in sorted(names):
            p = Path(root) / nm
            if not p.is_file() or not _include_file(p, str(p.relative_to(d))):
                continue
            # 「附带生成的 PDF」选项只控制 main.pdf；作为插图的其它 .pdf 仍要带上
            if nm.lower() == "main.pdf" and not include_pdf:
                continue
            rel = str(p.relative_to(d)).replace(os.sep, "/")
            try:
                raw = p.read_bytes()
            except Exception:
                continue
            if len(raw) > 40 * 1024 * 1024 or total + len(raw) > 90 * 1024 * 1024:
                continue
            data = raw
            if strip and p.suffix.lower() in TEXT_EXT:
                try:
                    cleaned, st = clean_source(raw.decode("utf-8", "replace"),
                                              "tex" if p.suffix.lower() not in
                                              (".md", ".mdtex") else "md", squeeze)
                    data = cleaned.encode("utf-8")
                    stats[rel] = st
                except Exception:
                    pass
            files.append((rel, data))
            total += len(data)
    return files, stats


def build_submission(d: Path, project: str, source_file: str,
                     opts: dict | None = None) -> tuple[bytes, dict]:
    opts = opts or {}
    files, stats = submission_files(d, source_file, opts)
    manifest = [
        "YangTex 投稿包 / Submission package",
        "项目：" + project,
        "生成时间：" + time.strftime("%Y-%m-%d %H:%M:%S"),
        "说明：源码已去除 % 注释（\\% 与 verbatim / lstlisting / minted 内的内容原样保留）；",
        "      已剔除 .aux/.log/.out/.synctex 等辅助文件；图片、类文件、.bib 与 PDF 一并打包。",
        "", "文件清单：",
    ]
    for rel, data in files:
        manifest.append("  %-52s %8d B" % (rel, len(data)))
    removed = sum(v.get("removed_chars", 0) for v in stats.values())
    removed_lines = sum(v.get("removed_lines", 0) for v in stats.values())
    manifest += ["", "共 %d 个文件；清除注释 %d 行 / %d 字符。" %
                 (len(files), removed_lines, removed), ""]
    files.insert(0, ("投稿说明.txt", "\n".join(manifest).encode("utf-8")))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in files:
            zi = zipfile.ZipInfo(rel, date_time=time.localtime()[:6])
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
    return buf.getvalue(), {"files": len(files),
                            "removed_lines": removed_lines,
                            "removed_chars": removed,
                            "cleaned": list(stats),
                            "size": len(buf.getvalue())}


def submission_preview(d: Path, project: str, source_file: str,
                        opts: dict | None = None) -> dict:
    files, stats = submission_files(d, source_file, opts or {})
    return {"ok": True, "project": project,
            "files": [{"name": rel, "size": len(data)} for rel, data in files],
            "total": len(files),
            "removed_lines": sum(v.get("removed_lines", 0) for v in stats.values()),
            "removed_chars": sum(v.get("removed_chars", 0) for v in stats.values()),
            "cleaned": list(stats)}
