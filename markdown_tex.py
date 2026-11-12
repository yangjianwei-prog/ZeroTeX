#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YangTex 内置 Markdown → LaTeX 转换器
====================================
零第三方依赖（仅 Python 标准库），不调用 pandoc，不需要 markdown.sty，
更不需要给 TeX 引擎开 -shell-escape。因此 Mac / Windows、TeX Live / MiKTeX
上都能「保证可运行」：编辑器里写的就是 Markdown 源，YangTex 把它同步生成
一份标准 main.tex 供 TeX 引擎编译，实时编译与 SyncTeX 双向同步照常可用。

行号映射
--------
md_to_latex() 的 info['linemap'] 给出「生成的 .tex 第 n 行 → 原始 .md 行号」，
0 表示这行是自动生成的结构（导言、环境边界、空行）。YangTex 后端用它把
SyncTeX / 编译日志里的 .tex 行号换算回编辑器里的 Markdown 行号。

支持的混排语法
--------------
- YAML 风格 front matter：title / author / date / class / engine / lang / packages
- `# ## ###` 标题、`**粗体**` `*斜体*` `` `代码` ``、链接、图片、水平线
- `- * +` 无序列表、`1.` 有序列表、`>` 引用、GFM 表格、``` 代码块
- `$...$` 行内数学与 `$$...$$` 陈列数学：原样保留 LaTeX
- `:::latex` … `:::` 原样 LaTeX 区：定理、证明、figure、tikzpicture 等直接写
"""
from __future__ import annotations

import re

__all__ = ["parse_front_matter", "md_body_to_latex", "md_to_latex",
           "md_fragment_to_latex", "md_engine_of"]

# LaTeX 里必须转义的字符；中文、中文标点不在此列，xelatex 可直接输出
_SPECIAL = {
    "\\": r"\textbackslash{}",
    "{": r"\{", "}": r"\}",
    "&": r"\&", "%": r"\%", "#": r"\#", "_": r"\_",
    "$": r"\$", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
    "<": r"\textless{}", ">": r"\textgreater{}", "|": r"\textbar{}",
}

BASE_PACKAGES = [
    "amsmath", "amssymb", "mathtools", "amsthm", "graphicx",
    "xcolor", "enumitem", "geometry", "hyperref",
]

_HEADINGS = ["\\section", "\\subsection", "\\subsubsection",
             "\\paragraph", "\\subparagraph"]


def tex_escape(s: str) -> str:
    return "".join(_SPECIAL.get(ch, ch) for ch in s)


def parse_front_matter(text: str) -> tuple[dict, str]:
    """极简 YAML front matter；不引第三方 yaml 库，只解析 key: value。"""
    meta: dict = {}
    body = text
    m = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.lstrip().startswith("#"):
                k, v = line.split(":", 1)
                meta[k.strip().lower()] = v.strip().strip('"').strip("'")
        body = text[m.end():]
    return meta, body


def _tex_inline(s: str) -> str:
    """行内元素：数学 / 代码 / 链接 / 图片先抽成哨兵，转义后再还原。"""
    holders: list[str] = []

    def hold(value: str) -> str:
        holders.append(value)
        return f"\x00{len(holders) - 1}\x00"

    def image(m: re.Match) -> str:
        alt, path = m.group(1), m.group(2).strip()
        opt = (m.group(3) or "").strip()
        label = re.sub(r"[^A-Za-z0-9]", "", path).lower()[:24] or "fig"
        # 文件名不能走 tex_escape：yt_pic.png 里的 _ 会被转成 \_，
        # graphicx 就找不到这个文件了。只去掉会破坏 LaTeX 参数的字符。
        safe_path = re.sub(r"[{}\\%#]", "", path).strip()
        # 可选宽度：![说明](图.png){w=80%} / {w=0.6\textwidth} / {w=6cm}
        width = "0.7\\textwidth"
        wm = re.search(r"\bw\s*=\s*([^\s}]+)", opt)
        if wm:
            v = wm.group(1)
            if v.endswith("%"):
                try:
                    width = f"{float(v[:-1]) / 100:.2f}\\textwidth"
                except ValueError:
                    width = v
            else:
                width = v
        # 必须保持单行：行内替换的结果会作为「一个输出行」记录行号映射，
        # 一旦含换行，linemap 长度就会与实际 .tex 行数错位。
        return hold(
            "\\begin{figure}[htbp] "
            "\\centering "
            f"\\includegraphics[width={width}]{{{safe_path}}} "
            f"\\caption{{{tex_escape(alt)}}} "
            f"\\label{{fig:{label}}} "
            "\\end{figure}")

    s = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)(?:\{(w[^}]*)\})?", image, s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
               lambda m: hold("\\href{" + tex_escape(m.group(2).strip()) + "}{"
                              + tex_escape(m.group(1)) + "}"), s)
    # 行内数学：不跨行、不含空内容，且不被反斜杠转义
    s = re.sub(r"(?<!\\)\$([^$\n]+?)\$", lambda m: hold("$" + m.group(1) + "$"), s)
    s = re.sub(r"`([^`\n]+)`",
               lambda m: hold("\\texttt{" + tex_escape(m.group(1)) + "}"), s)

    s = tex_escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", lambda m: "\\textbf{" + m.group(1) + "}", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)",
               lambda m: "\\textit{" + m.group(1) + "}", s)
    return re.sub("\x00(\\d+)\x00", lambda m: holders[int(m.group(1))], s)


def _split_md_row(line: str) -> list[str]:
    """按 | 分列，但保护 \\| 以及 $...$ 数学内部的竖线。"""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    cells, cur, in_math = [], [], False
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\":
            cur.append(c)
            if i + 1 < len(s):
                cur.append(s[i + 1])
                i += 1
            i += 1
            continue
        if c == "$":
            in_math = not in_math
            cur.append(c)
            i += 1
            continue
        if c == "|" and not in_math:
            cells.append("".join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def md_body_to_latex(text: str, line_map: list[int] | None = None,
                     md_offset: int = 0) -> str:
    """把 Markdown / 混排正文转成 LaTeX 片段（不含 documentclass）。

    传入 line_map 时，每个输出行都会追加一个「原始 Markdown 行号」(1-based)；
    0 表示这行是自动生成的结构（环境边界、空行）。md_offset 是 front matter
    占掉的行数，用来把正文内的相对行号还原成整份 .md 的绝对行号。
    """
    lines = text.splitlines()
    out: list[str] = []
    para: list[tuple[str, int]] = []
    list_kind = ""
    in_quote = False
    i = 0

    def emit(s: str = "", src: int = 0) -> None:
        out.append(s)
        if line_map is not None:
            line_map.append(src)

    def src(idx: int) -> int:
        return md_offset + idx + 1

    def flush_para() -> None:
        nonlocal para
        if para:
            emit(" ".join(_tex_inline(x) for x, _ in para), para[0][1])
            emit()
            para = []

    def close_list() -> None:
        nonlocal list_kind
        if list_kind:
            emit("\\end{" + list_kind + "}")
            emit()
            list_kind = ""

    def close_quote() -> None:
        nonlocal in_quote
        if in_quote:
            emit("\\end{quote}")
            emit()
            in_quote = False

    while i < len(lines):
        ln = lines[i].rstrip()
        st = ln.strip()
        cur = src(i)

        # ``` 代码块 → verbatim（无需 listings，跨平台最稳）
        if st.startswith("```"):
            flush_para(); close_list(); close_quote()
            start = i
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            emit("\\begin{verbatim}", src(start))
            for k, b in enumerate(buf):
                emit(b, src(start + 1 + k))
            emit("\\end{verbatim}")
            emit()
            continue

        # :::latex 原样区 → 用户写的定理 / 公式 / 图形直接放进文档
        if re.match(r"^:::(latex|tex)\b", st, re.I):
            flush_para(); close_list(); close_quote()
            start = i
            i += 1
            buf = []
            while i < len(lines) and lines[i].strip() != ":::":
                buf.append(lines[i]); i += 1
            i += 1
            for k, b in enumerate(buf):
                emit(b, src(start + 1 + k))
            emit()
            continue

        # $$ … $$ 陈列数学
        if st.startswith("$$"):
            flush_para(); close_list(); close_quote()
            start = i
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("$$"):
                buf.append(lines[i]); i += 1
            i += 1
            emit("\\[", src(start))
            for k, b in enumerate(buf):
                emit(b, src(start + 1 + k))
            emit("\\]", src(i - 1))
            emit()
            continue

        if not st:
            flush_para(); close_list(); close_quote()
            i += 1
            continue

        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", st):
            flush_para(); close_list(); close_quote()
            emit("\\par\\noindent\\rule{\\textwidth}{0.4pt}\\par", cur)
            emit()
            i += 1
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", st)
        if m:
            flush_para(); close_list(); close_quote()
            cmd = _HEADINGS[min(len(m.group(1)) - 1, len(_HEADINGS) - 1)]
            emit(cmd + "{" + _tex_inline(m.group(2).strip()) + "}", cur)
            emit()
            i += 1
            continue

        # GFM 表格（下一行是 |---|---| 形式的分隔行）
        if (st.startswith("|") and i + 1 < len(lines)
                and re.match(r"^\s*\|?[\s:|-]*-[\s:|-]*\|", lines[i + 1])):
            flush_para(); close_list(); close_quote()
            start = i
            header = _split_md_row(st)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append((_split_md_row(lines[i]), src(i)))
                i += 1
            ncol = max([len(header)] + [len(r) for r, _ in rows])
            emit("\\begin{center}", src(start))
            emit("\\begin{tabular}{" + "|".join(["l"] * ncol) + "}", src(start))
            emit("\\hline", src(start))
            emit(" & ".join(_tex_inline(c) for c in header) + " \\\\", src(start))
            emit("\\hline", src(start))
            for row, rline in rows:
                cells = [_tex_inline(c) for c in row]
                cells += [""] * (ncol - len(cells))
                emit(" & ".join(cells) + " \\\\", rline)
            emit("\\hline")
            emit("\\end{tabular}")
            emit("\\end{center}")
            emit()
            continue

        if st.startswith("> "):
            flush_para(); close_list()
            if not in_quote:
                emit("\\begin{quote}", cur)
                in_quote = True
            emit(_tex_inline(st[2:].strip()), cur)
            i += 1
            continue

        m = re.match(r"^\s*([-*+]|\d+[.)])\s+(.*)$", ln)
        if m:
            flush_para(); close_quote()
            kind = "enumerate" if re.match(r"\d", m.group(1)) else "itemize"
            if list_kind != kind:
                close_list()
                emit("\\begin{" + kind + "}", cur)
                list_kind = kind
            emit("  \\item " + _tex_inline(m.group(2).strip()), cur)
            i += 1
            continue

        close_list(); close_quote()
        para.append((st, cur))
        i += 1

    flush_para(); close_list(); close_quote()
    return "\n".join(out)


def md_engine_of(meta: dict) -> str:
    if meta.get("engine"):
        return meta["engine"]
    lang = meta.get("lang", "zh").lower()
    return "pdflatex" if lang in ("en", "english", "英文") else "xelatex"


def md_to_latex(text: str, source_name: str = "") -> tuple[str, dict]:
    """返回 (完整可编译 LaTeX, 元信息)。"""
    meta, body = parse_front_matter(text)
    lang = meta.get("lang", "zh").lower()
    cn = lang not in ("en", "english", "英文")
    cls = meta.get("class") or ("ctexart" if cn else "article")
    engine = md_engine_of(meta)

    pkgs = [p.strip() for p in (meta.get("packages") or "").split(",") if p.strip()]
    for p in BASE_PACKAGES:
        if p not in pkgs:
            pkgs.append(p)

    docopt = "UTF8,a4paper,11pt,fontset=fandol" if "ctex" in cls else "11pt,a4paper"
    thm = {"theorem": "定理", "lemma": "引理", "definition": "定义",
           "proposition": "命题", "corollary": "推论"} if cn else {
           "theorem": "Theorem", "lemma": "Lemma", "definition": "Definition",
           "proposition": "Proposition", "corollary": "Corollary"}

    def field(key: str, default: str) -> str:
        v = meta.get(key, default)
        return v if v.startswith("\\") else _tex_inline(v)

    head = [
        "% ==================================================================",
        "% YangTex · 编译产物，请勿直接编辑（改动会在下次保存时被覆盖）",
        (f"% 由 Markdown 源 {source_name} 自动生成" if source_name else "% 由 Markdown 源自动生成"),
        "% 请编辑同目录下的 main.md / main.mdtex：那才是主文档，",
        "% 用的是 Markdown 语法；本文件只交给 TeX 引擎编译。",
        "% ==================================================================",
        f"\\documentclass[{docopt}]{{{cls}}}",
    ]
    head += [f"\\usepackage{{{p}}}" for p in pkgs]
    head += [
        "\\geometry{margin=2.5cm}",
        "\\newtheorem{theorem}{" + thm["theorem"] + "}[section]",
        "\\newtheorem{lemma}[theorem]{" + thm["lemma"] + "}",
        "\\newtheorem{definition}[theorem]{" + thm["definition"] + "}",
        "\\newtheorem{proposition}[theorem]{" + thm["proposition"] + "}",
        "\\newtheorem{corollary}[theorem]{" + thm["corollary"] + "}",
    ]
    title = field("title", "未命名文档")
    head += [
        "\\title{" + title + "}",
        "\\author{" + field("author", "") + "}",
        "\\date{" + field("date", "\\today") + "}",
        "\\begin{document}",
        "\\maketitle",
        "",
    ]
    tail = ["", "\\end{document}", ""]
    # front matter 之后正文第一行在整份 .md 里的行号偏移
    consumed = len(text) - len(body)
    md_offset = text[:consumed].count("\n")
    body_map: list[int] = []
    body_lines = md_body_to_latex(body, body_map, md_offset).split("\n")
    while body_lines and body_lines[-1] == "":
        body_lines.pop()
        if body_map:
            body_map.pop()
    lines = list(head) + body_lines + list(tail)
    linemap = [0] * len(head) + body_map + [0] * len(tail)
    latex = "\n".join(lines)
    return latex, {"engine": engine, "class": cls, "lang": "中文" if cn else "英文",
                   "packages": pkgs, "title": meta.get("title", ""),
                   "linemap": linemap}


def md_fragment_to_latex(text: str) -> str:
    """供编辑器选区使用：只转正文片段，不包 documentclass。"""
    meta, body = parse_front_matter(text)
    return md_body_to_latex(body).strip()
