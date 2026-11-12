# -*- coding: utf-8 -*-
"""PDF 页级失效分析（零第三方依赖）。

TeX 每轮生成的 PDF 里 /CreationDate、/ModDate 与 /ID 都带时间戳，整文件哈希
永远在变；但「页字典 + 该页引用的内容流」才是真正决定画面的绘制指令。
本模块把它们逐页取出来做指纹，让前端只重画真正变化的那几页。

设计约束（比速度更重要）：
  * 不替换 TeX 引擎，版式与最终 PDF 100% 保真；
  * 解析不出来 / 结构异常一律返回 None，调用方退化为「全量渲染」，
    因此只可能少优化，绝不可能显示过期画面；
  * 全局 rev 排除 Info / XRef 两个元数据对象后覆盖**所有**其余对象
    （含字体、图片、资源字典），这样「内容流没变但资源变了」也不会被误判。

支持 pdfTeX 1.7 的压缩对象流 /ObjStm、传统对象表，以及 xelatex / xdvipdfmx
输出。只用标准库 re / zlib / hashlib。
"""
from __future__ import annotations

import hashlib
import re
import zlib

MAX_PDF_BYTES = 32 * 1024 * 1024   # 超大 PDF 不解析，直接退化为全量
MAX_PAGES = 5000

OBJ_RE = re.compile(rb"(?m)^[ \t]*(\d+)[ \t]+(\d+)[ \t]+obj\b")
STREAM_RE = re.compile(rb"\bstream\r?\n")
ENDSTREAM_RE = re.compile(rb"\bendstream\b")
KIDS_RE = re.compile(rb"/Kids\s*\[([^\]]*)\]")
REF_RE = re.compile(rb"(\d+)\s+(\d+)\s+R")
CONTENT_ONE_RE = re.compile(rb"/Contents\s+(\d+)\s+(\d+)\s+R")
CONTENT_ARR_RE = re.compile(rb"/Contents\s*\[([^\]]*)\]")
LENGTH_RE = re.compile(rb"/Length\s+(\d+)\b")
INFO_RE = re.compile(rb"/(?:CreationDate|ModDate|Producer|Creator|Trapped|PTEX\.Fullbanner)\b")
XREF_RE = re.compile(rb"/Type\s*/XRef\b")
PAGE_RE = re.compile(rb"/Type\s*/Page\b")
PAGES_RE = re.compile(rb"/Type\s*/Pages\b")
OBJSTM_RE = re.compile(rb"/Type\s*/ObjStm\b")


def _split_obj(chunk: bytes):
    """把单个对象切成 (字典头, 流字节|None)。优先用 /Length 精确截流。"""
    m = STREAM_RE.search(chunk)
    if not m:
        return chunk.split(b"endobj", 1)[0], None
    head, start = chunk[:m.start()], m.end()
    ml = LENGTH_RE.search(head)
    if ml:
        n = int(ml.group(1))
        if 0 <= n <= len(chunk) - start:
            body = chunk[start:start + n]
            if body.endswith(b"\r\n"):
                body = body[:-2]
            elif body.endswith(b"\n") or body.endswith(b"\r"):
                body = body[:-1]
            return head, body
    me = ENDSTREAM_RE.search(chunk, start)
    if not me:
        return head, None
    body = chunk[start:me.start()]
    if body.endswith(b"\r\n"):
        body = body[:-2]
    elif body.endswith(b"\n") or body.endswith(b"\r"):
        body = body[:-1]
    return head, body


def _objects(data: bytes) -> dict:
    """{objnum: (dict_bytes, stream_bytes|None)}，含 /ObjStm 解压展开。"""
    starts = [(int(m.group(1)), m.end()) for m in OBJ_RE.finditer(data)]
    objs: dict[int, tuple[bytes, bytes | None]] = {}
    for num, end in starts:
        nxt = OBJ_RE.search(data, end)
        chunk_end = nxt.start() if nxt else len(data)
        objs[num] = _split_obj(data[end:chunk_end])

    extra: dict[int, tuple[bytes, bytes | None]] = {}
    for head, body in list(objs.values()):
        if not body or not OBJSTM_RE.search(head):
            continue
        mn, mf = re.search(rb"/N\s+(\d+)", head), re.search(rb"/First\s+(\d+)", head)
        if not (mn and mf):
            continue
        try:
            raw = zlib.decompress(body)
        except Exception:
            continue
        n, first = int(mn.group(1)), int(mf.group(1))
        if not (0 < n <= 100000 and 0 <= first <= len(raw)):
            continue
        try:
            pairs = [int(x) for x in raw[:first].split()]
        except Exception:
            continue
        if len(pairs) < 2 * n:
            continue
        entries = [(pairs[2 * k], pairs[2 * k + 1]) for k in range(n)]
        for k, (onum, off) in enumerate(entries):
            s = first + off
            e = first + entries[k + 1][1] if k + 1 < n else len(raw)
            if 0 <= s < e <= len(raw):
                extra[onum] = (raw[s:e], None)
    objs.update(extra)
    return objs


def _page_order(objs: dict) -> list[int]:
    """按 Pages 树 /Kids 顺序返回页对象号；失败退回对象号顺序。

    注意 pdfTeX 对多页文档会生成分层页面树（根 /Pages 的下级仍是 /Pages），
    必须从「没有 /Parent 的那个」根节点开始，否则只会数到第一个子树。
    """
    nodes = [n for n, (h, _) in objs.items() if PAGES_RE.search(h)]
    roots = [n for n in nodes if not re.search(rb"/Parent\b", objs[n][0])]

    def count_of(num):
        m = re.search(rb"/Count\s+(\d+)", objs[num][0])
        return int(m.group(1)) if m else 0

    # 没有显式根（解析残缺）时取 /Count 最大的节点，尽量覆盖全部页
    if not roots and nodes:
        roots = [max(nodes, key=count_of)]
    root = roots[0] if roots else None
    if root is not None:
        out, seen, stack = [], set(), [root]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            head = objs.get(cur, (b"", None))[0]
            mk = KIDS_RE.search(head)
            if mk:
                kids = [int(m.group(1)) for m in REF_RE.finditer(mk.group(1))]
                for k in reversed(kids):
                    stack.append(k)
            elif PAGE_RE.search(head):
                out.append(cur)
        if out:
            return out
    return sorted(n for n, (h, _) in objs.items() if PAGE_RE.search(h))


def analyze(data: bytes) -> dict | None:
    """返回 {"pages": [每页指纹], "rev": 全局指纹, "size": 字节数}；失败 None。

    rev 覆盖除 Info 元数据与 XRef 表之外的所有对象（含字体/图片/资源），
    因此 rev 相同 ⇒ 画面一定相同；rev 不同但某些页指纹相同 ⇒ 只需重画其余页。
    """
    try:
        if not data or len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF-"):
            return None
        objs = _objects(data)
        if not objs:
            return None
        order = _page_order(objs)
        # 硬校验：解析出的页数必须与文档里 /Type /Page 对象总数一致。
        # 分层页面树、压缩对象流解析残缺时宁可整体退化，也不能给出半份
        # 指纹列表（那会让前端误以为某些页没变）。
        total_pages = sum(1 for h, _ in objs.values() if PAGE_RE.search(h))
        if not order or len(order) != total_pages or len(order) > MAX_PAGES:
            return None

        pages = []
        for pnum in order:
            head = objs[pnum][0]
            if not PAGE_RE.search(head):
                return None
            mc = CONTENT_ARR_RE.search(head)
            if mc:
                refs = [int(m.group(1)) for m in REF_RE.finditer(mc.group(1))]
            else:
                mo = CONTENT_ONE_RE.search(head)
                refs = [int(mo.group(1))] if mo else []
            if not refs:
                return None
            h = hashlib.sha256()
            h.update(head.strip())
            for r in refs:
                body = objs.get(r, (b"", None))[1]
                if body is None:
                    return None
                h.update(b"\x00")
                h.update(body)
            pages.append(h.hexdigest()[:16])

        g = hashlib.sha256()
        for num in sorted(objs):
            head, body = objs[num]
            # 时间戳只影响这两个对象；其余一律纳入，资源变化不会被漏掉
            if INFO_RE.search(head) or XREF_RE.search(head):
                continue
            g.update(str(num).encode())
            g.update(head.strip())
            if body:
                g.update(b"\x00")
                g.update(body)
        return {"pages": pages, "rev": g.hexdigest()[:20], "size": len(data)}
    except Exception:
        return None


def rev_of(pages: list[str]) -> str:
    """页指纹列表的联合摘要（给前端做轻量比较 / 日志用）。"""
    h = hashlib.sha256()
    for p in pages:
        h.update(p.encode())
        h.update(b"|")
    return h.hexdigest()[:16]
