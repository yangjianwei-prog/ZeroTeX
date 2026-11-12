/* ==========================================================================
   YangTex — 前端逻辑
   编辑器 / 实时编译 / pdf.js 预览 / SyncTeX 双向逐行同步 / AI / 模板 / 项目
   ========================================================================== */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const S = {
  project: '', projects: [], templates: [], engines: {}, enginePaths: {},
  state: {}, engine: 'auto', auto: true, sync: true, theme: 'light',
  fontSize: 14, lineHeight: 24, wrap: false,
  pdfDoc: null, pageViews: [], zoom: 1.25, pdfVer: 0, curPage: 1,
  compiling: false, pendingCompile: false, pendingForce: false, issues: [], logText: '',
  aiHistory: [], aiBusy: false, aiCoolingUntil: 0, tpShown: [], lastLine: 1, ready: false,
  autoPkg: true, turbo: true, lastMode: '', lastEngine: '',
  // 连续编译：边打字边编译（默认开启）。typing 表示「最近还有输入」，
  // 停手 TYPING_IDLE 后补一轮正式编译；composing 用来跳过输入法组字期间的半成品。
  cont: true, typing: false, composing: false,
  // 实时编译流水线：内容版本 / 上次「成功编译且已刷新预览」的指纹 / 当前磁盘指纹
  docRev: 0, compiledHash: '', compiledProject: '', diskHash: '',
  // 准增量预览：上一次真正画到 canvas 上的 PDF 全局 rev 与逐页指纹
  renderedRev: '', renderedPages: [], renderedProject: '', lastIncr: '',
  env: {}, templatesCat: '全部', templatesQuery: '',
  // 主编辑源：tex = main.tex；markdown = main.md；mixed = main.mdtex
  sourceKind: 'tex', sourceFile: 'main.tex',
};

// 编译启动延迟。连续编译下输入后一帧（20ms）就开跑 TeX，不等「停手」；
// 这 20ms 只用来合并同一帧里的多次 input（含输入法组字），不是防抖。
// 关闭连续编译后退回旧的停手防抖：极速 140ms / 标准 280ms。
const CONT_KICK = 20, TYPING_IDLE = 260;
function liveDebounce() { return S.turbo ? 140 : 280; }
function compileDelay() { return (S.cont && !NO_CONT && S.auto) ? CONT_KICK : liveDebounce(); }
// 诊断开关：置 true 时回到旧「停手才编译」行为，用于同一份代码上做 A/B 对比
const NO_CONT = !!window.__YT_NO_CONTINUOUS;

// 源码指纹（FNV-1a）：内容自上次成功编译后未变就直接复用已有 PDF，
// 整轮 TeX 都不用跑。撤回 / 重做回到同一内容时尤其有效。
function contentHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

let saveTimer = null, compileTimer = null, syncTimer = null, toastTimer = null;
let typingTimer = null;

// 编译链路分段计时（诊断钩子）。默认关闭，只有页面脚本运行前设了
// window.__YT_PERF_ON 才记录；每个字段都是「距本轮 compileNow 起点的毫秒」。
// 用它能精确量到「预览首帧提交」而不是状态栏那个提前亮起的 ✓。
const PERF = window.__YT_PERF = { enabled: !!window.__YT_PERF_ON, rows: [], cur: null };
// 诊断开关：置 true 时强制走全量渲染，用于同一份代码上做 A/B 耗时对比
const NO_INCR = !!window.__YT_NO_INCR;
function pfMark(pf, key) {
  if (pf) pf[key] = +(performance.now() - pf.t0).toFixed(1);
}

// ------------------------------------------------------------------ 网络
async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('服务器返回了非 JSON 内容');
  return r.json();
}

function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function setStatus(kind, text) {
  const el = $('compileStatus');
  const cls = 'status-' + kind;
  // 状态文字长度会改变元素宽度，进而把底栏后半段整体推走（实测 107px）。
  // 相同状态不重复写 DOM；宽度本身由 CSS 固定。
  if (el.className === cls && el.textContent === text) return;
  el.className = cls;
  el.textContent = text;
  el.title = text;          // 固定宽度会截断长文案，悬停仍能看到完整状态
}

// 准增量预览徽标：底栏单独一列，固定宽度，不参与状态栏的宽度抖动
function setIncrBadge(mode, changed, total) {
  const el = $('incrBadge');
  if (!el) return;
  const txt = mode === 'reuse' ? '⚡ 复用预览'
    : (mode === 'pages' ? `⚡ 增量 ${changed}/${total}` : '');
  el.textContent = txt;
  el.className = 'incr-badge' + (txt ? ' show' : '') + (mode === 'reuse' ? ' reuse' : '');
  el.title = mode === 'reuse' ? '本轮 PDF 画面未变：跳过重新解析与全部重绘'
    : (mode === 'pages' ? `本轮只重画 ${changed} / ${total} 页，其余页复用已渲染画布` : '');
}

// ------------------------------------------------------------------ Logo
async function injectLogos() {
  try {
    const svg = await (await fetch('/logo.svg')).text();
    ['bootLogo', 'brandLogo', 'welcomeLogo', 'emptyLogo'].forEach(id => {
      const el = $(id); if (el) el.innerHTML = svg;
    });
  } catch (e) { /* 图标缺失不影响功能 */ }
}

// ------------------------------------------------------------------ 编辑器高亮
const HL_RE = /(%.*$)|(\\(?:begin|end)\s*\{[^}]*\})|(\\[A-Za-z@]+|\\[^\s])|(\$[^$]*\$)|([{}])|([&_^~#])/g;

function highlightLine(line) {
  if (!line) return '';
  HL_RE.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = HL_RE.exec(line)) !== null) {
    out += esc(line.slice(last, m.index));
    const cls = m[1] ? 'tk-comment' : m[2] ? 'tk-env' : m[3] ? 'tk-cmd'
      : m[4] ? 'tk-math' : m[5] ? 'tk-brace' : 'tk-special';
    out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
    if (m[0].length === 0) HL_RE.lastIndex++;
  }
  return out + esc(line.slice(last));
}

// Markdown 主源用另一套高亮：标题、列表、引用、粗体、链接/图片、数学、:::latex
const MD_HL_RE = /(^#{1,6}[^\n]*)|(^>[^\n]*)|(^\s*(?:[-*+]|\d+[.)])\s)|(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)|(!?\[[^\]]*\]\([^)]+\)(?:\{[^}]*\})?)|(\$\$|\$[^$\n]+\$)|(^:::.*$)/g;

function highlightMdLine(line) {
  if (!line) return '';
  if (/^\s*(title|author|date|class|engine|lang|packages)\s*:/.test(line)) {
    return '<span class="tk-cmd">' + esc(line) + '</span>';
  }
  MD_HL_RE.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = MD_HL_RE.exec(line)) !== null) {
    out += esc(line.slice(last, m.index));
    const cls = m[1] ? 'tk-env' : m[2] ? 'tk-comment' : m[3] ? 'tk-special'
      : m[4] ? 'tk-cmd' : m[5] ? 'tk-math' : m[6] ? 'tk-math' : 'tk-brace';
    out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
    if (m[0].length === 0) MD_HL_RE.lastIndex++;
  }
  return out + esc(line.slice(last));
}

function buildHighlight() {
  const lines = $('editor').value.split('\n');
  const fn = S.sourceKind === 'tex' ? highlightLine : highlightMdLine;
  return lines.map(fn).join('\n');
}

function renderHighlight() {
  const pre = $('highlight');
  let inner = pre.querySelector('.hl-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'hl-inner';
    pre.appendChild(inner);
  }
  inner.innerHTML = buildHighlight() || ' ';
  inner.style.transform = `translate(${-$('editor').scrollLeft}px, ${-$('editor').scrollTop}px)`;
  renderGutter(linesOf());
}

function linesOf() { return $('editor').value.split('\n'); }

function renderGutter(lines) {
  const g = $('gutterInner');
  const cur = cursorLine();
  let html = '';
  for (let i = 1; i <= lines.length; i++) {
    html += '<div class="' + (i === cur ? 'cur' : '') + '">' + i + '</div>';
  }
  g.innerHTML = html;
  g.style.transform = `translateY(${-$('editor').scrollTop}px)`;
}

function positionActiveLine() {
  const ed = $('editor');
  const top = 12 + (cursorLine() - 1) * S.lineHeight - ed.scrollTop;
  $('activeLine').style.top = top + 'px';
  $('activeLine').style.height = S.lineHeight + 'px';
}

function cursorLine() {
  const ed = $('editor');
  return ed.value.slice(0, ed.selectionStart).split('\n').length;
}
function cursorCol() {
  const ed = $('editor');
  const upto = ed.value.slice(0, ed.selectionStart);
  return upto.length - upto.lastIndexOf('\n');
}

function updateCursorInfo() {
  const lines = linesOf();
  $('cursorInfo').textContent = `行 ${cursorLine()}, 列 ${cursorCol()}`;
  $('docInfo').textContent = `${lines.length} 行 · ${$('editor').value.length} 字符`;
  positionActiveLine();
  const g = $('gutterInner');
  g.querySelectorAll('.cur').forEach(e => e.classList.remove('cur'));
  const cur = g.children[cursorLine() - 1];
  if (cur) cur.classList.add('cur');
}

function applyFont() {
  document.documentElement.style.setProperty('--fs', S.fontSize + 'px');
  S.lineHeight = Math.round(S.fontSize * 1.7);
  document.documentElement.style.setProperty('--lh', S.lineHeight + 'px');
  renderHighlight(); positionActiveLine();
  if (ENV_STATE.open) positionEnvHint();
}

function gotoLine(line, col = 1) {
  const ed = $('editor');
  const lines = linesOf();
  line = Math.max(1, Math.min(line, lines.length));
  let pos = 0;
  for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
  pos += Math.min(Math.max(0, col - 1), lines[line - 1].length);
  ed.focus();
  ed.setSelectionRange(pos, pos);
  const target = 12 + (line - 1) * S.lineHeight - ed.clientHeight / 2;
  ed.scrollTop = Math.max(0, target);
  // 立即同步视觉
  $('highlight').querySelector('.hl-inner').style.transform =
    `translate(${-ed.scrollLeft}px, ${-ed.scrollTop}px)`;
  $('gutterInner').style.transform = `translateY(${-ed.scrollTop}px)`;
  updateCursorInfo();
  flashEditorLine(line);
}

function flashEditorLine(line) {
  const al = $('activeLine');
  al.style.background = 'var(--gold-soft)';
  setTimeout(() => { al.style.background = ''; }, 850);
}

// ------------------------------------------------------------------ 保存 / 编译
// 主源可能是 main.tex / main.md / main.mdtex，界面随项目类型切换
function updateSourceUI() {
  const md = S.sourceKind !== 'tex';
  if ($('docName')) $('docName').textContent = S.sourceFile;
  if ($('docDot')) $('docDot').className = 'dot ' + (md ? 'dot-md' : 'dot-tex');
  const badge = $('srcBadge');
  if (badge) {
    badge.textContent = S.sourceKind === 'mixed' ? 'Markdown + LaTeX 混排' : 'Markdown 源';
    badge.classList.toggle('hidden', !md);
  }
  if ($('editor')) $('editor').placeholder = md
    ? '# 在这里写 Markdown …\n\n支持 # 标题、**粗体**、列表、表格、$行内公式$、$$ 陈列公式 $$ 与 :::latex 原样块'
    : '% 在这里写 LaTeX …';
  const conv = $('mdConvertBtn');
  if (conv) {
    conv.textContent = md ? '⟨TeX⟩ 查看' : 'MD→TeX';
    conv.title = md
      ? '查看由 Markdown 自动生成的 main.tex（只读，仅供核对；请编辑 Markdown 源）'
      : '把选中的 Markdown / 混排文本转成 LaTeX（内置转换器，无需 pandoc）';
  }
  if ($('insertImageBtn')) $('insertImageBtn').title = md
    ? '插入 Markdown 图片 ![说明](图片){w=80%}（也可直接把图片拖进窗口）'
    : '插入图片（也可直接把图片拖进窗口）';
}

async function saveDoc(quiet = true, kind = null) {
  const content = $('editor').value;
  const body = { project: S.project, content };
  // 套用模板时顺带切换主源类型：Markdown 模板落 main.md，TeX 模板落 main.tex
  if (kind) body.kind = kind;
  try {
    const r = await api('/api/doc', 'POST', body);
    if (kind && r && r.source_kind) {
      S.sourceKind = r.source_kind;
      S.sourceFile = r.source_file || S.sourceFile;
      updateSourceUI();
    }
    // 记录真正写到磁盘的内容：编译失败后磁盘上是「失败版」，
    // 不能仅凭编辑器指纹就认定可以跳过下一轮 TeX。
    S.diskHash = contentHash(content);
    $('saveHint').textContent = '已保存';
    if (!quiet) toast('已保存 ' + S.sourceFile);
  } catch (e) { $('saveHint').textContent = '保存失败'; }
}

// ------------------------------------------------------------------ 导言区宏包自动补全
// 规则：源码里出现了需要某个宏包才能编译的命令 / 环境时，自动把 \usepackage 补进导言区。
const PKG_RULES = [
  { re: /\\(includegraphics|graphicspath|rotatebox|resizebox|scalebox)\b/, pkgs: ['graphicx'] },
  { re: /\\begin\{(align|align\*|gather|gather\*|multline|multline\*|equation\*|split|aligned|gathered|alignedat|cases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}/, pkgs: ['amsmath'] },
  { re: /\\(mathbb|mathfrak|varnothing|nexists|complement|leqslant|geqslant|lesssim|gtrsim|nsubseteq)\b/, pkgs: ['amssymb'] },
  { re: /\\(newtheorem|theoremstyle|qed|qedsymbol)\b|\\begin\{proof\}/, pkgs: ['amsthm'] },
  { re: /\\(DeclareMathOperator|coloneqq)\b|\\begin\{(dcases|rcases|multlined)\}/, pkgs: ['mathtools'] },
  { re: /\\(bm|boldsymbol)\b/, pkgs: ['bm'] },
  { re: /\\(textcolor|definecolor|colorbox|fcolorbox|rowcolor|color)\b/, pkgs: ['xcolor'] },
  { re: /\\(toprule|midrule|bottomrule|cmidrule|addlinespace)\b/, pkgs: ['booktabs'] },
  { re: /\\multirow\b/, pkgs: ['multirow'] },
  { re: /\\(href|url|autoref|nameref|phantomsection)\b|\\hypersetup\b/, pkgs: ['hyperref'] },
  { re: /\\begin\{tabularx\}|\\tabularx\b/, pkgs: ['tabularx'] },
  { re: /\\begin\{longtable\}/, pkgs: ['longtable'] },
  { re: /\\begin\{tikzpicture\}|\\draw\b|\\node\b/, pkgs: ['tikz'] },
  { re: /\\begin\{axis\}/, pkgs: ['pgfplots'] },
  { re: /\\begin\{algorithm\}/, pkgs: ['algorithm'] },
  { re: /\\begin\{algorithmic\}|\\State\b/, pkgs: ['algpseudocode'] },
  { re: /\\(subcaption|subfloat)\b|\\begin\{subfigure\}/, pkgs: ['subcaption'] },
  { re: /\\(SI|si|num)\b/, pkgs: ['siunitx'] },
  { re: /\\(setmainfont|setsansfont|setmonofont|newfontfamily)\b/, pkgs: ['fontspec'] },
  { re: /\\(enquote|textquote)\b/, pkgs: ['csquotes'] },
  { re: /\\begin\{lstlisting\}|\\lstset\b|\\lstinputlisting\b/, pkgs: ['listings'] },
];
// 某些宏包自身会加载另一些，避免重复补入
const PKG_PROVIDES = { mathtools: ['amsmath'], pgfplots: ['tikz'] };

function stripTexComments(src) {
  return src.split('\n').map(line => {
    let out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') { out += c + (line[i + 1] || ''); i++; continue; }
      if (c === '%') break;
      out += c;
    }
    return out;
  }).join('\n');
}

function existingPackages(pre) {
  const have = new Set();
  const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(pre))) {
    m[1].split(',').forEach(p => { if (p.trim()) have.add(p.trim()); });
  }
  return have;
}

function docStartOf(src) {
  const m = /\\begin\s*\{document\}/.exec(src);
  return m ? m.index : -1;
}

function scanNeededPackages() {
  const ed = $('editor'), src = ed.value;
  const start = docStartOf(src);
  if (start < 0 || !/\\documentclass/.test(src)) return [];
  const clean = stripTexComments(src);
  const have = existingPackages(clean.slice(0, start));
  const beamer = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*beamer[^}]*\}/i.test(clean);
  const skip = new Set(beamer ? ['amsthm', 'hyperref'] : []);
  const need = new Set();
  for (const rule of PKG_RULES) {
    if (!rule.re.test(clean)) continue;
    for (const p of rule.pkgs) {
      if (!have.has(p) && !skip.has(p)) need.add(p);
      for (const extra of (PKG_PROVIDES[p] || [])) have.add(extra);
    }
  }
  // 若 mathtools 已补入，就不必再单独补它自带的 amsmath
  for (const p of [...need]) {
    for (const extra of (PKG_PROVIDES[p] || [])) need.delete(extra);
  }
  return [...need];
}

// 把缺失宏包插到 \begin{document} 之前；同步平移光标，避免打断输入
function insertPackages(pkgs) {
  if (!pkgs || !pkgs.length) return [];
  const ed = $('editor'), src = ed.value;
  const start = docStartOf(src);
  if (start < 0 || !/\\documentclass/.test(src)) return [];
  const clean = stripTexComments(src);
  const have = existingPackages(clean.slice(0, start));
  const beamer = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*beamer[^}]*\}/i.test(clean);
  const final = pkgs.filter(p => !have.has(p) && !(beamer && ['amsthm', 'hyperref'].includes(p)));
  if (!final.length) return [];
  const before = src.slice(0, start);
  const insert = (before.endsWith('\n') ? '' : '\n') +
    final.map(p => '\\usepackage{' + p + '}').join('\n') + '\n';
  const a = ed.selectionStart, b = ed.selectionEnd;
  ed.setRangeText(insert, start, start, 'end');
  const d = insert.length;
  ed.setSelectionRange(a >= start ? a + d : a, b >= start ? b + d : b);
  return final;
}

function autoPackages() {
  if (!S.autoPkg) return [];
  return insertPackages(scanNeededPackages());
}

// ------------------------------------------------------------------ \begin{ 环境联想
// 输入 \begin{ 立刻列出环境名；选中后「随即」插入配对的 \end{...}，
// 光标落在环境体内，可一次撤回，并顺带补齐该环境依赖的宏包。
const ENV_HINT_KEY = 'yangtex.envHint';       // 仅用于把旧版偏好迁移一次
const ENV_PREFS_DEFAULT = {
  hint: true,          // 顶栏「环境联想」总开关
  auto_close: true,    // 手打完 \begin{xxx} 后自动补 \end{xxx}
  math_wrap: true,     // 需要数学模式的环境自动包 \[...\]
  group: true,         // 联想列表按「最近 / 常用 / 分类」分组
  recent: [],          // 最近使用过的环境名（最多 12 个）
};
// 偏好与主题 / 引擎 / 自动编译一样落在 .state.json，换浏览器、换设备都保持一致。
let envPrefs = { ...ENV_PREFS_DEFAULT, recent: [] };
let envHintEnabled = true;                    // envPrefs.hint 的镜像，供 envContext() 快速读取

function syncEnvPrefUI() {
  envHintEnabled = envPrefs.hint;
  const t = $('envHintToggle');
  if (t) t.classList.toggle('on', envHintEnabled);
  [['prefAutoClose', 'auto_close'], ['prefMathWrap', 'math_wrap'],
   ['prefGroup', 'group']].forEach(([id, key]) => {
    const el = $(id);
    if (el) el.checked = envPrefs[key];
  });
}

function readEnvPrefs() {
  const p = (S.state && S.state.env_prefs) || null;
  envPrefs = {
    hint: p ? p.hint !== false : true,
    auto_close: p ? p.auto_close !== false : true,
    math_wrap: p ? p.math_wrap !== false : true,
    group: p ? p.group !== false : true,
    recent: p && Array.isArray(p.recent) ? p.recent.slice(0, 12) : [],
  };
  // 旧版本把开关存在 localStorage。迁移一次并清掉，避免两个来源互相打架。
  try {
    const old = localStorage.getItem(ENV_HINT_KEY);
    if (old !== null) {
      if (!p) envPrefs.hint = old !== '0';
      localStorage.removeItem(ENV_HINT_KEY);
      saveEnvPrefs();
    }
  } catch (e) {}
  syncEnvPrefUI();
}

function saveEnvPrefs() {
  S.state = S.state || {};
  S.state.env_prefs = { ...envPrefs, recent: envPrefs.recent.slice(0, 12) };
  api('/api/state', 'POST', { env_prefs: S.state.env_prefs }).catch(() => {});
}

function envRemember(n) {
  envPrefs.recent = [n, ...envPrefs.recent.filter(x => x !== n)].slice(0, 12);
  saveEnvPrefs();
}

// 本机缺少哪些宏包：由 /api/init 的 kpsewhich 探测结果提供，用于给真实提示
S.envPkgs = {};

// n=环境名 d=说明 c=分类 p=需要补入的宏包
const ENV_ITEMS = [
  { n:'equation',       d:'单行公式 · 自动编号',            c:'数学' },
  { n:'equation*',      d:'单行公式 · 无编号',              c:'数学', p:'amsmath' },
  { n:'align',          d:'多行对齐公式 · 自动编号',        c:'数学', p:'amsmath' },
  { n:'align*',         d:'多行对齐公式 · 无编号',          c:'数学', p:'amsmath' },
  { n:'gather',         d:'多行居中公式',                   c:'数学', p:'amsmath' },
  { n:'gather*',        d:'多行居中公式 · 无编号',          c:'数学', p:'amsmath' },
  { n:'multline',       d:'超长单行公式折行',               c:'数学', p:'amsmath' },
  { n:'multline*',      d:'超长公式折行 · 无编号',          c:'数学', p:'amsmath' },
  { n:'split',          d:'在 equation 内拆分多行',         c:'数学', p:'amsmath' },
  { n:'aligned',        d:'行内对齐块',                     c:'数学', p:'amsmath' },
  { n:'gathered',       d:'行内居中块',                     c:'数学', p:'amsmath' },
  { n:'alignedat',      d:'多列对齐',                       c:'数学', p:'amsmath' },
  { n:'flalign',        d:'两端撑满对齐',                   c:'数学', p:'amsmath' },
  { n:'cases',          d:'分段函数 / 分情况',              c:'数学', p:'amsmath' },
  { n:'dcases',         d:'displaystyle 分段',              c:'数学', p:'mathtools' },
  { n:'rcases',         d:'右花括号分段',                   c:'数学', p:'mathtools' },
  { n:'multlined',      d:'多行内折行',                     c:'数学', p:'mathtools' },
  { n:'array',          d:'数学模式阵列',                   c:'数学' },
  { n:'matrix',         d:'无括号矩阵',                     c:'数学', p:'amsmath' },
  { n:'pmatrix',        d:'圆括号矩阵',                     c:'数学', p:'amsmath' },
  { n:'bmatrix',        d:'方括号矩阵',                     c:'数学', p:'amsmath' },
  { n:'Bmatrix',        d:'花括号矩阵',                     c:'数学', p:'amsmath' },
  { n:'vmatrix',        d:'单竖线行列式',                   c:'数学', p:'amsmath' },
  { n:'Vmatrix',        d:'双竖线行列式',                   c:'数学', p:'amsmath' },
  { n:'smallmatrix',    d:'行内小矩阵',                     c:'数学', p:'amsmath' },
  { n:'math',           d:'行内数学（老式写法）',           c:'数学' },
  { n:'displaymath',    d:'陈列数学（老式写法）',           c:'数学' },
  { n:'eqnarray',       d:'多行公式（旧式，建议 align）',   c:'数学' },
  { n:'theorem',        d:'定理 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'lemma',          d:'引理 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'proposition',    d:'命题 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'corollary',      d:'推论 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'definition',     d:'定义 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'remark',         d:'注记 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'example',        d:'例子 · 需 \\newtheorem 定义',    c:'定理', p:'amsthm' },
  { n:'proof',          d:'证明（自动带证毕符号）',         c:'定理', p:'amsthm' },
  { n:'document',       d:'文档正文起点',                   c:'结构' },
  { n:'abstract',       d:'摘要',                           c:'结构' },
  { n:'appendix',       d:'附录',                           c:'结构' },
  { n:'thebibliography',d:'参考文献列表',                   c:'结构' },
  { n:'titlepage',      d:'标题页',                         c:'结构' },
  { n:'figure',         d:'浮动图片',                       c:'图表' },
  { n:'figure*',        d:'双栏通栏图片',                   c:'图表' },
  { n:'table',          d:'浮动表格',                       c:'图表' },
  { n:'table*',         d:'双栏通栏表格',                   c:'图表' },
  { n:'tabular',        d:'表格主体',                       c:'图表' },
  { n:'tabularx',       d:'自动宽度表格',                   c:'图表', p:'tabularx' },
  { n:'longtable',      d:'跨页长表格',                     c:'图表', p:'longtable' },
  { n:'subfigure',      d:'子图',                           c:'图表', p:'subcaption' },
  { n:'center',         d:'居中',                           c:'图表' },
  { n:'minipage',       d:'小页 / 并排块',                  c:'图表' },
  { n:'wrapfigure',     d:'文字环绕图片',                   c:'图表', p:'wrapfig' },
  { n:'itemize',        d:'无序列表',                       c:'列表' },
  { n:'enumerate',      d:'有序列表',                       c:'列表' },
  { n:'description',    d:'描述列表',                       c:'列表' },
  { n:'quote',          d:'引用段落',                       c:'文本' },
  { n:'quotation',      d:'多行引用',                       c:'文本' },
  { n:'verse',          d:'诗歌',                           c:'文本' },
  { n:'verbatim',       d:'原样输出',                       c:'文本' },
  { n:'lstlisting',     d:'代码清单',                       c:'文本', p:'listings' },
  { n:'flushleft',      d:'左对齐',                         c:'文本' },
  { n:'flushright',     d:'右对齐',                         c:'文本' },
  { n:'tikzpicture',    d:'TikZ 绘图',                      c:'绘图', p:'tikz' },
  { n:'axis',           d:'pgfplots 坐标轴',                c:'绘图', p:'pgfplots' },
  { n:'algorithm',      d:'算法浮动体',                     c:'算法', p:'algorithm' },
  { n:'algorithmic',    d:'算法伪代码',                     c:'算法', p:'algpseudocode' },
  { n:'frame',          d:'Beamer 帧',                      c:'幻灯' },
  { n:'columns',        d:'Beamer 分栏',                    c:'幻灯' },
  { n:'column',         d:'Beamer 单栏',                    c:'幻灯' },
  { n:'block',          d:'Beamer 区块',                    c:'幻灯' },
  { n:'picture',        d:'picture 绘图环境',               c:'绘图' },
];

// 实测结论（TeX Live 2026 / pdflatex，逐个真实编译）：下面这些环境自身不开启
// 数学模式，直接插进正文会报 Missing $ inserted 或 amsmath Error，必须用 \[...\] 包住。
const ENV_NEEDS_MATH = new Set([
  'split','aligned','gathered','alignedat','multlined','cases','dcases','rcases',
  'pmatrix','bmatrix','Bmatrix','vmatrix','Vmatrix','smallmatrix','matrix','array',
]);
// 反过来，这些环境自带数学模式；再包一层 \[...\] 会报 Bad math environment
// delimiter。所以「自动包裹」必须只针对上面那一组，绝不能一刀切。
const ENV_OWN_MATH = new Set([
  'equation','equation*','align','align*','gather','gather*','multline','multline*',
  'flalign','flalign*','alignat','eqnarray','eqnarray*','math','displaymath',
]);

// 常见环境：无前缀输入时置顶，减少翻找
const ENV_FREQUENT = [
  'equation','align','cases','matrix','figure','tabular','itemize','enumerate',
  'theorem','proof','tikzpicture','abstract',
];
const ENV_CAT_ORDER = ['数学','定理','图表','列表','文本','绘图','算法','结构','幻灯'];

// 外壳 / 文档类 / 依赖提示：插入前就把「会不会编译失败」说清楚，而不是等底栏报错。
// outer 是自动补的外层环境；cls 表示只能在特定文档类下用；tip / warn 给浮层徽标用。
const ENV_REQUIRES = {
  axis:        { outer:'tikzpicture', tip:'自动外包 tikzpicture' },
  subfigure:   { outer:'figure',      tip:'自动外包 figure + \\centering + \\caption' },
  column:      { outer:'columns',     cls:'beamer', tip:'自动外包 columns' },
  columns:     { cls:'beamer', warn:'仅 beamer 可用，且需放在 frame 内' },
  frame:       { cls:'beamer', warn:'仅 beamer 文档类才是真正的「帧」' },
  block:       { cls:'beamer', warn:'仅 beamer 可用' },
  split:       { tip:'通常置于 equation / align 内，此处用 \\[…\\] 包裹' },
  algorithmic: { tip:'建议放在 algorithm 浮动体内' },
  appendix:    { warn:'\\appendix 是命令而非环境，建议直接使用命令' },
  document:    { warn:'正文起点；通常文档里已有一个' },
  thebibliography:{ tip:'需配合 \\bibitem 使用' },
  algorithm:   { tip:'内部建议再放 algorithmic 环境' },
};

// 需要自动补外壳的环境：before 拼在 \begin{env} 之前，after 拼在 \end{env} 之后
const ENV_OUTER = {
  tikzpicture: { before:'\\begin{tikzpicture}\n',  after:'\n\\end{tikzpicture}' },
  figure:      { before:'\\begin{figure}\n  \\centering\n',
                 // 纯 ASCII：中文图题在 pdflatex 下会报 Unicode character not set up
                 after:'\n  \\caption{Caption}\n\\end{figure}' },
  columns:     { before:'\\begin{columns}\n',       after:'\n\\end{columns}' },
};

const ENV_STATE = { open:false, items:[], idx:0, from:0, to:0, prefix:'' };
let envClosePending = null;      // 手打 \begin{xxx} 后的自动闭合待处理标记
let envCloseTimer = 0;

// 空环境体在 LaTeX 里往往不能编译（equation/align 报 Missing $，
// itemize 报 missing \item，matrix 报 Missing $）。所以插入的不是空壳，
// 而是「最小可编译骨架」：[[...]] 里的文字会被选中，用户一输入即替换；
// 若一直不输入，骨架本身也能编译通过，不会刚选完就弹错误面板。
const ENV_MATH_EMPTY = new Set([
  'equation','equation*','align','align*','gather','gather*','multline','multline*',
  'flalign','alignat','alignedat','multlined','split','aligned','gathered',
  'cases','dcases','rcases','matrix','pmatrix','bmatrix','Bmatrix','vmatrix','Vmatrix',
  'smallmatrix','array','eqnarray','math','displaymath',
]);
const ENV_LIST = new Set(['itemize','enumerate','description']);
const ENV_THEOREM = new Set([
  'theorem','lemma','proposition','corollary','definition','remark','example',
]);
const ENV_LABELS_CN = {
  theorem:'定理', lemma:'引理', proposition:'命题', corollary:'推论',
  definition:'定义', remark:'注记', example:'例',
};
// 必填参数 / 专属骨架：arg 拼在 \begin{env} 后面，b 覆盖默认环境体
const ENV_SKEL = {
  tabular:         { arg:'{cc}',                b:'  [[a & b \\\\]]' },
  tabularx:        { arg:'{\\linewidth}{XX}',   b:'  [[a & b \\\\]]' },
  longtable:       { arg:'{cc}',                b:'  [[a & b \\\\]]' },
  array:           { arg:'{cc}' },
  alignedat:       { arg:'{2}' },
  minipage:        { arg:'{0.5\\textwidth}' },
  wrapfigure:      { arg:'{l}{0.4\\textwidth}' },
  picture:         { arg:'(100,100)' },
  thebibliography: { arg:'{9}',                 b:'  \\bibitem{key} [[]]' },
  column:          { arg:'{0.5\\textwidth}' },
  algorithmic:     {                            b:'  \\State [[]]' },
  description:     {                            b:'  \\item[Key] [[]]' },
  // 实测：subfigure 必须给宽度且位于浮动体内；axis 必须位于 tikzpicture 内。
  // 两者由 ENV_OUTER 自动补外壳，这里只负责参数与最小可编译内容。
  subfigure:       { arg:'{0.45\\textwidth}',   b:'  [[]]' },
  axis:            {                            b:'  [[\\addplot {x^2};]]' },
};

function envArg(e) { return (ENV_SKEL[e.n] && ENV_SKEL[e.n].arg) || ''; }
function envBody(e) {
  const sk = ENV_SKEL[e.n];
  if (sk && sk.b !== undefined) return sk.b;
  if (ENV_MATH_EMPTY.has(e.n)) return '  [[{}]]';
  if (ENV_LIST.has(e.n)) return '  \\item [[]]';
  return '  [[]]';                       // 空体本身可编译（figure / center / proof …）
}

// 中文文档判定：旧版只认 \documentclass{ctex} / \usepackage{ctex}，
// 对 ctexart / xeCJK / 正文里已经大量写中文（却没用 ctex 宏包）的情况会误判成英文。
// 定理标题跟着文档语言走，才不会出现「Theorem 1」夹在中文段落里。
function docIsChinese(src) {
  const start = docStartOf(src);
  const head = start > 0 ? src.slice(0, start) : src.slice(0, 1500);
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*ctex/i.test(head)) return true;
  if (/\\usepackage\s*(?:\[[^\]]*\])?\s*\{(?:ctex|ctexcap|xeCJK|luatexja|zhspacing)/i.test(head)) return true;
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{(?:ctexart|ctexrep|ctexbook|ctexbeamer)/i.test(head)) return true;
  const body = start > 0 ? src.slice(start) : src;
  const han = (body.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 8 || (han > 0 && /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*(?:article|report|book)/i.test(head)
                      && /[，。；：、（）“”—]/.test(body));
}

function docClassOf(src) {
  const m = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(src);
  return m ? m[1].trim().toLowerCase() : 'article';
}

// 判断光标处是否已经在数学模式里。逐字符扫描光标之前的源码：
// 记住未闭合的 equation/align/… 环境栈、\[…\]、\(…\)、$…$、$$…$$，
// 跳过注释与 \$ \\% 等转义。用于避免「已在 equation 内又包一层 \[…\]」。
function envMathState(src, pos) {
  const s = src.slice(0, pos);
  const start = docStartOf(src);
  const inPreamble = start < 0 || pos <= start;
  let dollar = false, ddollar = false, bracket = false, paren = false, owner = '';
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i], nx = s[i + 1];
    if (c === '\\') {
      if (nx === '[') { bracket = true; i++; continue; }
      if (nx === ']') { bracket = false; i++; continue; }
      if (nx === '(') { paren = true; i++; continue; }
      if (nx === ')') { paren = false; i++; continue; }
      if (nx === 'b') {
        const m = /^\\begin\s*\{([^}]*)\}/.exec(s.slice(i));
        if (m) { stack.push(m[1]); if (ENV_OWN_MATH.has(m[1])) owner = m[1];
                 i += m[0].length - 1; continue; }
      }
      if (nx === 'e') {
        const m = /^\\end\s*\{([^}]*)\}/.exec(s.slice(i));
        if (m) {
          stack.pop();
          if (ENV_OWN_MATH.has(m[1])) {
            owner = '';
            for (let k = stack.length - 1; k >= 0; k--)
              if (ENV_OWN_MATH.has(stack[k])) { owner = stack[k]; break; }
          }
          i += m[0].length - 1; continue;
        }
      }
      i++;                       // \$ \\ \% \{ etc. 不参与数学模式判定
      continue;
    }
    if (c === '%') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '$') {
      if (nx === '$') { ddollar = !ddollar; i++; }
      else if (!ddollar) dollar = !dollar;
      continue;
    }
  }
  return { inMath: dollar || ddollar || bracket || paren || !!owner,
           owner, inPreamble };
}

// 给浮层徽标 / 底部提示 / 插入后 toast 用的一组真实诊断
function envDiagnose(e, src) {
  const req = ENV_REQUIRES[e.n] || {};
  const notes = [], warns = [], actions = [];
  if (e.p && S.envPkgs[e.p] === false)
    warns.push(`本机未检测到 ${e.p} 宏包，编译可能失败`);
  if (req.cls === 'beamer' && !/beamer/.test(docClassOf(src)))
    warns.push(`当前文档类是 ${docClassOf(src)}；${e.n} 需要 beamer`);
  if (req.warn) warns.push(req.warn);
  if (ENV_NEEDS_MATH.has(e.n)) {
    const st = envMathState(src, $('editor').selectionStart);
    actions.push(st.inMath ? '已在数学模式内，直接插入'
                           : (envPrefs.math_wrap ? '自动用 \\[…\\] 包裹' : '需要数学模式'));
    if (!st.inMath && !envPrefs.math_wrap) warns.push('该环境必须处于数学模式');
  }
  if (req.outer) actions.push(req.tip || `自动外包 ${req.outer}`);
  if (req.tip && !req.outer) notes.push(req.tip);
  if (ENV_THEOREM.has(e.n)) notes.push('自动写 \\newtheorem 定义');
  if (e.p) notes.push('自动补 ' + e.p);
  return { badge: warns.length ? '!' : (actions.length ? 'ⓘ' : ''),
           notes, warns, actions, req };
}

// 定理类环境光有 amsthm 还不够，必须先在导言区 \newtheorem 定义。
// 这里按文档实际语言决定标题用中文还是英文，避免插入即报 undefined。
function ensureTheorem(name) {
  if (!ENV_THEOREM.has(name)) return '';
  const ed = $('editor'), src = ed.value;
  const start = docStartOf(src);
  if (start < 0 || !/\\documentclass/.test(src)) return '';
  const pre = src.slice(0, start);
  if (new RegExp('\\\\newtheorem\\s*(?:\\[[^\\]]*\\])?\\s*\\{' + name + '\\}').test(pre)) return '';
  const cn = docIsChinese(src);
  const label = cn ? (ENV_LABELS_CN[name] || name)
                   : name[0].toUpperCase() + name.slice(1);
  const ins = (pre.endsWith('\n') ? '' : '\n') + '\\newtheorem{' + name + '}{' + label + '}\n';
  const a = ed.selectionStart, b = ed.selectionEnd;
  ed.setRangeText(ins, start, start, 'end');
  const d = ins.length;
  ed.setSelectionRange(a >= start ? a + d : a, b >= start ? b + d : b);
  return ins.trim();
}

// 注释行里不应弹出联想。跳过转义的反斜杠，遇到裸 % 就说明在注释中。
function hasCommentBefore(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '%') return true;
  }
  return false;
}

function envContext() {
  const ed = $('editor');
  if (!envHintEnabled || !ed || document.activeElement !== ed) return null;
  const pos = ed.selectionStart;
  if (pos !== ed.selectionEnd) return null;              // 有选区时不打扰
  const before = ed.value.slice(0, pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = before.slice(lineStart);
  const at = line.lastIndexOf('\\begin{');
  if (at < 0) return null;
  if (hasCommentBefore(line.slice(0, at))) return null;
  const typed = line.slice(at + 7);                      // '\begin{' 长度 7
  if (!/^[A-Za-z@*]*$/.test(typed)) return null;         // 已输入 } 或空格就收起
  return { from: lineStart + at, to: pos, prefix: typed };
}

function envCandidates(prefix) {
  const q = prefix.toLowerCase();
  const src = $('editor').value;
  const hasDoc = /\\begin\s*\{document\}/.test(src);
  const pool = ENV_ITEMS.filter(e =>
    (!q || e.n.toLowerCase().includes(q)) && !(hasDoc && e.n === 'document'));
  const byName = new Map(pool.map(e => [e.n, e]));
  const sortMatch = (a, b) => {
    const A = a.n.toLowerCase(), B = b.n.toLowerCase();
    const sa = A.startsWith(q) ? 0 : 1, sb = B.startsWith(q) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ia = A.indexOf(q), ib = B.indexOf(q);
    if (ia !== ib) return ia - ib;
    return A.length - B.length || A.localeCompare(B);
  };
  // 正在敲环境名时，分组标题只会碍事：退回纯匹配度排序
  if (q) return pool.sort(sortMatch).map(e => ({ ...e, _g: '' }));
  if (!envPrefs.group) return pool.map(e => ({ ...e, _g: '' }));

  const used = new Set(), out = [];
  const push = (e, g) => { if (e && !used.has(e.n)) { used.add(e.n); out.push({ ...e, _g: g }); } };
  envPrefs.recent.map(n => byName.get(n)).filter(Boolean).slice(0, 5)
    .forEach(e => push(e, '最近使用'));
  ENV_FREQUENT.forEach(n => push(byName.get(n), '常用'));
  const cats = [...new Set(pool.map(e => e.c))].sort((a, b) => {
    const ia = ENV_CAT_ORDER.indexOf(a), ib = ENV_CAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  cats.forEach(c => pool.filter(e => e.c === c).forEach(e => push(e, c)));
  pool.forEach(e => push(e, e.c));
  return out;
}

// 镜面 div 量出光标在视口中的坐标：比「列号 × 字符宽」更可靠，
// 自动换行、中文、字号变化、横向滚动都能正确处理。
function caretCoords() {
  const ed = $('editor');
  const r = ed.getBoundingClientRect(), cs = getComputedStyle(ed);
  const m = document.createElement('div');
  ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight',
   'tabSize','textTransform','wordBreak','overflowWrap'].forEach(k => { m.style[k] = cs[k]; });
  m.style.position = 'absolute'; m.style.left = '-9999px'; m.style.top = '0';
  m.style.visibility = 'hidden'; m.style.boxSizing = 'border-box';
  m.style.width = ed.clientWidth + 'px';
  m.style.padding = cs.padding; m.style.border = cs.border;
  m.style.whiteSpace = cs.whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'pre';
  m.textContent = ed.value.slice(0, ed.selectionStart);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  m.appendChild(mark);
  document.body.appendChild(m);
  const mr = m.getBoundingClientRect(), sr = mark.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || S.lineHeight;
  const out = { x: r.left + (sr.left - mr.left) - ed.scrollLeft,
                y: r.top + (sr.top - mr.top) - ed.scrollTop + lh };
  m.remove();
  return out;
}

function renderEnvHint() {
  const list = $('envHintList'), items = ENV_STATE.items;
  $('envHintCount').textContent = items.length + ' 项';
  if (!items.length) {
    list.innerHTML = '<div class="env-hint-none">没有匹配的环境名 · 继续输入或按 Esc 取消</div>';
    updateEnvTip(null);
    return;
  }
  const src = $('editor').value;
  let html = '', lastG = null;
  items.forEach((e, i) => {
    if (e._g && e._g !== lastG) {
      html += `<div class="env-hint-group">${esc(e._g)}</div>`;
      lastG = e._g;
    }
    const d = envDiagnose(e, src);
    const tip = [...d.warns, ...d.actions, ...d.notes].join(' · ');
    html += `<div class="env-hint-item ${i === ENV_STATE.idx ? 'sel' : ''}" data-i="${i}">
       <span class="env-hint-name">${esc(e.n)}</span>
       <span class="env-hint-desc">${esc(e.d)}</span>
       ${d.badge ? `<span class="env-hint-badge ${d.warns.length ? 'warn' : ''}" title="${esc(tip)}">${d.badge}</span>` : ''}
       ${e.p ? `<span class="env-hint-pkg">+${esc(e.p)}</span>` : ''}
       <span class="env-hint-cat">${esc(e._g && e._g !== e.c ? e.c : '')}</span>
     </div>`;
  });
  list.innerHTML = html;
  const sel = list.querySelector('.env-hint-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
  updateEnvTip(items[ENV_STATE.idx] || null);
}

// 浮层底部随 ↑↓ 实时说明当前环境「插入后会发生什么 / 有什么前置条件」
function updateEnvTip(e) {
  const box = $('envHintTip');
  if (!box) return;
  if (!e) { box.innerHTML = '<span class="env-tip-muted">选中环境后自动补 \\end{…} 与所需宏包</span>'; return; }
  const d = envDiagnose(e, $('editor').value);
  const bits = [];
  if (d.warns.length) bits.push(`<span class="env-tip-warn">⚠ ${esc(d.warns.join('；'))}</span>`);
  const rest = [...d.actions, ...d.notes];
  if (rest.length) bits.push(`<span class="env-tip-info">ⓘ ${esc(rest.join(' · '))}</span>`);
  if (!bits.length) bits.push('<span class="env-tip-ok">✓ 插入即可编译，无需额外设置</span>');
  box.innerHTML = `<b>${esc(e.n)}</b> ${bits.join(' ')}`;
}

function positionEnvHint() {
  const box = $('envHint');
  const c = caretCoords();
  const w = box.offsetWidth || 404, h = box.offsetHeight || 280;
  const left = Math.max(8, Math.min(c.x, window.innerWidth - w - 10));
  let top = c.y + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, c.y - h - S.lineHeight - 4);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
}

function openEnvHint(ctx) {
  clearTimeout(compileTimer);        // 半成品源码先别编译
  ENV_STATE.open = true;
  ENV_STATE.items = envCandidates(ctx.prefix);
  ENV_STATE.idx = 0;
  ENV_STATE.from = ctx.from;
  ENV_STATE.to = ctx.to;
  ENV_STATE.prefix = ctx.prefix;
  const box = $('envHint');
  box.classList.remove('hidden');
  box.setAttribute('aria-hidden', 'false');
  renderEnvHint();
  positionEnvHint();
}

function closeEnvHint(resumeCompile = false) {
  if (!ENV_STATE.open) return;
  ENV_STATE.open = false;
  ENV_STATE.items = [];
  const box = $('envHint');
  box.classList.add('hidden');
  box.setAttribute('aria-hidden', 'true');
  // 手动打完环境名 / 关掉开关时，源码已可能变成完整状态，补一次自动编译。
  // Esc 主动取消或选中确认（后者自己会调 onEditorInput）则不重复调度。
  if (resumeCompile && S.auto) {
    clearTimeout(compileTimer);
    compileTimer = setTimeout(() => compileNow(false), compileDelay());
  }
}

function updateEnvHint() {
  const ctx = envContext();
  if (!ctx) { closeEnvHint(true); return; }
  if (ENV_STATE.open && ENV_STATE.prefix === ctx.prefix &&
      ENV_STATE.from === ctx.from && ENV_STATE.to === ctx.to) return;
  openEnvHint(ctx);
}

function envMove(step) {
  const n = ENV_STATE.items.length;
  if (!n) return;
  ENV_STATE.idx = (ENV_STATE.idx + step + n) % n;
  renderEnvHint();
}

// 生成一段「插入即可编译」的完整环境文本。所有入口（联想选中 / 手动闭合）共用，
// 保证自动包裹、外壳、骨架、宏包、撤回行为完全一致。
function buildEnvText(e, from, args) {
  const src = $('editor').value;
  const st = envMathState(src, from);
  const req = ENV_REQUIRES[e.n] || {};
  const outerKey = req.outer;
  const outer = outerKey ? ENV_OUTER[outerKey] : null;
  // 只对「实测必须包、且当前确实不在数学模式、且不在导言区」的环境包一层 \[…\]
  const wrapMath = ENV_NEEDS_MATH.has(e.n) && envPrefs.math_wrap
                   && !st.inMath && !st.inPreamble;
  const math = wrapMath ? { before: '\\[\n', after: '\n\\]' }
                        : { before: '', after: '' };
  const head = (outer ? outer.before : '') + math.before
             + '\\begin{' + e.n + '}' + (args != null ? args : envArg(e)) + '\n';
  const tail = '\n\\end{' + e.n + '}' + math.after
             + (outer ? outer.after : '') + '\n';
  let body = e.n === 'document' ? '[[]]' : envBody(e);
  // [[...]] 里的占位文字插入后被选中，用户直接输入即替换；
  // 没输入时它本身可编译，不会刚选完就弹出错误面板。
  const m = /\[\[([^\]]*)\]\]/.exec(body);
  let selA = -1, selB = -1;
  if (m) {
    body = body.slice(0, m.index) + m[1] + body.slice(m.index + m[0].length);
    selA = head.length + m.index;
    selB = selA + m[1].length;
  }
  return { text: head + body + tail, selA, selB, wrapMath, outer: outerKey, st };
}

function insertEnvironment(e, from, to, opts = {}) {
  const ed = $('editor');
  const built = buildEnvText(e, from, opts.args);
  let end = to;
  if (built.st.inMath) {
    // 数学模式内不允许空行。光标常停在 equation 里的独立空行上，
    // 若直接插入，环境末尾的 \n 会和原文换行叠成空行 → Missing $ inserted。
    // 这里吃掉插入点后紧邻的那一个空行，保持结果始终可编译。
    const m = /^\n[ \t]*(?=\n|\\end\{)/.exec(ed.value.slice(to));
    if (m) end += m[0].length;
  }
  closeEnvHint();
  ed.focus();
  ed.setRangeText(built.text, from, end, 'end');
  if (built.selA >= 0) ed.setSelectionRange(from + built.selA, from + built.selB);
  else ed.setSelectionRange(from + built.text.length, from + built.text.length);
  // 补宏包 → 定义定理环境 → 常规输入处理。前两步都会同步平移当前选区。
  const extra = e.p ? insertPackages([e.p]) : [];
  const theorem = ensureTheorem(e.n);
  onEditorInput();
  // 逐字输入 \begin{ 时已产生一个「半成品」合并快照。把它直接覆盖成最终内容，
  // 撤回一次就回到输入 \begin{ 之前，不必先退回半成品再按一次。
  if (undoIdx >= 0 && undoHist[undoIdx]) {
    undoHist[undoIdx] = undoSnap();
    undoLastMergeable = false;
    updateUndoButtons();
  } else {
    undoRecord();
  }
  envRemember(e.n);
  const d = envDiagnose(e, ed.value);
  const done = [];
  if (built.wrapMath) done.push('用 \\[…\\] 包裹');
  if (built.outer) done.push('外包 ' + built.outer);
  if (extra.length) done.push('补入 ' + extra.join(', '));
  if (theorem) done.push('定义定理环境');
  if (d.warns.length) toast('⚠ ' + d.warns.join('；'));
  else if (done.length) toast('已自动：' + done.join(' · '));
  return true;
}

function acceptEnvHint(i) {
  const e = ENV_STATE.items[i];
  if (!e) return false;
  return insertEnvironment(e, ENV_STATE.from, ENV_STATE.to);
}

// 手打 \begin{xxx} 也能自动补全：敲下 } 或换行即补 \end{xxx}。
// 带必填参数的环境（tabular{lcr} / minipage{...}）给 150ms 宽限期，
// 期间继续敲 { 就放弃这次闭合，改由换行时再补，不把参数吞掉。
function tryAutoCloseEnv(mode) {
  if (!envPrefs.auto_close || !envHintEnabled) return;
  const ed = $('editor');
  if (document.activeElement !== ed) return;
  const pos = ed.selectionStart;
  if (pos !== ed.selectionEnd) return;
  const before = ed.value.slice(0, pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  let line = before.slice(lineStart), beginLineStart = lineStart;
  if (mode === 'newline') {
    const prevEnd = before.lastIndexOf('\n', before.length - 2);
    if (prevEnd < 0) return;
    beginLineStart = prevEnd + 1;
    line = before.slice(beginLineStart, before.length - 1);
  }
  if (hasCommentBefore(line)) return;
  const m = /\\begin\s*\{([A-Za-z@*]+)\}((?:\{[^}]*\})*)\s*$/.exec(line);
  if (!m) return;
  const name = m[1], args = m[2] || '';
  if (/\\end\s*\{/.test(line)) return;
  // 已经配对（例如在已有环境里改名字）就别再补一个 \end{}
  const src = ed.value, escName = name.replace(/[*]/g, '\\*');
  const begins = (src.match(new RegExp('\\\\begin\\s*\\{' + escName + '\\}', 'g')) || []).length;
  const ends = (src.match(new RegExp('\\\\end\\s*\\{' + escName + '\\}', 'g')) || []).length;
  if (ends >= begins) return;
  const beginStart = beginLineStart + m.index;
  // 只替换 \begin{...}{args} 这一段，不清掉用户随后输入的正文或换行
  const replaceTo = beginStart + m[0].length;
  const finish = () => {
    const now = $('editor');
    if (document.activeElement !== now) return;
    clearTimeout(envCloseTimer);       // 换行 / 参数闭合已处理掉，撤掉等待中的宽限任务
    const e = ENV_ITEMS.find(x => x.n === name) ||
              { n:name, d:'自定义环境', c:'自定义', p:'' };
    insertEnvironment(e, beginStart, replaceTo, { args: args || envArg(e) });
  };
  if (mode === 'brace' && !args) {
    // 环境名的 } 刚敲下：给 tabular{lcr} / minipage{...} 一点输入参数的时间。
    // 若期间开始输入 {，就交给参数末尾的 } 或换行再闭合，不把参数吞掉。
    clearTimeout(envCloseTimer);
    envCloseTimer = setTimeout(() => {
      const now = $('editor');
      const cur = now.value.slice(0, now.selectionStart);
      const lineNow = cur.slice(cur.lastIndexOf('\n') + 1);
      if (/\\begin\s*\{[A-Za-z@*]+\}\s*\{/.test(lineNow)) return;
      finish();
    }, 180);
  } else finish();
}

// ------------------------------------------------------------------ 图片拖入
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|pdf|eps)$/i;
const IMG_WIDTH_KEY = 'yangtex.imgWidth';

// w 为纯数字时按 \textwidth 的比例；也可直接给 6cm / 0.6\linewidth / 240pt；空串=原始尺寸
function imageLine(file, w) {
  const opt = String(w == null ? '' : w).trim();
  if (!opt) return `  \\includegraphics{${file}}`;
  const val = /^\d*\.?\d+$/.test(opt) ? opt + '\\textwidth' : opt;
  return `  \\includegraphics[width=${val}]{${file}}`;
}

// Markdown 主源里的图片：标准 ![]() 语法 + 可选的 {w=80%} 宽度标记，
// 转换器会自动生成居中 figure、caption 与 \label{fig:...}。
function mdImageLine(file, w) {
  const opt = String(w == null ? '' : w).trim();
  const stem = file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_ -]/g, '_') || 'figure';
  const width = !opt ? ''
    : (/^\d*\.?\d+$/.test(opt) ? Math.round(parseFloat(opt) * 100) + '%' : opt);
  return `![Figure: ${stem}](${file})` + (width ? `{w=${width}}` : '');
}

function savedImgWidth() {
  try {
    const v = localStorage.getItem(IMG_WIDTH_KEY);
    return v === null ? '0.8' : v;
  } catch (e) { return '0.8'; }
}

function figureSnippet(file, w) {
  const stem = file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'figure';
  // caption 只留 ASCII 字母数字与空格，避免 _ % # 等在任何引擎下报错
  const caption = stem.replace(/[^A-Za-z0-9 ]+/g, ' ').trim() || 'figure';
  return {
    stem,
    code: '\n\\begin{figure}[htbp]\n  \\centering\n' +
      imageLine(file, w) + '\n' +
      `  \\caption{Figure: ${caption}}\n  \\label{fig:${stem}}\n` +
      '\\end{figure}\n',
  };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

// 服务重启后 UI 需要几秒初始化（含首次编译），拖图可能早于 init 完成
async function waitForReady() {
  for (let i = 0; i < 80 && !S.ready; i++) {
    await new Promise(r => setTimeout(r, 150));
  }
  return !!S.ready;
}

let IMG_CTX = null, imgHideTimer = null;

function markImgPreset(w) {
  document.querySelectorAll('#imgSizePresets button').forEach(b => {
    b.classList.toggle('on', String(b.dataset.w || '') === String(w || ''));
  });
}

function hideImageSize() {
  const panel = $('imgSizePanel');
  panel.classList.add('hidden');
  panel.setAttribute('aria-hidden', 'true');
}

function showImageSize(w) {
  const panel = $('imgSizePanel');
  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
  markImgPreset(w);
  $('imgSizeTip').textContent = '改动会立即写入源码并重新编译';
  $('imgSizeTip').classList.remove('warn');
  clearTimeout(imgHideTimer);
  imgHideTimer = setTimeout(hideImageSize, 10000);
}

// 就地替换刚插入图片的 width 参数；不改动用户其它内容
function applyImageWidth(raw) {
  const tip = $('imgSizeTip');
  if (!IMG_CTX) {
    tip.textContent = '请先拖入或选择一张图片';
    tip.classList.add('warn');
    return;
  }
  const w = String(raw == null ? '' : raw).trim();
  const ed = $('editor'), src = ed.value;
  const old = IMG_CTX.line, idx = src.indexOf(old);
  if (idx < 0) {
    tip.textContent = '未找到刚插入的图片行（可能已被手动修改），请直接改源码里的 width';
    tip.classList.add('warn');
    return;
  }
  const next = IMG_CTX.md ? mdImageLine(IMG_CTX.file, w) : imageLine(IMG_CTX.file, w);
  if (next === old) { markImgPreset(w); return; }
  const a = ed.selectionStart, b = ed.selectionEnd;
  ed.setRangeText(next, idx, idx + old.length, 'end');
  const d = next.length - old.length;
  ed.setSelectionRange(a > idx ? a + d : a, b > idx ? b + d : b);
  IMG_CTX.line = next;
  try { localStorage.setItem(IMG_WIDTH_KEY, w); } catch (e) { /* 隐私模式 */ }
  markImgPreset(w);
  tip.textContent = '已设为 ' + (w ? (/^\d*\.?\d+$/.test(w) ? w + '\\textwidth' : w) : '原始尺寸');
  tip.classList.remove('warn');
  clearTimeout(saveTimer);
  onEditorInput();          // 更新高亮并排期编译
  undoRecord();             // 尺寸调整作为独立可撤回的一步
  saveDoc();                // 立即写盘，缩小被其它标签页覆盖的窗口
  clearTimeout(imgHideTimer);
  imgHideTimer = setTimeout(hideImageSize, 4500);
}

async function addImageFile(file) {
  if (!IMAGE_EXT.test(file.name)) {
    toast('仅支持 PNG / JPG / PDF / EPS / GIF / WEBP 图片');
    return false;
  }
  if (!(await waitForReady())) {
    toast('YangTex 正在启动，请等页面出现后再拖入图片', 4000);
    return false;
  }
  const dataUrl = await readFileAsDataURL(file);
  let r;
  try {
    r = await api('/api/upload-image', 'POST', {
      project: S.project, filename: file.name, data: dataUrl,
    });
  } catch (e) {
    toast('图片上传失败：请重启 YangTex 后再试（' + e.message + '）', 4200);
    return false;
  }
  if (!r || r.ok !== true) {
    const why = r && r.error ? '（' + r.error + '）' : '';
    toast('图片保存失败，请重启 YangTex 后重试' + why, 4200);
    return false;
  }

  // Markdown 主源：插入标准 Markdown 图片语法即可，graphicx / figure /
  // caption / label 全部由转换器生成，不用往 .md 里写任何 LaTeX。
  if (S.sourceKind !== 'tex') {
    const ed = $('editor'), src = ed.value;
    const pos = src.lastIndexOf('\n', Math.max(0, ed.selectionStart - 1)) + 1;
    ed.setSelectionRange(pos, pos);
    const w = savedImgWidth();
    const line = mdImageLine(r.file, w);
    insertSnippet(line + '\n', 'Markdown 图片 ' + r.file);
    clearTimeout(saveTimer);
    await saveDoc();
    IMG_CTX = { file: r.file, line, md: true };
    showImageSize(w);
    toast(`已用 Markdown 语法插入 ${r.file} · 自动居中并带 label · 可在左下角调整大小`, 4200);
    return true;
  }

  // 图片必须能编译：即便关掉「宏包补全」也强制补 graphicx
  const added = insertPackages(['graphicx']);
  const ed = $('editor');
  const src = ed.value;
  const start = docStartOf(src);
  const end = src.lastIndexOf('\\end{document}');
  let pos = ed.selectionStart;
  // 光标常常停在文件末尾（\end{document} 之后），或在导言区。
  // 这两种情况下插进去的 figure 会被 LaTeX 完全忽略，表现为
  // 「图片上传成功、编译成功，但预览里没有图」。统一挪到 \end{document} 之前。
  if (start >= 0 && end > start && (pos <= start || pos > end)) {
    pos = end;
  } else if (start >= 0 && pos <= start) {
    const nl = src.indexOf('\n', start);
    pos = nl >= 0 ? nl + 1 : start;
  }
  // 对齐到行首，让 figure 环境独占一个段落
  pos = src.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  ed.setSelectionRange(pos, pos);
  const w = savedImgWidth();
  const f = figureSnippet(r.file, w);
  insertSnippet(f.code, '图片 ' + r.file);
  // 关键：跳过 380ms 防抖立即写盘，避免被另一个标签页的自动保存抢先覆盖
  clearTimeout(saveTimer);
  await saveDoc();
  IMG_CTX = { file: r.file, line: imageLine(r.file, w) };
  showImageSize(w);
  toast(`已插入 ${r.file} · 居中 · \\label{fig:${f.stem}}` +
    (added.length ? ' · 已补 graphicx' : '') + ' · 可在左下角调整大小', 4200);
  return true;
}

// Markdown 项目里「⟨TeX⟩ 查看」：只读展示生成的编译产物，避免用户误改
async function showGeneratedTex() {
  const r = await api('/api/doc?project=' + encodeURIComponent(S.project) + '&tex=1');
  const code = r.tex_content || '';
  openModal('生成的 main.tex · 只读', `
    <div class="tpl-note">这是由 <code>${esc(S.sourceFile)}</code> 自动生成的编译产物，
      仅供核对。请勿直接编辑：下次保存 Markdown 时会重新生成。
      要改内容请回到编辑器里用 <b>Markdown 语法</b>写主源。</div>
    <pre class="tex-preview">${esc(code)}</pre>
    <div class="form-actions"><button class="btn" id="copyTexBtn">复制生成的 LaTeX</button></div>`);
  $('copyTexBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(code); toast('已复制生成的 LaTeX'); }
    catch (e) { toast('复制失败，可直接在框里选中复制'); }
  };
}

function setupImageDrop() {
  const hint = $('dropHint');
  let depth = 0;
  const isFileDrag = ev => ev.dataTransfer &&
    Array.from(ev.dataTransfer.types || []).includes('Files');
  const show = on => {
    hint.classList.toggle('hidden', !on);
    document.body.classList.toggle('drag-active', on);
  };
  window.addEventListener('dragenter', ev => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault(); depth++; show(true);
  });
  window.addEventListener('dragover', ev => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', ev => {
    if (!isFileDrag(ev)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener('drop', async ev => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault(); depth = 0; show(false);
    for (const file of Array.from(ev.dataTransfer.files || [])) {
      try { await addImageFile(file); } catch (e) { toast('图片插入失败：' + e.message); }
    }
  });
  $('insertImageBtn').onclick = () => $('imageInput').click();
  // Markdown 主源：查看自动生成的编译产物；TeX 主源：把选中片段转成 LaTeX。
  $('mdConvertBtn').onclick = async () => {
    if (S.sourceKind !== 'tex') { await showGeneratedTex(); return; }
    const ed = $('editor');
    const a = ed.selectionStart, b = ed.selectionEnd;
    if (a === b) { toast('先选中一段 Markdown 文本，再点 MD→TeX'); return; }
    const r = await api('/api/md-convert', 'POST',
                        { text: ed.value.slice(a, b), fragment: true });
    if (!r.ok || !r.content) { toast('转换失败：' + (r.error || '未知错误')); return; }
    ed.focus();
    ed.setRangeText(r.content, a, b, 'end');
    onEditorInput();
    undoRecord();
    toast('已把选中的 Markdown 转成 LaTeX（可一次撤回）');
  };
  $('imageInput').onchange = async ev => {
    for (const file of Array.from(ev.target.files || [])) {
      try { await addImageFile(file); } catch (e) { toast('图片插入失败：' + e.message); }
    }
    ev.target.value = '';
  };

  // 图片尺寸浮层：非模态，插入后自动出现，不打断「拖入即完成」
  $('imgSizeClose').onclick = hideImageSize;
  $('imgSizePresets').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-w]');
    if (b) applyImageWidth(b.dataset.w);
  });
  $('imgSizeApply').onclick = () => applyImageWidth($('imgSizeCustom').value);
  $('imgSizeCustom').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') applyImageWidth($('imgSizeCustom').value);
  });

  // 预览缩放：单一入口，位于预览栏「实时预览」标题右侧（原来顶栏的 − ＋ ⤢ 100 已移除）
  $('pvZoomIn').onclick = () => changeZoom(0.15);
  $('pvZoomOut').onclick = () => changeZoom(-0.15);
  $('pvZoomFit').onclick = fitWidthZoom;
  $('pvZoomReset').onclick = () => setZoom(1);
  $('pvFullBtn').onclick = togglePreviewMax;
  updateZoomLabel();
  updatePageInfo();
  // 标题栏页码：点击 / 键盘激活后输入页码跳转
  const topPageNo = $('pvPageNo');
  if (topPageNo) {
    topPageNo.onclick = openPageJump;
    topPageNo.onkeydown = ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPageJump(); }
    };
  }

  // ⌘/Ctrl + 滚轮：在预览区直接缩放 PDF
  const sc = $('pdfScroll');
  if (sc) sc.addEventListener('wheel', ev => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    changeZoom(ev.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
  // 滚动时实时更新「当前第几页」；rAF 合帧且不写 scrollTop
  let pageScrollFrame = 0;
  if (sc) sc.addEventListener('scroll', () => {
    if (pageScrollFrame) return;
    pageScrollFrame = requestAnimationFrame(() => {
      pageScrollFrame = 0;
      updateCurrentPage();
    });
  }, { passive: true });

  // 双击分隔条恢复 50% / 50%
  const sp = $('splitter');
  if (sp) sp.addEventListener('dblclick', () => {
    $('editorPane').style.width = '50%';
    toast('已恢复 50% / 50% 分栏');
  });
}

/* 两侧栏变窄时（AI / 工具停靠栏打开、拖动分隔条、窗口缩放），
   收起 pane-head 里的次要文字，保证撤回按钮与缩放组始终完整可见。 */
function setupPaneHeads() {
  const pairs = [['editorHead', 'editorPane'], ['previewHead', 'previewPane']];
  const syncs = [];
  for (const [hid, pid] of pairs) {
    const head = $(hid), pane = $(pid);
    if (!head || !pane) continue;
    const sync = () => head.classList.toggle('tight', pane.clientWidth < 640);
    syncs.push(sync);
    // resize 立即响应；ResizeObserver 额外覆盖分隔条拖动 / 停靠栏展开等栏宽变化
    if (window.ResizeObserver) new ResizeObserver(sync).observe(pane);
    sync();
  }
  window.addEventListener('resize', () => syncs.forEach(f => f()));
}

/* ------------------------------------------------------------------ 编辑器撤回 / 重做
   浏览器原生 undo 栈会被任何程序化写入（setRangeText / value=）清空：
   宏包自动补全、工具面板、图片插入、AI 代码块之后，用户此前的输入就再也撤不回来。
   因此这里维护自己的快照栈并接管 ⌘/Ctrl + Z，任何来源的修改都能逐步撤回。
   快照包含光标与滚动位置，撤回后回到当时的编辑上下文。 */
const UNDO_LIMIT = 200;
const UNDO_MERGE_MS = 450;      // 连续打字合并成一步，避免一个字母一步
let undoHist = [], undoIdx = -1, undoApplying = false;
let undoLastAt = 0, undoLastMergeable = false;

function undoSnap() {
  const ed = $('editor');
  return { text: ed.value, a: ed.selectionStart, b: ed.selectionEnd,
           top: ed.scrollTop, left: ed.scrollLeft };
}

// merge=true 只用于用户连续打字；程序化插入必须 merge=false 独立成一步
function undoRecord(opts = {}) {
  if (undoApplying || !$('editor')) return;
  const s = undoSnap();
  const cur = undoHist[undoIdx];
  if (cur && cur.text === s.text) { undoHist[undoIdx] = s; return; }
  const now = Date.now();
  const merge = !!opts.merge && undoLastMergeable && undoIdx >= 0
                && now - undoLastAt < UNDO_MERGE_MS;
  if (merge) {
    undoHist[undoIdx] = s;
  } else {
    undoHist = undoHist.slice(0, undoIdx + 1);
    undoHist.push(s);
    if (undoHist.length > UNDO_LIMIT) undoHist.shift();
    undoIdx = undoHist.length - 1;
  }
  undoLastAt = now;
  undoLastMergeable = !!opts.merge;
  updateUndoButtons();
}

// 切换项目 / 套用模板后，历史从新文档重新开始
function undoReset() {
  if (!$('editor')) return;
  undoHist = [undoSnap()];
  undoIdx = 0;
  undoLastAt = 0; undoLastMergeable = false;
  updateUndoButtons();
}

// 光标移动本身不产生 input 事件，若不回写，撤销后光标会跳回很早以前的位置。
// 在每次真实输入「之前」把当前光标记进当前快照，撤销就能回到落笔处。
function undoTrackCaret() {
  if (undoApplying || undoIdx < 0 || !undoHist[undoIdx]) return;
  const ed = $('editor'), h = undoHist[undoIdx];
  h.a = ed.selectionStart; h.b = ed.selectionEnd;
  h.top = ed.scrollTop; h.left = ed.scrollLeft;
}

function undoApply(s) {
  if (!s) return;
  const ed = $('editor');
  undoApplying = true;
  ed.value = s.text;
  const n = s.text.length;
  ed.setSelectionRange(Math.min(s.a, n), Math.min(s.b, n));
  ed.scrollTop = s.top; ed.scrollLeft = s.left;
  undoApplying = false;
  undoLastMergeable = false;
  closeEnvHint();               // 撤回/重做会换掉源码，旧的联想上下文已失效
  // skipAutoPkg：否则刚撤掉的 \mathbb 会让宏包补全立刻把 \usepackage 补回来
  onEditorInput({ skipAutoPkg: true });
  updateUndoButtons();
}

function undoEdit() {
  if (undoIdx <= 0) { toast('没有更多可撤回的操作'); return; }
  undoIdx--;
  undoApply(undoHist[undoIdx]);
  toast('已撤回');
}

function redoEdit() {
  if (undoIdx >= undoHist.length - 1) { toast('没有更多可重做的操作'); return; }
  undoIdx++;
  undoApply(undoHist[undoIdx]);
  toast('已重做');
}

function updateUndoButtons() {
  const u = $('undoBtn'), r = $('redoBtn');
  if (u) u.disabled = undoIdx <= 0;
  if (r) r.disabled = undoIdx < 0 || undoIdx >= undoHist.length - 1;
}

function onEditorInput(opts = {}) {
  // Markdown 主源没有导言区：宏包由 front matter / 转换器统一管理，
  // 不能把 \usepackage 插进 .md 里（那会变成正文文字）。
  if (!opts.skipAutoPkg && S.sourceKind === 'tex') {
    const added = autoPackages();
    if (added.length) toast('已自动补入宏包：' + added.join(', '));
  }
  S.docRev++;                 // 每次内容变化都留版本号，编译返回时据此判断结果是否过期
  $('saveHint').textContent = '编辑中…';
  renderHighlight(); updateCursorInfo();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDoc(), 380);
  if (S.auto) {
    clearTimeout(compileTimer);
    // \begin{ 联想打开时源码是半成品，此时编译必然报错还会自动弹开底栏，
    // 正好打断选择。等联想收起后由 closeEnvHint(true) 统一补一次编译。
    if (!ENV_STATE.open && !S.composing) {
      const continuous = S.cont && !NO_CONT;
      if (continuous) {
        S.typing = true;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(finishTyping, TYPING_IDLE);
      } else {
        S.typing = false;
        clearTimeout(typingTimer);
      }
      compileTimer = setTimeout(() => compileNow(false), compileDelay());
    }
  }
  if (S.sync) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => forwardSync(cursorLine(), 'quiet'), 320);
  }
}

// 停手：把 continuous 期间攒下的「过期结果」补成一轮正式编译。
// 若此刻仍有编译在跑，它自己的 stale 重排链会收尾，不必再排一个空转任务。
function finishTyping() {
  S.typing = false;
  if (S.auto && S.cont && !NO_CONT && !ENV_STATE.open && !S.compiling) {
    clearTimeout(compileTimer);
    compileTimer = setTimeout(() => compileNow(false), 16);
  }
}

async function compileNow(full = false, force = false) {
  if (S.compiling) {
    // 编译进行中又编辑了：只记一个「待重编」，等这轮结束立刻用最新内容重来。
    // 同时保住 force：开关极速 / 换引擎时恰好撞上在跑的编译，不能退化成
    // 被指纹跳过的空转，否则状态栏会停留在旧模式。
    clearTimeout(compileTimer);
    S.pendingCompile = true;
    S.pendingForce = S.pendingForce || !!force;
    return;
  }
  clearTimeout(compileTimer);
  const snapshot = $('editor').value;
  const hash = contentHash(snapshot);
  // 内容和上次成功编译完全一致（例如撤回 / 重做绕回原状）：TeX 一行都不用跑
  if (!full && !force && S.pdfDoc && S.compiledProject === S.project
      && hash === S.compiledHash && S.diskHash === hash) {
    // 连续编译里「停手补一轮」的空转会走到这里。若状态栏已是上一轮成功的 ✓，
    // 就不要用信息量更少的「已是最新」覆盖掉「增量 N/M 页 / 免编译」等提示。
    if ($('compileStatus').className !== 'status-ok') {
      setStatus('ok', S.lastMode === 'turbo'
        ? `✓ ⚡ 已是最新 · ${S.lastEngine || 'pdflatex'}`
        : '✓ 已是最新（源码未变）');
    }
    return;
  }

  S.compiling = true;
  const rev = S.docRev;
  const _now = PERF.enabled ? performance.now() : 0;
  const pf = PERF.enabled
    ? (PERF.cur = { t0: _now, abs0: _now, project: S.project, mode: '', ok: false })
    : null;
  if (pf) { PERF.rows.push(pf); if (PERF.rows.length > 60) PERF.rows.shift(); }
  $('compileBtn').classList.add('busy');
  // 连续编译期间状态栏稳定显示同一句，不在「编译中… / 连续编译…」之间抖动
  setStatus('run', (S.cont && !NO_CONT && S.typing) ? '● 连续编译…' : '● 编译中…');
  let r;
  try {
    // 先让磁盘与编辑器一致，再编译磁盘上的文件。
    // 不把「调用瞬间的快照」交给 /api/compile 写盘：那样会用旧内容覆盖刚插入的
    // 图片代码，也是多个标签页互相覆盖的元凶之一。
    // 同时取消 380ms 的兜底保存，避免同一份内容写两次盘。
    clearTimeout(saveTimer);
    await saveDoc();
    pfMark(pf, 'save');
    r = await api('/api/compile', 'POST', {
      project: S.project,
      engine: S.engine === 'auto' ? undefined : S.engine, full: !!full,
      turbo: !!S.turbo,
    });
    pfMark(pf, 'compile');
    if (pf && r) { pf.mode = r.mode || ''; pf.ok = !!r.ok; pf.pdfRev = r.pdf_rev || ''; }
  } catch (e) {
    r = { ok: false, error: String(e), issues: [] };
  }
  S.compiling = false;
  $('compileBtn').classList.remove('busy');

  // 编译期间又有输入 → 这轮结果相对编辑器已经过期。
  // 连续编译下仍把它作为「中间帧」安静地画出来（打字时预览持续跟进），
  // 但不报 ✓、不弹错误面板、不刷新 compiledHash；停手后的那一轮才做正式收尾。
  // 关闭连续编译（NO_CONT / 开关）时维持旧行为：过期结果整个丢弃。
  const stale = S.docRev !== rev;
  const renderThis = !stale || (S.cont && !NO_CONT);
  const quiet = stale && renderThis;
  if (pf) { pf.stale = stale; pf.rendered = renderThis; pf.quiet = quiet; }
  // 中间帧（打字期间源码又变了）不把半成品源码的报错 / 警告刷进底栏：
  // 问题面板不闪、错误徽标不跳、日志不被半截日志覆盖；停手那一轮会一次性
  // 刷新成正式结果。异步回来的完整日志也要确认这一帧仍是最新才允许落盘。
  if (!quiet) {
    S.issues = r.issues || [];
    if (r.log_tail) S.logText = r.log_tail;
    const logRev = rev;
    // 完整编译日志异步取，不挡住状态更新与 PDF 刷新（原来在这里串行 await）
    api('/api/log?project=' + encodeURIComponent(S.project))
      .then(lg => { if (lg.text && S.docRev === logRev) { S.logText = lg.text; renderBottom(); } })
      .catch(() => { /* 日志是辅助信息 */ });
    renderBottom();
    $('issueBadge').textContent = S.issues.filter(i => i.kind === 'error').length;
    $('issueBadge').classList.toggle('has-err', S.issues.some(i => i.kind === 'error'));
  }
  $('engineInfo').textContent = r.engine || S.engine;
  S.lastMode = r.mode || 'standard';
  S.lastEngine = r.engine || S.engine;

  // ---- 准增量预览决策 -------------------------------------------------
  // 后端给出「除元数据外所有对象」的全局 rev 与每页内容流指纹：
  //   rev 相同           ⇒ 画面一定没变，连 pdf.js 重新解析都省掉；
  //   rev 不同、部分页同 ⇒ 只重画指纹变化的页，其余 canvas / 文本层原样留着；
  //   rev 为空 / 页数变  ⇒ 退化为全量渲染，绝不显示过期画面。
  const newRev = r.ok ? (r.pdf_rev || '') : '';
  const newPages = r.ok && Array.isArray(r.pages) ? r.pages : [];
  const canIncr = !NO_INCR && !!newRev && newPages.length > 0 && !!S.pdfDoc
                  && S.renderedProject === S.project
                  && S.renderedPages.length === newPages.length;
  const reuseAll = canIncr && S.renderedRev === newRev;
  let changedPages = null;                     // null = 全量渲染
  if (canIncr && !reuseAll) {
    const diff = [];
    for (let i = 0; i < newPages.length; i++)
      if (S.renderedPages[i] !== newPages[i]) diff.push(i + 1);
    // rev 变了却没有任何页指纹变化：多半是字体 / 图片等资源变了，
    // 必须全量重画，不能误判成「全部复用」。
    if (diff.length && diff.length < newPages.length) changedPages = diff;
  }
  S.lastIncr = reuseAll ? 'reuse' : (changedPages ? 'pages' : 'full');
  if (pf) {
    pf.incr = S.lastIncr;
    pf.changedPages = changedPages ? changedPages.length : null;
  }
  if (!stale) setIncrBadge(S.lastIncr, changedPages ? changedPages.length : 0,
                           newPages.length);

  if (r.ok) {
    const badge = r.mode === 'turbo' ? '⚡ ' : '';
    const sync = r.synctex ? '同步就绪' : '同步缺失';
    const incrTag = reuseAll ? ' · 复用预览'
      : (changedPages ? ` · 增量 ${changedPages.length}/${newPages.length} 页` : '');
    // 后端判定「TeX 可见字符流未变」时会跳过整轮编译，明确告诉用户不是卡顿
    const skipTag = r.cached ? ' · 免编译' : '';
    // quiet 中间帧：不写 ✓（源码已经又变了），也不写成错误（多是半输入态）。
    // 状态栏固定为「连续编译…」，避免打字时红绿反复闪。
    if (quiet) setStatus('run', '● 连续编译…');
    else setStatus('ok', r.mode === 'turbo'
      ? `✓ ${badge}${r.duration}s · ${r.engine} · ${sync}${incrTag}${skipTag}`
      : `✓ ${r.duration}s · ${r.engine} · SyncTeX ${r.synctex ? '就绪' : '缺失'}${incrTag}${skipTag}`);
    $('saveHint').textContent = '已保存';
    pfMark(pf, 'status');
    if (renderThis) {
      const drawn = reuseAll ? true : await loadPdf(changedPages);
      pfMark(pf, 'loaded');
      if (!stale) {
        // .aux 的编号 / \bibcite 每轮都可能变化，编译成功后刷新悬停反查表
        refreshHoverIndex();
        // 只有「编译成功 + 预览确实刷新」才算已是最新；中间帧不标记，
        // 否则下一轮会被指纹跳过，预览会一直停留在这份稍旧的 PDF 上。
        S.compiledHash = hash;
        S.compiledProject = S.project;
        S.diskHash = hash;
      } else {
        // 中间帧是「稍旧源码」的画面，绝不能当成已编译状态。
        // 清空指纹可保证停手那一轮一定真跑一次 TeX，即便用户刚好撤回原状。
        S.compiledHash = '';
      }
      pfMark(pf, 'hover');
      if (drawn && newRev) {
        S.renderedRev = newRev;
        S.renderedPages = newPages;
        S.renderedProject = S.project;
      }
      if (!stale && S.sync) forwardSync(cursorLine(), 'quiet');
    }
  } else {
    // 失败版已被 saveDoc 写盘，清掉指纹，撤回后一定会重新编译并写回正确内容
    S.compiledHash = '';
    if (!quiet) {
      setIncrBadge('full', 0, 0);
      const n = S.issues.filter(i => i.kind === 'error').length;
      setStatus('err', `✗ ${n ? n + ' 处错误' : (r.error || '编译失败')} · 保留上次 PDF`);
      // 先展开问题列表，不等 PDF 渲染，保证错误立刻可见
      activateBottomTab(S.issues.length ? 'issues' : 'log');
      // 「保留上次成功 PDF」在首次打开就失败时也要成立：后台加载磁盘上已有的旧 PDF
      if (!S.pdfDoc) loadPdf().catch(() => {});
    } else {
      setStatus('run', '● 连续编译…');
    }
  }
  if (pf) { pfMark(pf, 'end'); pf.absEnd = performance.now(); PERF.cur = null; }
  // 有排队或结果过期：立刻用最新内容重编，不再额外空等 250ms。
  // 连续模式下 stale 重排不再强制 force —— 中间帧已画出，最终那轮
  // 若内容与上次一致就可以被指纹跳过，避免打字结束时多跑一次 TeX。
  if (S.pendingCompile || stale) {
    const rerunForce = S.pendingForce || (stale && !(S.cont && !NO_CONT));
    S.pendingCompile = false;
    S.pendingForce = false;
    setTimeout(() => compileNow(false, rerunForce), 0);
  }
}

// ------------------------------------------------------------------ PDF 渲染
// 无闪烁刷新（自动编译时预览必须「静止」）：
//   1) 每页先渲染到离屏 canvas，可见 canvas 从不被清空；渲染完成后在
//      requestAnimationFrame 里把已完成的页一次性 drawImage 换帧，
//      用户看到的是「旧内容 → 新内容」一帧切换，没有白屏中间态。
//   2) 页数不变时复用 div / canvas / 事件绑定；尺寸不变时连 width/height
//      都不赋值（赋值会立刻把画布清成全透明）。
//   3) 几何变化后在同一帧恢复 scrollTop，且之后不再抢回用户手动滚动的位置。
//   4) 不清空 .pdf-overlay：正向同步高亮框跨编译持续存在，不再「消失再闪出」。
let commitQueue = [], commitScheduled = false;
function queuePdfCommit(canvas, off, ver) {
  return new Promise(resolve => {
    commitQueue.push({ canvas, off, ver, resolve });
    if (commitScheduled) return;
    commitScheduled = true;
    requestAnimationFrame(() => {
      commitScheduled = false;
      const batch = commitQueue; commitQueue = [];
      for (const j of batch) {
        try {
          if (j.ver === S.pdfVer) {
            // drawImage 覆盖整个目标画布；它与可能的旧像素清除都在同一同步
            // 任务里完成，合成器只会看到最终帧，不存在可见的空白帧。
            j.canvas.getContext('2d').drawImage(j.off, 0, 0, j.canvas.width, j.canvas.height);
          }
        } catch (e) { /* 画布已被更新的刷新替换 */ }
        j.off.width = j.off.height = 0;   // 释放离屏显存
        j.resolve();
      }
    });
  });
}

// changed = null 表示全量重画；否则是「需要重画的 1-based 页码数组」。
// 未列出的页沿用已画好的 canvas 与已解析的文本层，连离屏画布都不创建。
async function loadPdf(changed = null) {
  const ver = ++S.pdfVer;
  const pf = PERF.cur;
  pfMark(pf, 'pdf_start');
  const changedSet = changed ? new Set(changed) : null;
  const oldViews = S.pageViews;
  const scroller = $('pdfScroll');
  const oldTop = scroller.scrollTop;
  const oldH = Math.max(1, scroller.scrollHeight);
  const url = '/api/pdf?project=' + encodeURIComponent(S.project) + '&v=' + Date.now();
  let doc;
  try {
    // 本地 CMap / 标准字体数据：xelatex 生成的中文 PDF 依赖它们才能正确显示字形
    // 本地服务直出的小 PDF：关掉 Range 请求与自动预取可省一次往返与
    // pdf.js worker 内的一次 fetch（实测约 -23ms）。文件再大也不走网络，
    // 全量读取反而更快。
    doc = await pdfjsLib.getDocument({
      url,
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/standard_fonts/',
      disableRange: true,
      disableAutoFetch: true,
    }).promise;
  } catch (e) {
    $('pdfEmpty').classList.remove('hidden');
    // 这次没画成：清掉页级缓存，下一轮必须全量重画
    S.renderedRev = ''; S.renderedPages = [];
    return false;
  }
  pfMark(pf, 'pdf_parse');
  if (ver !== S.pdfVer) { try { doc.destroy(); } catch (e) {} return false; }
  if (S.pdfDoc) { try { S.pdfDoc.destroy(); } catch (e) {} }

  S.pdfDoc = doc;
  const nPages = doc.numPages;
  const host = $('pdfPages');
  $('pdfEmpty').classList.add('hidden');

  let pages;
  try {
    pages = await Promise.all(Array.from({ length: nPages }, (_, i) => doc.getPage(i + 1)));
  } catch (e) { S.renderedRev = ''; S.renderedPages = []; return false; }
  pfMark(pf, 'pdf_getpage');
  if (ver !== S.pdfVer) return false;

  // 多出来的页才移除；已有页全部复用（连同高亮框一起保留）
  while (host.children.length > nPages) host.lastElementChild.remove();
  S.pageViews = new Array(nPages);
  const renders = [], prefetch = [];
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  for (let i = 0; i < nPages; i++) {
    const n = i + 1, page = pages[i];
    const hi = page.getViewport({ scale: S.zoom * dpr });
    const lo = page.getViewport({ scale: S.zoom });
    const W = Math.ceil(hi.width), H = Math.ceil(hi.height);
    let wrapEl = host.children[i], canvas, overlay, badge;
    if (!wrapEl || !wrapEl.classList.contains('pdf-page')) {
      wrapEl = document.createElement('div');
      wrapEl.className = 'pdf-page';
      canvas = document.createElement('canvas');
      // 尺寸在挂到 DOM 之前设好：新页本来就没有旧画面，
      // 更不能在已挂载后赋值 width（那会清空出一帧白页）。
      canvas.width = W; canvas.height = H;
      overlay = document.createElement('div');
      overlay.className = 'pdf-overlay';
      badge = document.createElement('span');
      badge.className = 'pdf-pageno';
      badge.title = '点击跳到这一页';
      // 徽标在页面外侧，点它只跳页，不触发 PDF 单击反向定位
      badge.addEventListener('click', ev => {
        ev.stopPropagation(); ev.preventDefault();
        scrollToPdfPage(Number(wrapEl.dataset.page));
      });
      wrapEl.appendChild(canvas); wrapEl.appendChild(overlay);
      wrapEl.appendChild(badge);
      host.appendChild(wrapEl);
      // 双向同步：单击即可。记录按下点，排除「拖拽滚动 / 框选」造成的误触。
      // 页码从 dataset 读，页数变化后复用的元素也不会绑死旧页码。
      let down = null;
      wrapEl.addEventListener('pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY }; });
      wrapEl.addEventListener('click', ev => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        if (window.getSelection && String(window.getSelection()).trim()) return;
        if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) return;
        down = null;
        onPdfClick(ev, Number(wrapEl.dataset.page));
      });
    } else {
      canvas = wrapEl.querySelector('canvas');
      overlay = wrapEl.querySelector('.pdf-overlay');
      badge = wrapEl.querySelector('.pdf-pageno');
      // 热更新前渲染出来的旧页面没有徽标：只补这一个节点，绝不重建整页
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'pdf-pageno';
        badge.title = '点击跳到这一页';
        badge.addEventListener('click', ev => {
          ev.stopPropagation(); ev.preventDefault();
          scrollToPdfPage(Number(wrapEl.dataset.page));
        });
        wrapEl.appendChild(badge);
      }
      // 不清 innerHTML：高亮框留着，安静地跟随内容更新即可
    }
    wrapEl.dataset.page = String(n);
    const btxt = n + ' / ' + nPages;
    if (badge.textContent !== btxt) badge.textContent = btxt;
    badge.setAttribute('aria-label', '第 ' + n + ' 页，共 ' + nPages + ' 页');
    const wpx = lo.width + 'px', hpx = lo.height + 'px';
    if (wrapEl.style.width !== wpx) wrapEl.style.width = wpx;
    if (wrapEl.style.height !== hpx) wrapEl.style.height = hpx;
    // 缩放 / 页尺寸变了就必须重画这一页，哪怕它的内容指纹没变
    const sizeChanged = canvas.width !== W || canvas.height !== H;
    if (sizeChanged) {
      // 复用页尺寸变化（例如缩放）才会清空画布：先把旧画面缩放回来当占位，
      // 这样切换缩放 / 页面尺寸变化时也不会出现白页。
      let keep = null;
      if (canvas.width && canvas.height) {
        keep = document.createElement('canvas');
        keep.width = canvas.width; keep.height = canvas.height;
        keep.getContext('2d').drawImage(canvas, 0, 0);
      }
      canvas.width = W; canvas.height = H;
      if (keep) {
        canvas.getContext('2d').drawImage(keep, 0, 0, W, H);
        keep.width = keep.height = 0;
      }
    }
    const cw = lo.width + 'px', ch = lo.height + 'px';
    if (canvas.style.width !== cw) canvas.style.width = cw;
    if (canvas.style.height !== ch) canvas.style.height = ch;
    // 内容未变的页：连文本层都复用，省一次 pdf.js getTextContent()
    const untouched = !!(changedSet && !changedSet.has(n) && !sizeChanged);
    S.pageViews[i] = { page, viewport: lo, el: wrapEl, overlay,
                       textItems: untouched && oldViews[i] ? oldViews[i].textItems : null,
                       textPromise: null, view: page.view };

    if (untouched) {
      // 可见 canvas 上已经是这一页的正确画面，直接占位一个已完成 Promise
      renders.push(Promise.resolve());
    } else {
      // 离屏渲染 → 提交换帧：可见 canvas 全程保持旧内容
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      renders.push(
        page.render({ canvasContext: off.getContext('2d'), viewport: hi }).promise
          .then(() => queuePdfCommit(canvas, off, ver))
          .catch(() => { off.width = off.height = 0; })
      );
    }
    prefetch.push(n);
  }

  // 几何一改完就在同一帧恢复阅读位置，避免中间态被看到。
  // 之后不再二次设置 scrollTop：用户在编译期间手动滚动不应被抢回去。
  const newH = Math.max(1, scroller.scrollHeight);
  const targetTop = newH > oldH ? oldTop * (newH / oldH) : oldTop;
  if (Math.abs(scroller.scrollTop - targetTop) > 0.5) scroller.scrollTop = targetTop;

  // 页码先立即刷新：状态栏的 ✓ 早于 pdf.js 渲染完成，若等到最后才更新，
  // 用户刚打开预览会看不到页码，必须滚动一下才出现。
  if (S.curPage > nPages) S.curPage = nPages;
  updatePageInfo();
  updateCurrentPage();

  // 文本层预解析挪到浏览器空闲时，不与 canvas 渲染抢 pdf.js worker
  const idle = window.requestIdleCallback
    ? fn => window.requestIdleCallback(fn, { timeout: 600 })
    : fn => setTimeout(fn, 60);
  idle(() => prefetch.forEach(n => getTextItems(n).catch(() => {})));

  // 只等「当前可见页」换完帧就宣告刷新完成；其余页在后台继续提交。
  let acc = 0, priority = 0;
  const mid = targetTop + scroller.clientHeight / 2;
  for (let i = 0; i < nPages; i++) {
    const h = host.children[i].offsetHeight;
    if (mid < acc + h) { priority = i; break; }
    acc += h;
  }
  await renders[priority];
  // 增量模式下变化页通常很少，必须等它们全部提交完才宣布「这一版已画好」；
  // 否则下一轮可能依据指纹跳过一页、而它的换帧实际上已被更新的刷新丢弃。
  if (changedSet) await Promise.all(renders);
  pfMark(pf, 'pdf_commit');
  if (ver !== S.pdfVer) return false;
  if (S.curPage > nPages) S.curPage = nPages;
  updatePageInfo();
  updateCurrentPage();
  scheduleHoverScan();
  return true;
}

/* ------------------------------------------------ 预览页码 ---------------- */
function updatePageInfo() {
  const el = $('pageInfo');
  const n = S.pageViews.length;
  const zoom = Math.round(S.zoom * 100);
  const cur = Math.min(S.curPage, n || 1);
  if (el) {
    const txt = n ? `第 ${cur} / ${n} 页 · ${zoom}%` : `尚未生成 PDF · ${zoom}%`;
    if (el.textContent !== txt) el.textContent = txt;
  }
  // 标题栏缩放区那一枚：与底栏同源，避免两处页码各算各的
  const top = $('pvPageNo');
  if (top) {
    const tt = n ? `${cur} / ${n}` : '— / —';
    if (top.textContent !== tt) top.textContent = tt;
    top.classList.toggle('empty', !n);
    const label = n ? `第 ${cur} / ${n} 页 · 点击输入页码跳转` : '尚未生成 PDF';
    top.setAttribute('aria-label', label);
    const box = $('pvPageBox');
    if (box) box.title = label;
  }
}

// 视口上三分之一视为「正在看的页」。只改 class 与文字，绝不动 scrollTop，
// 否则会破坏自动编译时保持阅读位置的零抖动策略。
function updateCurrentPage() {
  const host = $('pdfPages'), sc = $('pdfScroll');
  if (!host || !sc || !S.pageViews.length) return;
  const kids = host.children, n = kids.length;
  if (!n) return;
  const box = sc.getBoundingClientRect();
  const line = box.top + Math.min(box.height * 0.35, 240);
  let best = 0, dist = Infinity;
  for (let i = 0; i < n; i++) {
    const b = kids[i].getBoundingClientRect();
    if (b.top <= line && b.bottom >= line) { best = i; dist = -1; break; }
    const d = Math.abs((b.top + b.bottom) / 2 - line);
    if (d < dist) { dist = d; best = i; }
  }
  S.curPage = best + 1;
  for (let i = 0; i < n; i++) {
    const badge = kids[i].querySelector('.pdf-pageno');
    if (badge) badge.classList.toggle('cur', i === best);
  }
  updatePageInfo();
}

function scrollToPdfPage(n) {
  const host = $('pdfPages'), sc = $('pdfScroll');
  const total = S.pageViews.length;
  if (!total || !sc) return;
  const p = Math.max(1, Math.min(total, Math.round(Number(n) || 1)));
  const el = host && host.children[p - 1];
  if (!el) return;
  sc.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: 'smooth' });
  toast('已跳到第 ' + p + ' 页');
}

// 标题栏页码点击后原地变成数字输入框：Enter 跳页、Esc 取消、失焦还原。
// 不弹系统对话框，保持界面风格统一；输入框是兄弟节点，不会覆盖 label 的事件绑定。
function openPageJump() {
  const box = $('pvPageBox'), lab = $('pvPageNo');
  if (!box || !lab || box.querySelector('input')) return;
  const n = S.pageViews.length;
  if (!n) { toast('请先编译生成 PDF'); return; }
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.className = 'pv-page-input';
  inp.min = '1'; inp.max = String(n); inp.step = '1';
  inp.value = String(Math.min(S.curPage, n));
  inp.setAttribute('aria-label', '跳转到页码，输入后按回车');
  lab.classList.add('hidden');
  box.appendChild(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = jump => {
    if (done) return;
    done = true;
    const v = parseInt(inp.value, 10);
    inp.remove();
    lab.classList.remove('hidden');
    if (jump && Number.isFinite(v)) scrollToPdfPage(v);
  };
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(false));
}

async function getTextItems(n) {
  const pv = S.pageViews[n - 1];
  if (!pv) return [];
  if (pv.textItems) return pv.textItems;
  if (!pv.textPromise) {
    pv.textPromise = pv.page.getTextContent()
      .then(tc => (pv.textItems = tc.items || []))
      .catch(() => (pv.textItems = []));
  }
  return pv.textPromise;
}

function pdfPointFromEvent(ev, n) {
  const pv = S.pageViews[n - 1];
  const r = pv.el.getBoundingClientRect();
  const cssX = ev.clientX - r.left, cssY = ev.clientY - r.top;
  const [px, py] = pv.viewport.convertToPdfPoint(cssX, cssY);
  const v = pv.view || [0, 0, 595, 842];
  const height = v[3] - v[1];
  // SyncTeX 与 TeX 均以「页面左上角」为原点（已实测往返一致）
  return { x: px - v[0], y: height - (py - v[1]) };
}

// PDF → 源码：单击反向定位（精确锚点 + 原始点击点自洽校验）
async function onPdfClick(ev, n) {
  ev.preventDefault();
  const pv = S.pageViews[n - 1];
  if (!pv) return;
  const p = pdfPointFromEvent(ev, n);
  const height = (pv.view[3] - pv.view[1]);
  const items = await getTextItems(n);
  let qx = p.x, qy = p.y, best = Infinity;
  // 吸附到最近的文本项：即使点在行间空白 / 公式缝隙，也能落到准确的行
  for (const it of items) {
    if (!it.transform || !it.str || !it.str.trim()) continue;
    const x0 = it.transform[4];
    const yBase = height - (it.transform[5] - pv.view[1]);   // 基线（页面顶部原点）
    const w = Math.max(2, Math.min(700, it.width || 8));
    const h = Math.max(4, Math.min(40, it.height || 10));
    const yTop = yBase - h;
    const dx = Math.max(x0 - p.x, 0, p.x - (x0 + w));
    const dy = Math.max(yTop - p.y, 0, p.y - yBase);
    const d = Math.hypot(dx, dy * 0.85);
    if (d < best) {
      best = d;
      // 查询点取文本项左端、排版盒垂直中心 —— 实测这是 SyncTeX 命中率最高的锚点
      qx = x0 + Math.min(3, Math.max(1, w * 0.12));
      qy = yBase - h / 2;
    }
  }
  if (best > 60) { qx = p.x; qy = p.y; }
  try {
    const r = await api('/api/synctex/edit', 'POST', {
      project: S.project, page: n, x: qx, y: qy, ox: p.x, oy: p.y,
    });
    if (!r.ok) { toast('该位置没有对应的源码行'); return; }
    if (!r.main) { toast('该处内容来自宏包文件 ' + (r.file || '')); return; }
    gotoLine(r.line, r.column || 1);
    toast(`PDF 第 ${n} 页 → 源码第 ${r.line} 行`);
  } catch (e) { toast('反向定位失败：' + e.message); }
}

function showSyncBox(pageNo, rect, mode) {
  const pv = S.pageViews[pageNo - 1];
  if (!pv) return;
  const quiet = mode === 'quiet';
  // 自动同步（打字 / 自动编译）复用已有高亮框：不删、不重建、不播 flash。
  // 只有用户显式「定位到 PDF」才走下面的 scroll 分支。
  let box = quiet ? pv.overlay.querySelector('.sync-box') : null;
  if (!box) {
    document.querySelectorAll('.sync-box').forEach(e => e.remove());
    box = document.createElement('div');
    box.className = quiet ? 'sync-box' : 'sync-box flash';
    pv.overlay.appendChild(box);
  }
  const l = (rect[0] * S.zoom) + 'px';
  const t = (rect[1] * S.zoom) + 'px';
  const w = Math.max(8, (rect[2] - rect[0]) * S.zoom) + 'px';
  const h = Math.max(10, (rect[3] - rect[1]) * S.zoom) + 'px';
  // 位置没变就一个字节都不写：自动编译时绝大多数情况预览完全静止
  if (box.style.left !== l) box.style.left = l;
  if (box.style.top !== t) box.style.top = t;
  if (box.style.width !== w) box.style.width = w;
  if (box.style.height !== h) box.style.height = h;
  if (quiet || mode === 'no-scroll') return;   // 自动过程绝不抢预览滚动位置
  const sc = $('pdfScroll');
  const elTop = pv.el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  const boxTop = elTop + rect[1] * S.zoom;
  const boxBottom = boxTop + Math.max(10, (rect[3] - rect[1]) * S.zoom);
  const visTop = sc.scrollTop, visBottom = visTop + sc.clientHeight;
  const outOfView = boxTop < visTop + 30 || boxBottom > visBottom - 30;
  if (mode === 'scroll' || (mode === 'auto' && outOfView)) {
    sc.scrollTo({ top: Math.max(0, boxTop - sc.clientHeight / 2), behavior: 'smooth' });
  }
}

async function forwardSync(line, mode = 'scroll') {
  if (!S.pdfDoc || !S.pageViews.length) return;
  try {
    const r = await api('/api/synctex/view', 'POST', {
      project: S.project, line, col: cursorCol(),
    });
    if (!r.ok) return;
    // 请求回来时用户可能已经移动光标；静默同步不该把高亮画到别处
    if (mode === 'quiet' && cursorLine() !== line) return;
    showSyncBox(r.page, r.rect, mode);
    if (mode === 'scroll') toast(`源码第 ${line} 行 → PDF 第 ${r.page} 页`);
  } catch (e) { /* 静默：同步是增强功能 */ }
}

// ------------------------------------------------------------------ 底部面板
// 注意：容器 id 是 bottomPanel（不是 bottom）；旧代码取错 id 导致点击展开抛异常。
function expandBottom(on = true) {
  const el = $('bottomPanel');
  el.classList.toggle('expanded', on);
  el.classList.toggle('collapsed', !on);
  $('bottomToggle').textContent = on ? '▼ 收起' : '▲ 展开';
  // 关键：body 是 overflow:hidden 的普通块级流，#workspace 用的是固定高度，
  // 若不让它同步缩短，展开后的问题列表会整块落在视口之外（看起来像点不开）。
  // 值与 CSS .bottom.expanded 的 min(270px,36vh) 保持一致。
  const h = on ? Math.min(270, Math.round(window.innerHeight * 0.36)) : 30;
  document.documentElement.style.setProperty('--bottom-h', h + 'px');
  setTimeout(() => { try { positionActiveLine(); } catch (e) {} }, 220);
}

function activateBottomTab(name) {
  document.querySelectorAll('.btab').forEach(
    x => x.classList.toggle('active', x.dataset.tab === name));
  renderBottom();
  expandBottom(true);
}

// 每次编译都会调用 renderBottom()。问题列表内容没变时重建 DOM 会让展开的
// 底栏整块闪一下；缓存 HTML，只有真的变了才写。
let bottomHTMLCache = '';
function setBottomHTML(html) {
  const body = $('bottomBody');
  if (bottomHTMLCache === html) return false;
  bottomHTMLCache = html;
  body.innerHTML = html;
  return true;
}

function renderBottom() {
  const tab = document.querySelector('.btab.active');
  const which = tab ? tab.dataset.tab : 'issues';
  if (which === 'issues') {
    if (!S.issues.length) {
      setBottomHTML('<div style="color:var(--muted);padding:8px">✓ 暂无问题。编译错误与警告会显示在这里，点击可跳到对应源码行。</div>');
    } else {
      const html = S.issues.map(i =>
        `<div class="issue-row" data-line="${i.line || 1}">` +
        `<span class="issue-kind ${i.kind}">${i.kind === 'error' ? '错误' : '警告'}</span>` +
        `<span class="issue-line">${i.file || ''}${i.line ? ':' + i.line : ''}</span>` +
        `<span class="issue-msg">${esc(i.message)}</span></div>`).join('');
      if (setBottomHTML(html)) {
        $('bottomBody').querySelectorAll('.issue-row').forEach(row => {
          row.onclick = () => gotoLine(parseInt(row.dataset.line, 10), 1);
        });
      }
    }
  } else if (which === 'log') {
    setBottomHTML('<pre class="log-pre">' + esc(S.logText || '（暂无编译日志）') + '</pre>');
  } else {
    const e = S.env, paths = S.enginePaths || {};
    const rows = [
      ['TeX 引擎 xelatex', !!e.engines?.xelatex, paths.xelatex],
      ['TeX 引擎 pdflatex', !!e.engines?.pdflatex, paths.pdflatex],
      ['TeX 引擎 lualatex', !!e.engines?.lualatex, paths.lualatex],
      ['latexmk（参考文献）', !!e.engines?.latexmk, paths.latexmk],
      ['SyncTeX 双向定位', !!e.synctex_ready, paths.synctex],
      ['kpsewhich（模板检测）', !!e.engines?.kpsewhich, paths.kpsewhich],
      ['AI 免费大模型', true, e.ai?.model + ' · 无需 API Key / 注册'],
      ['内置模板', true, (S.templates.length || 0) + ' 个 · 可随时添加'],
    ];
    setBottomHTML('<div class="env-grid">' + rows.map(([name, ok, path]) =>
      `<div class="env-item"><b class="${ok ? 'env-ok' : 'env-no'}">${ok ? '● ' : '○ '}${esc(name)}</b>` +
      `<span>${esc(path || (ok ? '可用' : '未安装'))}</span></div>`).join('') + '</div>');
  }
}

// ------------------------------------------------------------------ 弹层
function openModal(title, html) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modal').classList.remove('hidden');
}
function closeModal() {
  $('modal').classList.add('hidden');
  $('modalCard').classList.remove('wide');
}

// 模板分类：一级按 category（出版商 / 用途），「全部」视图再按 publisher 分组。
const PUB_ORDER = ['AMS', 'SIAM', 'Springer', 'Elsevier', 'IEEE', 'AIMS', 'EMS',
  'Princeton', 'Duke', 'Oxford', 'LMS', '中文期刊', '华北水利水电大学',
  'arXiv', 'YangTex', '我的模板', '其他'];

function tplCardHtml(t) {
  const badge = t.preview
    ? '<span class="tc-preview">◐ 预览排版</span>'
    : t.available ? '<span class="tc-ok">✓ 可编译</span>'
      : `<span class="tc-warn">✗ 需安装 ${esc((t.missing || []).join(', ') || '对应宏包')}</span>`;
  const hint = t.preview
    ? `<div class="tc-hint">本机未装 ${esc((t.missing || []).join(', '))}，YangTex 自动降级为
       article 预览排版；把官方类放进 <code>templates/classes/</code> 后重新编译即切换为正式期刊格式。</div>` : '';
  const kindTag = t.kind === 'markdown'
    ? '<span class="tc-kind md" title="纯 Markdown 模板，套用时自动转成可编译 LaTeX">MD</span>'
    : t.kind === 'mixed'
      ? '<span class="tc-kind mix" title="Markdown + LaTeX 混排模板，套用时自动转成可编译 LaTeX">MD+TeX</span>'
      : '';
  const fullTag = t.full_source
    ? `<span class="tc-kind full" title="用户原始工程全文保留：章节、例题、每张幻灯片与参考文献一字未删">▤ 原稿全量 ${Number(t.source_lines || 0).toLocaleString()} 行</span>`
    : '';
  const officialTag = t.official
    ? (t.preview
        ? '<span class="tc-official preview" title="期刊官方模板，本机尚缺官方类文件">◐ 官方类待装</span>'
        : '<span class="tc-official" title="使用期刊官方文档类">◈ 官方模板</span>')
    : (t.full_source
        ? ''
        : (t.kind === 'tex'
            ? '<span class="tc-kind plain" title="按期刊投稿规范整理，非官方类文件">◇ 规范底稿</span>'
            : ''));
  const journal = t.journal
    ? `<div class="tc-journal">${esc(t.journal)}</div>` : '';
  return `<div class="tpl-card" data-id="${esc(t.id)}">
    <div class="tc-top"><b>${esc(t.name)}</b><span class="tc-cat">${esc(t.category)}</span></div>
    ${journal}<div class="tc-desc">${esc(t.description)}</div>${hint}
    <div class="tc-foot">${kindTag}${fullTag}${officialTag}<span>${esc(t.lang)}</span><span>${esc(t.engine)}</span>${badge}</div>
    <div class="tc-foot" style="border-top:none;padding-top:2px">
      <button class="mini-btn" data-use="new" data-id="${esc(t.id)}">新建项目</button>
      <button class="mini-btn" data-use="current" data-id="${esc(t.id)}">套用到当前</button>
    </div></div>`;
}

function renderTemplateCards() {
  const q = (S.templatesQuery || '').trim().toLowerCase();
  const match = t => !q || [t.name, t.journal, t.publisher, t.category,
    t.description, t.doc_class, (t.tags || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase().includes(q);
  // 有关键词时跨全库检索，避免「点过某分类后搜不到其它分类的期刊」
  const list = S.templates.filter(t =>
    (!!q || S.templatesCat === '全部' || t.category === S.templatesCat) && match(t));
  const box = $('tplResults');
  if (!box) return;
  if ($('tplFound')) $('tplFound').textContent = (q ? '全库 ' : '') + list.length + ' 份模板';
  let html = '';
  if (S.templatesCat === '全部' && !q) {
    const groups = new Map();
    list.forEach(t => {
      const k = t.publisher || '其他';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    });
    const keys = [...groups.keys()].sort((a, b) => {
      const ia = PUB_ORDER.indexOf(a), ib = PUB_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    for (const k of keys) {
      const items = groups.get(k);
      html += `<div class="tpl-group"><span>${esc(k)}</span><span>${items.length} 份</span></div>`;
      html += items.map(tplCardHtml).join('');
    }
  } else {
    html = list.map(tplCardHtml).join('');
  }
  box.innerHTML = html || '<div class="tpl-empty">没有匹配的模板，换个关键词试试。</div>';
  box.querySelectorAll('[data-use]').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); useTemplate(b.dataset.id, b.dataset.use); };
  });
}

function openTemplates() {
  const cats = ['全部', ...new Set(S.templates.map(t => t.category))];
  const counts = {};
  S.templates.forEach(t => { counts[t.category] = (counts[t.category] || 0) + 1; });
  const catHtml = cats.map(c => {
    const n = c === '全部' ? S.templates.length : (counts[c] || 0);
    return `<button class="tpl-cat ${c === S.templatesCat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}<i>${n}</i></button>`;
  }).join('');
  openModal('模板库 · ' + S.templates.length + ' 个模板', `
    <div class="tpl-tools">
      <input id="tplSearch" class="tpl-search" placeholder="⌕ 搜索期刊 / 模板名 / 出版商 / 标签"
             value="${esc(S.templatesQuery || '')}">
      <span class="tpl-found" id="tplFound"></span>
    </div>
    <div class="tpl-cats">${catHtml}</div>
    <div class="tpl-grid" id="tplResults"></div>
    <div class="tpl-note"><b>分类与检索：</b>全部模板按 AMS、SIAM、Springer、Elsevier、IEEE、
      AIMS、中文数学期刊等出版商分组；点顶部分类按钮可只看一类，也可直接搜索期刊名或标签。<br>
      <b>中文教材 / 课件 / 学位论文（原稿全量保留）：</b>「中文教材与讲义」「教学课件与答辩」
      「中文学位论文」三类带 <b>▤ 原稿全量 N 行</b> 徽标，由用户原始工程完整合并为单文件：
      全部章节、例题、每张幻灯片、封面与参考文献一字未删改（最多 4,736 行），
      仅去除 PDF / digest.lock 等编译产物；原稿 macOS 字体声明加了存在性判断，
      Mac 上视觉与原稿完全一致，Windows / Linux 自动跳过缺失字体仍可 xelatex 编译。<br>
      <b>数学期刊官方模板：</b>使用各刊官方文档类（amsart / elsarticle / IEEEtran / siamart /
      svjour3 / aimsart / llncs 等）。官方类已就绪时显示 <b>◈ 官方模板</b> 并编译出正式期刊版式；
      未安装时显示 <b>◐ 官方类待装</b>，自动降级为 article 预览排版，仍可正常编译、实时预览与双向同步。
      从期刊官网下载 <code>.cls</code> / <code>.sty</code> 放进
      <code>YangTex/templates/classes/</code> 即对所有项目生效（新建项目会顺带复制一份，方便打包投稿）；
      也可用 <code>tlmgr install &lt;包名&gt;</code> 或 MiKTeX Console 安装。<br>
      <b>随时添加更多模板：</b>把 <code>.tex</code>、<code>.md</code> 或 <code>.mdtex</code>
      文件放进 <code>YangTex/templates/</code> 目录，刷新页面即自动出现；
      也可点下方按钮在界面里粘贴保存（可选 LaTeX / Markdown / 混排三种格式）。<br>
      <b>Markdown / 混排模板直接用 Markdown 语法写</b>：套用后编辑器里是
      <code>main.md</code> / <code>main.mdtex</code>（标题、列表、表格、<code>$$</code> 公式），
      保存时由内置转换器自动生成编译用的 <code>main.tex</code>。
      不需要 pandoc、不需要 <code>markdown.sty</code>、也不用开 <code>-shell-escape</code>；
      实时编译与双向逐行同步照常，行号会自动换算回 Markdown 源。
      混排用 <code>:::latex</code> … <code>:::</code> 包住定理 / 公式等原样 LaTeX。</div>
    <div class="form-actions"><button class="btn" id="addTplBtn">＋ 添加自定义模板</button></div>
  `);
  $('modalBody').querySelectorAll('.tpl-cat').forEach(b => b.onclick = () => {
    S.templatesCat = b.dataset.cat; openTemplates();
  });
  $('tplSearch').oninput = e => { S.templatesQuery = e.target.value; renderTemplateCards(); };
  $('addTplBtn').onclick = addTemplateForm;
  renderTemplateCards();
}

const TPL_DEFAULTS = {
  tex: '\\documentclass[11pt,a4paper,fontset=fandol]{ctexart}\n'
     + '\\usepackage{amsmath,amssymb,amsthm}\n'
     + '\\begin{document}\n\n\\end{document}',
  markdown: '---\ntitle: 我的 Markdown 笔记\nlang: zh\n---\n\n'
          + '# 标题\n\n用 **Markdown** 写正文，行内数学 $u \\in H^1_0$。\n\n'
          + '- 要点一\n- 要点二\n\n'
          + '$$\n  -\\Delta u = f\n$$',
  mixed: '---\ntitle: 我的混排文档\nlang: zh\n---\n\n'
       + '# 引言\n\n结构用 Markdown，公式与定理用 LaTeX。\n\n'
       + ':::latex\n\\begin{theorem}[能量估计]\n'
       + '  $\\|u\\|_{L^2}^2 + \\|\\nabla u\\|_{L^2}^2 \\le C$.\n'
       + '\\end{theorem}\n:::',
};

function addTemplateForm() {
  openModal('添加自定义模板', `
    <div class="form-row"><label>模板名称</label><input id="tplName" placeholder="例如：我的 PDE 笔记模板"></div>
    <div class="form-row"><label>分类</label><input id="tplCat" value="我的模板"></div>
    <div class="form-row"><label>模板格式</label><select id="tplKind">
      <option value="tex">LaTeX（.tex，原样使用）</option>
      <option value="markdown">Markdown（.md，套用时转成 LaTeX）</option>
      <option value="mixed">Markdown + LaTeX 混排（.mdtex）</option></select></div>
    <div class="form-row"><label>编译引擎</label><select id="tplEngine">
      <option value="xelatex">xelatex（中文 / 系统字体）</option>
      <option value="pdflatex">pdflatex（纯英文，较快）</option>
      <option value="lualatex">lualatex</option></select></div>
    <div class="form-row"><label style="align-self:flex-start">模板内容</label></div>
    <div class="form-row"><textarea id="tplContent" placeholder="把模板全文粘贴到这里…">${TPL_DEFAULTS.tex}</textarea></div>
    <div class="form-actions"><button class="btn" id="tplCancel">取消</button>
      <button class="btn btn-primary" id="tplSave">保存模板</button></div>
  `);
  // 只在内容仍是某个默认样例时才替换，不覆盖用户已经写好的内容
  $('tplKind').onchange = () => {
    const ta = $('tplContent');
    if (!ta.value.trim() || Object.values(TPL_DEFAULTS).includes(ta.value))
      ta.value = TPL_DEFAULTS[$('tplKind').value];
  };
  $('tplCancel').onclick = openTemplates;
  $('tplSave').onclick = async () => {
    const name = $('tplName').value.trim();
    const content = $('tplContent').value;
    if (!name || !content.trim()) { toast('请填写名称和内容'); return; }
    const r = await api('/api/templates', 'POST', {
      name, content, engine: $('tplEngine').value, kind: $('tplKind').value,
      category: $('tplCat').value.trim() || '我的模板', description: '用户添加的模板',
    });
    if (r.ok) {
      toast('模板已添加：' + name);
      await refreshTemplates();
      openTemplates();
    } else toast('保存失败');
  };
}

async function useTemplate(id, how) {
  const t = S.templates.find(x => x.id === id);
  if (!t) return;
  if (how === 'current') {
    if (!confirm(`将用「${t.name}」覆盖当前项目 ${S.project} 的全部内容，确定吗？`)) return;
    const tpl = await api('/api/template-content?file=' + encodeURIComponent(t.file));
    if (!tpl.ok) { toast('读取模板失败'); return; }
    const kind = tpl.kind || 'tex';
    const isMd = kind === 'markdown' || kind === 'mixed';
    S.sourceKind = kind;
    S.sourceFile = kind === 'mixed' ? 'main.mdtex' : (isMd ? 'main.md' : 'main.tex');
    // Markdown 模板的 content 就是 Markdown 源，直接进编辑器；main.tex 由后端生成
    $('editor').value = tpl.content;
    updateSourceUI();
    renderHighlight(); updateCursorInfo();
    undoReset();               // 覆盖全文后历史重新开始
    await saveDoc(true, kind); // 同时把项目切换成对应的主源类型
    // 极速模式下由后端按源码自动选引擎，别让模板里钉死的 xelatex 拖慢英文模板
    S.engine = S.turbo ? 'auto' : (tpl.engine || t.engine);
    $('engineSel').value = S.engine; saveState();
    closeModal();
    toast(isMd ? `已套用「${t.name}」：现在直接用 Markdown 语法编辑，PDF 自动更新`
               : `已套用模板：${t.name}`);
    compileNow(false, true);
  } else {
    const defaultName = t.name.replace(/[（(].*?[)）]/g, '').trim().slice(0, 30) + ' 项目';
    openModal('用模板新建项目', `
      <div class="form-row"><label>项目名称</label><input id="npName" value="${esc(defaultName)}"></div>
      <div class="form-row"><label>使用模板</label><input value="${esc(t.name)}" readonly></div>
      <div class="tpl-note">每个项目有独立目录。LaTeX 模板的主文档是 <code>main.tex</code>；
        Markdown / 混排模板的主文档是 <code>main.md</code> / <code>main.mdtex</code>，
        <b>直接用 Markdown 语法写</b>，保存时自动生成编译用的 <code>main.tex</code> 与 <code>main.pdf</code>。</div>
      <div class="form-actions"><button class="btn" id="npCancel">取消</button>
        <button class="btn btn-primary" id="npCreate2">创建并打开</button></div>`);
    $('npCancel').onclick = () => openTemplates();
    $('npCreate2').onclick = () => doCreateProject($('npName').value, id);
  }
}

function openNewProject() {
  const opts = S.templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)} · ${esc(t.category)}</option>`).join('');
  openModal('新建项目', `
    <div class="form-row"><label>项目名称</label><input id="npName" value="新项目 ${new Date().toLocaleDateString('zh-CN')}"></div>
    <div class="form-row"><label>起始模板</label><select id="npTpl">${opts}</select></div>
    <div class="tpl-note">项目之间互不干扰；可随时切换、删除，也可以把 <code>.bib</code>、图片等
      附属文件直接放进项目目录，编译时会自动找到。</div>
    <div class="form-actions"><button class="btn" id="npCancel">取消</button>
      <button class="btn btn-primary" id="npCreate">创建项目</button></div>`);
  $('npCancel').onclick = closeModal;
  $('npCreate').onclick = () => doCreateProject($('npName').value, $('npTpl').value);
}

async function doCreateProject(name, tplId) {
  if (!name.trim()) { toast('请填写项目名称'); return; }
  const r = await api('/api/projects', 'POST', { name: name.trim(), template: tplId });
  if (!r.ok) { toast('创建失败'); return; }
  await refreshProjects();
  S.project = r.name;
  $('projectSel').value = S.project;
  // 模板建议的引擎（中文 ctexart → xelatex，英文 article → pdflatex）优先，
  // 避免用户上次手选的引擎把新项目编译坏
  if (r.engine) {
    S.engine = S.turbo ? 'auto' : r.engine;
    $('engineSel').value = S.engine;
  }
  closeModal();
  await loadDocument();
  toast('已创建项目：' + S.project + (r.source && r.source !== 'tex'
        ? '（Markdown 模板已转成可编译 LaTeX）' : ''));
  compileNow(true);
  saveState();
}

function openHelp() {
  const e = S.env;
  openModal('YangTex 使用说明', `<div class="help-body">
    <h3>它是什么</h3>
    YangTex 是本机的轻量 LaTeX 写作台：Python 标准库起一个本地服务，浏览器作界面，
    调用你机器上的 TeX 引擎编译。没有 Electron、没有账号、没有云同步，
    双击启动器即可打开，<b>全程无终端窗口</b>。
    <h3>⚡ 极速模式与编译速度的极限</h3>
    顶栏「<b>⚡ 极速</b>」默认开启，包含三件事：
    ① <b>按源码自动选最快引擎</b>——纯英文 / 拉丁文档走 <code>pdflatex</code>
    （约 0.8 秒），中文、ctex、fontspec、unicode-math 或非拉丁字符自动走
    <code>xelatex</code>（约 1.5 秒）。判断会先剥掉 <code>%</code> 注释，
    所以英文模板里的中文说明不会把引擎误判成 xelatex；
    ② <b>预编译导言区</b>——导言用 <code>pdflatex -ini … \\dump</code> 生成
    <code>.fmt</code> 并全局缓存，每轮只排版正文，TeX 阶段再省约 20–30%；
    正文文件把导言的每一行替换成空行来<b>保持原始行号</b>，所以双向逐行同步、
    编译错误行号、图片与 .bib 资源全部不变；
    ③ 关闭连续编译时，<b>防抖从 0.28 秒缩到 0.14 秒</b>，状态栏成功信息带「⚡」表示命中极速通道。
    中文 / 字体类文档、Markdown 中文模板、导言无法预编译的文档、
    「完整编译」以及任何异常都会<b>自动退回标准编译</b>，不会把文档编坏。
    手动在「引擎」里选具体引擎会自动关闭极速模式，把控制权交还给你。
    <br>要说明白的是：Texifier / Texpad 的「每敲一键就出结果」来自它们
    <b>内置的增量排版引擎（TexpadTeX）</b>——只重排光标到可见区域之间的内容、
    结果直接画进显存，不每轮生成磁盘 PDF，也不依赖外部 TeX 发行版。
    YangTex 走的是本机 TeX Live，每轮至少有一次进程启动 + 完整排版
    （本机实测下限约 0.5 秒）。「⇶ 连续编译」让它<b>不等停手、打字过程中持续出中间帧</b>，
    但每一帧仍是一次完整排版，约 0.5–0.9 秒后才追上当时的输入；
    这个架构差决定了它只能「接近」，不能等同；
    想要真正逐键实时，需要换内置 typesetter，那已经不是轻量方案了。
    <h3>🧩 准增量预览（页级失效分析）</h3>
    不改 TeX 引擎、不动版式语义，把「预览」这一半做成增量：后端每次编译完
    用零依赖解析器读出 <b>每页内容流指纹</b> 和一份排除时间戳元数据的全局指纹
    （支持 pdfTeX 压缩对象流与 xelatex 传统对象）。
    ① 全局指纹没变（例如只加注释、改 <code>\\label</code>、调空白）——
    <b>整份 PDF 重新解析与重绘都跳过</b>，状态栏显示「复用预览」；
    ② 只有几页变了——<b>只重画那几页</b>，其余页沿用已画好的画布与文本层，
    状态栏显示「增量 1/5 页」；③ 页数变化、资源变化或 PDF 结构无法解析时
    自动退化为全量渲染，宁可少优化也绝不显示过期画面。
    编译产物同时留在服务端内存流里，<code>/api/pdf</code> 带 <code>ETag</code>，
    不必每轮重读磁盘。实测短文档「无视觉变化的编辑」约 1.08 → 0.84 秒，
    五页文档「只改一页」约 1.35 → 1.25 秒；剩余耗时仍是 TeX 全量排版本身。
    <h3>⚡ 语义免编译与启动开销压缩</h3>
    后端会逐行还原「<b>TeX 真正看得见的字符流</b>」（区分真注释与
    <code>\\%</code>、保留行数与行尾注释标记）。若与上次成功编译一致，
    <b>连 TeX 进程都不启动</b>，直接复用已有 PDF / aux / SyncTeX，
    状态栏显示「免编译」：改写注释、调整行尾空格、撤回绕回旧内容这类编辑
    从约 0.6 秒降到接近 0。<b>安全性优先</b>：出现
    <code>verbatim</code> / <code>lstlisting</code> / <code>\\url</code> /
    <code>\\input</code> / <code>\\today</code> 等无法可靠推断的构造、
    或项目里图片 / <code>.bib</code> 等外部文件有改动时，一律照常编译；
    「完整编译」与切换引擎也从不走捷径。
    另外给 TeX 子进程只传必要环境变量（宿主环境常有一两百个变量，
    实测拖慢启动约 38ms），并关闭 pdf.js 对小 PDF 的 Range / 预取请求（约 23ms）。
    <h3>⇶ 连续编译（边打字边编译）</h3>
    顶栏「<b>⇶ 连续编译</b>」默认开启：<b>不再等停手</b>，每次输入后约一帧
    （20ms）就启动一轮 TeX，打字过程中预览持续跟着更新，状态栏显示「● 连续编译…」。
    实现上仍是<b>单飞调度</b>——同一时刻只有一轮编译在跑，编辑期间回来的结果
    作为「安静中间帧」画进预览（不报 ✓、不弹错误面板、不覆盖问题列表），
    停手 0.26 秒后自动补一轮正式编译收尾；所以不会堆积任务，
    半输入态的报错也不会打断写作。中文输入法组字期间自动跳过，
    候选字上屏后才补编译。关闭此开关即回到「停手 0.14 秒才编译」的传统防抖，
    偏好写入 <code>.state.json</code>，下次启动保持。
    <br>诊断：在页面脚本运行前设 <code>window.__YT_NO_CONTINUOUS = true</code>
    可在同一份代码上临时对照旧行为。
    <h3>实时编译与自动补全</h3>
    除连续编译外，也可按 <kbd>⌘/Ctrl + Enter</kbd> 立即编译。整条链路已针对延迟优化：
    打字期间产生的过期编译结果作为中间帧渲染、下一轮立即接上，日志异步读取，
    PDF 只重绘变化的页面并优先画当前可见页，多页并行渲染；
    <b>源码与磁盘内容自上次成功编译后没变时整轮 TeX 直接跳过</b>
    （状态栏显示「✓ 已是最新」），撤回 / 重做绕回原内容时尤其省时。
    切换项目、换引擎、手动点「▶ 编译」仍会强制真正重编一次。
    剩余耗时主要是本机 TeX 引擎本身（中文 xelatex 约 1 秒），这是编译的硬开销。
    开启顶栏「<b>宏包补全</b>」时，一旦写到 <code>\\includegraphics</code>、
    <code>align</code>、<code>\\mathbb</code>、<code>\\toprule</code> 等需要宏包的命令或环境，
    会自动把 <code>\\usepackage{...}</code> 补进导言区（不重复、不打断光标、忽略注释）。
    编译失败时<b>保留上一次成功的 PDF</b>，底部面板自动展开、工作区同步让出高度并列出错误，
    点击任一条即跳到源码行；也可直接点「问题 / 编译日志 / 环境」标签或「▲ 展开」查看，
    再点「▼ 收起」还原。
    <h3>预览刷新不抖动</h3>
    自动编译刷新时预览<b>保持静止</b>：新页面先在离屏画布上画好，再一帧切换过去，
    可见画布全程不清空、不闪白；页数与尺寸不变时连 DOM 和点击绑定都不重建；
    阅读位置在几何更新的同一帧恢复，并关闭了浏览器的滚动锚定。
    编译状态栏、页信息、问题列表都做了固定宽度 / 内容缓存，文字变化不会推动界面元素。
    逐行同步的高亮框跨编译<b>持续存在</b>，自动同步不再播放闪烁动画，
    更重要的是<b>不会把预览滚回光标处</b>——你滚到哪里就停在哪里。
    需要主动跳转时按 <kbd>F8</kbd> 或点「⇥ 定位到 PDF」，才会平滑滚动并闪一下高亮。
    <h3>环境联想与自动配对</h3>
    输入 <code>\\begin{</code> 立刻弹出环境名联想：方程、对齐、矩阵、定理、图表、
    列表、绘图、算法、Beamer 等 70 多个环境；继续输入名称即可筛选，
    <code>↑</code> / <code>↓</code> 选择，<kbd>Enter</kbd> 或 <kbd>Tab</kbd> 确认，
    <kbd>Esc</kbd> 取消，也可以直接用鼠标点。<b>选中后随即自动补上配对的
    <code>\\end{...}</code></b>。<b>手打完整环境名也一样</b>：敲下 <code>}</code>
    或换行就会自动补 <code>\\end{...}</code>；tabular / minipage 这类还要跟参数的环境
    有 150ms 宽限期，继续敲 <code>{</code> 不会把参数吞掉。
    <h3>插入即可编译的骨架</h3>
    插入的不是空壳，而是<b>最小可编译骨架</b>：数学环境带被选中的 <code>{}</code> 占位、
    列表自动写 <code>\\item</code>、tabular / minipage / wrapfigure / thebibliography
    带好必填参数。直接输入就替换占位；不写也不会因「Missing $」或「missing \\item」弹错误面板。
    依赖的宏包（align → amsmath、tikzpicture → tikz）会补进导言区；
    定理类环境自动写 <code>\\newtheorem</code>，中文文档（ctex / ctexart / xeCJK，
    或正文已大量使用中文）用「定理 / 引理」等标题，其余用英文。
    <code>axis</code> 自动外包 <code>tikzpicture</code>，<code>subfigure</code> 自动外包
    <code>figure</code> 并补宽度、<code>\\centering</code> 与 <code>\\caption</code>。
    <h3>数学模式与依赖诊断</h3>
    <code>cases / matrix / aligned / split</code> 等自身不开启数学模式的环境，
    若光标不在数学模式内，会自动用 <code>\\[ … \\]</code> 包住；
    而 <code>equation / align / gather / math</code> 等<b>自带数学模式</b>的环境不会被包裹
    （包了反而报 Bad math environment delimiter）。已在
    <code>equation</code> / <code>$…$</code> / <code>\\[…\\]</code> 内也不会重复包裹。
    浮层底部会实时说明当前环境插入后会发生什么，<b>⚠</b> 标出真正的前置条件：
    本机缺少的宏包（由 kpsewhich 实测）、<code>frame / columns / column / block</code>
    需要 <code>beamer</code> 文档类、<code>\\appendix</code> 其实是命令而非环境等。
    <h3>联想分组与偏好</h3>
    无前缀时列表按「<b>最近使用</b> / <b>常用</b> / <b>分类</b>」分组，
    输入前缀后自动退回纯匹配度排序，不让分组标题打断查找。
    浮层顶部三个开关可分别控制「自动补 \\end{}」「数学模式包裹」「分组」，
    顶栏「<b>环境联想</b>」是总开关；这些偏好与主题、引擎一起保存在
    <code>.state.json</code>，换浏览器或换设备都一致（旧版 localStorage 偏好会自动迁移）。
    整次插入算一步，<kbd>⌘/Ctrl + Z</kbd> 可一次撤回。
    注释行、中文输入法组字期间不会弹出；联想打开时暂不启动半成品编译，
    避免刚选完就被错误面板打断。
    <h3>数学期刊官方模板与分类</h3>
    模板库把全部模板按出版商 / 用途分类：AMS、SIAM、Springer、Elsevier、IEEE、
    AIMS、EMS、中文数学期刊、预印本、中文写作、报告讲义、Markdown 与混排等。
    点顶栏「▤ 模板」里的分类按钮可只看一类，也可直接搜索期刊名 / 出版商 / 标签；
    「全部」视图按出版商分组，卡片上标出期刊全名。<br>
    内置 JAMS、Trans. AMS、Math. Comp.、SIAM 系列、Inventiones、Math. Annalen、
    CMP、JDE、JFA、Advances in Mathematics、AIMS Mathematics、DCDS、
    《中国科学：数学》《数学学报》等主流数学期刊的投稿模板，均使用期刊官方文档类
    （<code>amsart</code> / <code>elsarticle</code> / <code>IEEEtran</code> /
    <code>siamart</code> / <code>svjour3</code> / <code>aimsart</code> / <code>llncs</code>）。
    官方类已装时显示 <b>◈ 官方模板</b>，编译出正式期刊版式；未装时显示
    <b>◐ 官方类待装</b>，自动降级为 article 预览排版，仍能正常编译与双向逐行同步。
    把期刊官网下载的 <code>.cls</code> / <code>.sty</code> 放进
    <code>YangTex/templates/classes/</code> 即对所有项目生效，新建项目还会自动复制一份，
    方便打包投稿；YangTex 不随包再分发第三方类文件，避免许可问题。
    少数期刊（Annals、Duke、IMRN 及中文期刊）没有公开官方类，卡片标
    <b>◇ 规范底稿</b>，按投稿规范用 amsart / ctexart 排好版。
    <h3>Markdown 模板：直接用 Markdown 语法写</h3>
    模板库里「Markdown 模板」与「Markdown / LaTeX 混排」共 8 份，
    卡片上有 <code>MD</code> / <code>MD+TeX</code> 标识。套用或新建项目后
    <b>编辑器里装的就是 Markdown 源码</b>：标题用 <code>#</code>、列表用 <code>-</code>、
    表格用 <code>|</code>、粗体用 <code>**…**</code>，而不是
    <code>\\section</code> / <code>\\begin{itemize}</code>。编辑器标题栏显示
    <code>main.md</code> / <code>main.mdtex</code> 与绿色「Markdown 源」徽标。<br>
    每次保存，YangTex 用<b>内置零依赖转换器</b>同步生成编译用的 <code>main.tex</code>：
    不需要 pandoc、不需要 <code>markdown.sty</code>、也不开 <code>-shell-escape</code>。
    生成的 <code>main.tex</code> 是只读产物，点「<b>⟨TeX⟩ 查看</b>」可核对，请勿直接改。
    双向逐行同步与编译错误定位会自动把 .tex 行号换算回 Markdown 行号。<br>
    <code>.md</code> 写纯 Markdown；<code>.mdtex</code> 可以混着写：
    <code>$…$</code> 与 <code>$$…$$</code> 写数学，再用
    <code>:::latex</code> … <code>:::</code> 包住定理、证明、align、figure 等原样 LaTeX。
    文件开头的 <code>---</code> front matter 可设置
    <code>title / author / date / class / engine / lang / packages</code>。<br>
    拖入图片会插入标准 <code>![说明](图片){w=80%}</code>，自动生成居中 figure 与 label；
    工具面板里的 LaTeX 片段会自动包成 <code>$…$</code> 或 <code>:::latex</code> 原样块。
    在 LaTeX 项目里仍可用「<b>MD→TeX</b>」把选中片段就地转换（可一次撤回）。
    「添加自定义模板」支持 LaTeX / Markdown / 混排三种格式，
    直接把 <code>.md</code> / <code>.mdtex</code> 放进 <code>templates/</code>
    也会被自动识别。
    <h3>撤回 / 重做</h3>
    编辑器工具栏左侧有「<b>↶ 撤回</b>」「<b>↷ 重做</b>」两个按钮（不可用时置灰），
    也可用 <kbd>⌘/Ctrl + Z</kbd> 撤回、<kbd>⌘/Ctrl + Shift + Z</kbd> 或
    <kbd>Ctrl + Y</kbd> 重做，右键菜单里的「撤销 / 重做」同样有效。
    YangTex 使用<b>自己的快照历史</b>而不是浏览器原生撤销栈：因为宏包自动补全、
    工具面板、插入图片、AI 代码块都会程序化改写源码，会清空浏览器原生历史。
    现在这些改动都和打字一起按步记录，撤回后还会回到当时的<b>光标与滚动位置</b>，
    且不会被宏包补全立刻「补回来」。连续打字自动合并成一步；切换项目或套用模板会重置历史。
    <h3>插入图片与调整大小</h3>
    把 PNG / JPG / PDF / EPS 图片<b>直接拖进窗口</b>（或点编辑器右上「▣ 插入图片」选择文件），
    图片保存到当前项目目录，并自动插入带 <code>\\centering</code>、<code>\\caption</code>
    与 <code>\\label{fig:...}</code> 的居中 figure 环境；插入点会自动避开导言区和
    <code>\\end{document}</code> 之后，同时确保导言区有 graphicx。
    插入后左下角出现「<b>图片显示大小</b>」浮层：可选 30% / 50% / 80% / 100% / 原始，
    或填 <code>6cm</code>、<code>0.6\\linewidth</code>、<code>240pt</code> 等自定义宽度；
    改动立即写回源码并重新编译，选择会被记住。
    <h3>预览显示大小 / 预览区大小</h3>
    预览栏顶部「<b>实时预览</b>」<b>标题右侧</b>就是缩放控件：<code>−</code> / 百分比 /
    <code>＋</code> / <code>⤢ 适配</code> / <code>100</code>，一眼可见、随手可调；
    在 PDF 上按 <kbd>⌘/Ctrl + 滚轮</kbd> 也能直接缩放。预览栏变窄时（例如打开 AI 助手），
    工具栏会自动收起次要文字，缩放按钮始终完整可见。
    中间分隔条可<b>拖动</b>调整「代码 / 预览」两栏宽度，<b>双击</b>恢复 50% / 50%；
    点底栏的「<b>⛶ 放大预览</b>」把预览铺满整个工作区，再点一次或按 <kbd>Esc</kbd> 还原。
    缩放偏好自动保存，下次打开保持一致。
    <h3>打开与下载 PDF</h3>
    预览工具栏有两个独立入口：「<b>↗ 打开 PDF</b>」在新标签页用浏览器自带的 PDF 查看器打开
    <code>main.pdf</code>，可放大、搜索、打印或系统另存；「<b>↓ 下载 PDF</b>」把当前 PDF
    以「项目名.pdf」直接保存到下载目录（中文项目名也保持原样）。下载走浏览器本地文件流，
    不依赖服务器附件头，因此<b>刷新页面即可生效</b>；「▣ 文件夹」可打开项目目录直接取文件。
    <h3>双向逐行同步（SyncTeX）</h3>
    <ul>
      <li><b>源码 → PDF</b>：把光标放在某一行，按 <kbd>F8</kbd> 或点「⇥ 定位到 PDF」，
          平滑滚动到对应排版位置并高亮；开启「逐行同步」后移动光标会自动高亮，
          但<b>不会抢走你当前的预览滚动位置</b>，自动编译刷新时也不会。</li>
      <li><b>PDF → 源码</b>：<b>单击</b>预览中的任意文字，编辑器精确跳回该行；
          点击行间空白会吸附到最近的文本项，因此命中率极高；拖拽滚动页面不会误触。</li>
    </ul>
    <h3>工具面板</h3>
    点「🧰 工具面板」或按 <kbd>⌘/Ctrl + K</kbd> 打开，按宏命令、运算符、<b>箭头</b>、定界符、
    环境、函数、字体、表格、表情包等分类一键插入 LaTeX 片段。若已选中文字，带 <code>{}</code>
    的命令会自动包裹选区；字体分类有「字体对话框…」，表格分类有「插入表格…」，
    表情包分类可按笑脸 / 手势 / 学术 / 标记 / 庆祝 / 数学符号筛选。
    <h3>中英文与模板</h3>
    中文模板使用 <code>ctexart + fontset=fandol</code> 并以 <b>xelatex</b> 编译（跨平台自带字体）；
    英文模板用 pdflatex。内置 AMS 三件套、PDE 论文、Elsevier、IEEE、SIAM、Springer、AIMS、
    arXiv、中文期刊、中英双语、Beamer、讲义等模板。
    <b>添加模板</b>：把 <code>.tex</code> 放进 <code>templates/</code> 目录，或在模板库里粘贴保存。
    <h3>AI 辅助</h3>
    点「✦ AI 助手」或按 <kbd>⌘/Ctrl + /</kbd>。它作为<b>右侧第三栏</b>停靠，
    与「代码｜预览」并排，工作区会自动让出宽度，<b>完全不遮挡 PDF 预览</b>；
    工具面板与 AI 共用这一栏且互斥。可解释选中公式、润色、中英互译、
    生成 LaTeX、诊断编译错误。接入免费大模型通道，<b>无需注册、无需 API Key、无需任何设置</b>。
    顶部「模型 / 通道」可<b>自动选最快</b>、指定某个免费模型，或锁定某条传输通道；
    模型清单从官方接口动态读取，新增匿名免费模型时无需升级 YangTex。
    「⚡ 测速选优」实测各通道连接速度并结合历史真实耗时重新排序；默认走<b>流式输出</b>，
    首字一到就开始显示。匿名免费层对同一 IP 限制为「一次一个请求、间隔 30 秒」；
    <b>一旦限流或断网，AI 不会空白、也不会一直转圈</b>：立刻给出内置 LaTeX 知识助手的答案
    （可编译片段与错误排查，问 amsmath / 中文 / 图片 / 定理 / 表格 / 参考文献 / 编译错误等），
    冷却结束后自动把同一条消息替换为在线大模型答案，也可点「立即重试在线大模型」。
    「<b>🔍 自检</b>」一键查看本地服务、免费模型接口、各通道实测耗时与冷却状态。
    只有你主动点击时才会发送选中的文字。
    <h3>公式 / 引用编号悬停指向</h3>
    PDF 里带虚线下划线的 <code>(1)</code>、<code>[2]</code> 就是编号热区，
    <b>鼠标离编号 28px 内也能命中</b>；编号被 pdf.js 拆成 <code>(</code> <code>1</code> <code>)</code>
    三个文本项、或夹在整句里、或写成 <code>[1,2]</code>，都能识别。
    编号优先取自每次编译的 <code>main.aux</code>（<code>\\newlabel</code> / <code>\\bibcite</code>），
    缺失时依次用 <code>.bbl</code>、aux 引用顺序、源码 <code>\\bibitem</code> 顺序兜底；
    没写 <code>\\label</code> 的公式按真实公式环境顺序补号（<code>\\[...\\]</code>、<code>equation*</code>
    等不编号环境不会误占号）。<b>不靠 OCR</b>，章节号和公式号同为
    <code>1</code> 时也不会指错。悬停弹出卡片：公式显示<b>从 PDF 页上裁出的缩略图</b>、
    原始 TeX 片段、标签名与页码；<code>\\cite{key}</code> 对应的文献显示条目全文、来源文件与真实性徽标。
    编辑器里的 <code>\\eqref{...}</code> / <code>\\ref{...}</code> /
    <code>\\cite{key}</code> / <code>\\citep{...}</code> / <code>\\cite[说明]{key}</code>
    同样可以精确悬停反查；引用键找不到时会提示检查文献表，不会毫无反应。
    卡片刻意做得<b>紧凑</b>：公式只显示从 PDF 裁出的缩略图 + 一行标签信息，
    <b>不再铺开 TeX 源码</b>，文献条目也压成一行，避免盖住正文；
    要看完整源码，<b>点一下卡片</b>就跳到源码对应行并在 PDF 中高亮定位。
    <h3>◉ 参考文献管理</h3>
    顶栏「◉ 文献」打开面板，三个页签：<br>
    内置模板里所有含文献表的模板都已在正文补上 <code>\\cite{...}</code>，
    新建项目后不会出现「文献没有被引用」；已经创建过的旧项目内容不会被自动改写，
    需要时自行在正文加一条 <code>\\cite{key}</code> 即可。<br>
    ① <b>文献条目</b>——同时兼容外部 <code>.bib</code> 与源码内嵌
    <code>thebibliography / \\bibitem</code>，可新增、编辑、删除；保存后会重载源码并
    自动做一次<b>完整编译</b>（含 BibTeX），让编号与 PDF 立刻一致。项目里还没有文献表时，
    保存会自动新建 <code>references.bib</code> 并挂接
    <code>\\bibliographystyle{plain}</code> + <code>\\bibliography{references}</code>。<br>
    ② <b>引用检查</b>——漏引（<code>\\cite</code> / <code>\\eqref</code> 指向不存在的键）、
    文献未被引用、引用键重复、作者 / 标题 / 年份不全、.bib 未挂接、缺
    <code>\\bibliographystyle</code> 等，逐条给出源码行号，点击即可跳过去。<br>
    ③ <b>真实性核验</b>——把条目的标题 / 作者 / 年份 / DOI 送到
    <b>CrossRef、OpenAlex、Semantic Scholar</b> 三个免费公开索引比对，
    无需 API Key、不上传正文；DOI 精确命中或标题相似度 ≥ 0.58 记为「已核实」，
    结果缓存 7 天，断网时显示「离线未核验」而<b>不会误判成假文献</b>。
    <h3>⇪ 投稿包（干干净净）</h3>
    点「⇪ 投稿包」可先看清单再下载 zip。源码里的 <code>%</code> 注释会被清除，
    但 <code>\\%</code>、<code>verbatim</code>、<code>lstlisting</code>、
    <code>minted</code>、<code>comment</code> 环境内的百分号原样保留；
    <code>.aux / .log / .out / .synctex.gz</code> 等辅助文件一律剔除，
    只打包源码、Markdown 主源、图片、<code>.bib</code>、类文件、PDF 与
    <code>投稿说明.txt</code> 清单。可选「去除注释」「附带生成的 PDF」「合并连续空行」。
    <h3>📽 投影与自动播放</h3>
    点顶栏「📽 投影」或预览栏的「📽 投影」进入全屏演示，用独立的 pdf.js 文档渲染，
    <b>不影响左侧的零抖动实时预览</b>。<kbd>←</kbd> / <kbd>→</kbd> / <kbd>空格</kbd> 翻页，
    点击画面左右两侧也能翻页；<kbd>P</kbd> 开 / 关自动播放（间隔 1–60 秒，末页循环），
    <kbd>B</kbd> 黑屏、<kbd>W</kbd> 白屏、<kbd>L</kbd> 激光笔、<kbd>Home/End</kbd> 首末页，
    <kbd>Esc</kbd> 退出。<br>
    点 <kbd>✎ 批注</kbd>（或 <kbd>A</kbd>）可在幻灯片上写画：5 色、3 档粗细、
    逐笔撤销（<kbd>U</kbd>）、清除本页（<kbd>C</kbd>）、存成 PNG；笔迹<b>按页保留</b>，
    翻页、缩放、进出全屏都会自动重绘。<kbd>⛶ 全屏</kbd>（或 <kbd>F</kbd>）切换原生全屏，
    浏览器不允许时自动降级为沉浸模式。
    <h3>快捷键</h3>
    <kbd>⌘/Ctrl + Enter</kbd> 编译 · <kbd>⌘/Ctrl + S</kbd> 保存 ·
    <kbd>⌘/Ctrl + Z</kbd> 撤回 · <kbd>⌘/Ctrl + Shift + Z</kbd> 重做 ·
    <kbd>F8</kbd> 定位到 PDF · <kbd>⌘/Ctrl + /</kbd> AI 助手 · <kbd>⌘/Ctrl + K</kbd> 工具面板 ·
    <kbd>Esc</kbd> 关闭弹层
    <h3>🖥 启动与系统支持</h3>
    <b>macOS</b> 双击 <code>YangTex.app</code> · <b>Windows</b> 双击
    <code>双击启动 YangTex.vbs</code>（备用 <code>备用启动 YangTex.bat</code>）·
    <b>Linux</b> 双击 <code>启动 YangTex.sh</code>（或终端运行）。三者都是
    一键启动、自动开浏览器、<b>不保留终端窗口</b>，并会重启旧实例以载入最新代码。<br>
    需要 Python 3.10+ 与 TeX Live / MiKTeX（xelatex、pdflatex）。Linux 无图形会话时
    不会自动开浏览器，脚本会打印本机地址，手动打开即可；也可用
    <code>BROWSER=...</code> 指定浏览器。
    <h3>当前环境</h3>
    TeX 引擎：${e.tex_ready ? '<span class="env-ok">✓ 已就绪</span>' : '<span class="env-no">✗ 未检测到，请安装 TeX Live / MiKTeX</span>'} ·
    SyncTeX：${e.synctex_ready ? '✓' : '✗'} · 模板 ${S.templates.length} 个 ·
    AI：${esc(e.ai?.model || 'openai-fast')}（免费，无需 Key）
    <h3>退出</h3>
    点右上角 <kbd>⏻</kbd> 会关闭本地服务并停止后台进程；也可直接关闭本页面后再退出启动器。
  </div>`);
}

// ------------------------------------------------------------------ 工具面板
// 片段语法：'{}' = 选区包裹位；'§' = 插入后光标停留位（优先级更高）。
const TP_CURSOR = '§';
// 表情包分组：全部展开 160+ 个，也可按子分类筛选
const TP_EMOJI_GROUPS = [
  { name: '笑脸', list: ('😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😎 🤓 🧐 🤔 😐 😑 😶 😴 😪 😭 😤 🥺 😱 🤗 🤭 🙄 😬 🤯 🥳').split(' ') },
  { name: '手势', list: ('👍 👎 👌 ✌️ 🤞 🤟 🤘 👏 🙌 🤝 👋 ✋ 🖐️ 👆 👇 👈 👉 ✊ 👊 ✍️ 💪 🙏 🫶 🤙 👀 🧠').split(' ') },
  { name: '学术', list: ('📐 📊 📈 📉 📚 📖 📝 🧮 🔬 🔭 🧪 🧬 🖥️ ⌨️ 💡 🎓 🏫 ✏️ 📌 📎 🗂️ 🧾 🔖 📏 ⚗️ 🧲 🔍 🗒️ 📋 🖊️').split(' ') },
  { name: '标记', list: ('✅ ❌ ⚠️ ❗ ❓ ‼️ ⁉️ ⭕ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ✔️ ✖️ ➕ ➖ ➗ ✳️ ✴️ 💯 🔔 🔕 🔒 🔓 🚩 🏁').split(' ') },
  { name: '庆祝', list: ('🎉 🎊 🎈 🎁 🏆 🥇 ⭐ 🌟 ✨ 🔥 💥 💫 🏅 🎯 🚀 🌈 ☀️ 🌙 ⚡ ❤️ 💖 💙 💚 💛 🍀 🌸 🐱 🐶').split(' ') },
  { name: '数学符号', list: ('∞ ≠ ≤ ≥ ± × ÷ ∑ ∫ ∂ ∇ √ ∝ ∈ ∉ ⊂ ⊆ ∪ ∩ ∀ ∃ ∴ ∵ ≈ ≡ ≪ ≫ ∅ ∠ ⊥ ∥ ⌈ ⌉ ⌊ ⌋ ✓ ✗ ★ ☆ ♠ ♣ ♥ ♦ ◦ ‖').split(' ') },
];
const TP_CATS = [
  { id: 'cmd', icon: '#', name: '宏命令', items: [
    { l: '\\documentclass', s: '\\documentclass{article}' },
    { l: '\\usepackage', s: '\\usepackage{}' },
    { l: '\\begin / \\end', s: '\\begin{equation}\n  §\n\\end{equation}' },
    { l: '\\section', s: '\\section{}' },
    { l: '\\subsection', s: '\\subsection{}' },
    { l: '\\textbf', s: '\\textbf{}' },
    { l: '\\textit', s: '\\textit{}' },
    { l: '\\underline', s: '\\underline{}' },
    { l: '\\emph', s: '\\emph{}' },
    { l: '\\label', s: '\\label{}' },
    { l: '\\ref', s: '\\ref{}' },
    { l: '\\cite', s: '\\cite{}' },
    { l: '\\footnote', s: '\\footnote{}' },
    { l: '\\caption', s: '\\caption{}' },
    { l: '\\includegraphics', s: '\\includegraphics[width=0.8\\textwidth]{}' },
    { l: '居中插图环境', t: '插入带 caption / label 的居中 figure 环境', cls: 'special',
      s: '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{§}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}' },
    { l: '\\newpage', s: '\\newpage' },
    { l: '\\clearpage', s: '\\clearpage' },
    { l: '% 注释', t: '插入一行注释', cls: 'special', s: '% ' },
    { l: '\\usepackage[选项]', s: '\\usepackage[]{}' },
    { l: '\\maketitle', s: '\\maketitle' },
    { l: '\\tableofcontents', s: '\\tableofcontents' },
    { l: '\\centering', s: '\\centering' },
  ] },
  { id: 'op', icon: '±', name: '运算符', symbol: true, items: [
    { l: '+', s: '+ ' }, { l: '−', s: '- ' }, { l: '×', s: '\\times ', t: '\\times（数学模式）' },
    { l: '÷', s: '\\div ', t: '\\div（数学模式）' }, { l: '±', s: '\\pm ' }, { l: '∓', s: '\\mp ' },
    { l: '≤', s: '\\le ' }, { l: '≥', s: '\\ge ' }, { l: '≠', s: '\\ne ' },
    { l: '≈', s: '\\approx ' }, { l: '≡', s: '\\equiv ' }, { l: '∼', s: '\\sim ' },
    { l: '≪', s: '\\ll ' }, { l: '≫', s: '\\gg ' }, { l: '∈', s: '\\in ' },
    { l: '∉', s: '\\notin ' }, { l: '⊂', s: '\\subset ' }, { l: '⊆', s: '\\subseteq ' },
    { l: '∪', s: '\\cup ' }, { l: '∩', s: '\\cap ' }, { l: '∅', s: '\\varnothing ' },
    { l: '∀', s: '\\forall ' }, { l: '∃', s: '\\exists ' }, { l: '∞', s: '\\infty ' },
    { l: '∂', s: '\\partial ' }, { l: '∇', s: '\\nabla ' }, { l: '⋯', s: '\\cdots ' },
    { l: '·', s: '\\cdot ' },
    { l: '→', s: '\\to ' }, { l: '←', s: '\\leftarrow ' }, { l: '↔', s: '\\leftrightarrow ' },
    { l: '⇒', s: '\\Rightarrow ' }, { l: '⇔', s: '\\Leftrightarrow ' }, { l: '↦', s: '\\mapsto ' },
    { l: '↑', s: '\\uparrow ' }, { l: '↓', s: '\\downarrow ' },
  ] },
  { id: 'arrow', icon: '→', name: '箭头', symbol: true, items: [
    { l: '→', s: '\\to ' }, { l: '←', s: '\\leftarrow ' }, { l: '↔', s: '\\leftrightarrow ' },
    { l: '⇒', s: '\\Rightarrow ' }, { l: '⇐', s: '\\Leftarrow ' }, { l: '⇔', s: '\\Leftrightarrow ' },
    { l: '↦', s: '\\mapsto ' }, { l: '⟼', s: '\\longmapsto ' },
    { l: '↪', s: '\\hookrightarrow ' }, { l: '↩', s: '\\hookleftarrow ' },
    { l: '⇀', s: '\\rightharpoonup ' }, { l: '↽', s: '\\leftharpoonup ' },
    { l: '⇝', s: '\\rightsquigarrow ' }, { l: '⇢', s: '\\leadsto ' },
    { l: '⟶', s: '\\longrightarrow ' }, { l: '⟵', s: '\\longleftarrow ' },
    { l: '⟷', s: '\\longleftrightarrow ' }, { l: '⟹', s: '\\Longrightarrow ' },
    { l: '⟸', s: '\\Longleftarrow ' }, { l: '⟺', s: '\\Longleftrightarrow ' },
    { l: '↑', s: '\\uparrow ' }, { l: '↓', s: '\\downarrow ' }, { l: '↕', s: '\\updownarrow ' },
    { l: '⇑', s: '\\Uparrow ' }, { l: '⇓', s: '\\Downarrow ' }, { l: '⇕', s: '\\Updownarrow ' },
    { l: '↗', s: '\\nearrow ' }, { l: '↘', s: '\\searrow ' },
    { l: '↙', s: '\\swarrow ' }, { l: '↖', s: '\\nwarrow ' },
    { l: '⟹', s: '\\implies ', t: '\\implies（需 amsmath）' },
    { l: '⟺', s: '\\iff ', t: '\\iff（需 amsmath）' },
    { l: '\\xrightarrow{}', s: '\\xrightarrow{§}', cls: 'wide' },
    { l: '\\xleftarrow{}', s: '\\xleftarrow{§}', cls: 'wide' },
    { l: '\\xRightarrow{}', s: '\\xRightarrow{§}', cls: 'wide' },
    { l: '\\xleftrightarrow{}', s: '\\xleftrightarrow{§}', cls: 'wide' },
    { l: '\\overset{}{}', s: '\\overset{§}{}' }, { l: '\\underset{}{}', s: '\\underset{§}{}' },
    { l: '\\xrightarrow[下]{上}', s: '\\xrightarrow[§]{}' },
    { l: ' Unicode →', s: '→', t: '直接插入 Unicode 箭头（xelatex 文本模式）' },
    { l: ' Unicode ⇒', s: '⇒', t: '直接插入 Unicode 双箭头' },
    { l: ' Unicode ⟺', s: '⟺', t: '直接插入 Unicode 等价箭头' },
  ] },
  { id: 'delim', icon: '( )', name: '定界符', items: [
    { l: '( )', s: '(§)' }, { l: '[ ]', s: '[§]' },
    { l: '\\{ \\}', s: '\\{ § \\}' }, { l: '\\langle \\rangle', s: '\\langle § \\rangle' },
    { l: '\\left( \\right)', s: '\\left( § \\right)' },
    { l: '\\left[ \\right]', s: '\\left[ § \\right]' },
    { l: '\\left\\{ \\right\\}', s: '\\left\\{ § \\right\\}' },
    { l: '\\left| \\right|', s: '\\left| § \\right|' },
    { l: '\\lvert \\rvert', s: '\\lvert § \\rvert' },
    { l: '\\lVert \\rVert', s: '\\lVert § \\rVert' },
    { l: '\\lceil \\rceil', s: '\\lceil § \\rceil' },
    { l: '\\lfloor \\rfloor', s: '\\lfloor § \\rfloor' },
    { l: '\\bigl( \\bigr)', s: '\\bigl( § \\bigr)' },
    { l: '\\Bigl[ \\Bigr]', s: '\\Bigl[ § \\Bigr]' },
    { l: '\\left. \\right|_{}', s: '\\left. § \\right|_{}' },
    { l: '\\left\\langle \\right\\rangle', s: '\\left\\langle § \\right\\rangle' },
  ] },
  { id: 'env', icon: '▤', name: '环境', items: [
    { l: 'equation', s: '\\begin{equation}\n  §\n\\end{equation}' },
    { l: 'equation*', s: '\\begin{equation*}\n  §\n\\end{equation*}' },
    { l: 'align', s: '\\begin{align}\n  § &= \\\\\n  &\n\\end{align}' },
    { l: 'gather', s: '\\begin{gather}\n  §\n\\end{gather}' },
    { l: 'cases', s: '\\begin{cases}\n  § & \\text{if } \\\\\n    & \\text{otherwise}\n\\end{cases}' },
    { l: 'itemize', s: '\\begin{itemize}\n  \\item §\n  \\item \n\\end{itemize}' },
    { l: 'enumerate', s: '\\begin{enumerate}\n  \\item §\n  \\item \n\\end{enumerate}' },
    { l: 'description', s: '\\begin{description}\n  \\item[§] \n\\end{description}' },
    { l: 'theorem', s: '\\begin{theorem}\n  §\n\\end{theorem}' },
    { l: 'proof', s: '\\begin{proof}\n  §\n\\end{proof}' },
    { l: 'figure', s: '\\begin{figure}[htbp]\n  \\centering\n  §\n  \\caption{}\n\\end{figure}' },
    { l: 'table', s: '\\begin{table}[htbp]\n  \\centering\n  §\n  \\caption{}\n\\end{table}' },
    { l: 'abstract', s: '\\begin{abstract}\n  §\n\\end{abstract}' },
    { l: 'quote', s: '\\begin{quote}\n  §\n\\end{quote}' },
    { l: 'verbatim', s: '\\begin{verbatim}\n§\n\\end{verbatim}' },
    { l: 'center', s: '\\begin{center}\n  §\n\\end{center}' },
  ] },
  { id: 'fn', icon: 'f', name: '函数', items: [
    { l: '\\frac{}{}', s: '\\frac{§}{}' }, { l: '\\dfrac{}{}', s: '\\dfrac{§}{}' },
    { l: '\\sqrt{}', s: '\\sqrt{}' }, { l: '\\sqrt[n]{}', s: '\\sqrt[n]{}' },
    { l: '\\sum_{}^{}', s: '\\sum_{§}^{}' }, { l: '\\prod_{}^{}', s: '\\prod_{§}^{}' },
    { l: '\\int_{}^{}', s: '\\int_{§}^{}' }, { l: '\\lim_{}', s: '\\lim_{§}' },
    { l: '\\sin', s: '\\sin ' }, { l: '\\cos', s: '\\cos ' }, { l: '\\tan', s: '\\tan ' },
    { l: '\\ln', s: '\\ln ' }, { l: '\\log', s: '\\log ' }, { l: '\\exp', s: '\\exp ' },
    { l: '\\max', s: '\\max ' }, { l: '\\min', s: '\\min ' },
    { l: '\\sup', s: '\\sup ' }, { l: '\\inf', s: '\\inf ' },
    { l: '\\det', s: '\\det ' }, { l: '\\dim', s: '\\dim ' }, { l: '\\gcd', s: '\\gcd ' },
    { l: '\\operatorname{}', s: '\\operatorname{}' }, { l: '\\binom{}{}', s: '\\binom{§}{}' },
    { l: '\\overline{}', s: '\\overline{}' }, { l: '\\hat{}', s: '\\hat{}' },
    { l: '\\vec{}', s: '\\vec{}' }, { l: '\\tilde{}', s: '\\tilde{}' },
    { l: '\\bmod', s: '\\bmod ' },
  ] },
  { id: 'size', icon: 'Aa', name: '字体大小', items: [
    { l: '\\tiny', s: '{\\tiny §}' }, { l: '\\scriptsize', s: '{\\scriptsize §}' },
    { l: '\\footnotesize', s: '{\\footnotesize §}' }, { l: '\\small', s: '{\\small §}' },
    { l: '\\normalsize', s: '{\\normalsize §}' }, { l: '\\large', s: '{\\large §}' },
    { l: '\\Large', s: '{\\Large §}' }, { l: '\\LARGE', s: '{\\LARGE §}' },
    { l: '\\huge', s: '{\\huge §}' }, { l: '\\Huge', s: '{\\Huge §}' },
    { l: '声明式 \\small', s: '\\small\n§\n\\normalsize' },
    { l: '声明式 \\large', s: '\\large\n§\n\\normalsize' },
  ] },
  { id: 'font', icon: 'A', name: '字体', items: [
    { l: '字体对话框…', t: '组合字体族 / 字形 / 字号后插入', cls: 'special', dlg: true },
    { l: '\\textbf', s: '\\textbf{}' }, { l: '\\textit', s: '\\textit{}' },
    { l: '\\texttt', s: '\\texttt{}' }, { l: '\\textsc', s: '\\textsc{}' },
    { l: '\\textsf', s: '\\textsf{}' }, { l: '\\textrm', s: '\\textrm{}' },
    { l: '\\emph', s: '\\emph{}' }, { l: '\\underline', s: '\\underline{}' },
    { l: '\\textsuperscript', s: '\\textsuperscript{}' },
    { l: '\\textsubscript', s: '\\textsubscript{}' },
    { l: '\\uppercase', s: '\\uppercase{}' }, { l: '\\lowercase', s: '\\lowercase{}' },
    { l: '\\bfseries', s: '{\\bfseries §}' }, { l: '\\itshape', s: '{\\itshape §}' },
    { l: '\\ttfamily', s: '{\\ttfamily §}' },
  ] },
  { id: 'table', icon: '▦', name: '表格', items: [
    { l: '插入表格…', t: '按行列数自动生成 tabular 表格', cls: 'special', dlg: true },
    { l: 'tabular', s: '\\begin{tabular}{|c|c|}\n  \\hline\n  § & \\\\\n  \\hline\n\\end{tabular}' },
    { l: 'table + caption', s: '\\begin{table}[htbp]\n  \\centering\n  \\caption{§}\n  \\label{tab:}\n  \\begin{tabular}{|c|c|}\n    \\hline\n     & \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}' },
    { l: '\\hline', s: '\\hline' }, { l: '& 列分隔', s: ' & ' },
    { l: '\\\\ 换行', s: ' \\\\\n' }, { l: '\\multicolumn', s: '\\multicolumn{2}{|c|}{§}' },
    { l: '\\toprule', s: '\\toprule', t: 'booktabs 三线表（需 \\usepackage{booktabs}）' },
    { l: '\\midrule', s: '\\midrule', t: 'booktabs 三线表' },
    { l: '\\bottomrule', s: '\\bottomrule', t: 'booktabs 三线表' },
    { l: '\\caption', s: '\\caption{}' }, { l: '\\label{tab:}', s: '\\label{tab:}' },
    { l: '\\centering', s: '\\centering' },
    { l: '\\resizebox', s: '\\resizebox{\\textwidth}{!}{§}' },
  ] },
  { id: 'emoji', icon: '😀', name: '表情包', emoji: true, groups: TP_EMOJI_GROUPS,
    items: TP_EMOJI_GROUPS.flatMap(g => g.list.map(e => ({
      l: e, s: e, t: '插入 ' + e + '（正文显示需 xelatex + emoji 字体；也可放在注释里）',
    }))).concat([
      { l: '$\\checkmark$', s: '$\\checkmark$' }, { l: '$\\star$', s: '$\\star$' },
      { l: '$\\heartsuit$', s: '$\\heartsuit$' }, { l: '$\\square$', s: '$\\square$' },
      { l: '$\\bullet$', s: '$\\bullet$' }, { l: '$\\dagger$', s: '$\\dagger$' },
    ]) },
];

let tpActive = 'cmd', tpSub = '全部', tpHintTimer = null;

function toolHint(text) {
  const el = $('tpHint');
  el.textContent = text;
  clearTimeout(tpHintTimer);
  tpHintTimer = setTimeout(() => { el.textContent = ''; }, 1800);
}

function tpCat() { return TP_CATS.find(c => c.id === tpActive) || TP_CATS[0]; }

function tpShownItems() {
  const cat = tpCat();
  if (!cat.groups || tpSub === '全部') return cat.items;
  const g = cat.groups.find(x => x.name === tpSub);
  return (g ? g.list : []).map(e => ({
    l: e, s: e, t: '插入 ' + e + '（正文显示需 xelatex + emoji 字体）',
  }));
}

function renderToolCats() {
  $('tpCats').innerHTML = TP_CATS.map(c =>
    `<button class="tp-cat${c.id === tpActive ? ' active' : ''}" data-cat="${c.id}">` +
    `<span class="tp-cat-ico">${esc(c.icon)}</span>${esc(c.name)}</button>`).join('');
}

function renderToolSubcats() {
  const cat = tpCat(), box = $('tpSubcats');
  if (!cat.groups) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const names = ['全部', ...cat.groups.map(g => g.name)];
  box.classList.remove('hidden');
  box.innerHTML = names.map(n =>
    `<button class="tp-subcat${n === tpSub ? ' active' : ''}" data-sub="${esc(n)}">${esc(n)}</button>`).join('');
}

function renderToolGrid() {
  const cat = tpCat(), items = tpShownItems();
  S.tpShown = items;
  const kind = cat.emoji ? ' emoji' : (cat.symbol ? ' sym' : '');
  $('tpGrid').innerHTML = items.map((it, i) =>
    `<button class="tp-item ${kind} ${it.cls || ''}" data-i="${i}" title="${esc(it.t || it.l)}">` +
    `<span>${esc(it.l)}</span></button>`).join('');
  renderToolSubcats();
  renderToolDialog(true);
}

function fontDialogHTML() {
  return `<div class="tp-dlg-head"><b>字体对话框…</b><span>组合字体族 / 字形 / 字号，一次插入带选区的格式命令</span></div>
  <div class="tp-dlg-row">
    <label>字体族<select id="tpFamily">
      <option value="">默认</option><option value="\\rmfamily">罗马 \\rmfamily</option>
      <option value="\\sffamily">无衬线 \\sffamily</option><option value="\\ttfamily">等宽 \\ttfamily</option>
    </select></label>
    <label>字形<select id="tpShape">
      <option value="">默认</option><option value="\\bfseries">粗体 \\bfseries</option>
      <option value="\\itshape">斜体 \\itshape</option><option value="\\scshape">小型大写 \\scshape</option>
      <option value="\\upshape">正体 \\upshape</option>
    </select></label>
    <label>字号<select id="tpSize">
      <option value="">默认</option><option value="\\small">\\small</option>
      <option value="\\large">\\large</option><option value="\\Large">\\Large</option>
      <option value="\\footnotesize">\\footnotesize</option>
    </select></label>
  </div>
  <div class="tp-dlg-actions"><button class="tp-dlg-go" id="tpFontGo">插入到光标处</button>
  <button class="tp-dlg-cancel" id="tpDlgClose">收起</button></div>`;
}

function tableDialogHTML() {
  return `<div class="tp-dlg-head"><b>插入表格…</b><span>生成可直接编译的 table + tabular 骨架</span></div>
  <div class="tp-dlg-row">
    <label>行数<input id="tpRows" type="number" min="1" max="20" value="3"></label>
    <label>列数<input id="tpCols" type="number" min="1" max="12" value="3"></label>
    <label>列对齐<select id="tpAlign"><option value="c">居中 c</option>
      <option value="l">左对齐 l</option><option value="r">右对齐 r</option>
      <option value="p{2.5cm}">定宽 p{2.5cm}</option></select></label>
    <label>外框<select id="tpBorder"><option value="1">带竖线 |</option>
      <option value="0">三线表风格（无竖线）</option></select></label>
  </div>
  <div class="tp-dlg-actions"><button class="tp-dlg-go" id="tpTableGo">插入表格</button>
  <button class="tp-dlg-cancel" id="tpDlgClose">收起</button></div>`;
}

function renderToolDialog(show) {
  const box = $('tpDialog');
  if (!show || !['font', 'table'].includes(tpActive)) {
    box.classList.add('hidden'); box.innerHTML = ''; return;
  }
  box.classList.remove('hidden');
  box.innerHTML = tpActive === 'font' ? fontDialogHTML() : tableDialogHTML();
  $('tpDlgClose').onclick = () => renderToolDialog(false);
  if (tpActive === 'font') {
    $('tpFontGo').onclick = () => {
      const cmds = [$('tpFamily').value, $('tpShape').value, $('tpSize').value].filter(Boolean).join(' ');
      insertSnippet('{' + (cmds ? cmds + ' ' : '') + TP_CURSOR + '}', '字体格式');
    };
  } else {
    $('tpTableGo').onclick = () => insertSnippet(tableSnippet(), '表格');
  }
}

function tableSnippet() {
  const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, parseInt(v, 10) || d));
  const rows = clamp($('tpRows').value, 1, 20, 3);
  const cols = clamp($('tpCols').value, 1, 12, 3);
  const al = $('tpAlign').value || 'c';
  const bordered = $('tpBorder').value === '1';
  const spec = (bordered ? '|' : '') + new Array(cols).fill(al).join(bordered ? '|' : '') + (bordered ? '|' : '');
  const row = r => '    ' + Array.from({ length: cols }, (_, c) => `$a_{${r + 1}${c + 1}}$`).join(' & ') + ' \\\\';
  let body = '';
  if (!bordered) body += '    \\toprule\n';
  else body += '    \\hline\n';
  for (let r = 0; r < rows; r++) {
    body += row(r) + '\n';
    if (!bordered && r === 0) body += '    \\midrule\n';
  }
  body += '    ' + (bordered ? '\\hline' : '\\bottomrule') + '\n';
  const pkg = bordered ? '' : '% 三线表需 \\usepackage{booktabs}\n';
  return pkg + '\\begin{table}[htbp]\n  \\centering\n  \\caption{' + TP_CURSOR + '}\n' +
    '  \\label{tab:new}\n  \\begin{tabular}{' + spec + '}\n' + body +
    '  \\end{tabular}\n\\end{table}';
}

// 工具面板里是 LaTeX 片段；在 Markdown 主源里要包成 $…$ 或 :::latex 原样区，
// 否则 \alpha 之类会被当成正文文字直接排进 PDF。
function mdWrapSnippet(raw) {
  if (S.sourceKind === 'tex') return raw;
  const s = String(raw).trim();
  if (!s || /^!\[[^\]]*\]\(/.test(s) || !s.includes('\\')) return raw;
  if (/\\(begin|end)\s*\{|\\(usepackage|documentclass|section|subsection|caption|label|item|includegraphics|newtheorem)\b/.test(s)) {
    return '\n:::latex\n' + s + '\n:::\n';
  }
  return '$' + s + '$';
}

// 核心：把片段插入光标处；有选区时自动填入 {} 或 § 占位符
function insertSnippet(raw, label) {
  const ed = $('editor');
  const a = ed.selectionStart, b = ed.selectionEnd;
  const sel = ed.value.slice(a, b);
  let text = mdWrapSnippet(raw), caret;
  const ph = text.indexOf(TP_CURSOR);
  if (ph >= 0) {
    text = text.replace(TP_CURSOR, sel);
    caret = ph + sel.length;
  } else if (sel && text.includes('{}')) {
    const i = text.indexOf('{}');
    text = text.slice(0, i) + '{' + sel + '}' + text.slice(i + 2);
    caret = i + 1 + sel.length;
  } else if (text.includes('{}')) {
    caret = text.indexOf('{}') + 1;
  } else {
    caret = text.length;
  }
  ed.focus();
  ed.setRangeText(text, a, b, 'end');
  const pos = a + caret;
  ed.setSelectionRange(pos, pos);
  onEditorInput();
  undoRecord();             // 片段插入作为独立可撤回的一步
  toolHint('已插入 ' + label);
}

// 右侧停靠栏：AI 与工具面板共占第三栏且互斥。
// 打开时工作区通过 margin-right 让出宽度，形成「代码 | 预览 | AI/工具」三栏，预览不被遮挡。
function syncDock() {
  const aiOpen = $('aiDrawer').classList.contains('open');
  const tpOpen = $('toolPanel').classList.contains('open');
  document.body.classList.toggle('dock-open', aiOpen || tpOpen);
  document.body.classList.toggle('dock-tools', tpOpen);
  $('toolPanel').setAttribute('aria-hidden', String(!tpOpen));
  // 布局变化后刷新编辑器行高亮位置
  positionActiveLine();
  window.dispatchEvent(new Event('resize'));
}

function openTools(open = true) {
  const el = $('toolPanel');
  if (open) $('aiDrawer').classList.remove('open');   // 互斥
  el.classList.toggle('open', open);
  if (open && !el.dataset.ready) {
    renderToolCats(); renderToolGrid(); el.dataset.ready = '1';
  }
  syncDock();
}

// ------------------------------------------------------------------ AI
// 免费匿名大模型：浏览器直连（端点开放 CORS），刷新页面即生效，无需重启本地服务。
// 多通道按实测延迟自动选优 + 单飞串行 + 流式首字；限流只在真实 402 时按官方 30 秒排队。
// 免费匿名大模型：浏览器直连（端点 CORS=*），无需 Key / 注册 / 任何设置。
// 官方 Classic API 规则：同一 IP 文本请求「一次只能有一个、间隔 ≥ 30 秒」，402 带 "Retry after Ns"。
// 45 秒是图片的限制，旧版误用成文本冷却，白白多等 15 秒；这里改为 31 秒并按实际 Retry 值排队。
const AI_MODEL = 'openai-fast';            // 当前匿名免费层唯一模型 GPT-OSS 20B
const AI_MODELS_URL = 'https://text.pollinations.ai/models';
const AI_COOLDOWN = 31000;
const AI_TIMEOUT = 9000;   // 单通道快速失败，不在一条坏通道上干等
const AI_STATS_KEY = 'yangtex.aiStats';
const AI_PREF_KEY = 'yangtex.aiPref';

// 同一 IP 只允许一个在途请求 → 通道之间「串行按序尝试」，绝不并发竞速。
const AI_CHANNELS = [
  { id: 'v1-stream', label: '流式 SSE · 首字最快', mode: 'sse', base: 5500,
    url: 'https://text.pollinations.ai/v1/chat/completions', probe: AI_MODELS_URL },
  { id: 'text', label: '纯文本 POST · 最轻量', mode: 'text', base: 6500,
    url: 'https://text.pollinations.ai/', probe: AI_MODELS_URL },
  { id: 'v1', label: '标准 JSON · /v1', mode: 'json', base: 8000,
    url: 'https://text.pollinations.ai/v1/chat/completions', probe: AI_MODELS_URL },
  { id: 'openai', label: '兼容端点 · /openai', mode: 'json', base: 8500,
    url: 'https://text.pollinations.ai/openai/chat/completions', probe: AI_MODELS_URL },
  { id: 'local', label: '本地服务代理', mode: 'local', base: 11000,
    url: '/api/ai', probe: '/api/health' },
];

let AI_MODELS = [{ name: AI_MODEL, description: 'GPT-OSS 20B Reasoning LLM (OVH)',
                    tier: 'anonymous', aliases: [] }];
let AI_PREF = 'auto';           // auto | model:<name> | ch:<id>
let AI_STATS = {};              // 每个通道的实测耗时 / 成功率 / 冷却
let AI_FLIGHT = Promise.resolve();   // 单飞链：任何时候只有一个生成请求在途
try { AI_PREF = localStorage.getItem(AI_PREF_KEY) || 'auto'; } catch (e) {}
try { AI_STATS = JSON.parse(localStorage.getItem(AI_STATS_KEY) || '{}') || {}; }
catch (e) { AI_STATS = {}; }

function aiSaveStats() {
  try { localStorage.setItem(AI_STATS_KEY, JSON.stringify(AI_STATS)); } catch (e) {}
}
function aiStat(id) {
  return AI_STATS[id] || (AI_STATS[id] = { ms: 0, ok: 0, fail: 0, until: 0, rtt: 0 });
}
function aiRecord(id, ok, ms) {
  const s = aiStat(id);
  if (ok) {
    s.ok++;
    s.ms = s.ms ? Math.round(s.ms * 0.65 + ms * 0.35) : Math.round(ms);
  } else s.fail++;
  aiSaveStats();
}
function aiActiveModel() {
  return AI_PREF.startsWith('model:') ? AI_PREF.slice(6) : AI_MODEL;
}
function aiRank() {
  const now = Date.now();
  return AI_CHANNELS.slice().map(c => {
    const s = AI_STATS[c.id] || {};
    const score = (s.ms || c.base) + (s.fail || 0) * 900 - (s.ok || 0) * 250
      + (s.rtt || 0) * 0.25 + ((s.until || 0) > now ? 20000 : 0);
    return { c, score };
  }).sort((a, b) => a.score - b.score).map(x => x.c);
}
function aiPickChannels() {
  const ranked = aiRank();
  if (AI_PREF.startsWith('ch:')) {
    const c = AI_CHANNELS.find(x => x.id === AI_PREF.slice(3));
    if (c) return [c, ...ranked.filter(x => x.id !== c.id)];
  }
  return ranked;
}
function aiHttpError(status, raw, headers) {
  let detail = '';
  try {
    const j = JSON.parse(raw);
    detail = (j && j.error && j.error.message) || '';
  } catch (e) { detail = String(raw || '').slice(0, 180); }
  const m = String(detail).match(/Retry after\s+(\d+)\s*s/i);
  const hdr = headers && headers.get('Retry-After');
  const hdrSec = hdr ? Number(hdr) : 0;
  const err = new Error(detail || ('HTTP ' + status));
  err.status = status;
  err.busy = status === 429 && /still running/i.test(detail);
  err.retryAfter = err.busy ? 2
    : (m ? Number(m[1]) : (Number.isFinite(hdrSec) && hdrSec > 0 ? hdrSec
      : (status === 402 || status === 429 ? 31 : 0)));
  return err;
}

// 轻量连通性探测：外网/代理不通时直接跳过 4 条远程通道，避免每个都等 9 秒
let aiProbeAt = 0, aiProbeOk = true;
async function aiProbeReachable() {
  if (Date.now() - aiProbeAt < 15000) return aiProbeOk;
  aiProbeAt = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(AI_MODELS_URL + '?_=' + Date.now(),
      { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    aiProbeOk = r.ok;
  } catch (e) { aiProbeOk = false; }
  return aiProbeOk;
}

// 动态发现官方当前开放的免费模型：以后新增匿名模型时 YangTex 无需升级即可选用
let aiModelsLoadedAt = 0;
async function aiLoadModels(force = false) {
  if (!force && aiModelsLoadedAt && Date.now() - aiModelsLoadedAt < 600000) return;
  let list = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(AI_MODELS_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.data || j.models || []);
      list = arr.filter(m => m && (m.name || m.id)).map(m => ({
        name: String(m.name || m.id),
        description: String(m.description || m.name || m.id),
        tier: String(m.tier || 'anonymous'),
        aliases: Array.isArray(m.aliases) ? m.aliases : [],
      }));
    }
  } catch (e) { /* 直连失败 → 走本地服务兜底 */ }
  if (!list || !list.length) {
    try {
      const j = await api('/api/ai-models');
      if (j && j.models && j.models.length) list = j.models;
    } catch (e) { /* 使用内置默认 */ }
  }
  if (list && list.length) AI_MODELS = list;
  aiModelsLoadedAt = Date.now();
  aiBuildSelect();
}
function aiBuildSelect() {
  const sel = $('aiModel');
  if (!sel) return;
  let html = '<option value="auto">⚡ 自动 · 选最快免费通道</option>';
  html += '<optgroup label="免费模型（无需 Key）">';
  for (const m of AI_MODELS) {
    html += `<option value="model:${esc(m.name)}">${esc(m.description)} · ${esc(m.name)}</option>`;
  }
  html += '</optgroup><optgroup label="传输通道（锁定）">';
  for (const c of AI_CHANNELS) {
    const s = AI_STATS[c.id] || {};
    const speed = s.ms ? `（${(s.ms / 1000).toFixed(1)}s）` : '';
    html += `<option value="ch:${c.id}">${esc(c.label + speed)}</option>`;
  }
  html += '</optgroup>';
  sel.innerHTML = html;
  sel.value = AI_PREF;
  if (!Array.from(sel.options).some(o => o.value === AI_PREF)) sel.value = 'auto';
  aiUpdateNote();
}
function aiUpdateNote(extra) {
  const el = $('aiModelNote');
  if (!el) return;
  const c = aiPickChannels()[0];
  const s = AI_STATS[c.id] || {};
  const ms = s.ms ? ` · 实测 ${(s.ms / 1000).toFixed(1)}s` : '';
  const left = Math.max(0, ((s.until || 0) - Date.now()) / 1000);
  el.textContent = extra || (AI_PREF === 'auto'
    ? `自动选优：${c.label}${ms}${left > 0 ? ` · 冷却 ${Math.ceil(left)}s` : ''}`
    : `已锁定：${c.label}${ms}`);
}

// 「测速选优」只测连接 RTT（不消耗每 30 秒一次的生成配额），再结合历史真实耗时排序
async function aiBench() {
  const btn = $('aiBench');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const note = $('aiModelNote');
  note.textContent = '正在实测各免费通道连接速度…';
  const hosts = [...new Set(AI_CHANNELS.map(c => c.probe))];
  await Promise.all(hosts.map(async u => {
    const t0 = performance.now();
    try {
      await fetch(u + (u.includes('?') ? '&' : '?') + '_=' + Date.now(),
        { cache: 'no-store', mode: 'cors' });
      const rtt = Math.round(performance.now() - t0);
      AI_CHANNELS.filter(c => c.probe === u).forEach(c => { aiStat(c.id).rtt = rtt; });
    } catch (e) {
      AI_CHANNELS.filter(c => c.probe === u).forEach(c => { aiStat(c.id).rtt = 3000; });
    }
  }));
  aiSaveStats();
  aiBuildSelect();
  const best = aiRank()[0];
  note.textContent = `测速完成：${hosts.length} 个端点；当前优先「${best.label}」` +
    `（连接 ${aiStat(best.id).rtt}ms，历史 ${(aiStat(best.id).ms / 1000 || 0).toFixed(1)}s）`;
  toast('测速完成，已按响应速度重新排序');
  btn.disabled = false;
  setTimeout(() => aiUpdateNote(), 6000);
}

// 「🔍 自检」：不消耗每 30 秒一次的生成配额，只看连通性、历史耗时与冷却状态
async function aiSelfCheck() {
  const btn = $('aiSelfCheck');
  if (btn) btn.disabled = true;
  const note = $('aiModelNote');
  if (note) note.textContent = '正在诊断免费通道…';
  const lines = ['【AI 自检】'];
  try {
    const r = await fetch('/api/health?_=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    lines.push(`本地服务：✓ 正常${j.build ? '（构建 ' + j.build + '）' : ''}`);
  } catch (e) {
    lines.push('本地服务：✗ 无法连接，请重新双击 YangTex 启动器');
  }
  let online = false;
  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(AI_MODELS_URL + '?_=' + Date.now(),
      { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    online = r.ok;
    lines.push(`免费模型接口：${r.ok ? '✓ 可达' : '✗ HTTP ' + r.status} · ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    lines.push('免费模型接口：✗ 直连不通（代理 / 断网 / 被拦截）');
  }
  const now = Date.now();
  for (const c of AI_CHANNELS) {
    const s = AI_STATS[c.id] || {};
    const left = Math.max(0, Math.ceil(((s.until || 0) - now) / 1000));
    lines.push(`· ${c.label}：${s.ms ? '实测 ' + (s.ms / 1000).toFixed(1) + 's' : '尚无实测'}` +
      `${left ? ' · 冷却 ' + left + 's' : ''}${s.fail ? ' · 失败 ' + s.fail + ' 次' : ''}`);
  }
  const wait = Math.max(0, Math.ceil(((S.aiCoolingUntil || 0) - now) / 1000));
  lines.push(wait ? `官方冷却期：约 ${wait}s 后可再次请求（可先用内置助手）`
    : '当前不在冷却期，可以直接提问');
  lines.push(online
    ? '结论：免费通道可达。若仍无回复，点「⚡ 测速选优」或在下拉里锁定另一条通道。'
    : '结论：外网不可达。AI 会自动用内置助手即时回答，网络恢复后点「重试在线大模型」。');
  addMsg('sys', lines.join('\n'));
  if (note) note.textContent = online ? '自检完成：免费通道可达 · 可直接提问'
    : '自检完成：外网不可达 · 内置助手随时可用';
  $('aiChat').scrollTop = $('aiChat').scrollHeight;
  if (btn) btn.disabled = false;
}

// 页面已打开时后端/前端文件更新 → 提示刷新，避免一直停留在旧界面
let BUILD_SEEN = '', BUILD_DISMISSED = false;
async function checkBuild() {
  if (BUILD_DISMISSED) return;
  try {
    const r = await fetch('/api/health?_=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    if (!j.build) return;
    if (!BUILD_SEEN) { BUILD_SEEN = j.build; return; }
    if (j.build !== BUILD_SEEN) {
      const bar = $('updateBar');
      if (bar) { bar.classList.remove('hidden'); bar.setAttribute('aria-hidden', 'false'); }
    }
  } catch (e) { /* 服务重启瞬间忽略 */ }
}
const AI_SYSTEM = (
  '你是 YangTex 内置的 LaTeX 与数学写作助手，服务对象是偏微分方程(PDE)方向的数学学者。' +
  '规则：1) 回答用简体中文，简洁、专业、可直接行动；2) 涉及 LaTeX 代码时给出完整可编译片段，' +
  '用 ```latex 代码块包裹；3) 优先使用 amsmath/amssymb/amsthm/mathtools 等标准宏包，' +
  '中英文混排时用 ctex + xelatex；4) 解释编译错误时先给原因，再给最小修改方案；' +
  '5) 不臆造文献与定理，不确定的地方明确说明；6) 不要输出多余的寒暄。'
);

function openAI(open = true) {
  if (open) $('toolPanel').classList.remove('open');   // 与工具面板互斥
  $('aiDrawer').classList.toggle('open', open);
  syncDock();
  if (open) {
    aiBuildSelect();
    aiLoadModels();     // 异步读取官方当前开放的免费模型，回来自动刷新下拉
    const box = $('aiChat');
    if (!box.dataset.greeted) {
      box.dataset.greeted = '1';
      addMsg('sys', '你好，我是 YangTex AI 助手。可解释选中公式、润色、中英互译、生成 LaTeX、诊断编译错误。'
        + '免费且无需 Key；默认自动选最快的通道并流式显示，可在上方切换模型 / 锁定通道 / 测速选优。');
    }
    setTimeout(() => $('aiInput').focus(), 260);
  }
}

function setAiSource(text, color) {
  const el = $('aiSource');
  el.textContent = text;
  el.style.color = color;
}

function mdRender(text) {
  let s = esc(text);
  // 代码块
  s = s.replace(/```(?:latex|tex|bib)?\s*\n?([\s\S]*?)```/gi, (m, code) =>
    `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/^###\s*(.+)$/gm, '<b>$1</b>');
  return s;
}

function addMsg(role, text) {
  const box = $('aiChat');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (role === 'ai') div.innerHTML = mdRender(text);
  else div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function aiRenderReply(el, text, opts = {}) {
  el.innerHTML = mdRender(text || '（无回复）');
  const acts = document.createElement('div');
  acts.className = 'msg-actions';
  const blocks = el.querySelectorAll('pre code');
  if (blocks.length) {
    const b = document.createElement('button');
    b.textContent = '插入代码块到光标处';
    b.onclick = () => {
      const ed = $('editor');
      const p = ed.selectionStart;
      ed.setRangeText('\n' + blocks[0].textContent + '\n', p, p, 'end');
      ed.focus(); onEditorInput(); undoRecord();
      toast('已插入代码块');
    };
    acts.appendChild(b);
  }
  if (opts.retry) {
    const b = document.createElement('button');
    b.textContent = opts.retryLabel || '重试在线 AI';
    b.onclick = () => opts.retry();
    acts.appendChild(b);
  }
  el.appendChild(acts);
}

function aiCompose(action, message, selected) {
  let user = message || '';
  if (action === 'fix') {
    const brief = (S.issues || []).slice(0, 8).map(i => `${i.line}: ${i.message}`).join('\n');
    user = `请诊断并修复以下 LaTeX 编译错误，给出最小改动方案：\n${brief}\n\n相关源码：\n${String(selected).slice(0, 3000)}`;
  } else if (action === 'explain') {
    user = `请解释这段 LaTeX / 数学公式的含义，并指出可改进之处：\n\`\`\`latex\n${String(selected).slice(0, 3000)}\n\`\`\``;
  } else if (action === 'polish') {
    user = `请在保持原意的前提下润色下面这段学术文字（中文或英文），只输出润色后的正文：\n${String(selected).slice(0, 3000)}`;
  } else if (action === 'translate') {
    user = `请把下面这段文字在中文与英文之间互译，保持学术书面语，只输出译文：\n${String(selected).slice(0, 3000)}`;
  } else if (action === 'generate') {
    user = `请根据需求写出可直接编译的 LaTeX 代码（含必要导言区）：\n${String(message || selected).slice(0, 2000)}`;
  }
  const msgs = [{ role: 'system', content: AI_SYSTEM }];
  for (const m of (S.aiHistory || []).slice(-8)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && m.content) {
      msgs.push({ role: m.role, content: String(m.content).slice(0, 4000) });
    }
  }
  msgs.push({ role: 'user', content: String(user || '请用一句话介绍你自己，并说明能帮我做什么。').slice(0, 12000) });
  return msgs;
}

// 内置 LaTeX 知识库：断网 / 免费通道冷却时，AI 依然给出能直接用的回答，
// 而不是只丢一句「离线不可用」。命中多条时最多给 2 条，避免刷屏。
const AI_KB = [
  { id: 'amsmath', re: /amsmath|ams\s*数学|align|gather|multline|多行公式|对齐公式|数学宏包|矩阵/i, a: [
    '【amsmath · 数学公式】',
    '提供 align / align* / gather / multline / split 等多行对齐环境，pmatrix、bmatrix、cases 矩阵，',
    '以及 \\text{}、\\nonumber、\\tag{}、\\label + \\eqref 等编号与文字控制。',
    '```latex',
    '\\usepackage{amsmath,amssymb}',
    '\\begin{align}',
    '  -\\Delta u &= f  \\quad \\text{in } \\Omega, \\\\',
    '  u &= 0      \\quad \\text{on } \\partial\\Omega. \\nonumber',
    '\\end{align}',
    '```',
    'YangTex 顶栏「宏包补全」开启时，写到 align 会自动把 amsmath 补进导言区。',
  ].join('\n') },
  { id: 'ctex', re: /中文|ctex|xelatex|中英|混排|汉字|字体.*中/i, a: [
    '【中文写作 · ctex + xelatex】',
    '中文必须用 xelatex（或 lualatex）+ ctex，pdflatex 不能直接排汉字：',
    '```latex',
    '\\documentclass[11pt,a4paper,fontset=fandol]{ctexart}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\begin{document}',
    '\\section{引言}  设 $\\Omega\\subset\\mathbb{R}^n$ 为有界区域。',
    '\\end{document}',
    '```',
    'fontset=fandol 使用 TeX Live 自带字体，Mac / Windows 都无需另装中文字体。',
    '顶栏引擎选「自动」即可；YangTex 内置「中文期刊」「中英双语」模板可直接套用。',
  ].join('\n') },
  { id: 'figure', re: /图片|图形|figure|includegraphics|graphicx|插图|拖入/i, a: [
    '【插入图片】',
    '把 PNG / JPG / PDF / EPS 直接拖进 YangTex 窗口，会自动生成居中 figure，',
    '含 \\centering、\\caption、\\label{fig:...}，并自动补 graphicx 宏包。',
    '```latex',
    '\\begin{figure}[htbp]',
    '  \\centering',
    '  \\includegraphics[width=0.8\\textwidth]{图片文件名.png}',
    '  \\caption{图题}\\label{fig:demo}',
    '\\end{figure}',
    '```',
    '插入后左下角浮层可改 30%/50%/80%/100%/原始尺寸，或填 6cm、0.6\\linewidth、240pt。',
    '注意：图片代码必须在 \\begin{document} 与 \\end{document} 之间，放在结尾之后会被 LaTeX 忽略。',
  ].join('\n') },
  { id: 'errors', re: /错误|报错|编译失败|undefined|missing \$|not found|未闭合|诊断|修复/i, a: [
    '【常见编译错误 · 速查】',
    '1) Undefined control sequence：宏包缺失或命令拼错，例如 \\usepackage{hyperre} 应为 hyperref。',
    '2) Missing $ inserted：数学符号没放进 $...$、\\[...\\] 或 equation/align 环境。',
    '3) File `xxx` not found：图片 / 宏包 / 文档类不存在；图片要与 main.tex 同目录。',
    '4) Unicode character ... not set up：中文要用 xelatex + ctex，别用 pdflatex。',
    '5) Missing \\end{...} 或 LaTeX Error: \\begin{...} ended：环境未成对闭合。',
    '6) 全角 ￥、，或 emoji 在 lmroman10 下会报 "Missing character"：改用 ctex 或换成半角符号。',
    '点底部「问题」标签可展开错误列表，单击任一条直接跳到源码行。',
  ].join('\n') },
  { id: 'theorem', re: /定理|lemma|theorem|proof|amsthm|定义|证明/i, a: [
    '【定理环境 · amsthm】',
    '```latex',
    '\\usepackage{amsthm}',
    '\\newtheorem{theorem}{定理}[section]',
    '\\newtheorem{lemma}[theorem]{引理}',
    '\\begin{theorem} 设 $f\\in L^2(\\Omega)$，则 $-\\Delta u=f$ 存在唯一弱解。\\end{theorem}',
    '```',
    'amsart / amsbook 文档类已内置 \\subjclass、\\keywords 与定理环境，不要重复 \\newtheorem 同名命令。',
    'Beamer 幻灯片里建议改用 \\begin{block}{定理} ... \\end{block}。',
  ].join('\n') },
  { id: 'table', re: /表格|tabular|booktabs|三线表|列对齐/i, a: [
    '【表格 · booktabs 三线表】',
    '```latex',
    '\\usepackage{booktabs}',
    '\\begin{table}[htbp]\\centering',
    '\\begin{tabular}{lcc}\\toprule',
    '方法 & 误差 & 阶数 \\\\ \\midrule',
    'FEM   & 1.2e-3 & 2 \\\\ \\bottomrule',
    '\\end{tabular}\\caption{数值结果}\\label{tab:result}',
    '\\end{table}',
    '```',
    '工具面板「表格」分类里有「插入表格…」可自动生成骨架。',
  ].join('\n') },
  { id: 'ref', re: /参考文献|bibtex|biblatex|引用|citation|\\cite|文献/i, a: [
    '【参考文献】',
    '最省事：在正文末尾直接写 \\begin{thebibliography}{9} \\bibitem{key} ... \\end{thebibliography}，无需额外工具。',
    '用 .bib 时：把 refs.bib 放进项目目录，导言区加 \\usepackage{biblatex} + \\addbibresource{refs.bib}，',
    '正文 \\cite{key} 与 \\printbibliography；YangTex 检测到 .bib 且系统有 bibtex 时会自动跑参考文献。',
  ].join('\n') },
  { id: 'layout', re: /页边距|页面|geometry|纸张|a4|行距|页码/i, a: [
    '【版式 · geometry】',
    '\\usepackage[margin=2.5cm,a4paper]{geometry} 可设页边距与纸张。',
    '行距用 \\linespread{1.25}\\selectfont 或 \\usepackage{setspace} + \\onehalfspacing。',
    '超链接与书签：\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue]{hyperref}（注意是 hyperref，不是 hyperre）。',
  ].join('\n') },
  { id: 'engine', re: /引擎|pdflatex|lualatex|编译引擎|选哪个|区别/i, a: [
    '【编译引擎怎么选】',
    '• 纯英文、传统期刊模板：pdflatex（最快）。',
    '• 中文 / Unicode / 系统字体：xelatex（YangTex「自动」模式会按文档内容自动选）。',
    '• 需要 Lua 宏包或复杂字体：lualatex。',
    '顶栏「引擎」可手动锁定；模板库里每个模板也标好了推荐引擎。',
  ].join('\n') },
  { id: 'template', re: /模板库|期刊模板|内置模板|换模板|siam|springer|ieee|elsevier|arxiv|投稿|beamer|幻灯片/i, a: [
    '【模板库】',
    '点顶栏「▤ 模板」可套用 16 个内置模板：AMS 三件套、PDE 论文、Elsevier、IEEE、SIAM、',
    'Springer、AIMS、arXiv、中文期刊、中英双语、Beamer、讲义等。',
    'SIAM / Springer / AIMS 未安装官方 .cls 时会自动降级为 article 预览排版，装好官方类后自动启用正式格式。',
    '添加自己的模板：把 .tex 放进 templates/ 目录，或在模板库里粘贴保存。',
  ].join('\n') },
  { id: 'synctex', re: /同步|定位|synctex|跳回|逐行|双向/i, a: [
    '【双向逐行同步】',
    '源码 → PDF：光标放在某行按 F8，或点「⇥ 定位到 PDF」；开启「逐行同步」后移动光标自动高亮。',
    'PDF → 源码：在预览里单击文字即精确跳回该行；拖滚动条或框选文字不会误触。',
  ].join('\n') },
  { id: 'pdf', re: /pdf|下载|打开预览|预览.*大小|缩放|导出|打印/i, a: [
    '【PDF 打开 / 下载 / 预览大小】',
    '预览栏「↗ 打开 PDF」在新标签页打开完整 PDF，可打印或系统另存；「↓ 下载 PDF」直接存成本机文件。',
    '预览底部有 − / 百分比 / ＋ / ⤢ 适配 / 100，也可按 ⌘/Ctrl + 滚轮缩放，或点「⛶ 放大预览」把预览铺满工作区（Esc 还原）。',
    '拖动代码与预览之间的分隔条可改两栏宽度，双击分隔条恢复 50% / 50%。',
  ].join('\n') },
];

function aiLocalAnswer(action, message, selected) {
  const q = (String(message || '') + ' ' + String(selected || '')).slice(0, 4000);
  const parts = [];
  const errs = (S.issues || []).filter(i => i.kind === 'error');
  if (action === 'fix' && errs.length) {
    parts.push('【内置诊断 · 最近一次编译】\n' +
      errs.slice(0, 5).map((i, k) => `${k + 1}. 第 ${i.line} 行：${i.message}`).join('\n') +
      '\n按下方「常见编译错误」逐条排查，改完点「▶ 编译」验证。');
  }
  if (action === 'explain' && String(selected || '').trim()) {
    const t = String(selected);
    const cmds = [...new Set(t.match(/\\([A-Za-z]+)/g) || [])].slice(0, 12).join('、') || '（无）';
    const envs = [...new Set(t.match(/\\begin\{[^}]+\}/g) || [])].slice(0, 8).join('、') || '（无）';
    parts.push(`【片段解析】共 ${t.split('\n').length} 行、${t.length} 字符。\n` +
      `命令：${cmds}\n环境：${envs}\n` +
      '检查数学模式 $...$ / \\[...\\] 是否成对，\\begin 与 \\end 是否配对。');
  }
  let hits = AI_KB.filter(k => k.re.test(q)).slice(0, 2).map(k => k.a);
  if (!hits.length && action === 'fix') {
    const e = AI_KB.find(k => k.id === 'errors');
    if (e) hits = [e.a];
  }
  if (!parts.length && !hits.length) {
    parts.push([
      '【YangTex 内置助手 · 离线可用】',
      '我暂时没连上免费大模型，但可以先帮你做这些：',
      '• 解释 / 检查 LaTeX 片段：选中代码后点「解释选中」，离线也能解析命令、环境与数学模式。',
      '• 诊断编译错误：点「修复编译错误」会列出最近一次日志里的错误行与常见原因。',
      '• 直接问「amsmath」「中文」「图片」「定理」「表格」「参考文献」「模板」「编译错误」等关键词，我会给出可编译片段。',
      '• 常用骨架在「🧰 工具面板」，完整结构在「▤ 模板库」。',
      ...(action === 'polish' || action === 'translate'
        ? ['润色与中英互译需要语言模型联网生成，离线时不做伪造译文；网络恢复后重试即可。'] : []),
    ].join('\n'));
  }
  parts.push(...hits);
  parts.push('— 以上由内置助手离线给出；点「重试在线大模型」可获取针对性回答，「🔍 自检」可查看通道状态。');
  return parts.join('\n\n');
}

async function aiFetchChannel(ch, messages, onDelta, ctrl) {
  const model = aiActiveModel();
  let r;
  if (ch.mode === 'local') {
    // 本地服务代理：浏览器无法直连外网时仍有出路（后端可设 Referer / 走系统代理）
    const last = messages[messages.length - 1] || { content: '' };
    r = await fetch('/api/ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'chat', message: last.content,
        messages: messages.slice(1, -1), model, text: '', issues: [] }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (!r.ok || !j.reply) throw new Error(j.error || ('HTTP ' + r.status));
    if (j.source === 'rate-limited') {
      const e = new Error('免费通道限流');
      e.retryAfter = j.retry_after || 31;
      throw e;
    }
    if (j.source === 'offline') throw new Error(j.error || '在线通道不可达');
    return { reply: j.reply, model: j.model || model };
  }

  const stream = ch.mode === 'sse';
  if (ch.mode === 'text') {
    // Classic API：POST / 直接返回纯文本，响应体最轻、首字最快
    r = await fetch('https://text.pollinations.ai/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model, max_tokens: 1800, temperature: 0.3 }),
      signal: ctrl.signal,
    });
  } else {
    r = await fetch(ch.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: 1800, temperature: 0.3, stream }),
      signal: ctrl.signal,
    });
  }
  if (!r.ok) throw aiHttpError(r.status, await r.text().catch(() => ''), r.headers);

  if (ch.mode === 'text') {
    const txt = (await r.text()).trim();
    if (!txt || txt.startsWith('{')) throw new Error('纯文本通道返回异常');
    if (onDelta) onDelta(txt);
    return { reply: txt, model };
  }
  if (!stream) {
    const j = await r.json();
    let reply = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (Array.isArray(reply)) reply = reply.map(p => (p && p.text) || '').join('');
    reply = String(reply || '').trim();
    if (!reply) throw new Error('空回复');
    if (onDelta) onDelta(reply);
    return { reply, model: (j && j.model) || model };
  }

  // SSE 流式：逐块解析 data: {...}，边生成边显示
  if (!r.body || !r.body.getReader) throw new Error('浏览器不支持流式读取');
  const reader = r.body.getReader(), dec = new TextDecoder('utf-8');
  let buf = '', text = '', usedModel = model;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && typeof d.content === 'string') text += d.content;
        if (j.model) usedModel = j.model;
      } catch (ignored) { /* 心跳 / 非 JSON 行 */ }
    }
    if (text.trim() && onDelta) onDelta(text);
  }
  if (!text.trim()) throw new Error('流式回复为空');
  return { reply: text.trim(), model: usedModel };
}

async function aiFetchOnline(messages, onDelta) {
  // 单飞链：同一 IP 只允许一个在途请求，绝不并发，避免 429 "previous request is still running"
  const run = async () => {
    const reachable = await aiProbeReachable();
    const channels = aiPickChannels().filter(c => reachable || c.mode === 'local');
    let lastErr = null, minRetry = 0;
    for (const ch of channels) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT);
      const t0 = performance.now();
      try {
        const out = await aiFetchChannel(ch, messages, onDelta, ctrl);
        aiRecord(ch.id, true, performance.now() - t0);
        aiStat(ch.id).until = Date.now() + AI_COOLDOWN;
        S.aiCoolingUntil = Date.now() + AI_COOLDOWN;   // 官方要求间隔 30 秒
        aiSaveStats();
        return { ...out, channel: ch };
      } catch (e) {
        aiRecord(ch.id, false, performance.now() - t0);
        lastErr = e;
        if (e.retryAfter) {
          aiStat(ch.id).until = Date.now() + e.retryAfter * 1000;
          minRetry = minRetry ? Math.min(minRetry, e.retryAfter) : e.retryAfter;
          aiSaveStats();
          if (e.busy) await new Promise(res => setTimeout(res, 1800));
        }
        // 限流可能按通道独立 → 继续串行试下一个；其它错误也直接切下一个
      } finally {
        clearTimeout(timer);
      }
    }
    if (minRetry) {
      const err = lastErr || new Error('免费通道冷却中');
      err.retryAfter = minRetry;
      S.aiCoolingUntil = Math.max(S.aiCoolingUntil || 0, Date.now() + minRetry * 1000);
      throw err;
    }
    throw lastErr || new Error('所有免费通道均不可达');
  };
  const p = AI_FLIGHT.then(run, run);
  AI_FLIGHT = p.catch(() => {});
  return p;
}

const AI_LABEL = {
  explain: '解释选中内容', polish: '润色选中文字', translate: '中英互译',
  generate: '生成 LaTeX', fix: '修复编译错误', chat: '提问',
};

async function aiCall(action, message, opts = {}) {
  if (S.aiBusy) return;
  const ed = $('editor');
  const selected = opts.selected !== undefined
    ? opts.selected : ed.value.slice(ed.selectionStart, ed.selectionEnd);
  openAI(true);
  const label = AI_LABEL[action] || '提问';
  if (!opts.silent) {
    const display = action === 'chat' ? (message || '').slice(0, 120)
      : (selected ? `${label}（已选中 ${selected.length} 字）：${selected.slice(0, 60)}…` : label);
    addMsg('user', display);
  }
  S.aiBusy = true;
  $('aiSend').disabled = true;
  const thinking = opts.replaceEl || addMsg('ai', '正在连接免费大模型…');
  if (opts.replaceEl) {
    thinking.innerHTML = '<div class="ai-count">在线通道已恢复，正在获取大模型答案…</div>';
  }
  const messages = aiCompose(action, message, selected);
  const again = extra => aiCall(action, message,
    Object.assign({}, opts, { silent: true, force: true, selected }, extra || {}));

  // 不再让用户干等 30 秒冷却：直接尝试；一旦限流/断网就秒回内置答案，
  // 冷却结束后自动用在线大模型答案替换同一条气泡（不新增重复消息）。
  let lastPaint = 0;
  const onDelta = part => {
    const now = performance.now();
    if (now - lastPaint < 110) return;
    lastPaint = now;
    thinking.innerHTML = mdRender(part + ' ▍');
    const box = $('aiChat');
    box.scrollTop = box.scrollHeight;
  };

  try {
    setAiSource('正在连接最优免费通道…', 'var(--muted)');
    aiUpdateNote('正在按实测响应速度依次尝试免费通道…');
    const r = await aiFetchOnline(messages, onDelta);
    aiRenderReply(thinking, r.reply, {});
    const ch = r.channel ? r.channel.label : '免费通道';
    setAiSource(`${r.model || AI_MODEL} · ${ch} · 无需 Key`, 'var(--ok)');
    S.aiHistory.push(
      { role: 'user', content: message || selected || label },
      { role: 'assistant', content: r.reply });
    if (S.aiHistory.length > 12) S.aiHistory = S.aiHistory.slice(-12);
    const st = AI_STATS[r.channel.id] || {};
    aiUpdateNote(`本次 ${ch} · ${((st.ms || 0) / 1000).toFixed(1)}s；`
      + `下次优先 ${aiPickChannels()[0].label}`);
  } catch (e) {
    // 限流 / 断网 / 代理拦截：一律立即给出内置助手的真实回答，不留空白、不转圈
    const secs = Number(e.retryAfter || 0);
    aiRenderReply(thinking, aiLocalAnswer(action, message, selected), {
      retry: () => again({ autoRetries: 9, replaceEl: thinking }),
      retryLabel: '立即重试在线大模型',
    });
    setAiSource(secs ? '免费通道冷却中 · 已先用内置助手回答'
      : '内置 LaTeX 助手 · 离线可用', 'var(--gold)');
    aiUpdateNote(secs
      ? `在线通道约 ${secs}s 后恢复，会自动补充大模型答案；也可点「立即重试在线大模型」`
      : '已用内置助手即时回答；点「立即重试在线大模型」或「🔍 自检」可恢复在线回答');
    if (secs > 0 && (opts.autoRetries || 0) < 1) {
      setTimeout(() => {
        if (!thinking.isConnected || S.aiBusy) return;
        again({ autoRetries: (opts.autoRetries || 0) + 1, replaceEl: thinking });
      }, secs * 1000 + 800);
    }
    $('aiChat').scrollTop = $('aiChat').scrollHeight;
  } finally {
    S.aiBusy = false; $('aiSend').disabled = false;
    $('aiChat').scrollTop = $('aiChat').scrollHeight;
  }
}

// ------------------------------------------------------------------ 数据加载
async function refreshTemplates() {
  const r = await api('/api/templates');
  S.templates = r.templates || [];
  $('tplCount').textContent = S.templates.length;
}
async function refreshProjects() {
  const r = await api('/api/projects');
  S.projects = r.projects || [];
  const sel = $('projectSel');
  sel.innerHTML = S.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.pdf ? ' · PDF' : ''}</option>`).join('');
  if (S.project) sel.value = S.project;
}
async function loadDocument() {
  closeEnvHint();              // 切项目 / 套模板时不要留着上一个文档的联想框
  const r = await api('/api/doc?project=' + encodeURIComponent(S.project));
  S.sourceKind = r.source_kind || 'tex';
  S.sourceFile = r.source_file || 'main.tex';
  $('editor').value = r.content || '';
  updateSourceUI();
  renderHighlight(); updateCursorInfo();
  undoReset();                 // 新项目 = 新的撤回历史起点
  // 换项目后必须真正重编一次：即使源码凑巧相同，预览里也是另一个项目的 PDF
  S.compiledHash = ''; S.compiledProject = '';
  S.diskHash = contentHash(r.content || '');
  // 页级缓存也按项目隔离：新项目的第一份 PDF 必须全量画一遍
  S.renderedRev = ''; S.renderedPages = []; S.renderedProject = '';
  setIncrBadge('full', 0, 0);
  S.hover = null; HOVER.hotspots = {}; hideHoverCard();
  $('saveHint').textContent = '已保存';
}

function saveState() {
  api('/api/state', 'POST', {
    project: S.project, engine: S.engine, auto_compile: S.auto,
    sync_enabled: S.sync, theme: S.theme, font_size: S.fontSize,
    auto_packages: S.autoPkg, turbo: S.turbo, continuous: S.cont,
    welcome_shown: true,
    env_prefs: { ...envPrefs, recent: envPrefs.recent.slice(0, 12) },
  }).catch(() => {});
}

// ------------------------------------------------------------------ 启动
async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
  // 预览缩放偏好在首次渲染 PDF 之前恢复
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (z >= 0.6 && z <= 2.6) S.zoom = z;
  } catch (e) { /* 隐私模式 */ }
  updateZoomLabel();
  await injectLogos();

  // 服务刚重启时刷新页面可能撞上未就绪窗口：自动重试，别一次性卡死
  let e = null;
  for (let i = 0; i < 6 && !e; i++) {
    try { e = await api('/api/init'); }
    catch (err) { if (i < 5) await new Promise(r => setTimeout(r, 800)); }
  }
  if (!e) {
    $('boot').innerHTML = '<div class="boot-title">YangTex</div>' +
      '<div class="boot-sub">服务连接失败 · <button id="bootRetry" ' +
      'style="border:0;background:transparent;color:var(--accent);cursor:pointer;' +
      'font:inherit;text-decoration:underline">点此重试</button></div>';
    $('bootRetry').onclick = () => location.reload();
    return;
  }
  S.env = e;
  S.state = e.state || {};
  S.project = S.state.project || '欢迎使用 YangTex';
  S.engine = S.state.engine || 'auto';
  S.auto = S.state.auto_compile !== false;
  S.sync = S.state.sync_enabled !== false;
  S.autoPkg = S.state.auto_packages !== false;
  S.turbo = S.state.turbo !== false;
  S.cont = S.state.continuous !== false;
  // 极速模式由后端按源码自动选引擎：把旧状态里钉死的 xelatex 归位到「自动」，
  // 否则下拉框显示 xelatex、状态栏却是 pdflatex，容易误解。
  if (S.turbo) S.engine = 'auto';
  S.theme = S.state.theme || 'light';
  S.fontSize = S.state.font_size || 14;
  S.projects = e.projects || [];
  S.templates = e.templates || [];
  S.engines = e.engines || {};
  S.enginePaths = e.enginePaths || e.engine_paths || {};
  S.envPkgs = e.env_pkgs || {};      // 本机真实宏包可用性（依赖提示用）
  readEnvPrefs();                    // .state.json 里的环境联想偏好 + 旧偏好迁移

  // 只切主题类，避免覆盖 dock-open / dock-tools / drag-active 等状态类
  document.body.classList.remove('theme-light', 'theme-dark');
  document.body.classList.add('theme-' + S.theme);
  $('engineSel').value = S.engine;
  $('autoToggle').classList.toggle('on', S.auto);
  $('contToggle').classList.toggle('on', S.cont && !NO_CONT);
  $('turboToggle').classList.toggle('on', S.turbo);
  $('syncToggle').classList.toggle('on', S.sync);
  $('pkgToggle').classList.toggle('on', S.autoPkg);
  $('tplCount').textContent = S.templates.length;
  await refreshProjects();
  await loadDocument();
  applyFont();
  renderBottom();

  const ready = e.tex_ready;
  $('welcomeStatus').innerHTML = ready
    ? `✓ TeX 引擎已就绪 · SyncTeX ${e.synctex_ready ? '可用' : '不可用'} · 内置 <b>${S.templates.length}</b> 个模板 · AI 已接入免费大模型`
    : `⚠ 未检测到 TeX 引擎：请先安装 TeX Live / MiKTeX，然后重新启动 YangTex`;

  $('boot').classList.add('gone');
  setTimeout(() => $('boot').remove(), 450);

  bindEvents();

  // 首次进入展示欢迎词
  if (!S.state.welcome_shown) {
    $('welcome').classList.remove('hidden');
  } else {
    saveState();
  }
  // 第一次编译：让打开即见成品。必须等它结束再标记就绪，
  // 否则「启动期间拖入图片」会被这次编译的旧内容覆盖回磁盘。
  if (ready) await compileNow(false);
  else setStatus('err', '✗ 未检测到 TeX 引擎');
  S.ready = true;
  // 停留在已打开的旧页面时，后端/前端文件一更新就提示刷新
  checkBuild();
  setInterval(checkBuild, 20000);
  // 即使本机没装 TeX 引擎（首轮没编译），已有 .aux 的项目也能用编号悬停
  refreshHoverIndex();
}

// ------------------------------------------------------------------ 事件
function bindEvents() {
  const ed = $('editor');

  // 顺序很重要：onEditorInput() 里的宏包自动补全会同步改内容，
  // 所以快照要等它跑完再记录，一次按键（含自动补包）才算一步。
  ed.addEventListener('input', () => onEditorInput());
  ed.addEventListener('input', () => undoRecord({ merge: true }));
  // 联想放在最后：宏包补全可能改写源码并平移光标，检测要基于最终内容
  ed.addEventListener('input', () => {
    // \begin{ 环境联想只属于 LaTeX；Markdown 里请用 :::latex 原样块
    if (S.sourceKind !== 'tex') { closeEnvHint(); return; }
    updateEnvHint();
    if (envClosePending) {
      const mode = envClosePending;
      envClosePending = null;
      tryAutoCloseEnv(mode);
    }
  });
  // 中文输入法组字期间不弹联想，也不把「拼音 / 半截汉字」送进 TeX；
  // 组字结束后再基于最终文本判断一次，并立即补一轮编译。
  ed.addEventListener('compositionstart', () => { S.composing = true; closeEnvHint(); });
  ed.addEventListener('compositionend', () => {
    S.composing = false;
    setTimeout(() => { updateEnvHint(); onEditorInput(); }, 0);
  });
  // 右键菜单 / 触控板手势触发的原生 historyUndo、historyRedo 也统一接管，
  // 避免浏览器自己的 undo 栈与我们的快照栈打架。
  ed.addEventListener('beforeinput', ev => {
    if (ev.inputType === 'historyUndo' || ev.inputType === 'historyRedo') {
      ev.preventDefault();
      if (ev.inputType === 'historyUndo') undoEdit(); else redoEdit();
      return;
    }
    if (envPrefs.auto_close && ev.inputType === 'insertText' && ev.data === '}')
      envClosePending = 'brace';
    else if (envPrefs.auto_close &&
             (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph'))
      envClosePending = 'newline';
    undoTrackCaret();
  });
  $('undoBtn').onclick = undoEdit;
  $('redoBtn').onclick = redoEdit;
  ed.addEventListener('scroll', () => {
    const inner = $('highlight').querySelector('.hl-inner');
    if (inner) inner.style.transform = `translate(${-ed.scrollLeft}px, ${-ed.scrollTop}px)`;
    $('gutterInner').style.transform = `translateY(${-ed.scrollTop}px)`;
    positionActiveLine();
    if (ENV_STATE.open) positionEnvHint();
  });
  // 点击别处时收起；列表项 mousedown 已阻止默认失焦，所以点选不会先关掉
  ed.addEventListener('blur', () => setTimeout(() => {
    if (ENV_STATE.open && !$('envHint').contains(document.activeElement)) closeEnvHint();
  }, 120));
  $('envHintList').addEventListener('mousedown', ev => {
    const it = ev.target.closest('.env-hint-item');
    if (!it) return;
    ev.preventDefault();              // 保持编辑器焦点，光标位置不丢
    acceptEnvHint(Number(it.dataset.i));
  });
  ['click', 'keyup', 'select'].forEach(ev => ed.addEventListener(ev, () => {
    undoTrackCaret();
    updateCursorInfo();
    const ln = cursorLine();
    if (S.sync && ln !== S.lastLine) {
      S.lastLine = ln;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => forwardSync(ln, 'quiet'), 260);
    }
  }));
  ed.addEventListener('keydown', ev => {
    if (ENV_STATE.open) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); envMove(1); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); envMove(-1); return; }
      if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation(); closeEnvHint(); return;
      }
      // ⌘/Ctrl + Enter 仍是「立即编译」，此时不接管
      if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.metaKey && !ev.ctrlKey) {
        if (!ENV_STATE.items.length) { closeEnvHint(); return; }
        ev.preventDefault(); acceptEnvHint(ENV_STATE.idx); return;
      }
    }
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const a = ed.selectionStart, b = ed.selectionEnd;
      ed.setRangeText('  ', a, b, 'end');
      onEditorInput(); undoRecord();
    }
  });

  $('gutter').addEventListener('click', ev => {
    const top = $('gutter').getBoundingClientRect().top;
    const line = Math.floor((ev.clientY - top - 12 + ed.scrollTop) / S.lineHeight) + 1;
    gotoLine(line, 1);
    forwardSync(line, 'scroll');
  });

  // 顶栏
  $('projectSel').onchange = async () => {
    S.project = $('projectSel').value;
    await loadDocument(); saveState();
    compileNow(false, true);
    toast('已切换到项目：' + S.project);
  };
  $('newProjectBtn').onclick = openNewProject;
  $('templatesBtn').onclick = openTemplates;
  $('engineSel').onchange = () => {
    S.engine = $('engineSel').value;
    // 手动选具体引擎与「按源码自动选最快」互斥：选了就退出极速，避免困惑
    if (S.engine !== 'auto' && S.turbo) {
      S.turbo = false;
      $('turboToggle').classList.remove('on');
      toast('已改用手动引擎，极速模式自动关闭');
    }
    saveState();
    toast('引擎已设为 ' + S.engine + '，正在重新编译');
    compileNow(false, true);     // 换引擎必须真跑一次，不能被指纹跳过
  };
  $('compileBtn').onclick = () => compileNow(false, true);
  $('autoToggle').onclick = () => {
    S.auto = !S.auto; $('autoToggle').classList.toggle('on', S.auto);
    saveState(); toast(S.auto ? '自动编译已开启' : '自动编译已关闭');
    if (S.auto) compileNow(false);
  };
  $('contToggle').onclick = () => {
    S.cont = !S.cont;
    $('contToggle').classList.toggle('on', S.cont);
    S.typing = false;
    clearTimeout(typingTimer);
    saveState();
    toast(S.cont
      ? '⇶ 连续编译已开启：输入后一帧就启动 TeX，打字过程中预览持续跟进'
      : '连续编译已关闭：恢复「停手后才编译」的防抖模式');
    // 关掉时把可能残留的「连续编译…」中间态收尾成一次正式编译
    clearTimeout(compileTimer);
    compileTimer = setTimeout(() => compileNow(false, true), 16);
  };
  $('turboToggle').onclick = () => {
    S.turbo = !S.turbo;
    $('turboToggle').classList.toggle('on', S.turbo);
    if (S.turbo) {
      // 极速模式由后端按源码内容选引擎，前端把选择权交回「自动」
      S.engine = 'auto'; $('engineSel').value = 'auto';
    }
    saveState();
    toast(S.turbo
      ? (S.cont ? '⚡ 极速已开启：英文文档自动用 pdflatex + 预编译导言（连续编译中）'
                : '⚡ 极速已开启：英文文档自动用 pdflatex + 预编译导言，停手 0.14 秒即编译')
      : (S.cont ? '极速已关闭：恢复标准编译（连续编译仍开启）'
                : '极速已关闭：恢复 0.28 秒防抖与标准编译（仍可用手动引擎）'));
    compileNow(false, true);
  };
  $('syncToggle').onclick = () => {
    S.sync = !S.sync; $('syncToggle').classList.toggle('on', S.sync);
    saveState(); toast(S.sync ? '逐行同步已开启' : '逐行同步已关闭');
    if (!S.sync) document.querySelectorAll('.sync-box').forEach(x => x.remove());
  };
  $('pkgToggle').onclick = () => {
    S.autoPkg = !S.autoPkg;
    $('pkgToggle').classList.toggle('on', S.autoPkg);
    saveState();
    toast(S.autoPkg ? '宏包自动补全已开启' : '宏包自动补全已关闭');
    if (S.autoPkg && autoPackages().length) { onEditorInput(); undoRecord(); }
  };
  $('envHintToggle').onclick = () => {
    envPrefs.hint = !envPrefs.hint;
    syncEnvPrefUI(); saveEnvPrefs();
    // 点完开关把焦点还给编辑器：既能继续打字，也让「重新开启」立刻恢复联想
    $('editor').focus();
    if (!envHintEnabled) closeEnvHint(true); else updateEnvHint();
    toast(envHintEnabled ? '环境联想已开启' : '环境联想已关闭');
  };
  // 浮层内的三项偏好与顶栏开关一样写进 .state.json，跨浏览器 / 跨设备一致
  [['prefAutoClose', 'auto_close', '自动补 \\end{}'],
   ['prefMathWrap', 'math_wrap', '数学模式自动包裹'],
   ['prefGroup', 'group', '分类分组']].forEach(([id, key, label]) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => {
      envPrefs[key] = el.checked;
      saveEnvPrefs();
      toast(label + (el.checked ? ' 已开启' : ' 已关闭'));
      if (key === 'group' && ENV_STATE.open) {
        ENV_STATE.items = envCandidates(ENV_STATE.prefix);
        ENV_STATE.idx = 0;
        renderEnvHint();
      }
    };
  });
  // 点击浮层里的偏好开关时别让编辑器失焦，否则联想会先收起
  $('envHintPrefs').addEventListener('mousedown', ev => {
    if (ev.target.closest('label')) ev.preventDefault();
  });
  $('toolsBtn').onclick = () => openTools(!$('toolPanel').classList.contains('open'));
  $('aiBtn').onclick = () => openAI(!$('aiDrawer').classList.contains('open'));
  $('toolPanelClose').onclick = () => openTools(false);
  $('tpCats').addEventListener('click', ev => {
    const b = ev.target.closest('.tp-cat');
    if (!b) return;
    tpActive = b.dataset.cat; tpSub = '全部';
    renderToolCats(); renderToolGrid();
    $('tpBody').scrollTop = 0;
  });
  $('tpSubcats').addEventListener('click', ev => {
    const b = ev.target.closest('.tp-subcat');
    if (!b) return;
    tpSub = b.dataset.sub;
    renderToolGrid();
    $('tpBody').scrollTop = 0;
  });
  $('tpGrid').addEventListener('click', ev => {
    const b = ev.target.closest('.tp-item');
    if (!b) return;
    const it = (S.tpShown || tpCat().items)[Number(b.dataset.i)];
    if (!it) return;
    if (it.dlg) {
      renderToolDialog($('tpDialog').classList.contains('hidden'));
      return;
    }
    insertSnippet(it.s, it.l);
  });
  $('themeBtn').onclick = () => {
    S.theme = S.theme === 'light' ? 'dark' : 'light';
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add('theme-' + S.theme);
    saveState();
  };
  $('helpBtn').onclick = openHelp;
  $('brandBtn').onclick = () => $('welcome').classList.remove('hidden');
  $('exitBtn').onclick = async () => {
    if (!confirm('退出 YangTex？本地服务与后台进程会被关闭，源文件已保存在项目中。')) return;
    try { await api('/api/shutdown', 'POST', {}); } catch (e) {}
    document.body.innerHTML = '<div class="boot" style="opacity:1"><div class="boot-title">YangTex 已退出</div>' +
      '<div class="boot-sub">可以关闭本页面了。下次双击启动器即可继续使用。</div></div>';
  };

  // 编辑器工具栏
  $('locateBtn').onclick = () => forwardSync(cursorLine(), 'scroll');
  $('wrapBtn').onclick = () => {
    S.wrap = !S.wrap;
    ed.classList.toggle('wrap', S.wrap);
    $('highlight').classList.toggle('wrap', S.wrap);
    toast(S.wrap ? '已开启自动换行（行号仍按逻辑行对应）' : '已关闭自动换行，逐行定位最精确');
  };
  $('fontMinus').onclick = () => { S.fontSize = Math.max(11, S.fontSize - 1); applyFont(); saveState(); };
  $('fontPlus').onclick = () => { S.fontSize = Math.min(20, S.fontSize + 1); applyFont(); saveState(); };

  // 预览工具栏（缩放按钮已在 setupImageDrop() 中提前绑定）
  $('syncHereBtn').onclick = () => {
    if (!S.pageViews.length) { toast('请先编译'); return; }
    const sc = $('pdfScroll'), mid = sc.scrollTop + sc.clientHeight / 2;
    let best = 0, dist = Infinity;
    S.pageViews.forEach((pv, i) => {
      const top = pv.el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const d = Math.abs(top + pv.el.offsetHeight / 2 - mid);
      if (d < dist) { dist = d; best = i + 1; }
    });
    const pv = S.pageViews[best - 1];
    const y = Math.max(30, Math.min(pv.viewport.height - 30, (mid - (pv.el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop)) / S.zoom));
    onPdfClick({ clientX: pv.el.getBoundingClientRect().left + 90,
                    clientY: pv.el.getBoundingClientRect().top + y * S.zoom,
                    preventDefault() {} }, best);
  };
  // ---- PDF 打开 / 下载 ----
  // 下载走 blob：不依赖服务端 Content-Disposition，旧后端未重启时刷新页面也能立即下载。
  function pdfUrl() {
    return '/api/pdf?project=' + encodeURIComponent(S.project) + '&v=' + (S.pdfVer || Date.now());
  }
  function pdfFileName() {
    return (S.project || 'YangTex').replace(/[\\/:*?"<>|\r\n\t]/g, '_') + '.pdf';
  }
  async function downloadPdf() {
    try {
      const r = await fetch(pdfUrl(), { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('pdf')) {
        toast('PDF 尚未生成，请先点击「▶ 编译」');
        return;
      }
      const blob = await r.blob();
      if (!blob.size) { toast('PDF 文件为空，请重新编译'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdfFileName();
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
      toast(`已下载 ${a.download}（${Math.round(blob.size / 1024)} KB）`);
    } catch (e) {
      // 兜底：服务端 attachment 直链（新版后端带 RFC 5987 中文文件名）
      const a = document.createElement('a');
      a.href = '/api/download?project=' + encodeURIComponent(S.project);
      a.download = pdfFileName();
      document.body.appendChild(a); a.click(); a.remove();
      toast('已通过直链下载 PDF');
    }
  }
  function openPdfTab() {
    const w = window.open(pdfUrl(), '_blank');
    if (!w) {   // 浏览器拦截弹窗时退化为普通链接
      const a = document.createElement('a');
      a.href = pdfUrl(); a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    }
    toast('已在新标签页打开完整 PDF，可用浏览器打印或另存');
  }
  $('openPdfBtn').onclick = openPdfTab;
  $('downloadBtn').onclick = downloadPdf;
  $('folderBtn').onclick = async () => {
    const r = await api('/api/open-folder?project=' + encodeURIComponent(S.project));
    if (!r.ok) toast('无法打开文件夹：' + (r.error || ''));
  };

  // 底部面板
  $('bottomTabs').addEventListener('click', ev => {
    const b = ev.target.closest('.btab');
    if (b) {
      // 点标签即展开：否则点了「问题」也看不到列表
      document.querySelectorAll('.btab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderBottom(); expandBottom(true);
    }
  });
  $('bottomToggle').onclick = () => expandBottom(!$('bottomPanel').classList.contains('expanded'));
  $('cleanBtn').onclick = async () => {
    await api('/api/clean', 'POST', { project: S.project });
    toast('已清理编译辅助文件');
  };

  // AI：模型 / 通道选择 + 一键测速选优
  $('aiModel').addEventListener('change', ev => {
    AI_PREF = ev.target.value || 'auto';
    try { localStorage.setItem(AI_PREF_KEY, AI_PREF); } catch (e) {}
    aiUpdateNote();
    toast(AI_PREF === 'auto' ? '已切换为「自动选最快免费通道」' : '已锁定所选模型 / 通道');
  });
  $('aiBench').onclick = aiBench;
  $('aiSelfCheck').onclick = aiSelfCheck;
  const ur = $('updateReload'); if (ur) ur.onclick = () => location.reload();
  const uc = $('updateClose'); if (uc) uc.onclick = () => {
    BUILD_DISMISSED = true;
    const bar = $('updateBar');
    if (bar) { bar.classList.add('hidden'); bar.setAttribute('aria-hidden', 'true'); }
  };
  $('aiClose').onclick = () => openAI(false);
  $('aiSend').onclick = () => {
    const v = $('aiInput').value.trim();
    if (!v) return;
    $('aiInput').value = '';
    aiCall('chat', v);
  };
  $('aiInput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault(); $('aiSend').click();
    }
  });
  document.querySelectorAll('.ai-quick button').forEach(b => {
    b.onclick = () => aiCall(b.dataset.action, '');
  });

  // 弹层 / 欢迎
  $('modalClose').onclick = closeModal;
  $('modal').addEventListener('click', ev => { if (ev.target === $('modal')) closeModal(); });
  $('welcomeClose').onclick = () => { $('welcome').classList.add('hidden'); saveState(); };
  $('welcomeStart').onclick = () => { $('welcome').classList.add('hidden'); saveState(); ed.focus(); };
  $('welcomeTemplates').onclick = () => { $('welcome').classList.add('hidden'); saveState(); openTemplates(); };
  $('welcomeNew').onclick = () => { $('welcome').classList.add('hidden'); saveState(); openNewProject(); };

  // 快捷键
  document.addEventListener('keydown', ev => {
    // 投影模式独占键盘：避免全局 ⌘S / Esc 等快捷键干扰演示
    if (typeof PRES !== 'undefined' && PRES.open) { presKey(ev); return; }
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key.toLowerCase();
    // 只在编辑器内接管撤回/重做；AI 输入框、项目名等仍用浏览器原生撤销
    if (mod && (key === 'z' || key === 'y') && document.activeElement === ed) {
      ev.preventDefault();
      if (key === 'y' || ev.shiftKey) redoEdit(); else undoEdit();
      return;
    }
    if (mod && ev.key === 'Enter') { ev.preventDefault(); compileNow(false, true); }
    else if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveDoc(false); }
    else if (mod && ev.key === '/') {
      ev.preventDefault(); openAI(!$('aiDrawer').classList.contains('open'));
    }
    else if (mod && ev.key.toLowerCase() === 'k') {
      ev.preventDefault(); openTools(!$('toolPanel').classList.contains('open'));
    }
    else if (ev.key === 'F8') { ev.preventDefault(); forwardSync(cursorLine(), 'scroll'); }
    else if (ev.key === 'Escape') {
      closeModal(); $('welcome').classList.add('hidden');
      if ($('aiDrawer').classList.contains('open')) openAI(false);
      if ($('toolPanel').classList.contains('open')) openTools(false);
      if (document.body.classList.contains('preview-max')) togglePreviewMax();
    }
  });

  // 分隔条拖拽
  let dragging = false;
  $('splitter').addEventListener('mousedown', ev => {
    dragging = true; $('splitter').classList.add('dragging');
    document.body.style.userSelect = 'none'; ev.preventDefault();
  });
  document.addEventListener('mousemove', ev => {
    if (!dragging) return;
    // 工作区已为右侧停靠栏让出宽度，按实际可用宽度限制拖拽
    const ws = $('workspace');
    const maxW = Math.max(260, ws.clientWidth - 320);
    const w = Math.max(260, Math.min(maxW, ev.clientX - ws.getBoundingClientRect().left));
    $('editorPane').style.width = w + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; $('splitter').classList.remove('dragging'); document.body.style.userSelect = ''; }
  });

  window.addEventListener('resize', () => {
    positionActiveLine();
    // 展开高度按 36vh 计算，窗口尺寸变化后要重算，避免小窗口又溢出
    if ($('bottomPanel').classList.contains('expanded')) expandBottom(true);
  });
}

const ZOOM_KEY = 'yangtex.zoom';

function setZoom(z) {
  S.zoom = Math.max(0.6, Math.min(2.6, Math.round(z * 100) / 100));
  try { localStorage.setItem(ZOOM_KEY, String(S.zoom)); } catch (e) { /* 隐私模式 */ }
  updateZoomLabel();
  if (S.pdfDoc) loadPdf();
  else updatePageInfo();
}

function updateZoomLabel() {
  const l = $('pvZoomLabel');
  if (l) l.textContent = Math.round(S.zoom * 100) + '%';
}

function changeZoom(delta) { setZoom(S.zoom + delta); }

function togglePreviewMax() {
  const on = document.body.classList.toggle('preview-max');
  const b = $('pvFullBtn');
  if (b) {
    b.textContent = on ? '⛶ 还原布局' : '⛶ 放大预览';
    b.title = on ? '恢复代码｜预览双栏（Esc）' : '把预览放大到整个工作区（Esc 还原）';
  }
  toast(on ? '预览已放大到整个工作区，按 Esc 还原' : '已恢复双栏布局');
  setTimeout(positionActiveLine, 300);
}

// 「⤢」按预览区实际宽度适配，预览栏变宽/变窄后可一键重算
function fitWidthZoom() {
  const pv = S.pageViews.find(Boolean);
  const sc = $('pdfScroll');
  if (!pv || !sc) { toast('请先编译生成 PDF'); return; }
  const base = (pv.view && pv.view.width) ? pv.view.width : pv.viewport.width / S.zoom;
  const avail = Math.max(200, sc.clientWidth - 44);
  setZoom(avail / base);
  toast(`已按预览区宽度适配 · ${Math.round(S.zoom * 100)}%`);
}

// 事件在脚本加载时立即绑定，不等 init 完成：
// 服务重启后首次编译可能要数秒，用户在启动遮罩期间的操作也不会丢。
setupImageDrop();
setupPaneHeads();

// 兜底：若 15 秒后仍未进入工作区，给出可点击的重试入口，避免"点了没反应"
setTimeout(() => {
  const b = $('boot');
  if (!b || b.classList.contains('gone') || $('bootRetry')) return;
  b.innerHTML = '<div class="boot-title">YangTex</div>' +
    '<div class="boot-sub">仍在启动（首次编译可能较慢）· <button id="bootRetry" ' +
    'style="border:0;background:transparent;color:var(--accent);cursor:pointer;' +
    'font:inherit;text-decoration:underline">点此重试</button></div>';
  $('bootRetry').onclick = () => location.reload();
}, 15000);

/* ==========================================================================
   学术写作增强
   --------------------------------------------------------------------------
   1) 公式编号 / 引用编号悬停精确反查：编号来自 .aux 的 \newlabel / \bibcite，
      PDF 上的热区来自 pdf.js getTextContent() 的真实文本项，不做 OCR、不猜。
   2) 参考文献管理 + 引用检查 + 真实性核验（CrossRef / OpenAlex / S2）。
   3) 去注释投稿包导出。
   4) PDF 投影与自动播放（独立 pdf.js 文档，不干扰零抖动预览）。
   ========================================================================== */
const HOVER = { hotspots: {}, current: null, timer: 0, scanning: false,
                rescan: false, pdfFrame: 0, edFrame: 0,
                pdfEv: null, edEv: null,
                hideTimer: 0, thumbSeq: 0, lastX: 0, lastY: 0 };

// pdf.js 常把 (1) 拆成 '(' '1' ')' 三个文本项，也常把编号夹在整句话里，
// 所以热区必须「在文本项内部找编号」，而不是要求整个文本项就是编号。
const HV_BRACKETED = /[\[(]\s*(\d+(?:\.\d+)?[a-zA-Z]?(?:\s*[,，]\s*\d+(?:\.\d+)?[a-zA-Z]?)*)\s*[\])]/g;
const HV_BARE = /^[\[(]?\s*(\d+(?:\.\d+)?[a-zA-Z]?)\s*[\])]?$/;
const HV_HIT_RADIUS = 28;   // 鼠标离编号 28px 内也算命中，避免「差一点就无效」

function hvPick(num, style, eq, rf) {
  const hasEq = !!eq[num], hasRef = !!rf[num];
  if (!hasEq && !hasRef) return null;          // 只认索引里真实存在的编号
  if (style === 'ref') return hasRef ? { kind: 'ref', data: rf[num] }
                                     : (hasEq ? { kind: 'eq', data: eq[num] } : null);
  if (style === 'eq') return hasEq ? { kind: 'eq', data: eq[num] }
                                   : (hasRef ? { kind: 'ref', data: rf[num] } : null);
  return hasRef ? { kind: 'ref', data: rf[num] } : { kind: 'eq', data: eq[num] };
}

async function refreshHoverIndex() {
  try {
    const p = encodeURIComponent(S.project);
    const r = await api('/api/hover-index?project=' + p);
    if (!r.ok) return;
    S.hover = r;
    scheduleHoverScan();
    // 顺带把已缓存的「真实性核验」状态带回来，卡片上直接显示徽标
    const keys = Object.keys(r.refs || {}).join(',');
    if (keys) {
      api('/api/ref-verify?keys=' + encodeURIComponent(keys) + '&project=' + p)
        .then(v => {
          S.verify = {};
          (v.results || []).forEach(x => { S.verify[x.key] = x; });
        }).catch(() => {});
    }
  } catch (e) { /* 悬停是增强功能，绝不影响编译主链路 */ }
}

function scheduleHoverScan() {
  clearTimeout(HOVER.timer);
  HOVER.timer = setTimeout(() => { scanHoverHotspots().catch(() => {}); }, 140);
}

/* pdf.js 的 getTextContent() 真实形态有三种，旧版只认第 ① 种，所以「很多悬停无效」：
     ① (1) / [2] 本身就是一个文本项
     ② 拆成 '(' '1' ')' 三个文本项（公式编号最常见）
     ③ 夹在整句里，如 "see [1,2]"、"(3) implies …"
   这里按「同一基线的文本项拼成一行」统一处理：拼接串上跑括号编号正则，
   再用 char→格子 映射把每个编号换算成页内精确小矩形。
   只有 eq_by_num / ref_by_num 里真实存在的编号才会变成热区，数学式里的孤立数字不会被误判。 */
async function scanHoverHotspots() {
  if (HOVER.scanning) { HOVER.rescan = true; return; }
  if (!S.hover || !S.pageViews.length) return;
  HOVER.scanning = true;
  const eq = S.hover.eq_by_num || {}, rf = S.hover.ref_by_num || {};
  const zoom = S.zoom || 1;
  const next = {};
  try {
    if (!Object.keys(eq).length && !Object.keys(rf).length) {
      HOVER.hotspots = {}; drawHoverHints(); return;
    }
    for (let n = 1; n <= S.pageViews.length; n++) {
      const pv = S.pageViews[n - 1];
      if (!pv) continue;
      const items = await getTextItems(n);
      const v = pv.view || [0, 0, 595, 842];
      const H = v[3] - v[1], W = v[2] - v[0];
      const cells = [];
      for (const it of items) {
        const str = String(it.str || '');
        if (!str || !it.transform) continue;
        const tx = it.transform[4], ty = it.transform[5];
        const w = Math.max(2, Math.min(700, it.width || str.length * 5));
        const h = Math.max(4, Math.min(40, it.height || 10));
        cells.push({ str, x: tx - v[0], y: H - (ty - v[1]) - h,
                     w, h, base: H - (ty - v[1]),
                     right: (tx - v[0]) > W * 0.66 });
      }
      if (!cells.length) continue;

      // 按基线分行（用基线而不是 top，字号不同的上下标才不会把一行切开）
      const byBase = cells.slice().sort((a, b) => a.base - b.base || a.x - b.x);
      const rows = [];
      let row = [], rowBase = null;
      for (const c of byBase) {
        if (!row.length || Math.abs(c.base - rowBase) > 3.5) {
          row = []; rows.push(row); rowBase = c.base;
        }
        row.push(c);
      }

      const list = [], dedupe = new Set();
      const add = (num, kind, data, cx, cy, cw, ch) => {
        const key = num + '|' + kind + '|' + Math.round(cx / 5) + '|' + Math.round(cy / 5);
        if (dedupe.has(key)) return;
        dedupe.add(key);
        list.push({ kind, data, num, page: n,
                    x: cx * zoom, y: cy * zoom,
                    w: Math.max(10, cw * zoom), h: Math.max(10, ch * zoom) });
      };

      for (const raw of rows) {
        if (!raw.length) continue;
        const r = raw.slice().sort((a, b) => a.x - b.x);
        const line = r.map(c => c.str).join('');
        if (!line) continue;
        // loc[i] = 拼接串第 i 个字符属于哪个格子、格内第几个字符
        const loc = [];
        r.forEach((c, ci) => { for (let j = 0; j < c.str.length; j++) loc.push({ ci, li: j }); });
        const xAt = i => {
          const L = loc[i];
          if (L) { const c = r[L.ci]; return c.x + (L.li / c.str.length) * c.w; }
          if (i <= 0) return r[0].x;
          const last = r[r.length - 1];
          return last.x + last.w;
        };

        HV_BRACKETED.lastIndex = 0;
        let m;
        while ((m = HV_BRACKETED.exec(line))) {
          const open = m[0][0], group = m[1];
          const cA = r[(loc[m.index] || {}).ci || 0];
          const cB = r[(loc[Math.min(line.length - 1, m.index + m[0].length - 1)] || {}).ci || 0];
          const cy = Math.min(cA.y, cB.y);
          const ch = Math.max(10, Math.min(30, Math.max(cA.y + cA.h, cB.y + cB.h) - cy));
          // 跨度过大的匹配一定是把不相干的两格粘起来了
          if (xAt(m.index + m[0].length) - xAt(m.index) > 80) continue;
          // 左括号前若紧跟字母/数字（f(1)、a[1]）就不是编号；
          // 但公式常以 ')' 结尾后紧跟编号 '(3)'，这些标点必须放行。
          const L0 = loc[m.index];
          if (L0 && L0.li > 0 && /[A-Za-z0-9_'`]/.test(r[L0.ci].str[L0.li - 1])) continue;
          // 圆括号里的逗号多为坐标 (0,1)，只有右侧公式编号才允许
          if (open === '(' && /[,，]/.test(group) && !cA.right) continue;
          const style = open === '[' ? 'ref' : 'eq';
          const gStart = m.index + m[0].indexOf(group);
          const NUM_TOKEN = /\d+(?:\.\d+)?[a-zA-Z]?/g;
          let t;
          while ((t = NUM_TOKEN.exec(group))) {
            const num = t[0];
            const hit = hvPick(num, style, eq, rf);
            if (!hit) continue;
            const i0 = gStart + t.index, i1 = i0 + num.length;
            const x0 = xAt(i0), x1 = xAt(i1);
            add(num, hit.kind, hit.data, x0, cy, Math.max(10, x1 - x0 + 2), ch);
          }
        }
      }

      // 有些文档类把公式编号印成不带括号的右侧裸数字
      for (const c of cells) {
        const s = c.str.trim();
        if (!c.right || s.length > 4 || !HV_BARE.test(s)) continue;
        const num = (s.match(/\d+(?:\.\d+)?[a-zA-Z]?/) || [])[0];
        if (!num) continue;
        const hit = hvPick(num, 'eq', eq, rf);
        if (hit) add(num, hit.kind, hit.data, c.x, c.y, c.w, c.h);
      }
      next[n] = list;
    }
    HOVER.hotspots = next;
    drawHoverHints();
  } finally {
    HOVER.scanning = false;
    if (HOVER.rescan) { HOVER.rescan = false; scheduleHoverScan(); }
  }
}

function drawHoverHints() {
  document.querySelectorAll('.hv-spot-layer').forEach(e => e.remove());
  Object.keys(HOVER.hotspots).forEach(k => {
    const n = Number(k), pv = S.pageViews[n - 1];
    const list = HOVER.hotspots[n];
    if (!pv || !list || !list.length) return;
    const layer = document.createElement('div');
    layer.className = 'hv-spot-layer';
    list.forEach(s => {
      const el = document.createElement('i');
      el.className = 'hv-spot ' + (s.kind === 'ref' ? 'ref' : '');
      el.style.left = s.x + 'px'; el.style.top = (s.y + s.h - 2) + 'px';
      el.style.width = s.w + 'px'; el.style.height = '2px';
      layer.appendChild(el);
      s.el = el;
    });
    pv.el.appendChild(layer);
  });
}

function doHideHoverCard() {
  const c = $('hoverCard');
  if (!c) return;
  c.classList.add('hidden');
  c.setAttribute('aria-hidden', 'true');
  HOVER.current = null;
  Object.values(HOVER.hotspots).forEach(list =>
    (list || []).forEach(s => { if (s.el) s.el.classList.remove('on'); }));
}
function hideHoverCard(delay = 0) {
  clearTimeout(HOVER.hideTimer);
  if (delay) HOVER.hideTimer = setTimeout(doHideHoverCard, delay);
  else doHideHoverCard();
}

function bibText(e) {
  const f = e.fields || {};
  if (e.raw && String(e.raw).length < 420) return String(e.raw);
  return [f.author, f.title ? '《' + f.title + '》' : '',
          f.journal || f.booktitle || f.publisher || '', f.year,
          f.doi ? 'DOI ' + f.doi : ''].filter(Boolean).join('，') || '（无条目信息）';
}

// 悬停卡片只做「指向」：不铺开 TeX 源码 / 长条目，压成一行，
// 否则大卡片会盖住 PDF 和编辑器，反而挡住要读的内容。
function hvShort(s, n = 150) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function verifyBadge(key) {
  const v = (S.verify || {})[key];
  if (!v) return '<span class="hv-badge">未核验</span>';
  if (v.status === 'verified') return '<span class="hv-badge ok">✓ 已核实</span>';
  if (v.status === 'offline') return '<span class="hv-badge">离线未核验</span>';
  return '<span class="hv-badge bad">未找到匹配</span>';
}

function placeHoverCard(cx, cy) {
  const c = $('hoverCard');
  const w = c.offsetWidth || 296, h = c.offsetHeight || 130;
  let x = cx + 16, y = cy + 16;
  if (x + w > window.innerWidth - 12) x = cx - w - 16;
  if (y + h > window.innerHeight - 12) y = Math.max(8, cy - h - 16);
  c.style.left = Math.max(8, x) + 'px';
  c.style.top = Math.max(8, y) + 'px';
}

function showHoverCard(hit, cx, cy) {
  clearTimeout(HOVER.hideTimer);
  HOVER.lastX = cx; HOVER.lastY = cy;
  const c = $('hoverCard');
  if (HOVER.current !== hit) {
    HOVER.current = hit;
    renderHoverCard(hit);
  }
  c.classList.remove('hidden');
  c.setAttribute('aria-hidden', 'false');
  placeHoverCard(cx, cy);
  Object.values(HOVER.hotspots).forEach(list =>
    (list || []).forEach(s => { if (s.el) s.el.classList.toggle('on', s === hit); }));
}

function renderHoverCard(hit) {
  const d = hit.data || {}, c = $('hoverCard');
  const seq = ++HOVER.thumbSeq;
  c.classList.toggle('is-ref', hit.kind === 'ref');
  $('hvKind').textContent = hit.kind === 'eq' ? '公式' : (hit.kind === 'ref' ? '参考文献' : '标签');
  $('hvNum').textContent = hit.kind === 'ref' ? '[' + (d.num || '') + ']'
    : (d.num ? '(' + d.num + ')' : (d.label || ''));
  if (hit.kind === 'eq' || hit.kind === 'label') {
    const label = esc(d.label || '');
    const cmd = hit.kind === 'eq' ? '\\eqref' : '\\ref';
    // 只显示 PDF 里裁出的公式条带 + 一行标签信息；不再贴 TeX 源码，
    // 卡片因此从 ~300px 高缩到 ~120px，不会盖住正文。
    $('hvBody').innerHTML =
      `<div class="hv-kicker">标签 <code>${esc(cmd)}{${label}}</code> · 第 ${esc(d.page || '?')} 页 · 源码第 ${esc(d.line || '?')} 行</div>` +
      `<div class="hv-thumb" id="hvThumb"><span>正在截取 PDF 中的公式…</span></div>`;
    $('hvFoot').textContent = '点击卡片：跳到源码并定位 PDF';
    hoverThumb(d).then(canvas => {
      if (seq !== HOVER.thumbSeq) return;
      const box = $('hvThumb');
      if (!box) return;
      if (canvas) { box.innerHTML = ''; box.appendChild(canvas); }
      else box.innerHTML = '<span>暂无 PDF 缩略图 · 点击卡片跳到源码</span>';
      // 用最近一次鼠标位置重排，别在卡片当前 left/top 上叠加偏移造成漂移
      if (c && !c.classList.contains('hidden')) placeHoverCard(HOVER.lastX, HOVER.lastY);
    });
  } else {
    const f = d.fields || {};
    $('hvBody').innerHTML =
      `<div class="hv-kicker">引用键 <code>${esc(d.key || '')}</code> · ${esc(d.origin === 'embedded' ? '内嵌 thebibliography' : (d.file || 'BibTeX'))} · 源码第 ${esc(d.line || '?')} 行 ${verifyBadge(d.key || '')}</div>` +
      `<div class="hv-entry">${esc(hvShort(bibText(d), 150))}</div>` +
      (f.doi ? `<div class="hv-kicker hv-doi">DOI <code>${esc(f.doi)}</code></div>` : '');
    $('hvFoot').textContent = '点击卡片：跳到文献条目在源码中的位置';
  }
}

async function hoverThumb(d) {
  try {
    const r = await api('/api/synctex/view', 'POST',
      { project: S.project, line: d.line || 1, col: 1 });
    if (!r.ok || !r.rect) return null;
    const pv = S.pageViews[r.page - 1];
    if (!pv) return null;
    const canvas = pv.el.querySelector('canvas');
    if (!canvas || !canvas.width) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // 取整行横向条带：公式本来就跨页宽，比裁一个窄包围盒好看得多
    const y0 = Math.max(0, (r.rect[1] * S.zoom - 14) * dpr);
    const hh = Math.max(28 * dpr, ((r.rect[3] - r.rect[1]) * S.zoom + 28) * dpr);
    const h = Math.min(canvas.height - y0, hh);
    if (h <= 4) return null;
    const out = document.createElement('canvas');
    const scale = Math.min(1, 900 / canvas.width);
    out.width = Math.round(canvas.width * scale);
    out.height = Math.round(h * scale);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, y0, canvas.width, h, 0, 0, out.width, out.height);
    return out;
  } catch (e) { return null; }
}

function sameHoverHit(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.kind === b.kind && !!a.data && a.data === b.data;
}

function pdfHitAt(ev) {
  // 悬停卡片可能盖在页面上：target 是卡片时用 elementsFromPoint 找到底下的页
  let n = null;
  if (ev.target && ev.target.closest) {
    const wrap = ev.target.closest('.pdf-page');
    if (wrap) n = Number(wrap.dataset.page);
  }
  if (n == null && document.elementsFromPoint) {
    const w = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find(e => e.classList && e.classList.contains('pdf-page'));
    if (w) n = Number(w.dataset.page);
  }
  const pv = n == null ? null : S.pageViews[n - 1];
  if (!pv) return null;
  const list = HOVER.hotspots[n] || [];
  if (!list.length) return null;
  const r = pv.el.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  // 旧版要求鼠标落在「2px 虚线 + 5px pad」的小矩形里，偏 14px 就完全没反应。
  // 改成「到矩形边缘的距离」：矩形内为 0，半径 28px 内按距离取最近热区。
  let hit = null, best = Infinity;
  for (const s of list) {
    const dx = Math.max(s.x - x, 0, x - (s.x + s.w));
    const dy = Math.max(s.y - y, 0, y - (s.y + s.h));
    const dist = Math.hypot(dx, dy);
    if (dist > HV_HIT_RADIUS) continue;
    const center = Math.hypot(x - (s.x + s.w / 2), y - (s.y + s.h / 2));
    const score = (dist > 0 ? 1000 + dist : 0) + center / 1000;
    if (score < best) { best = score; hit = s; }
  }
  return hit;
}

function onPdfHover(ev) {
  const hit = pdfHitAt(ev);
  if (!hit) { hideHoverCard(180); return; }
  showHoverCard(hit, ev.clientX, ev.clientY);
  // 单击 PDF 仍然走原来的 SyncTeX 反向定位，不受悬停热区影响
}

/* textarea 不暴露 caretRangeFromPoint。旧版用「y/行高 → 行号、x/字符宽 → 列号」
   估算，自动换行、中文、字号变化、横向滚动、padding 一变就整体偏移，
   这是 \cite{key} 悬停常常没反应的主因之一。
   这里造一层与编辑器同字体 / 同宽度 / 同滚动位置的镜面 div，借
   caretRangeFromPoint 反查精确字符偏移。全程同步完成，镜面不拦截任何鼠标事件。 */
let ED_MIRROR = null, ED_MIRROR_TEXT = null;

function editorCharWidth() {
  const ed = $('editor'), cs = getComputedStyle(ed);
  const c = document.createElement('canvas').getContext('2d');
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const w = c.measureText('M').width;
  return w > 2 ? w : (S.fontSize * 0.6);
}

function editorOffsetFallback(ev) {
  const ed = $('editor'), r = ed.getBoundingClientRect(), cs = getComputedStyle(ed);
  const padT = parseFloat(cs.paddingTop) || 0, padL = parseFloat(cs.paddingLeft) || 0;
  const lh = parseFloat(cs.lineHeight) || S.lineHeight;
  const y = ev.clientY - r.top + ed.scrollTop - padT;
  const x = ev.clientX - r.left + ed.scrollLeft - padL;
  const line = Math.floor(y / lh) + 1;
  const col = Math.floor(x / editorCharWidth());
  const lines = ed.value.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  return Math.max(0, Math.min(ed.value.length, off + Math.max(0, col)));
}

function editorOffsetAt(ev) {
  const ed = $('editor');
  if (!ed) return null;
  const r = ed.getBoundingClientRect();
  if (ev.clientX < r.left || ev.clientX > r.right ||
      ev.clientY < r.top || ev.clientY > r.bottom) return null;
  const cs = getComputedStyle(ed);
  let m = ED_MIRROR;
  if (!m) {
    m = document.createElement('div');
    m.setAttribute('data-yt-hover-mirror', '1');
    ED_MIRROR = m; ED_MIRROR_TEXT = null;
  }
  if (!m.isConnected) document.body.appendChild(m);
  ['fontFamily','fontSize','fontWeight','fontStyle','fontVariant','letterSpacing',
   'lineHeight','tabSize','wordSpacing','textTransform','wordBreak','overflowWrap',
   'paddingTop','paddingLeft','paddingBottom'].forEach(k => { m.style[k] = cs[k]; });
  m.style.position = 'fixed';
  m.style.left = r.left + 'px'; m.style.top = r.top + 'px';
  m.style.width = r.width + 'px'; m.style.height = r.height + 'px';
  m.style.boxSizing = 'border-box';
  m.style.border = '0'; m.style.margin = '0';
  m.style.whiteSpace = cs.whiteSpace;
  m.style.overflow = 'hidden';
  m.style.color = 'transparent'; m.style.background = 'transparent';
  m.style.zIndex = '9999'; m.style.pointerEvents = 'none';
  // 垂直滚动条会吃掉文本区宽度，用 paddingRight 补出来，换行位置才与 textarea 一致
  const sb = Math.max(0, r.width - ed.clientWidth);
  m.style.paddingRight = ((parseFloat(cs.paddingRight) || 0) + sb) + 'px';
  if (ED_MIRROR_TEXT !== ed.value) {
    m.textContent = ed.value + '\n';
    ED_MIRROR_TEXT = ed.value;
  }
  m.scrollTop = ed.scrollTop; m.scrollLeft = ed.scrollLeft;
  let off = null;
  try {
    m.style.pointerEvents = 'auto';
    void m.offsetHeight;                       // 强制样式/布局生效
    if (document.caretRangeFromPoint) {
      const rg = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (rg && rg.startContainer && (rg.startContainer === m || m.contains(rg.startContainer)))
        off = rg.startContainer === m ? 0 : rg.startOffset;
    } else if (document.caretPositionFromPoint) {
      const cp = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (cp && cp.offsetNode && (cp.offsetNode === m || m.contains(cp.offsetNode)))
        off = cp.offset;
    }
  } catch (e) { /* 老浏览器 / 命中失败 → 走估算兜底 */ }
  m.style.pointerEvents = 'none';
  if (off == null) return editorOffsetFallback(ev);
  return Math.max(0, Math.min(ed.value.length, off));
}

const ED_HOVER_RE = /\\(eqref|ref|autoref|cref|Cref|pageref|cite|citep|citet|parencite|textcite|autocite|nocite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;

function editorHitAt(ev) {
  if (!S.hover || S.sourceKind === 'markdown') return null;
  const off = editorOffsetAt(ev);
  if (off == null) return null;
  const text = $('editor').value;
  ED_HOVER_RE.lastIndex = 0;
  let m, found = null;
  while ((m = ED_HOVER_RE.exec(text))) {
    if (m.index > off) break;
    if (off >= m.index && off <= m.index + m[0].length) { found = m; break; }
  }
  if (!found) return null;
  const cmd = found[1], keys = found[2].split(',').map(s => s.trim()).filter(Boolean);
  const key = keys[0];
  if (!key) return null;
  const isCite = /cite/i.test(cmd);
  const eq = (S.hover.equations || {})[key];
  const rf = (S.hover.refs || {})[key];
  let hit = null;
  if (isCite) {
    // 每个 \cite{key} 都要有反应：条目缺失也弹「请检查引用键」而不是无声无息
    const base = rf || { key, type: 'misc', fields: {}, label: key,
                         raw: '（源码中未找到该条目，请检查引用键或文献表）',
                         origin: 'missing', file: '', line: 1, num: '' };
    const data = keys.length > 1 ? { ...base,
      raw: (base.raw || '') + `（共 ${keys.length} 条引用，卡片显示第 1 条）` } : base;
    hit = { kind: 'ref', data, num: data.num || '' };
  } else if (eq) {
    hit = { kind: (eq.env && eq.env !== 'label') ? 'eq' : 'label',
            data: eq, num: eq.num || '' };
  } else if (rf) {
    hit = { kind: 'ref', data: rf, num: rf.num || '' };
  } else {
    const lines = text.slice(0, found.index).split('\n');
    hit = { kind: 'label', num: '',
            data: { label: key, env: 'label',
                    tex: '（源码中未找到 \\label{' + key + '}，请检查标签拼写）',
                    line: lines.length, page: '' } };
  }
  return hit;
}

function onEditorHover(ev) {
  const hit = editorHitAt(ev);
  if (!hit) { hideHoverCard(180); return; }
  showHoverCard(hit, ev.clientX, ev.clientY);
}

/* ---------------------------------------------------------------- 文献面板 */
const BIB = { tab: 'entries', state: null, check: null, verify: {},
              entries: [], editing: -1, dirty: false, msg: '', busy: false };

async function bibReload() {
  const p = encodeURIComponent(S.project);
  const [st, ck] = await Promise.all([
    api('/api/bib?project=' + p),
    api('/api/ref-check?project=' + p),
  ]);
  BIB.state = st; BIB.check = ck;
  BIB.entries = (st.entries || []).map(e => ({
    ...e, fields: { ...(e.fields || {}) }, raw: e.raw || '' }));
  BIB.editing = -1; BIB.dirty = false;
  const keys = BIB.entries.map(e => e.key).join(',');
  if (keys) {
    try {
      const v = await api('/api/ref-verify?keys=' + encodeURIComponent(keys) + '&project=' + p);
      (v.results || []).forEach(r => { BIB.verify[r.key] = r; });
    } catch (e) { /* 缓存读取失败不影响面板 */ }
  }
}

async function openBibPanel(tab) {
  if (tab) BIB.tab = tab;
  openModal('◉ 参考文献管理', '<div class="yt-empty">正在读取文献与引用…</div>');
  $('modalCard').classList.add('wide');
  try {
    await bibReload();
    renderBibPanel();
  } catch (e) {
    $('modalBody').innerHTML = '<div class="yt-note warn">读取失败：' + esc(e.message || e) + '</div>';
  }
}

function bibModeText() {
  const m = BIB.state && BIB.state.mode;
  if (m === 'embedded') return '内嵌 thebibliography / \\bibitem';
  if (m === 'bib') return 'BibTeX：' + ((BIB.state.files || []).join('、') || 'references.bib');
  return '尚未建立文献表';
}

function renderBibPanel() {
  const st = BIB.state || {}, ck = BIB.check || {};
  const sum = ck.summary || {};
  const tabs = [
    ['entries', '文献条目'], ['check', '引用检查'],
    ['verify', '真实性核验'], ];
  let html = '<div class="yt-tabs">' + tabs.map(([id, name]) =>
    `<button class="yt-tab ${BIB.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">${name}</button>`).join('') + '</div>';
  if (BIB.msg) html += `<div class="yt-note">${esc(BIB.msg)}</div>`;
  if (BIB.tab === 'entries') html += bibEntriesHtml();
  else if (BIB.tab === 'check') html += bibCheckHtml(sum, ck);
  else html += bibVerifyHtml();
  $('modalBody').innerHTML = html;
}

function bibEntriesHtml() {
  const st = BIB.state || {};
  const cited = new Set();
  ((S.hover && S.hover.cites) || []).forEach(c => (c.keys || []).forEach(k => cited.add(k)));
  let h = `<div class="yt-note">当前模式：<b>${esc(bibModeText())}</b>。外部 .bib 与源码内嵌 <code>\\bibitem</code> 都能直接编辑；保存后会自动重载源码并做一次完整编译，让编号与 PDF 同步更新。</div>`;
  h += '<div class="yt-bar">' +
    '<button class="yt-btn primary" data-act="save">保存全部</button>' +
    '<button class="yt-btn" data-act="add">＋ 新增条目</button>' +
    '<button class="yt-btn" data-act="link">挂接 \\bibliography</button>' +
    '<button class="yt-btn" data-act="fullcompile">完整编译</button>' +
    '<span class="sp"></span>' +
    `<span class="yt-pill">${BIB.entries.length} 条</span>` +
    `<span class="yt-pill ${BIB.dirty ? 'warn' : ''}">${BIB.dirty ? '有未保存修改' : '已同步'}</span>` +
    '</div>';
  if (!BIB.entries.length) {
    h += '<div class="yt-empty">项目里还没有文献条目。点「＋ 新增条目」建立第一条，或在编辑器里写 <code>\\bibitem{...}</code> 后重新打开本面板。</div>';
  } else {
    h += '<table class="yt-table"><thead><tr><th>键</th><th>类型</th><th>作者</th><th>标题 / 期刊</th><th>年份</th><th>引用</th><th>核验</th><th>操作</th></tr></thead><tbody>';
    BIB.entries.forEach((e, i) => {
      const f = e.fields || {}, v = BIB.verify[e.key];
      const pill = v ? (v.status === 'verified' ? '<span class="yt-pill ok">已核实</span>'
        : v.status === 'offline' ? '<span class="yt-pill">离线</span>'
        : '<span class="yt-pill bad">未找到</span>') : '<span class="yt-pill">未核验</span>';
      h += `<tr><td class="k">${esc(e.key)}</td><td>${esc(e.type || 'misc')}</td>` +
        `<td class="ell">${esc(f.author || '')}</td>` +
        `<td class="ell">${esc([f.title, f.journal || f.booktitle].filter(Boolean).join(' · '))}</td>` +
        `<td>${esc(f.year || '')}</td>` +
        `<td>${cited.has(e.key) ? '<span class="yt-pill ok">已引用</span>' : '<span class="yt-pill warn">未引用</span>'}</td>` +
        `<td>${pill}</td>` +
        `<td><button class="yt-btn" data-act="edit" data-i="${i}">编辑</button> ` +
        `<button class="yt-btn danger" data-act="del" data-i="${i}">删除</button></td></tr>`;
    });
    h += '</tbody></table>';
  }
  if (BIB.editing >= 0) h += bibFormHtml(BIB.entries[BIB.editing], BIB.editing);
  return h;
}

function bibFormHtml(e, i) {
  if (!e) return '';
  const f = e.fields || {};
  const val = k => esc(f[k] || '');
  const row = (k, label, placeholder) =>
    `<label>${label}<input data-f="${k}" value="${val(k)}" placeholder="${esc(placeholder || '')}"></label>`;
  const types = ['misc', 'article', 'book', 'inproceedings', 'phdthesis', 'misc'];
  return `<div class="yt-form" data-form="${i}">` +
    `<label>引用键<input data-f="key" value="${esc(e.key || '')}" placeholder="GT2020"></label>` +
    `<label>条目类型<select data-f="type">${types.map(t =>
      `<option value="${t}" ${e.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` +
    row('author', '作者', 'D. Gilbarg and N. S. Trudinger') +
    row('title', '标题', 'Elliptic Partial Differential Equations') +
    row('journal', '期刊 / 会议', 'Ann. of Math.') +
    row('year', '年份', '2001') +
    row('volume', '卷', '191') +
    row('pages', '页码', '1--30') +
    row('doi', 'DOI', '10.1007/978-3-642-61798-0') +
    row('url', 'URL', 'https://…') +
    `<label>条目原文（内嵌 thebibliography 时以此为准；留空则按上面字段生成）<textarea data-f="raw" placeholder="D.~Gilbarg, \\emph{Elliptic PDE}, Springer, 2001.">${esc(e.raw || '')}</textarea></label>` +
    `<div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end">` +
    `<button class="yt-btn" data-act="canceledit">收起</button>` +
    `<button class="yt-btn primary" data-act="save">应用并保存</button></div>` +
    '</div>';
}

function bibCheckHtml(sum, ck) {
  let h = '<div class="yt-cards">' +
    `<div class="yt-card"><b>${sum.entries || 0}</b><span>文献条目</span></div>` +
    `<div class="yt-card"><b>${sum.cites || 0}</b><span>正文引用次数</span></div>` +
    `<div class="yt-card err"><b>${sum.errors || 0}</b><span>错误</span></div>` +
    `<div class="yt-card ok"><b>${sum.warnings || 0}</b><span>提醒</span></div></div>`;
  h += '<div class="yt-bar"><button class="yt-btn" data-act="recheck">↻ 重新检查</button>' +
       '<span class="sp"></span><span class="yt-pill">点击条目跳到源码对应行</span></div>';
  const issues = ck.issues || [];
  if (!issues.length) h += '<div class="yt-empty">✓ 没有发现漏引、未定义引用或重复键。</div>';
  else {
    h += '<div class="yt-issues">';
    issues.forEach((x, i) => {
      h += `<div class="yt-issue ${esc(x.severity)}" data-act="goto" data-line="${esc(x.line || 1)}">` +
        `<span class="ln">第 ${esc(x.line || '?')} 行</span>` +
        `<span class="msg">${esc(x.message)}<br><span class="fix">建议：${esc(x.fix || '')}</span></span>` +
        `<span class="yt-pill ${x.severity === 'error' ? 'bad' : (x.severity === 'warn' ? 'warn' : '')}">${esc(x.kind)}</span></div>`;
    });
    h += '</div>';
  }
  h += '<div class="yt-note" style="margin-top:12px">检查范围：<code>\\cite / \\eqref / \\ref</code> 是否指向真实存在的键、文献是否被引用、键是否重复、作者/标题/年份是否齐全，以及 .bib 是否已挂接。编号取自编译产物 main.aux，请先编译一次以保证结果最新。</div>';
  return h;
}

function bibVerifyHtml() {
  const src = 'CrossRef（DOI / 标题）、OpenAlex（书籍与老文献）、Semantic Scholar';
  let h = `<div class="yt-note">「核实真实性」会把条目的标题 / 作者 / 年份送到免费公开索引 <b>${esc(src)}</b> 做比对，只发送文献元数据，不上传正文。结果按条目缓存 7 天；断网时显示「离线未核验」，不会误判为假文献。DOI 精确命中或标题相似度 ≥ 0.58 记为「已核实」。</div>`;
  h += '<div class="yt-bar">' +
    '<button class="yt-btn primary" data-act="verify">🔍 核验全部</button>' +
    '<button class="yt-btn" data-act="verifyforce">↻ 强制重验</button>' +
    '<span class="sp"></span><span class="yt-pill">仅查询公开元数据 · 无需 API Key</span></div>';
  if (!BIB.entries.length) return h + '<div class="yt-empty">还没有文献条目。</div>';
  h += '<table class="yt-table"><thead><tr><th>键</th><th>状态</th><th>匹配到的题名</th><th>来源 / DOI</th></tr></thead><tbody>';
  BIB.entries.forEach(e => {
    const v = BIB.verify[e.key];
    const status = !v ? '<span class="yt-pill">未核验</span>'
      : v.status === 'verified' ? '<span class="yt-pill ok">✓ 已核实</span>'
      : v.status === 'offline' ? '<span class="yt-pill warn">离线未核验</span>'
      : v.status === 'no_query' ? '<span class="yt-pill warn">信息不足</span>'
      : '<span class="yt-pill bad">未找到匹配</span>';
    h += `<tr><td class="k">${esc(e.key)}</td><td>${status}</td>` +
      `<td class="ell">${esc(v ? (v.title || v.message || '') : '')}</td>` +
      `<td class="ell">${esc(v ? [v.source, v.doi, v.year].filter(Boolean).join(' · ') : '')}</td></tr>`;
  });
  h += '</tbody></table>';
  return h;
}

async function bibPanelClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act, i = Number(btn.dataset.i || -1);
  if (act === 'tab') { BIB.tab = btn.dataset.tab; renderBibPanel(); return; }
  if (act === 'goto') {
    const ln = Number(btn.dataset.line || 1);
    closeModal(); gotoLine(ln); toast('跳到源码第 ' + ln + ' 行');
    return;
  }
  if (act === 'add') {
    BIB.entries.push({ key: 'ref' + (BIB.entries.length + 1), type: 'article',
                       fields: {}, raw: '', origin: (BIB.state || {}).mode || 'bib' });
    BIB.editing = BIB.entries.length - 1; BIB.dirty = true;
    renderBibPanel(); return;
  }
  if (act === 'edit') { BIB.editing = i; renderBibPanel(); return; }
  if (act === 'canceledit') { BIB.editing = -1; renderBibPanel(); return; }
  if (act === 'del') {
    if (i >= 0) { BIB.entries.splice(i, 1); BIB.editing = -1; BIB.dirty = true; renderBibPanel(); }
    return;
  }
  if (act === 'save') { await bibSaveAll(); return; }
  if (act === 'link') {
    const r = await api('/api/bib', 'POST', { project: S.project, action: 'link' });
    BIB.msg = r.note || r.error || '';
    toast(BIB.msg); renderBibPanel(); return;
  }
  if (act === 'fullcompile') {
    closeModal(); toast('正在执行完整编译（含 BibTeX / 交叉引用）…');
    await compileNow(true, true); return;
  }
  if (act === 'recheck') {
    BIB.msg = '已重新检查'; await bibReload(); renderBibPanel(); return;
  }
  if (act === 'verify' || act === 'verifyforce') {
    if (BIB.busy) return;
    BIB.busy = true;
    btn.textContent = '核验中…';
    try {
      const r = await api('/api/ref-verify', 'POST', {
        project: S.project, keys: BIB.entries.map(e => e.key),
        force: act === 'verifyforce' });
      (r.results || []).forEach(x => { BIB.verify[x.key] = x; S.verify = S.verify || {}; S.verify[x.key] = x; });
      BIB.msg = `已核验 ${r.total || 0} 条：${r.summary ? r.summary.verified : 0} 条已核实` +
        (r.summary && r.summary.offline ? '，' + r.summary.offline + ' 条因网络未核验' : '');
      renderBibPanel();
    } catch (e) { toast('核验失败：' + (e.message || e)); }
    finally { BIB.busy = false; }
    return;
  }
}

async function bibSaveAll() {
  if (BIB.busy) return;
  BIB.busy = true;
  try {
    const mode = (BIB.state && BIB.state.mode) === 'none'
      ? 'bib' : (BIB.state || {}).mode || 'bib';
    const r = await api('/api/bib', 'POST', {
      project: S.project, action: 'save', mode, entries: BIB.entries,
      file: ((BIB.state || {}).files || [])[0] || 'references.bib',
    });
    if (!r.ok) { toast(r.error || '保存失败'); return; }
    BIB.msg = r.note || '文献表已保存';
    toast(BIB.msg);
    await loadDocument();
    await compileNow(true, true);
    await bibReload();
    renderBibPanel();
  } catch (e) { toast('保存失败：' + (e.message || e)); }
  finally { BIB.busy = false; }
}

function bibPanelInput(ev) {
  const f = ev.target && ev.target.dataset ? ev.target.dataset.f : null;
  if (!f || BIB.editing < 0) return;
  const e = BIB.entries[BIB.editing];
  if (!e) return;
  const v = ev.target.value;
  if (f === 'key') e.key = v;
  else if (f === 'type') e.type = v;
  else if (f === 'raw') e.raw = v;
  else { e.fields = e.fields || {}; e.fields[f] = v; }
  BIB.dirty = true;
}

/* -------------------------------------------------------------- 投稿包面板 */
const SUB = { opts: { strip: true, pdf: true, squeeze: true },
              info: null, busy: false, msg: '' };

function subUrl(dl) {
  const o = SUB.opts;
  return '/api/submission?project=' + encodeURIComponent(S.project) +
    '&strip=' + (o.strip ? 1 : 0) + '&pdf=' + (o.pdf ? 1 : 0) +
    '&squeeze=' + (o.squeeze ? 1 : 0) + (dl ? '' : '&info=1');
}

async function subReload() {
  SUB.info = await api(subUrl(false));
}

async function openSubmission() {
  openModal('⇪ 导出投稿包', '<div class="yt-empty">正在整理项目文件…</div>');
  $('modalCard').classList.add('wide');
  try { await subReload(); renderSubmission(); }
  catch (e) { $('modalBody').innerHTML = '<div class="yt-note warn">整理失败：' + esc(e.message || e) + '</div>'; }
}

function renderSubmission() {
  const o = SUB.opts, info = SUB.info || {};
  const files = info.files || [];
  let h = '<div class="yt-note">投稿包会把 <code>main.tex</code> / Markdown 主源里的 <b>% 注释整段清掉</b>，' +
    '但 <code>\\%</code>、<code>verbatim</code>、<code>lstlisting</code>、<code>minted</code>、<code>comment</code> 环境里的百分号原样保留；' +
    '同时剔除 .aux / .log / .out / .synctex 等编译辅助文件，只留下源码、图片、.bib、类文件、PDF 与清单，解压即可直接投稿或编译。</div>';
  h += '<div class="yt-checks">' +
    `<label><input type="checkbox" data-opt="strip" ${o.strip ? 'checked' : ''}> 去除注释（干干净净）</label>` +
    `<label><input type="checkbox" data-opt="pdf" ${o.pdf ? 'checked' : ''}> 附带生成的 PDF</label>` +
    `<label><input type="checkbox" data-opt="squeeze" ${o.squeeze ? 'checked' : ''}> 合并连续空行</label></div>`;
  h += '<div class="yt-cards">' +
    `<div class="yt-card"><b>${files.length}</b><span>打包文件数</span></div>` +
    `<div class="yt-card"><b>${info.removed_lines || 0}</b><span>清除注释行</span></div>` +
    `<div class="yt-card"><b>${info.removed_chars || 0}</b><span>清除字符</span></div>` +
    `<div class="yt-card ok"><b>${(info.cleaned || []).length}</b><span>已清理源码</span></div></div>`;
  h += '<div class="yt-bar"><button class="yt-btn primary" data-act="download">↓ 下载投稿包 (.zip)</button>' +
       '<button class="yt-btn" data-act="refresh">↻ 重新统计</button>' +
       '<span class="sp"></span><span class="yt-pill">包含 投稿说明.txt 清单</span></div>';
  h += '<div class="yt-files">' + (files.length
    ? files.map(f => `<div class="yt-file"><span>${esc(f.name)}</span><span class="sz">${(f.size / 1024).toFixed(1)} KB</span></div>`).join('')
    : '<div class="yt-empty">没有可打包的文件，请先编译。</div>') + '</div>';
  h += '<div class="yt-note" style="margin-top:12px">建议先点「▶ 编译」确认当前源码能正常出 PDF，再导出。' +
       '若项目用 Markdown 主源，压缩包里会同时包含 Markdown 原文与自动生成的 main.tex。</div>';
  $('modalBody').innerHTML = h;
}

async function subPanelClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (btn && btn.dataset.act === 'download') {
    toast('正在生成投稿包…');
    window.location.href = subUrl(true);
    return;
  }
  if (btn && btn.dataset.act === 'refresh') {
    await subReload(); renderSubmission(); return;
  }
}

function subPanelChange(ev) {
  const k = ev.target && ev.target.dataset ? ev.target.dataset.opt : null;
  if (!k || !(k in SUB.opts)) return;
  SUB.opts[k] = !!ev.target.checked;
  subReload().then(renderSubmission).catch(() => {});
}

/* ------------------------------------------------------------------ 投影播放 */
const PRES = { open: false, doc: null, page: 1, pages: 1, playing: false,
               timer: 0, blank: 0, laser: false, token: 0, dpr: 1, task: null,
               // 批注：按页存笔迹，坐标归一化到 [0,1]，翻页 / 缩放 / 全屏后都能重绘
               ink: false, inks: {}, project: '', color: '#e63946',
               colors: ['#e63946', '#f59f00', '#2f9e44', '#1c7ed6', '#111827'],
               width: 0.0045, drawing: false, stroke: null, faux: false };
const PRES_TIP = '← → / 空格 翻页 · 点击画面左右两侧翻页 · B 黑屏 · W 白屏 · P 播放/暂停 · L 激光笔 · A 批注 · F 全屏 · Esc 退出';
const PRES_INK_TIP = '批注中：拖动写画 · 1–5 换色 · [ ] 粗细 · U 撤销 · C 清除本页 · ⤓ 存图 · A 退出批注 · Esc 退出投影';

let presOpening = false;
async function openPresenter() {
  if (PRES.open || presOpening) return;
  presOpening = true;
  try {
    // 状态栏在 `await loadPdf()` 之前就会置为 ✓，此刻 S.pdfDoc 可能仍为 null。
    // 这个窗口里点「投影」不该误报「请先编译」：等这一轮预览文档就绪（最多 12s）。
    if (!S.pdfDoc) {
      toast('正在载入 PDF 预览…');
      for (let i = 0; i < 60 && !S.pdfDoc; i++) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (!S.pdfDoc) { toast('请先编译生成 PDF，再开启投影'); return; }
    const p = $('presenter');
    p.classList.remove('hidden');
    p.setAttribute('aria-hidden', 'false');
    PRES.open = true;
    // 同一项目反复进出投影时保留批注；换了项目才清空，避免把上一份文档的笔迹带过去
    if (PRES.project !== S.project) { PRES.inks = {}; PRES.project = S.project; }
    presSetInk(false, true); presSetLaser(false); presSyncFullBtn();
    $('presPage').textContent = '加载中…';
    try {
      PRES.doc = await pdfjsLib.getDocument({
        url: '/api/pdf?project=' + encodeURIComponent(S.project) + '&v=' + Date.now(),
        cMapUrl: '/vendor/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/vendor/standard_fonts/',
      }).promise;
      PRES.pages = PRES.doc.numPages;
      PRES.page = 1;
      await presRender();
      toast('投影已开启：→ / 空格 翻页，P 自动播放，Esc 退出');
    } catch (e) {
      toast('投影加载失败：' + (e.message || e));
      closePresenter();
    }
  } finally {
    presOpening = false;
  }
}

function closePresenter() {
  PRES.open = false;
  clearInterval(PRES.timer); PRES.timer = 0; PRES.playing = false;
  if (PRES.task) { try { PRES.task.cancel(); } catch (e) {} PRES.task = null; }
  if (PRES.doc) { try { PRES.doc.destroy(); } catch (e) {} PRES.doc = null; }
  const p = $('presenter');
  p.classList.add('hidden'); p.setAttribute('aria-hidden', 'true');
  $('presPlay').classList.remove('on'); $('presPlay').textContent = '▶ 自动播放';
  $('presBlack').classList.remove('on'); $('presWhite').classList.remove('on');
  $('presLaser').classList.add('hidden'); $('presBlank').classList.add('hidden');
  PRES.blank = 0;
  presSetInk(false, true); presSetLaser(false);
  PRES.drawing = false; PRES.stroke = null;
  if (document.fullscreenElement) {
    try { document.exitFullscreen(); } catch (e) {}
  }
  PRES.faux = false;
  p.classList.remove('pres-faux-full');
  presSyncFullBtn();
}

async function presRender() {
  if (!PRES.doc || !PRES.open) return;
  const token = ++PRES.token;
  // 页码 / 进度先立即更新，不等 pdf.js 渲染完（否则用户以为按键没响应）
  $('presPage').textContent = PRES.page + ' / ' + PRES.pages;
  $('presProgress').style.width = (PRES.page / PRES.pages * 100) + '%';
  // 翻页瞬间就把该页批注换掉，不等 pdf.js 渲染完
  presInkRedraw();
  if (PRES.task) { try { PRES.task.cancel(); } catch (e) {} PRES.task = null; }
  const page = await PRES.doc.getPage(PRES.page);
  if (token !== PRES.token || !PRES.open) return;
  const v0 = page.getViewport({ scale: 1 });
  const stage = $('presStage');
  const availW = Math.max(200, stage.clientWidth - 48);
  const availH = Math.max(200, stage.clientHeight - 48);
  const scale = Math.min(availW / v0.width, availH / v0.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  PRES.dpr = dpr;
  const vp = page.getViewport({ scale: scale * dpr });
  const c = $('presCanvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  c.style.width = (vp.width / dpr) + 'px';
  c.style.height = (vp.height / dpr) + 'px';
  // 批注层与 PDF 层像素尺寸完全一致，覆盖在同一张「纸」上
  const ink = $('presInk');
  if (ink) {
    ink.width = c.width; ink.height = c.height;
    ink.style.width = c.style.width; ink.style.height = c.style.height;
    presInkRedraw();
  }
  try {
    PRES.task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    await PRES.task.promise;
  } catch (e) { return; }
  finally { if (PRES.task && token === PRES.token) PRES.task = null; }
  if (token !== PRES.token || !PRES.open) return;
}

function presStep(delta, loop) {
  if (!PRES.open || !PRES.doc) return;
  if (PRES.blank) { presBlank(0); return; }
  let n = PRES.page + delta;
  if (n > PRES.pages) n = loop ? 1 : PRES.pages;
  if (n < 1) n = loop ? PRES.pages : 1;
  if (n === PRES.page) return;
  PRES.page = n;
  presRender();
}

function presSetPlay(on) {
  PRES.playing = on;
  clearInterval(PRES.timer); PRES.timer = 0;
  $('presPlay').classList.toggle('on', on);
  $('presPlay').textContent = on ? '❚❚ 暂停' : '▶ 自动播放';
  if (on) {
    const sec = Math.max(1, Math.min(60, parseInt($('presInterval').value || '5', 10) || 5));
    PRES.timer = setInterval(() => presStep(1, true), sec * 1000);
    toast('自动播放：每 ' + sec + ' 秒翻一页，到末页循环');
  }
}

function presBlank(mode) {
  PRES.blank = mode === PRES.blank ? 0 : mode;
  const b = $('presBlank');
  b.classList.toggle('hidden', PRES.blank === 0);
  b.classList.toggle('white', PRES.blank === 2);
  $('presBlack').classList.toggle('on', PRES.blank === 1);
  $('presWhite').classList.toggle('on', PRES.blank === 2);
}

/* ------------------------------------------------- 投影：批注画笔 / 全屏 */
function presInkRedraw() {
  const ink = $('presInk');
  if (!ink) return;
  const ctx = ink.getContext('2d');
  const dpr = PRES.dpr || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cssW = parseFloat(ink.style.width) || ink.width / dpr;
  const cssH = parseFloat(ink.style.height) || ink.height / dpr;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of (PRES.inks[PRES.page] || [])) {
    if (!s.p || !s.p.length) continue;
    ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
    ctx.lineWidth = Math.max(1, s.w * cssW);
    if (s.p.length === 1) {
      ctx.beginPath();
      ctx.arc(s.p[0][0] * cssW, s.p[0][1] * cssH, Math.max(1, s.w * cssW / 2), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s.p[0][0] * cssW, s.p[0][1] * cssH);
    for (let i = 1; i < s.p.length; i++) ctx.lineTo(s.p[i][0] * cssW, s.p[i][1] * cssH);
    ctx.stroke();
  }
}

// 只补画新增的一小段，避免每帧重绘整页笔迹拖慢手写
function presInkSegment(s, a, b) {
  const ink = $('presInk');
  const ctx = ink.getContext('2d');
  const dpr = PRES.dpr || 1;
  const cssW = parseFloat(ink.style.width) || ink.width / dpr;
  const cssH = parseFloat(ink.style.height) || ink.height / dpr;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = s.c; ctx.lineWidth = Math.max(1, s.w * cssW);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(a[0] * cssW, a[1] * cssH);
  ctx.lineTo(b[0] * cssW, b[1] * cssH);
  ctx.stroke();
  ctx.restore();
}

function presInkPoint(ev) {
  const ink = $('presInk');
  const r = ink.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const x = (ev.clientX - r.left) / r.width;
  const y = (ev.clientY - r.top) / r.height;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

function presInkStart(ev) {
  if (!PRES.open || !PRES.ink || PRES.blank) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  ev.preventDefault(); ev.stopPropagation();
  const pt = presInkPoint(ev);
  if (!pt) return;
  PRES.stroke = { c: PRES.color, w: PRES.width, p: [pt] };
  (PRES.inks[PRES.page] = PRES.inks[PRES.page] || []).push(PRES.stroke);
  PRES.drawing = true;
  try { ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
  presInkRedraw();  // 单击也要留下一个点
}

function presInkMove(ev) {
  if (!PRES.drawing || !PRES.stroke) return;
  ev.preventDefault();
  const pt = presInkPoint(ev);
  if (!pt) return;
  const p = PRES.stroke.p, last = p[p.length - 1];
  if (Math.abs(pt[0] - last[0]) + Math.abs(pt[1] - last[1]) < 0.0015) return;
  presInkSegment(PRES.stroke, last, pt);
  p.push(pt);
}

function presInkEnd(ev) {
  if (!PRES.drawing) return;
  PRES.drawing = false; PRES.stroke = null;
  try { ev.target.releasePointerCapture(ev.pointerId); } catch (e) {}
}

function presInkUndo() {
  const list = PRES.inks[PRES.page] || [];
  if (!list.length) { toast('本页没有可撤销的批注'); return; }
  list.pop();
  presInkRedraw();
  toast('已撤销一笔（本页还剩 ' + list.length + ' 笔）');
}

function presInkClear() {
  const list = PRES.inks[PRES.page] || [];
  if (!list.length) { toast('本页没有批注'); return; }
  PRES.inks[PRES.page] = [];
  presInkRedraw();
  toast('已清除第 ' + PRES.page + ' 页的全部批注');
}

function presInkSetColor(c, silent) {
  PRES.color = c;
  document.querySelectorAll('#presSwatches .pres-swatch').forEach(b => {
    b.classList.toggle('on', b.dataset.color === c);
  });
  if (!silent) toast('批注颜色已切换');
}

function presInkSetWidth(w, silent) {
  PRES.width = w;
  const sel = $('presInkWidth');
  if (sel) sel.value = String(w);
  if (!silent) toast('笔触：' + (w <= 0.0025 ? '细' : w >= 0.0075 ? '粗' : '中'));
}

function presInkWidthStep(delta) {
  const sel = $('presInkWidth');
  if (!sel) return;
  const i = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + delta));
  sel.selectedIndex = i;
  presInkSetWidth(parseFloat(sel.value));
}

function presInkSave() {
  const c = $('presCanvas'), ink = $('presInk');
  if (!c || !c.width) { toast('当前页尚未渲染完成'); return; }
  const out = document.createElement('canvas');
  out.width = c.width; out.height = c.height;
  const cx = out.getContext('2d');
  cx.drawImage(c, 0, 0);
  if (ink && ink.width === c.width) cx.drawImage(ink, 0, 0);
  out.toBlob(blob => {
    if (!blob) { toast('存图失败'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (S.project || 'YangTex') + '-投影第' + PRES.page + '页.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('已保存第 ' + PRES.page + ' 页（含批注）');
  }, 'image/png');
}

function presSetInk(on, silent) {
  PRES.ink = on;
  $('presStage').classList.toggle('ink-on', on);
  $('presInkBtn').classList.toggle('on', on);
  $('presInkTools').classList.toggle('hidden', !on);
  PRES.drawing = false; PRES.stroke = null;
  $('presTip').textContent = on ? PRES_INK_TIP : PRES_TIP;
  if (!silent) toast(on ? '批注已开启：笔迹按页保留，翻页回来仍在'
                       : '批注已关闭');
}

function presSetLaser(on) {
  PRES.laser = on;
  $('presLaserBtn').classList.toggle('on', on);
  $('presLaser').classList.toggle('hidden', !on);
}

// 激光笔与画笔互斥：一个开着时切到另一个，自动把前一个关掉
function presToggleInk() {
  const on = !PRES.ink;
  if (on) presSetLaser(false);
  presSetInk(on);
}

function presToggleLaser() {
  const on = !PRES.laser;
  if (on) presSetInk(false, true);
  presSetLaser(on);
}

function presSyncFullBtn() {
  const b = $('presFullBtn');
  if (!b) return;
  const on = !!document.fullscreenElement || !!PRES.faux;
  b.classList.toggle('on', on);
  b.textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
}

async function presToggleFull() {
  const p = $('presenter');
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch (e) {}
    PRES.faux = false; p.classList.remove('pres-faux-full');
  } else {
    let ok = false;
    try {
      if (p.requestFullscreen) {
        await p.requestFullscreen();
        ok = !!document.fullscreenElement;
      }
    } catch (e) { ok = false; }
    // 部分浏览器 / 内嵌窗口会拒绝原生全屏：退化为「沉浸模式」，仍可用 F 切换
    if (!ok) {
      PRES.faux = !PRES.faux;
      p.classList.toggle('pres-faux-full', PRES.faux);
      toast(PRES.faux ? '浏览器未允许原生全屏，已切换沉浸模式'
                      : '已退出沉浸模式');
    }
  }
  presSyncFullBtn();
  if (PRES.open) presRender();
}

function presKey(ev) {
  const k = ev.key;
  const ae = document.activeElement;
  if (k !== 'Escape' && ae &&
      (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
  const low = k.toLowerCase();
  if (k === 'Escape') { ev.preventDefault(); closePresenter(); }
  else if ((ev.metaKey || ev.ctrlKey) && low === 'z') {
    ev.preventDefault(); presInkUndo();
  }
  else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Enter') {
    ev.preventDefault(); presStep(1, true);
  } else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') {
    ev.preventDefault(); presStep(-1, true);
  } else if (k === 'Home') { ev.preventDefault(); PRES.page = 1; presRender(); }
  else if (k === 'End') { ev.preventDefault(); PRES.page = PRES.pages; presRender(); }
  else if (low === 'b') { ev.preventDefault(); presBlank(1); }
  else if (low === 'w') { ev.preventDefault(); presBlank(2); }
  else if (low === 'p') { ev.preventDefault(); presSetPlay(!PRES.playing); }
  else if (low === 'l') { ev.preventDefault(); presToggleLaser(); }
  else if (low === 'a') { ev.preventDefault(); presToggleInk(); }
  else if (low === 'f') { ev.preventDefault(); presToggleFull(); }
  else if (low === 'u') { ev.preventDefault(); presInkUndo(); }
  else if (low === 'c') { ev.preventDefault(); presInkClear(); }
  else if (k >= '1' && k <= '5' && PRES.ink) {
    ev.preventDefault(); presInkSetColor(PRES.colors[+k - 1]);
  } else if (k === '[' || k === ']') {
    ev.preventDefault(); presInkWidthStep(k === ']' ? 1 : -1);
  }
}

/* ------------------------------------------------------------------ 绑定 */
function setupScholar() {
  const $id = id => document.getElementById(id);
  if ($id('bibBtn')) $id('bibBtn').onclick = () => openBibPanel('entries');
  if ($id('submissionBtn')) $id('submissionBtn').onclick = () => openSubmission();
  if ($id('presentBtn')) $id('presentBtn').onclick = () => openPresenter();
  if ($id('presentMiniBtn')) $id('presentMiniBtn').onclick = () => openPresenter();

  const card = $id('hoverCard');
  if (card) {
    card.addEventListener('mouseenter', () => clearTimeout(HOVER.hideTimer));
    card.addEventListener('mouseleave', () => hideHoverCard(140));
    // 卡片是可点击的，会挡住底下的编辑器 / PDF。只有当「卡片底下确实是另一个
    // 公式/引用编号」时才让位；否则说明用户正移向卡片准备点击，必须保留卡片。
    document.addEventListener('mousemove', ev => {
      if (card.classList.contains('hidden') || !card.contains(ev.target)) return;
      const cx = ev.clientX, cy = ev.clientY;
      if (Math.hypot(cx - HOVER.lastX, cy - HOVER.lastY) <= 52) return;
      const stack = document.elementsFromPoint
        ? document.elementsFromPoint(cx, cy) : [];
      const isEditor = stack.some(e => e.id === 'editor');
      const isPdf = stack.some(e => e.classList && e.classList.contains('pdf-page'));
      if (!isEditor && !isPdf) return;
      const at = { clientX: cx, clientY: cy, target: null };
      const next = isEditor ? editorHitAt(at) : pdfHitAt(at);
      if (!next || sameHoverHit(next, HOVER.current)) return;
      hideHoverCard(0);
      // 延到本轮 mouseleave / mouseenter 边界事件派发完之后再弹出：
      // 否则它们排队的 140~220ms 延迟隐藏会把刚显示的新卡片又收掉。
      setTimeout(() => {
        if (isEditor) HOVER.edEv = at; else HOVER.pdfEv = at;
        showHoverCard(next, cx, cy);
      }, 0);
    }, true);
    card.addEventListener('click', ev => {
      if (ev.target.closest('#hvClose')) { hideHoverCard(); return; }
      ev.stopPropagation();
      const hit = HOVER.current;
      if (!hit) return;
      const line = (hit.data && hit.data.line) || 1;
      hideHoverCard();
      gotoLine(line);
      forwardSync(line, 'scroll');
      toast(hit.kind === 'ref' ? '已跳到文献条目' : '已跳到公式 / 标签');
    });
    $id('hvClose').onclick = ev => { ev.stopPropagation(); hideHoverCard(); };
  }

  const pages = $id('pdfPages');
  if (pages) {
    pages.addEventListener('mousemove', ev => {
      HOVER.pdfEv = ev;
      if (HOVER.pdfFrame) return;
      HOVER.pdfFrame = requestAnimationFrame(() => {
        HOVER.pdfFrame = 0;
        if (HOVER.pdfEv) onPdfHover(HOVER.pdfEv);
      });
    });
    pages.addEventListener('mouseleave', () => { HOVER.pdfEv = null; hideHoverCard(220); });
  }
  const ed = $id('editor');
  if (ed) {
    ed.addEventListener('mousemove', ev => {
      HOVER.edEv = ev;
      if (HOVER.edFrame) return;
      HOVER.edFrame = requestAnimationFrame(() => {
        HOVER.edFrame = 0;
        if (HOVER.edEv) onEditorHover(HOVER.edEv);
      });
    });
    ed.addEventListener('mouseleave', () => { HOVER.edEv = null; hideHoverCard(220); });
  }

  // 面板按钮统一委托：按标题区分是文献面板还是投稿包面板
  const body = $id('modalBody');
  if (body) {
    body.addEventListener('click', ev => {
      const t = ($id('modalTitle') || {}).textContent || '';
      if (t.includes('参考文献')) bibPanelClick(ev);
      else if (t.includes('投稿包')) subPanelClick(ev);
    });
    body.addEventListener('input', ev => {
      const t = ($id('modalTitle') || {}).textContent || '';
      if (t.includes('参考文献')) bibPanelInput(ev);
    });
    body.addEventListener('change', ev => {
      const t = ($id('modalTitle') || {}).textContent || '';
      if (t.includes('参考文献')) bibPanelInput(ev);
      else if (t.includes('投稿包')) subPanelChange(ev);
    });
  }

  // 投影控制条
  const bind = (id, fn) => { const e = $id(id); if (e) e.onclick = fn; };
  bind('presPrev', () => presStep(-1, true));
  bind('presNext', () => presStep(1, true));
  bind('presPlay', () => presSetPlay(!PRES.playing));
  bind('presBlack', () => presBlank(1));
  bind('presWhite', () => presBlank(2));
  bind('presLaserBtn', presToggleLaser);
  bind('presInkBtn', presToggleInk);
  bind('presFullBtn', presToggleFull);
  bind('presInkUndo', presInkUndo);
  bind('presInkClear', presInkClear);
  bind('presInkSave', presInkSave);
  bind('presExit', closePresenter);
  const sw = $id('presSwatches');
  if (sw) sw.addEventListener('click', ev => {
    const b = ev.target.closest('.pres-swatch');
    if (b) presInkSetColor(b.dataset.color);
  });
  const iw = $id('presInkWidth');
  if (iw) iw.addEventListener('change', () => presInkSetWidth(parseFloat(iw.value)));
  const ink = $id('presInk');
  if (ink) {
    ink.addEventListener('pointerdown', presInkStart);
    ink.addEventListener('pointermove', presInkMove);
    ink.addEventListener('pointerup', presInkEnd);
    ink.addEventListener('pointercancel', presInkEnd);
  }
  const stage = $id('presStage');
  if (stage) {
    stage.addEventListener('click', ev => {
      // 批注模式下点击是落笔，不能再触发左右两侧翻页
      if (!PRES.open || PRES.ink || PRES.drawing) return;
      const r = stage.getBoundingClientRect();
      const x = ev.clientX - r.left;
      if (x < r.width * 0.35) presStep(-1, true);
      else if (x > r.width * 0.65) presStep(1, true);
    });
    stage.addEventListener('mousemove', ev => {
      if (!PRES.laser) return;
      const dot = $id('presLaser');
      dot.style.left = ev.clientX + 'px';
      dot.style.top = ev.clientY + 'px';
    });
  }
  document.addEventListener('fullscreenchange', () => {
    PRES.faux = false;
    $id('presenter').classList.remove('pres-faux-full');
    presSyncFullBtn();
    if (PRES.open) presRender();
  });
  window.addEventListener('resize', () => { if (PRES.open) presRender(); });
}

setupScholar();

document.addEventListener('DOMContentLoaded', init);
})();
