# YangTex 技术文档与使用手册

**版本 1.0.0 · 轻量 · 实时 · 中英文 · 精确双向同步**

本文档面向两类读者：第一至第七章是**使用手册**，按"安装 → 写作 → 编译 → 投稿"的实际工作流组织，可直接照着操作；第八至第十五章是**技术实现附录**，记录架构、编译流水线、HTTP 接口、编号索引、启动器与验证体系，供后续维护与二次开发查阅。文中所有功能描述、参数与文件名均对应当前交付版本（`YangTex.py` 2000 行、`web/app.js` 5581 行、`scholar_tools.py` 1124 行、`markdown_tex.py` 405 行、模板 70 份）。

> 阅读约定：`⌘/Ctrl + X` 表示 macOS 用 Command、Windows/Linux 用 Ctrl；反引号包裹的是文件名、命令或代码；表格中"默认"一列指首次启动时的状态，用户改动会持久化到 `.state.json`。

---

## 一、产品概览

### 1.1 它是什么

YangTex 是运行在本机的轻量 LaTeX 写作台。它用 **Python 标准库**启动一个本地 HTTP 服务，用**浏览器**作为界面，调用机器上已安装的 TeX 引擎完成编译。没有 Electron 外壳、没有账号体系、没有云同步，也不要求用户配置任何密钥。双击对应平台的启动器即可打开操作页面，启动器短生命周期退出、后台服务与终端解绑，**全程不保留终端窗口**。

服务的默认端口是 `17865`，只监听本机回环地址；界面与数据都留在本地磁盘。它追求的是 Texifier / Texpad 那类"边写边看"的体验，但把实现约束在"零第三方 Python 依赖 + 复用系统 TeX 发行版"这一轻量前提下。

### 1.2 设计目标与边界

| 目标 | 实现方式 | 明确边界 |
| --- | --- | --- |
| 双击即用 | macOS `.app`、Windows `.vbs`/`.bat`、Linux `.sh` 三套启动器 | 仍需 Python 3.10+ 与 TeX Live / MiKTeX |
| 中英文都能编译 | 按源码自动选 `pdflatex` / `xelatex`，中文模板用 `ctex` + `fontset=fandol` | 不随包分发字体，依赖系统或 TeX 发行版自带字体 |
| 实时自动编译 | 输入防抖 → 增量写盘 → 单轮 TeX → pdf.js 双缓冲刷新 | 外部 TeX 引擎每轮有一次进程启动，无法做到逐键即时 |
| 精确双向同步 | SyncTeX `view` / `edit` + pdf.js 文本项吸附 | 依赖编译产出 `.synctex.gz` |
| 模板可持续扩充 | `templates/_index.json` 元数据 + 目录扫描 + 官方类注入 | 第三方期刊 `.cls` 不随包分发，避免许可问题 |
| AI 免设置可用 | 浏览器直连匿名免费端点 + 内置离线知识库兜底 | 匿名免费层有同 IP 频率限制，非商用 SLA |
| 轻量可分发 | 全部后端用标准库，前端 pdf.js 随包 | 分发包约 24 MB，不含 TeX 发行版本体 |

一个必须说清的边界：Texifier / Texpad 的"每敲一键就出结果"来自其**内置增量排版引擎**（只重排光标到可见区之间的内容、结果直接画进显存、不生成磁盘 PDF）。YangTex 走本机 TeX Live，每轮至少一次进程启动加完整排版，本机实测下限约 0.5 秒。架构差异决定了它只能"接近"而不能"等同"；要真正逐键实时，需要换内置 typesetter，那就不是轻量方案了。

### 1.3 功能总览

| 领域 | 能力 |
| --- | --- |
| 写作 | 语法高亮、行号、自定义快照撤回/重做、自动换行、字号调节、环境联想与自动配对、宏包自动补全、数学模式包裹、依赖诊断、图片拖入 |
| 编译 | 实时防抖编译、⚡ 极速模式（`.fmt` 预编译导言 + 引擎自动择优）、完整编译（BibTeX + 多轮交叉引用）、错误面板展开与点击跳行 |
| 预览 | pdf.js 多页渲染、零抖动刷新、就地缩放、放大预览、每页页码徽标、标题栏页码跳转、打开/下载 PDF |
| 同步 | SyncTeX 源码 → PDF（F8）、PDF → 源码（单击）、Markdown 行号映射 |
| 模板 | 70 份、16 个一级分类、38 份标记为官方模板、Markdown 与混排 8 份、原稿全量模板 7 份、分类检索、自定义模板 |
| AI | 免费大模型、动态模型发现、通道测速选优、SSE 流式、31 秒冷却、离线知识库秒回、一键自检 |
| 学术 | 公式/引用编号悬停指向、参考文献管理、引用检查、真实性核验、去注释投稿包 |
| 演示 | 独立 pdf.js 投影、自动播放、黑/白屏、激光笔、按页批注、全屏与沉浸降级 |
| 界面 | 三栏布局（代码 / 预览 / AI 与工具）、深浅主题、C 方案单行菜单栏、17 档宽度零溢出 |

### 1.4 版本与运行环境

| 项 | 当前值 |
| --- | --- |
| 产品版本 | `1.0.0` |
| 服务端口 | `17865`（被占用时自动择下一个空闲端口） |
| 后端 | Python 3.10+（本机实测 3.13.12），仅标准库 |
| TeX 发行版 | TeX Live 2026（本机）；MiKTeX 亦可 |
| 必需 TeX 程序 | `xelatex`、`pdflatex`；建议同时有 `lualatex`、`synctex`、`bibtex`、`kpsewhich`、`latexmk` |
| 浏览器 | 任意现代浏览器（Chrome / Edge / Safari / Firefox） |
| 本机实测环境 | macOS 26.7.2 / Darwin 25.6.0 / x86_64 |

`/api/init` 会返回 `engines`、`engine_paths`、`tex_ready`、`synctex_ready`、`env_pkgs`（由 `kpsewhich` 批量探测的宏包可用性）、`platform` 等字段；界面「?」帮助底部直接显示这些检测结果。

---

## 二、快速开始

### 2.1 解压与启动

把 `YangTex-轻量版.zip` 解压到任意不含特殊权限限制的目录，保持目录内结构完整。三平台启动方式如下：

| 平台 | 启动文件 | 窗口行为 | 说明 |
| --- | --- | --- | --- |
| macOS 10.13+ | `YangTex.app` | 无终端 | `Info.plist` 声明 `LSMinimumSystemVersion=10.13`，ad-hoc 签名，内部启动器权限 755 |
| Windows | `双击启动 YangTex.vbs` | 无终端 | 调用 `pythonw.exe` 隐藏窗口；`备用启动 YangTex.bat` 作为备用；两者均为 CRLF 换行 |
| Linux | `启动 YangTex.sh` | 无终端 | `nohup` 分离服务，端口就绪后由启动器打开浏览器；无图形会话时只打印地址 |

三个启动器都是**一键启动、自动开浏览器、重启旧实例以载入最新代码**。Windows 的 VBScript 会依次枚举 19 个 Python 候选路径（覆盖 3.10–3.14，已排除不兼容的 3.9 及以下），找到第一个可用解释器后启动。Linux 启动器支持用 `YANGTEX_PYTHON` 覆盖解释器路径，用 `BROWSER` 指定浏览器。

### 2.2 依赖检查

首次打开页面后，点顶栏 `?` 查看「当前环境」。若显示「✗ 未检测到」，请先安装 TeX Live（macOS 可用 MacTeX，Windows 可用 MiKTeX，Linux 用发行版包管理器），确保 `xelatex` 与 `pdflatex` 在 `PATH` 中。若 TeX 装在非标准位置，可在产品根目录建 `config.json` 指定引擎路径；后端 `find_tex_bin()` 也会主动探测常见安装目录。

### 2.3 第一次编译

1. 欢迎页点「开始写作」，或直接点「浏览模板库」挑一份模板。
2. 顶栏「＋ 新建」创建独立项目目录，模板库里点「套用」会用模板内容初始化 `main.tex`（或 `main.md`）。
3. 在左侧编辑器输入内容，停止输入约 0.14–0.3 秒后自动编译；也可按 `⌘/Ctrl + Enter` 立即编译。
4. 右侧「实时预览」出现排版结果；状态栏显示 ✓、引擎名与耗时。
5. 若编译失败，底部问题面板自动展开，点任意错误条目跳到源码行；上一版成功的 PDF 会保留。

### 2.4 退出

点右上角 `⏻` 会调用 `/api/shutdown` 关闭本地服务并停止后台进程；接口在 `os._exit(0)` 之前显式删除 `.runtime.json`，避免下次启动读到过期的 port / pid。直接关闭浏览器标签页不会停止服务，重新打开同一地址即可继续。

---

## 三、界面与基本操作

### 3.1 三栏布局

工作区从左到右是「代码编辑器 ｜ PDF 实时预览 ｜ AI 助手 / 工具面板」。AI 与工具面板**共用第三栏且互斥**，作为右侧停靠栏附着而不是浮层，因此完全不遮挡 PDF。中间的分隔条可拖动调整代码与预览的宽度，双击恢复 50% / 50%。点底栏「⛶ 放大预览」把预览铺满工作区，再点一次或按 `Esc` 还原。

### 3.2 顶栏（C 方案菜单栏）

顶栏保持**单行、按钮一个不减**。当前版式不靠「隐藏文字换零溢出」，而是用分组标题（写作 / 工具）、窄宽度短词（自动 / 连续 / 极速 / 同步 / 宏包 / 联想 / 工具 / AI / 文献 / 投稿 / 投影）、悬浮文字气泡和统一强调色开关来实现。断点为 1700 / 1650 / 1250 / 1050 / 960 / 900 六档，仅在 ≤900px 才恢复横向滚动；已在 1700 至 900 共 17 档宽度实测零溢出。加入「⇶ 连续编译」后开关组由 5 枚增至 6 枚，断点相应上移以继续保证零溢出。

从左到右的功能区：

| 组 | 控件 | 作用 |
| --- | --- | --- |
| 项目 | 项目下拉、＋ 新建、▤ 模板 | 切换 / 新建项目、打开模板库 |
| 写作 | 引擎下拉、▶ 编译、⏱ 自动编译、⇶ 连续编译、⚡ 极速、⇄ 逐行同步、⊕ 宏包补全、⌁ 环境联想 | 编译与写作辅助开关，默认全开（引擎为「自动」）；「⇶ 连续编译」决定是否等停手 |
| 工具 | 🧰 工具面板、✦ AI 助手、◉ 文献、⇪ 投稿包、📽 投影 | 五个入口 |
| 右侧常驻 | ◐ 主题、? 帮助、⏻ 退出 | `position:sticky` 保证窄宽度下仍可见 |

### 3.3 编辑器栏

标题栏显示当前主编辑源文件名与类型徽标（如 `main.md` + 绿色「Markdown 源」），右侧是「已保存」提示、↶ 撤回 / ↷ 重做、▣ 插入图片、⟨TeX⟩ 查看 / MD→TeX、⇥ 定位到 PDF、↩ 自动换行、A− / A+ 字号。底部显示行列位置与行数 / 字符数。

### 3.4 预览栏

「实时预览」标题右侧就是缩放控件：`−` / 百分比 / `＋` / `⤢ 适配` / `100`，紧随其后是**页码指示器** `N / M`（点击可输入页码跳转，Enter 确认、Esc 取消、越界自动钳制）。PDF 上按 `⌘/Ctrl + 滚轮` 也能缩放，缩放偏好自动保存。

预览区还有三处同源的页码显示：每页上沿外侧的 `.pdf-pageno` 徽标（`n / M`，点击跳页且不会误触 SyncTeX）、底栏 `#pageInfo`（`第 N / M 页 · zoom%`）、标题栏 `#pvPageNo`。当前页按视口上三分之一判定，滚动监听用 `requestAnimationFrame` 合帧，只改 class 与文本、不写 `scrollTop`。

预览工具栏另有 ⇤ 反向定位、↗ 打开 PDF、↓ 下载 PDF、📽 投影、▣ 文件夹。打开与下载走浏览器本地文件流，中文项目名保持原样。

### 3.5 底栏问题面板

编译失败时自动展开，工作区同步让出高度，列出错误、警告与环境信息。三个页签是「问题 / 编译日志 / 环境」。点「▲ 展开」或「▼ 收起」切换；「清理辅助文件」调用 `/api/clean` 删除 `.aux` / `.log` / `.out` 等中间产物。

### 3.6 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `⌘/Ctrl + Enter` | 立即编译 |
| `⌘/Ctrl + S` | 保存 |
| `⌘/Ctrl + Z` | 撤回 |
| `⌘/Ctrl + Shift + Z` 或 `Ctrl + Y` | 重做 |
| `F8` | 源码 → PDF 定位 |
| `⌘/Ctrl + /` | AI 助手 |
| `⌘/Ctrl + K` | 工具面板 |
| `Esc` | 关闭弹层 / 退出放大预览 / 退出投影 |

投影模式另有 `←` `→` `空格`（翻页）、`P`（播放）、`B` `W`（黑/白屏）、`L`（激光笔）、`A`（批注）、`F`（全屏）、`U`（撤销笔迹）、`C`（清除本页）、`1`–`5`（换色）、`[` `]`（粗细）、`Home/End`（首末页）。

---

## 四、写作与编译

### 4.1 实时自动编译

**默认行为是 4.9 节的连续编译**：输入后一帧（20ms）即启动 TeX，不等停手；关闭「⇶ 连续编译」后才回到停手防抖（标准 0.28 秒、⚡ 极速 0.14 秒）。整条链路针对延迟做了完整优化：

- **源码指纹**：`contentHash()` 与 `S.docRev` 标记文档版本；过期结果在连续编译下作为安静中间帧渲染、下一轮立即接上，关闭连续编译时整个丢弃；
- **整轮跳过**：源码与磁盘内容自上次成功编译后未变时，直接跳过整轮 TeX，状态栏显示「✓ 已是最新」；后端还有「语义免编译」（4.11），注释 / 空白改动连 TeX 进程都不启动；
- **异步日志**：`/api/log` 用 fire-and-forget 读取，不阻塞渲染；
- **优先可见页**：pdf.js 多页并行渲染，当前可见页优先；
- **页级失效分析**：按每页内容流指纹只重画变化页，全局指纹未变时连 pdf.js 解析都跳过（4.10）；
- **DOM 复用**：页数与尺寸不变时连 `.pdf-page` DOM 和点击事件都不重建。

切换项目、换引擎、手动点「▶ 编译」仍会强制真正重编一次。**剩余耗时主要是本机 TeX 引擎的全量排版**（英文 `pdflatex` 实测下限约 0.5 秒，中文 `xelatex` 约 1.4 秒），其中 kpathsea 初始化占主要部分；这是不改内置排版引擎就无法消除的硬开销。

### 4.2 ⚡ 极速模式

顶栏「⚡ 极速」默认开启，包含三件事：

1. **按源码自动选最快引擎**：纯英文 / 拉丁文档走 `pdflatex`（约 0.8 秒），中文、`ctex`、`fontspec`、`unicode-math` 或非拉丁字符自动走 `xelatex`（约 1.5 秒）。判断前先用 `strip_tex_comments()` 剥掉 `%` 注释，因此英文模板里的中文说明不会误判。
2. **预编译导言区**：用 `pdflatex -ini … \dump` 生成 `.fmt` 并缓存到 `.fmt_cache/`，每轮只排版正文，TeX 阶段再省约 20–30%。正文文件把导言的每一行替换成空行以**保持原始行号**，因此双向逐行同步、编译错误行号、图片与 `.bib` 资源引用全部不变。
3. **停手防抖 0.14 秒**（仅在关闭连续编译时生效）：状态栏成功信息带「⚡」表示命中极速通道。实测 `.fmt` 预编译导言只省约 18ms（3.5%），真正的提速来自 4.10 / 4.11 两节所述的前端增量与语义跳过。

中文 / 字体类文档、Markdown 中文模板、导言无法预编译的文档、「完整编译」以及任何异常都会**自动退回标准编译**。手动在引擎下拉里指定具体引擎会自动关闭极速模式，把控制权交还给用户。从极速切回标准时，后端会把 `.turbo/` 里较新的 `.aux` 带回项目根，避免交叉引用编号退回上一轮。

### 4.3 宏包自动补全

开启「⊕ 宏包补全」后，写到 `\includegraphics`、`align`、`\mathbb`、`\toprule` 等需要宏包的命令或环境时，自动把 `\usepackage{...}` 补进导言区。规则表 `PKG_RULES` 与 `PKG_PROVIDES` 处理依赖链（如 `mathtools` 自动提供 `amsmath`、`pgfplots` 提供 `tikz`）；补全不重复、不打断光标、忽略注释行。

### 4.4 环境联想与自动配对

输入 `\begin{` 立即弹出环境名联想，覆盖方程、对齐、矩阵、定理、图表、列表、绘图、算法、Beamer 等 70 多个环境。继续输入筛选，`↑` / `↓` 选择，`Enter` 或 `Tab` 确认，`Esc` 取消。**选中后随即自动补上配对的 `\end{...}`**；手打完整环境名时，敲下 `}` 或换行也会自动补 `\end{}`，`tabular` / `minipage` 这类需跟参数的环境有 150ms 宽限期。

插入的是**最小可编译骨架**而非空壳：数学环境带被选中的 `{}` 占位、列表自动写 `\item`、`tabular` / `minipage` / `wrapfigure` / `thebibliography` 带好必填参数。依赖宏包会补进导言区；定理类环境自动写 `\newtheorem`，中文文档用「定理 / 引理」等标题。`axis` 自动外包 `tikzpicture`，`subfigure` 自动外包 `figure` 并补宽度、`\centering` 与 `\caption`。

配套的诊断能力：`cases` / `matrix` / `aligned` / `split` 等自身不开启数学模式的环境，光标不在数学模式内时自动用 `\[ … \]` 包住；`equation` / `align` / `gather` / `math` 等自带数学模式的环境不包裹。浮层底部实时说明插入后会发生什么，用 ⚠ 标出本机缺少的宏包（由 `kpsewhich` 实测）、`frame` / `columns` 需要 `beamer` 文档类等前置条件。无前缀时按「最近使用 / 常用 / 分类」分组，输入前缀后退回纯匹配度排序。偏好（自动补 `\end{}`、数学模式包裹、分组）与主题、引擎一起保存在 `.state.json`。

### 4.5 撤回与重做

编辑器工具栏有「↶ 撤回」「↷ 重做」，也可用快捷键或右键菜单。YangTex 使用**自己的快照历史**（`UNDO_LIMIT=200`、`UNDO_MERGE_MS=450`）而不是浏览器原生撤销栈——因为宏包补全、工具面板、插入图片、AI 代码块都会程序化改写源码，会清空浏览器原生历史。现在这些改动与打字一起按步记录，撤回后回到当时的**光标与滚动位置**，且不会被宏包补全立刻「补回来」。连续打字自动合并成一步；切换项目或套用模板会重置历史。

### 4.6 插入图片

把 PNG / JPG / PDF / EPS 直接拖进窗口，或点「▣ 插入图片」选择文件。图片保存到当前项目目录，并自动插入带 `\centering`、`\caption`、`\label{fig:...}` 的居中 `figure` 环境；插入点自动避开导言区与 `\end{document}` 之后，同时确保导言区有 `graphicx`。插入后左下角出现「图片显示大小」浮层，可选 30% / 50% / 80% / 100% / 原始，或填 `6cm`、`0.6\linewidth`、`240pt` 等自定义宽度，改动立即写回源码并重新编译，选择会被记住。Markdown 主源下改为插入标准 `![说明](图片){w=80%}`。

### 4.7 中英文与双向逐行同步

中文模板使用 `ctexart + fontset=fandol` 并以 `xelatex` 编译（跨平台自带字体），英文模板用 `pdflatex`；原稿全量模板用 `\IfFontExistsTF` 做 Mac 字体兜底，生效的都是 `fontset=fandol` 或 ctex 自动识别。

SyncTeX 双向定位：

- **源码 → PDF**：光标放在某一行，按 `F8` 或点「⇥ 定位到 PDF」，平滑滚动到对应排版位置并高亮；开启「⇄ 逐行同步」后移动光标会自动高亮，但**不会抢走当前预览滚动位置**，自动编译刷新时也不会。
- **PDF → 源码**：**单击**预览中的任意文字，编辑器精确跳回该行；点击行间空白会吸附到最近的文本项，拖拽滚动不会误触。

### 4.8 预览刷新零抖动

自动编译刷新时预览保持静止：新页面先在离屏 canvas 上画好，再用 `requestAnimationFrame` 一帧切换；可见 canvas 全程不清空、不闪白；阅读位置在几何更新的同一帧恢复，并关闭浏览器滚动锚定。状态栏、页信息、问题列表都做了固定宽度 / 内容缓存，文字变化不推动界面元素。逐行同步的高亮框跨编译持续存在，自动同步走 `quiet` 模式，不播放闪烁动画、不滚回光标处。

### 4.9 ⇶ 连续编译（边打字边编译）

4.1 节的「停手后防抖」是**关闭连续编译时**的旧行为。默认开启顶栏「⇶ 连续编译」后，调度模型改为**不等停手**：每次输入后约一帧（`CONT_KICK = 20ms`，仅用来合并同一帧内的多次 `input` 事件，不是防抖）就启动一轮 TeX，打字过程中预览持续跟进。停手 `TYPING_IDLE = 260ms` 后由 `finishTyping()` 补一轮正式编译收尾；若此刻仍有编译在跑，则交给它的过期重排链收尾，不额外堆积空转任务。

实现上仍是**单飞调度**（`S.compiling` 配合 `S.pendingCompile` / `S.pendingForce`），同一时刻只有一轮 TeX 在运行。编辑期间返回的编译结果相对编辑器已经过期，旧版会整个丢弃；现在把它作为 `quiet` **中间帧**安静地画进预览：不写 `S.compiledHash`、不标记「已是最新」，保证停手那一轮一定真跑一次 TeX；不报 ✓、不弹错误面板、不刷新问题列表 / 编译日志 / 错误徽标，异步取回的完整日志也按 `S.docRev === logRev` 过滤，避免半输入态的报错打断写作；状态栏在打字期间固定显示「● 连续编译…」，不再在两种文案之间抖动。中间帧照常参与页级失效分析，页指纹缓存按实际画出的那一版更新。

中文输入法组字期间（`compositionstart` / `compositionend`）跳过编译，拼音与半截汉字不会送进 TeX，候选字上屏后补一轮；`\begin{` 联想浮层打开时同样暂不调度。偏好 `continuous` 写入 `.state.json`，重启保持；关闭开关即退回 4.1 节的防抖模型。诊断时可在页面脚本运行前设 `window.__YT_NO_CONTINUOUS = true`，在同一份代码上对照旧行为。

需要说明边界：每一帧仍是一次完整的 TeX Live 排版，约 0.5–0.9 秒后才追上当时的输入。它做到的是「不等停手、打字过程中持续出画面」，而不是 Texifier 内置 typesetter 那种逐键 20–50ms 级实时；后者需要替换排版引擎，会牺牲 70 份期刊官方模板、SyncTeX 精确映射与投稿包一致性。

### 4.10 🧩 准增量预览（页级失效分析）

不改 TeX 引擎、不动版式语义，只把「预览」这一半做成增量。后端每次编译完用零依赖模块 `pdf_incremental.py` 读出**每页内容流指纹**和一份排除时间戳元数据的全局指纹（支持 pdfTeX 压缩对象流、xelatex 传统对象与分层页面树）。`/api/compile` 随结果返回 `pdf_rev` 与 `pages`，前端据此做三选一决策：

1. **`reuse`**：全局 rev 与上次相同，连 pdf.js 重新解析与重绘都跳过，状态栏显示「复用预览」；
2. **`pages`**：rev 变化但只有部分页指纹变化，只重画变化页，其余 canvas 与文本层原样保留，显示「增量 N/M 页」；
3. **`full`**：页数变化、资源（字体 / 图片）变化、换项目、解析失败或编译失败时退化为全量渲染，绝不显示过期画面。

编译产物同时留在服务端内存流中，`/api/pdf` 带 `ETag` 与 `X-YangTex-Pages`，`If-None-Match` 命中返回 304，不必每轮重读磁盘。底栏 `#incrBadge` 是独立固定宽度列，避免长状态文案把 `#compileStatus` 截断。

实测（真实 Chrome + TeX Live，A/B 正反序各 5 轮取中位）：短文档注释编辑 977.7 → 771.0ms（−21.1%），五页文档注释编辑 1078.9 → 961.1ms（−10.9%）；改正文与「只改一页」基本持平。结论是**省掉的是 PDF 解析与重绘，TeX 全量排版约 0.55 秒的硬开销仍在**，因此这条路线的收益有明确上限。

### 4.11 ⚡ 语义免编译与启动开销压缩

后端逐行还原「TeX 真正看得见的字符流」：`effective_tex_lines()` 区分真注释与 `\%`、保留行数与行尾注释标记。若与上次成功编译一致，**连 TeX 进程都不启动**，直接复用已有 PDF / `.aux` / SyncTeX，`/api/compile` 返回 `cached: true` 与 `duration: 0`，状态栏显示「免编译」。改写注释、调整行尾空格、撤回绕回旧内容这类编辑由此从约 0.6 秒降到接近 0。

安全性优先：`_SKIP_UNSAFE` 遇到 `verbatim` / `lstlisting` / `\url` / `\input` / `\today` 等无法可靠推断的构造时一律照常编译；`_external_fingerprint()` 监视项目内图片、`.bib`、`.sty` 等外部文件，有改动立即让缓存失效；「完整编译」与切换引擎从不走捷径；`_SKIP_CACHE` 只缓存编译成功的结果。诊断可用 `YANGTEX_NO_SKIP=1` 关闭。

启动开销方面，`_subprocess_env()` 按精确名与前缀两张白名单只给 TeX / synctex / bibtex 子进程传必要环境变量（宿主常有近 200 个变量，实测拖慢启动约 38ms），`YANGTEX_FULL_ENV=1` 可回退；Windows 未真机实测，默认保守沿用完整环境，需 `YANGTEX_SLIM_ENV=1` 才启用，白名单已补齐 MiKTeX 所需 `APPDATA` / `USERPROFILE` / `SYSTEMROOT` 等。pdf.js 侧对小 PDF 设置 `disableRange` / `disableAutoFetch`，再省约 23ms。曾尝试用 `lualatex` 替代中文 `xelatex`，实测直接 fatal error 且耗时 12 秒，已放弃。

---

## 五、模板库

### 5.1 分类与规模

模板库共 **70 份**，由 `templates/_index.json` 管理元数据，按出版商 / 用途分为 **16 个一级分类**：

| 分类 | 份数 | 分类 | 份数 |
| --- | --- | --- | --- |
| AMS 美国数学会 | 8 | Elsevier 数学期刊 | 8 |
| Springer 数学期刊 | 8 | AIMS 与其他英文期刊 | 8 |
| SIAM 工业与应用数学会 | 7 | 中文数学期刊 | 5 |
| Markdown 模板 | 4 | Markdown / LaTeX 混排 | 4 |
| IEEE 与交叉学科 | 3 | 中文教材与讲义 | 3 |
| 教学课件与答辩 | 3 | 入门与通用 | 2 |
| 预印本与通用 | 2 | 中文写作 | 2 |
| 报告与讲义 | 2 | 中文学位论文 | 1 |

其中 **38 份**标记为 `official=true`。顶栏「▤ 模板」可按分类只看一类，也可搜索期刊名 / 出版商 / 标签；「全部」视图按 `PUB_ORDER` 分组，卡片标出期刊全名。

### 5.2 官方模板与类文件注入

内置 JAMS、Trans. AMS、Math. Comp.、SIAM 系列、Inventiones、Math. Annalen、CMP、JDE、JFA、Advances in Mathematics、AIMS Mathematics、DCDS、《中国科学：数学》《数学学报》等主流数学期刊投稿模板，使用 `amsart` / `elsarticle` / `IEEEtran` / `siamart` / `svjour3` / `aimsart` / `llncs` 等官方文档类。

后端 `run_cmd()` 把 `templates/classes/` 注入 `TEXINPUTS`（尾部保留空字段，让 kpathsea 追加默认 TeX 树）。官方类已装时卡片显示「◈ 官方模板」，编译出正式期刊版式；未装时显示「◐ 官方类待装」，模板内 `\IfFileExists` 自动降级为 `article` 预览排版，仍能正常编译与双向逐行同步。把期刊官网下载的 `.cls` / `.sty` 放进 `templates/classes/` 即对所有项目生效，新建项目还会自动复制一份。YangTex 不随包再分发第三方类文件，避免许可问题。少数没有公开官方类的期刊标「◇ 规范底稿」，按投稿规范用 `amsart` / `ctexart` 排好版。

### 5.3 Markdown 与 LaTeX 混排

「Markdown 模板」与「Markdown / LaTeX 混排」共 8 份，卡片有 `MD` / `MD+TeX` 标识。套用后**编辑器里装的就是 Markdown 源码**：标题用 `#`、列表用 `-`、表格用 `|`、粗体用 `**…**`，编辑器标题栏显示 `main.md` / `main.mdtex` 与绿色徽标。

每次保存，内置**零依赖转换器** `markdown_tex.py` 同步生成编译用的 `main.tex`：不需要 pandoc、不需要 `markdown.sty`、不开 `-shell-escape`。`main.tex` 是只读产物，点「⟨TeX⟩ 查看」可核对。`.md` 写纯 Markdown；`.mdtex` 可混写 `$…$` / `$$…$$` 数学，再用 `:::latex … :::` 包住定理、证明、align、figure 等原样 LaTeX。文件开头 `---` front matter 可设置 `title / author / date / class / engine / lang / packages`。

行号映射保存在 `main.map.json`：双向逐行同步与编译错误定位会自动把 `.tex` 行号换算回 Markdown 行号，错误面板显示 `main.md` 而不是 `main.tex`。LaTeX 项目里仍可用「MD→TeX」把选中片段就地转换（可一次撤回）。「添加自定义模板」支持三种格式，直接把 `.tex` / `.md` / `.mdtex` 放进 `templates/` 也会被自动识别。

### 5.4 原稿全量保留模板

7 份来自用户自己的中文 LaTeX 源码工程（华北水利水电大学数学与统计学院），按「**全文保真**」原则装入：只删除 PDF / `digest.lock` 等编译产物，把 `\input` 递归展开为单文件，保留全部章节、例题、每张幻灯片、封面与参考文献，原稿文字一字不改；仅做必要的跨平台字体兜底（`\IfFontExistsTF`、`ctex` 自动识别平台）。若原稿有文献表但完全没有 `\cite`，才补一句中性引用句并在注释中明确标注。

| 模板 | 合并后行数 | 编译页数 |
| --- | --- | --- |
| `ncwu_linear_algebra_book.tex` | 4736 | 62 |
| `ncwu_beamer_cloud.tex` | 3465 | 255 |
| `ncwu_calc_notes_color.tex` | 1311 | 27 |
| `ncwu_thesis_v4.tex` | 1078 | 29 |
| `ncwu_beamer_defense_red.tex` | 1058 | 29 |
| `ncwu_calc_notes_humor.tex` | 988 | 27 |
| `ncwu_beamer_huashui_blue.tex` | 907 | 26 |

7 份都经过逐份 3 遍 `xelatex` 真实编译（7/7 PASS），并用 PyMuPDF 对原 zip 内 PDF 文本与重编译 PDF 文本做逐字保真比对，保真度 100% / 100% / 100% / 99.99% / 99.97% / 98.38% / 97.54%，6/7 页数与原 PDF 完全一致；少量差异经定位确认是原包内 `main.pdf` 旧于同包 `.tex` 源码，并非合并丢内容。模板卡片上有绿色「▤ 原稿全量 N 行」徽标，元数据带 `full_source=True`、`source_lines`、`origin`。

---

## 六、AI 助手

### 6.1 免设置接入

点「✦ AI 助手」或按 `⌘/Ctrl + /`。它作为右侧第三栏停靠，与「代码｜预览」并排，不遮挡 PDF；工具面板与 AI 共用这一栏且互斥。可解释选中公式、润色、中英互译、生成 LaTeX、诊断编译错误。**无需注册、无需 API Key、无需任何设置**；只有主动点击时才会发送选中的文字。

### 6.2 模型与通道选优

顶部「模型 / 通道」支持自动选最快、指定某个免费模型、锁定某条传输通道。模型清单从官方接口动态读取（`/api/ai-models` 与浏览器端 `https://text.pollinations.ai/models`），新增匿名免费模型时无需升级 YangTex。「⚡ 测速选优」实测各通道连接速度并结合历史真实耗时（`AI_STATS` 持久化在 localStorage）重新排序；默认走 **SSE 流式输出**，首字一到就开始显示。`AI_FLIGHT` 保证任何时刻只有一个生成请求在途，单通道 `AI_TIMEOUT=9000` 快速失败，不在坏通道上干等。

### 6.3 限流、离线与自检

匿名免费层对同一 IP 限制为「一次一个请求、间隔 30 秒」，产品侧设 `AI_COOLDOWN=31000` 并显示冷却倒计时，结束后自动重试。**一旦限流或断网，AI 不会空白、也不会一直转圈**：立刻由内置 LaTeX 知识库 `AI_KB` 给出可编译片段与错误排查（覆盖 amsmath、中文、图片、定理、表格、参考文献、编译错误等），冷却结束后自动把同一条消息替换为在线大模型答案，也可点「立即重试在线大模型」。「🔍 自检」一键查看本地服务、免费模型接口、各通道实测耗时与冷却状态。

---

## 七、学术写作增强

### 7.1 公式 / 引用编号悬停指向

PDF 里带虚线下划线的 `(1)`、`[2]` 是编号热区，**鼠标离编号 28px 内也能命中**。编号被 pdf.js 拆成 `(` `1` `)` 三个文本项、夹在整句里、或写成 `[1,2]`，都能识别；章节号与公式号同为 `1` 时也不会指错，因为编号优先取自每次编译的 `main.aux`（`\newlabel` / `\bibcite`），不做 OCR。

编号缺失时依次用 `main.bbl` 的 `\bibitem[...]{key}` 顺序、`.aux` 的 `\citation` / `\abx@aux@cite` 首次引用顺序、源码 `\bibitem` / `.bib` 条目顺序四级兜底；没写 `\label` 的公式按真实公式环境顺序补号，`\[...\]`、`equation*` 等不编号环境不会误占号。

悬停卡片刻意做得**紧凑**（宽 296px、最大高 190px）：公式只显示从 PDF 页裁出的缩略图 + 一行标签 / 页码 / 源码行号，**不再铺开 TeX 源码**；文献条目压成一行并做 3 行 `line-clamp`，避免盖住正文。要看完整源码，**点一下卡片**就跳到源码对应行并在 PDF 中高亮定位。编辑器里的 `\eqref{...}`、`\ref{...}`、`\cite{key}`、`\citep{...}`、`\cite[说明]{key}` 同样可精确悬停反查（镜面层 + `caretRangeFromPoint` 取字符偏移）；引用键找不到时会提示检查文献表。

### 7.2 参考文献管理

顶栏「◉ 文献」打开面板，三个页签：

1. **文献条目**：同时兼容外部 `.bib` 与源码内嵌 `thebibliography` / `\bibitem`，可新增、编辑、删除；保存后重载源码并自动做一次**完整编译**（含 BibTeX），让编号与 PDF 立刻一致。项目里还没有文献表时，保存会自动新建 `references.bib` 并挂接 `\bibliographystyle{plain}` + `\bibliography{references}`。
2. **引用检查**：漏引（`\cite` / `\eqref` 指向不存在的键）、文献未被引用、引用键重复、作者 / 标题 / 年份不全、`.bib` 未挂接、缺 `\bibliographystyle` 等，逐条给出源码行号，点击即可跳过去。内置模板里所有含文献表的模板都已在正文补上 `\cite{...}`，新建项目不会出现「文献没有被引用」；已创建的旧项目不会被自动改写。
3. **真实性核验**：把条目的标题 / 作者 / 年份 / DOI 送到 **CrossRef、OpenAlex、Semantic Scholar** 三个免费公开索引比对，无需 API Key、不上传正文；DOI 精确命中或标题相似度 ≥ 0.58 记为「已核实」，结果缓存 7 天，断网时显示「离线未核验」而**不会误判成假文献**。

### 7.3 投稿包（干干净净）

点「⇪ 投稿包」可先看清单再下载 zip。源码里的 `%` 注释会被清除，但 `\%`、`verbatim`、`lstlisting`、`minted`、`comment` 环境内的百分号原样保留；`.aux` / `.log` / `.out` / `.synctex.gz` 等辅助文件一律剔除，只打包源码、Markdown 主源、图片、`.bib`、类文件、PDF 与 `投稿说明.txt` 清单。可选「去除注释」「附带生成的 PDF」「合并连续空行」。

### 7.4 投影、批注与全屏

点顶栏「📽 投影」或预览栏同名按钮进入全屏演示，用**独立的 pdf.js 文档**渲染，不影响左侧零抖动实时预览。翻页、自动播放（间隔 1–60 秒、末页循环）、黑屏、白屏、激光笔、首末页、点击画面左右两侧翻页都支持。

「✎ 批注」（或 `A`）可在幻灯片上写画：5 色、3 档粗细、逐笔撤销、清除本页、存成 PNG。笔迹按 `PRES.inks[page]` 保存，坐标归一化到 `[0,1]`，翻页 / 缩放 / 进出全屏自动重绘；同一项目反复进出投影会保留，换项目才清空。批注模式下禁用「点击画面左右两侧翻页」，并与激光笔互斥。「⛶ 全屏」（或 `F`）调 `requestFullscreen`，浏览器不允许时降级为 `.pres-faux-full` 沉浸模式。

---

## 八、技术架构（附录 A）

### 8.1 分层

```text
┌───────────────────── 启动器层 ─────────────────────┐
│ macOS YangTex.app / Windows vbs+bat / Linux sh       │
│ 短生命周期，分离服务，自动开浏览器                    │
└───────────────────────┬───────────────────────────┘
                        │ HTTP 127.0.0.1:17865
┌───────────────────────▼───────────────────────────┐
│ 后端 YangTex.py · ThreadingHTTPServer                │
│ 静态资源 / 26 个 API / 项目与状态 / 编译调度          │
│ scholar_tools.py（学术）· markdown_tex.py（转换）     │
└──────────┬─────────────────────────┬──────────────┘
           │ 子进程                   │ JSON / PDF 字节
┌──────────▼──────────┐    ┌─────────▼──────────────┐
│ 本机 TeX 发行版       │    │ 浏览器前端 web/          │
│ xelatex/pdflatex     │    │ index.html / app.js      │
│ synctex/bibtex       │    │ app.css / pdf.js         │
│ kpsewhich/latexmk    │    │ 三栏 UI / 零抖动渲染      │
└─────────────────────┘    └────────────────────────┘
```

后端只用 Python 标准库：`http.server`、`subprocess`、`threading`、`json`、`urllib`、`pathlib`、`re`、`shutil`。编译由 `COMPILE_LOCK` 串行化，`DOC_WRITE_LOCK` 保护写盘；`STATE_LOCK` 保护 `.state.json`。Windows 下 `CREATE_FLAGS` 带 `NO_WINDOW=0x08000000`，保证不弹黑窗。

### 8.2 目录结构

| 路径 | 作用 |
| --- | --- |
| `YangTex.py` | 后端主程序（2000 行），API、编译、项目、状态、AI、启动引导 |
| `scholar_tools.py` | 学术工具层（1124 行），编号索引、BibTeX、引用检查、真实性核验、投稿包 |
| `markdown_tex.py` | 零依赖 Markdown → LaTeX 转换器（405 行），含行号映射 |
| `web/index.html` / `app.js` / `app.css` | 界面结构（371 行）、逻辑（5581 行）、样式（833 行） |
| `templates/` | 70 份模板 + `_index.json` 元数据 + `classes/` 官方类目录 |
| `projects/` | 每个项目一个独立目录，含主源、`main.tex`、`main.pdf`、`.aux`、图片、`.bib` |
| `assets/` | 49 张展示图与应用图标 |
| `.fmt_cache/` | 极速模式预编译的 `.fmt` 文件（按导言哈希命名） |
| `.state.json` | 用户偏好：项目、引擎、主题、开关、字号、环境联想偏好 |
| `.runtime.json` | 运行态 `port` / `pid` / `started`，供启动器与 `--restart` 使用 |
| `config.json` | 可选，手工指定引擎路径等环境覆盖 |

### 8.3 前端状态与模块

全局状态 `S` 保存当前项目、模板列表、文档版本（`docRev`）、编译哈希、PDF 文档与页面视图、缩放、当前页、主题等；另有 `HOVER`、`BIB`、`SUB`、`PRES`、`ENV_STATE`、`AI_STATS` 等独立子系统状态。按领域把状态隔离，能避免任一侧栏的交互污染编译主链路。

核心函数分组：编译与 PDF（`compileNow` / `loadPdf` / `queuePdfCommit`）、同步（`forwardSync` / `onPdfClick` / `showSyncBox`）、联想（`envCandidates` / `insertEnvironment` / `acceptEnvHint`）、AI（`aiFetchChannel` / `aiFetchOnline` / `aiLocalAnswer`）、学术（`refreshHoverIndex` / `scanHoverHotspots` / `openBibPanel` / `renderSubmission`）、投影（`presRender` / `presInk*` / `presToggleFull`）、页码（`updatePageInfo` / `updateCurrentPage` / `scrollToPdfPage` / `openPageJump`）。

---

## 九、编译流水线（附录 B）

### 9.1 时序

```text
键入 → [连续] CONT_KICK 20ms 帧合并 / [防抖] 140–280ms
     → saveDoc() 写 /api/doc → /api/compile（turbo/full、engine）
     → [语义跳过命中] cached=true，复用 PDF/aux/SyncTeX，0 秒返回
     → [未命中] write_main() 原子写盘 → engine_for() 选引擎
       [turbo] ensure_fmt() → turbo_compile()
       [standard] run_cmd(xelatex/pdflatex -synctex=1 …)
     → 可选 bibtex + 2/3 轮交叉引用（仅 full）
     → pdf_incremental 页指纹 → pdf_rev / pages / timings
     → parse_log() → /api/log（fire-and-forget）
     → /api/pdf（内存流 + ETag / 304）
     → [reuse] 跳过 / [pages] 只重画变化页 / [full] 全量离屏渲染 → 一帧提交
     → refreshHoverIndex() → /api/hover-index（重建编号热区）
     → stale 中间帧或 !stale 正式帧；停手后补一轮收尾
```

`run_cmd()` 的固定参数是 `-synctex=1 -interaction=nonstopmode -file-line-error -halt-on-error main.tex`，超时 90 秒；`TEXINPUTS` 注入 `templates/classes/` 且保留尾部空字段。实时自动编译只跑一轮（最快），`.aux` 保留使下一轮自然得到正确引用编号；只有「完整编译」才跑 BibTeX 与最多三轮交叉引用。

### 9.2 过期控制与整轮跳过

前端用 `S.docRev` 标记每次编辑，`contentHash()` 计算源码指纹，`S.compiledHash` / `S.diskHash` 比对磁盘与上次成功编译。旧版过期结果整个丢弃；连续编译下改为 `quiet` 中间帧安静渲染（见 9.7），且中间帧绝不写 `S.compiledHash`。`pendingForce` 修复强制编译被在途编译吞掉的问题。日志异步读取，PDF 按页级指纹只重绘变化页并优先画当前可见页。

### 9.3 极速通道实现

`fmt_volatile()` 识别 `\title` / `\author` / `\date` / `\thanks` / `\hypersetup` 等易变行，`split_preamble()` 切分导言，`fmt_cache_key()` 按引擎与导言哈希，`ensure_fmt()` 在 `.fmt_cache/` 中命中或生成 `ytfast.fmt`。`turbo_compile()` 把正文文件的导言行替换成**空行**（不是删除），因此所有行号保持不变；`FMT_AUX_FILES` 在切回标准时回拷 `.aux`，避免编号回退。中文、字体类文档、Markdown 中文模板、导言不可预编译、完整编译与任何异常都回退 `mode=standard`。

### 9.4 零抖动渲染

`queuePdfCommit()` 用离屏 canvas 画好新页面，`requestAnimationFrame` 批量 `drawImage` 到可见 canvas；可见 canvas 全程不清空、不清 `.pdf-overlay`；页数与尺寸不变时复用 `.pdf-page` DOM 与事件绑定；几何更新与 `scrollTop` 恢复在同一帧完成；自动同步走 `quiet` 模式。状态栏、页信息、问题列表用固定宽度与内容缓存消除布局跳动。

### 9.5 准增量预览实现

`pdf_incremental.py` 用标准库 `re` 直接解析 PDF 对象：定位 `/Type /Page` 与 `/Contents`，展开 `/ObjStm` 压缩对象流，按页面树 `/Kids` 顺序还原页序，对每页内容流做 FNV-1a 指纹；全局 `pdf_rev` 排除 `/CreationDate` / `/ModDate` / `/ID` 等易变元数据，保证「只加注释」不会被误判为整份文档变化。页面树层级异常或对象流解析失败时返回空 rev，驱动前端退化为 `full`，宁可少优化也不显示过期画面。

`YangTex.py` 的 `/api/compile` 在编译成功后把 `pdf_rev` / `pages` / `timings` 一并回传；`/api/pdf` 改为内存字节流并带 `ETag`，`If-None-Match` 命中即返回 304。前端 `loadPdf(changedPages)` 只对变化页重排离屏 canvas，其余页连同 `.pdf-overlay` 里的 SyncTeX 高亮框一并保留。

### 9.6 语义跳过与子进程环境

`semantic_skip_key()` 由有效字符流、引擎、turbo 标志、主源类型、`full` 标志与 `_external_fingerprint()` 共同组成；`_SKIP_CACHE` 只缓存**编译成功**的结果，失败版本绝不复用。命中时 `compile_project()` 在写盘与启动 TeX 之前就返回 `cached: true`，复用上一轮 PDF / `.aux` / SyncTeX。`_subprocess_env()` 用 `_TEX_ENV_EXACT` 与 `_TEX_ENV_PREFIX` 两张白名单裁剪环境，并保留三个诊断开关 `YANGTEX_FULL_ENV` / `YANGTEX_SLIM_ENV` / `YANGTEX_NO_SKIP`。

| 场景 | 改造前 | 改造后 | 变化 |
| --- | --- | --- | --- |
| 短文档 · 改注释 | 736.6ms | 185.3ms | −74.8% |
| 短文档 · 改正文 | 922.0ms | 885.5ms | −4.0% |
| 中文 · 改正文 | 1850.2ms | 1700.1ms | −8.1% |
| 短文档 · 改行尾空格 | 728.1ms | 187.0ms | −74.3% |

真实 A/B 使用隔离的 17894 基线服务与 17893 优化服务、真实 Chrome + TeX Live，正反序各 5 轮共 10 轮取中位。结论：无视觉变化的编辑接近瞬时，真实改正文只省约 40ms；**TeX Live 全量排版仍是硬地板**。这一轮还修复了一处隐蔽回归：误删 `def synctex_file(d: Path)` 定义行后，Python 纯注释行不触发 DEDENT，`py_compile` 照样通过而 SyncTeX 静默全失败，由专项断言 A17 抓到，并补了 S09b / A43 / Z31 三处护栏。

### 9.7 连续编译调度状态机

`compileDelay()` 在 `S.cont && !NO_CONT && S.auto` 时取 `CONT_KICK = 20`，否则取 `liveDebounce()`（极速 140 / 标准 280）。`onEditorInput()` 每次输入重置 `typingTimer`；`finishTyping()` 把 `S.typing` 置假并补一轮正式编译。`compileNow()` 以 `rev = S.docRev` 记录起点，返回时计算 `stale = S.docRev !== rev`：

```text
输入 → CONT_KICK 20ms → compileNow(rev)
   ├─ 无在途编译 → saveDoc() → /api/compile → 结果回来
   │    ├─ !stale → 正式帧：状态 ✓ / 问题面板 / compiledHash / hover-index / forwardSync
   │    └─ stale  → quiet 中间帧：只画 PDF，状态栏固定「● 连续编译…」
   └─ 有在途编译 → S.pendingCompile=true，由在途那轮的 stale 链重排
停手 260ms → finishTyping() → 补一轮正式编译（内容未变时可被指纹跳过）
```

关键不变量：中间帧**绝不写** `S.compiledHash`，否则停手那一轮会被指纹跳过、预览停留在稍旧版本；`S.renderedRev` / `S.renderedPages` 则按实际画出的那一版更新，保证下一轮页级 diff 的基准正确。输入法组字与 `\begin{` 联想浮层打开时暂不调度，避免半成品源码触发必然失败的编译。专项验证实测连续编译开启时首轮编译在输入后 58–64ms 启动、打字过程中产生 3 轮中间帧；诊断开关关闭时首轮需等到打字结束后约 1300ms 才发出，仅 1 轮。

---

## 十、HTTP API 参考（附录 C）

后端共 **26 个** `/api/*` 端点，`GET` 走 `api_get()`、`POST` 走 `api_post()`，统一以 JSON 或字节流返回。所有需要项目的接口都接受 `project` 查询参数或请求体字段，缺省使用 `STATE["project"]`。

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/health` | GET | 存活检查，返回 `app` / `version` / `uptime` / `build` |
| `/api/init` | GET | 欢迎词、状态、引擎可用性、宏包探测、项目与模板列表、AI 信息、平台 |
| `/api/state` | GET/POST | 读写用户偏好（主题、开关、字号、引擎、`continuous`、环境联想偏好） |
| `/api/projects` | GET/POST | 项目列表 / 新建项目 |
| `/api/project/select` | POST | 切换当前项目 |
| `/api/doc` | GET/POST | 读写主编辑源；GET 带 `source_kind` / `source_file` / `mtime` |
| `/api/compile` | POST | 编译，支持 `turbo` / `full` / `engine` / `content`；返回 `ok` / `duration` / `mode` / `cached` / `pdf_rev` / `pages` / `timings` |
| `/api/log` | GET | 读取编译日志与解析后的问题列表 |
| `/api/clean` | POST | 清理辅助文件 |
| `/api/pdf` | GET | inline 打开 `main.pdf`；内存字节流 + `ETag` / `X-YangTex-Pages`，`If-None-Match` 命中返回 304 |
| `/api/download` | GET | 以「项目名.pdf」下载（RFC 5987 处理中文名） |
| `/api/open-folder` | POST | 在系统文件管理器里打开项目目录 |
| `/api/templates` | GET | 模板元数据列表（含 `official` / `full_source` / `source_lines` / `origin`） |
| `/api/template-content` | GET | 读取单份模板源码 |
| `/api/md-convert` | POST | Markdown 片段 → LaTeX 片段 |
| `/api/upload-image` | POST | 保存图片到项目目录 |
| `/api/synctex/view` | GET | 源码行 → PDF 位置 |
| `/api/synctex/edit` | GET | PDF 坐标 → 源码行（含 Markdown 行号换算） |
| `/api/ai` | POST | AI 生成（流式 / 回退） |
| `/api/ai-models` | GET | 动态模型清单 |
| `/api/hover-index` | GET | 公式 / 引用编号与目标的索引 |
| `/api/bib` | GET/POST | 文献条目读写与保存 |
| `/api/ref-check` | GET | 引用关系检查 |
| `/api/ref-verify` | GET | 文献真实性核验（`keys` 参数） |
| `/api/submission` | GET/POST | 投稿包预览清单与 zip 下载 |
| `/api/shutdown` | POST | 停止服务并清理 `.runtime.json` |

静态资源严格限制在 `web/` 目录内（`resolve()` 后前缀校验，越界返回 403）。`/api/health` 返回的 `build` 是源码内容哈希，前端 `checkBuild()` 用它提示「点此刷新」。

---

## 十一、SyncTeX 与编号索引（附录 D）

### 11.1 双向定位

`parse_view_output()` 解析 `synctex view` 输出得到页号与矩形，`forwardSync()` 在预览里高亮并平滑滚动；`_synctex_edit_raw()` 调 `synctex edit`，`synctex_edit()` 把结果经 `tex_line_to_md()` 换算到 Markdown 主源行号。前端 `pdfPointFromEvent()` 把点击坐标换算成 PDF 点数，`onPdfClick()` 发请求；空白处吸附到最近文本项，拖拽滚动不误触。Markdown 模式下 `main.map.json` 保存 `.tex` 行 → Markdown 行的映射，错误面板也据此显示 `main.md`。

### 11.2 编号索引四级兜底

`build_hover_index()` 的输入是 `main.aux`、源码、`.bib` / `.bbl` 与文献状态：

1. `parse_aux()` 读 `\newlabel{...}{{number}{page}...}` 与 `\bibcite{key}{number}`，`bib_number()` 与 `aux_balanced()` 专门处理 beamer `.aux` 里 `\bibcite{Cheng}{\hyperlink{...}{1}}` 这种嵌套；
2. `parse_bbl_numbers()` 读 `main.bbl` 的 `\bibitem[标签]{key}` 顺序；
3. `parse_aux_citation_order()` 读 `\citation` / `\abx@aux@cite` 首次引用顺序；
4. 源码 `\bibitem` / `.bib` 条目顺序。

`fallback_ref_numbers()` 合并四级结果，`fill_eq_numbers()` 为无 `\label` 的编号公式按真实公式环境顺序补号并生成 `eq@<line>` 合成键（跳过 `\[...\]`、`equation*` 等不编号环境）。这样每个 `\cite{key}` 与 `\eqref` / `\ref` 都有可反查目标。

### 11.3 PDF 文本层热区算法

`getTextContent()` 返回的文本项按基线拼成整行，`HV_BRACKETED` 在拼接串内部匹配 `(1)` / `[2]` / `[1,2]`，再用 char → 格子映射算出精确小矩形；`HV_BARE` 处理孤立编号。`HV_HIT_RADIUS=28` 让鼠标离编号 28px 内也命中；`HV_HINT` 只标注公式编号与引用编号，不把无关数学数字误判为热区。PDF 事件与编辑器事件分帧处理，编辑器侧用镜面层 + `caretRangeFromPoint()` 取字符偏移后由 `ED_HOVER_RE` 匹配 `\cite` / `\eqref` 等命令。

---

## 十二、三平台启动器（附录 E）

| 平台 | 机制 | 换行 / 权限 |
| --- | --- | --- |
| macOS | `.app` 内短生命周期启动器，调 `YangTex.py --restart` 分离服务；`LSMinimumSystemVersion=10.13`；ad-hoc 签名 | LF / 755 |
| Windows | `vbs` 用 `WScript.Shell.Run` 调 `pythonw.exe` 隐藏窗口；`FindPython()` 枚举 19 条候选（3.10–3.14）；`bat` 备用 | CRLF / 644 |
| Linux | `sh` 用 `nohup env YANGTEX_LAUNCHER_OPENS_BROWSER=1 python3 YangTex.py --restart &` + `disown`；轮询 `.runtime.json` 要求 `pid == $SVC_PID` 且 `/api/health` 返回 `app=YangTex`；就绪后 `BROWSER` / `xdg-open` / `gio open` / `sensible-browser` 打开 | LF / 755 |

Linux 启动器**不删除** `.runtime.json`（`--restart` 需要它找旧实例），而是用 pid 匹配来辨认新实例；后端检测 `YANGTEX_LAUNCHER_OPENS_BROWSER=1` 后让位，避免开出两个标签页。Windows 两个脚本必须是 CRLF：`.bat` 中有跨行 `if exist (...)` 块，cmd.exe 对 LF-only 不总可靠。VBScript 候选里已移除 `Python39\pythonw.exe`，因为后端用了 PEP 604 类型标注（`str | None`），要求 Python ≥ 3.10，只有 3.9 的机器会启动即崩。分发包中所有中文文件名条目都带 UTF-8 标志，Windows 解压不会乱码。

---

## 十三、配置、数据与隐私

| 文件 | 内容 | 是否随包分发 |
| --- | --- | --- |
| `.state.json` | 当前项目、引擎、自动编译、逐行同步、主题、欢迎页状态、字号、宏包补全、环境联想偏好、极速开关 | 仅空壳，不泄露用户状态 |
| `.runtime.json` | `port` / `pid` / `started`，运行态 | 否 |
| `config.json` | 可选，引擎路径覆盖 | 否 |
| `.yangtex-source.json` | 项目内主编辑源类型（markdown / mixed / tex） | 随项目 |
| `main.map.json` | Markdown 项目的行号映射 | 随项目 |
| `~/.yangtex-launch.log` | 启动器日志（用户主目录） | 否 |

**数据流向**：源码、PDF、图片、文献全部留在本地；AI 只在用户主动点击时把选中文字发往免费端点；文献真实性核验只发送条目的标题 / 作者 / 年份 / DOI 到三个公开索引，不上传正文；没有账号、没有遥测、没有云同步。关闭服务后本地端口不再监听。

---

## 十四、验证与质量体系

交付前用 Playwright（系统 Chrome 无头模式）与静态断言组成回归套件，覆盖静态、API、UI 三层：

| 套件 | 覆盖 |
| --- | --- |
| `verify_api.py` | 接口、编译、SyncTeX、状态、模板、投稿包 |
| `verify_compact_and_cites.py` | 紧凑悬停卡片、模板补引用 |
| `verify_hover_fix.py` / `verify_cite_hover.py` | 公式编号与 `\cite` 悬停反查 |
| `verify_ui.py` | 三栏、工具面板、投影、主题、编译错误面板 |
| `verify_menubar_c.py` | 14 枚短词、8 个提示、2 个分组标题、6 档断点、17 档零溢出、气泡与交互还原 |
| `verify_page_numbers.py` / `verify_top_pageno.py` | 每页徽标、底栏、标题栏页码与跳页 |
| `verify_present_annotate.py` | 投影批注、全屏、按页笔迹 |
| `verify_windows_launchers.py` | VBScript 字面量解析、19 条 Python 候选、模拟 Windows 目录树 8 场景、BAT 分支 |
| `verify_linux_launcher.py` | 隔离端口真实启动、pid 匹配、浏览器让位、runtime 清理 |
| `verify_incremental.py` | 页指纹解析、内存 PDF 流 / ETag / 304、reuse / pages / full 三路决策与 SyncTeX 回归 |
| `verify_speed2.py` | 语义免编译正确性、安全边界、精简 env、免编译状态栏与 A/B 耗时 |
| `verify_continuous.py` | 连续编译接线、偏好持久化、输入过程中即编译的 A/B、中间帧不弹底栏、最终 PDF 正确 |
| `repack.py` | 分发包内容断言（模板行数、无未展开 `\input`、无版权残留、C 方案菜单栏、三平台换行与权限、页码、手册 DOCX/MD、不泄露运行态与用户项目目录名） |

最近一次完整回归为 **355/355 PASS**：综合 111 + 菜单栏 C 41 + 准增量 62 + 语义免编译 50 + 连续编译 46 + 每页页码 18 + 标题栏页码 27；打包断言 **55/55 PASS**。更早的里程碑包括 284/284（9 套件连跑）、222/222（投影批注 59 + 全回归）、163/163（去版权 + 菜单栏）、125/125（原稿全量模板）。7 份原稿全量模板另经逐份 3 遍 `xelatex` 真实编译与 PDF 文本逐字保真比对（6 份 100%、最低 97.54%，差异经确认为原包内 PDF 旧于 `.tex` 源码）。

A/B 性能测量统一使用隔离服务与真实 Chrome + TeX Live，正反序交替多轮取中位；连续编译专项还会在页面脚本运行前注入 `window.__YT_NO_CONTINUOUS` 做同一份代码的对照。

分发包当前为 `YangTex-轻量版.zip`，约 25.6 MB / 339 条目 / 52 张展示图，内含本手册的 DOCX 与 Markdown 双版本，`projects/` 只保留顶层空目录标记，不含任何用户项目目录名。

---

## 十五、故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 双击启动器无反应 | 检查 Python 3.10+ 与 TeX 发行版；查看 `~/.yangtex-launch.log`；Windows 用 `备用启动 YangTex.bat` 观察报错；macOS 曾出现 LaunchServices 缓存导致的双击无响应，用 `open -a YangTex.app` 复现并修复 |
| 帮助里显示「✗ 未检测到」TeX | 把 `xelatex` / `pdflatex` 加入 `PATH`，或在 `config.json` 里指定路径 |
| 编译失败但 PDF 还在 | 这是设计行为：保留上一次成功的 PDF。展开底栏「问题」页签，点错误跳到源码行 |
| 底栏展开看不到内容 | 已修复 `#workspace` 固定高度与 `body{overflow:hidden}` 的裁剪；若仍异常可刷新页面 |
| PDF 下载中断 | 早期中文文件名触发 `Content-Disposition` 的 latin-1 编码错误，现改为浏览器本地文件流下载，刷新页面即生效 |
| 模板显示「◐ 官方类待装」 | 该期刊官方 `.cls` 未安装，会自动降级 `article` 预览；把官网下载的 `.cls` / `.sty` 放进 `templates/classes/` 即可 |
| AI 一直转圈 / 报限流 | 匿名免费层同 IP 限制「一次一个请求、间隔 30 秒」；产品会自动给出内置知识库答案并在冷却结束后重试；点「🔍 自检」查看通道状态 |
| 悬停卡片太大 / 挡住正文 | 当前版本已移除卡片里的 TeX 源码块，只保留缩略图与一行信息；点卡片可跳到源码查看完整内容 |
| 引用检查提示「文献没有被引用」 | 旧项目不会被自动改写；在正文补一条 `\cite{key}` 即可。内置模板新建的项目都已带引用 |
| Linux 无图形会话 | 启动器不会自动开浏览器，会打印 `http://127.0.0.1:PORT/`，手动打开即可；也可用 `BROWSER=...` 指定 |
| 换电脑后偏好丢失 | 偏好存在产品目录 `.state.json` 与环境联想偏好里，随目录一起拷走即可；部分 AI 统计存在浏览器 localStorage |
| 端口被占用 | 后端 `choose_port()` 自动择下一个空闲端口，启动器从 `.runtime.json` 读取实际端口 |

---

## 十六、术语表

| 术语 | 含义 |
| --- | --- |
| SyncTeX | TeX 引擎生成的源码行 ↔ PDF 位置映射（`.synctex.gz`），用于双向定位 |
| `.fmt` | 预编译的 TeX 格式文件，把导言区固化以跳过重复解析 |
| pdf.js 文本层 | PDF 中提取出的文本项（字符、坐标、字体），用于选择与编号热区 |
| 主编辑源 | 用户实际编辑的文件：`main.tex` / `main.md` / `main.mdtex`；后两者的 `main.tex` 是生成物 |
| 行号映射 | `main.map.json` 保存 `.tex` 行号 → Markdown 行号，供 SyncTeX 与错误定位换算 |
| 编号热区 | PDF 上可悬停的公式编号 `(n)` 与引用编号 `[n]` 小矩形 |
| 官方类 | 期刊提供的 `.cls` / `.sty`，放在 `templates/classes/` 后对全部项目生效 |
| 零抖动刷新 | 离屏渲染 + 一帧提交 + DOM 复用，使自动编译不闪白、不跳滚动位置 |
| 极速模式 | 引擎自动择优 + `.fmt` 预编译导言 + 0.14 秒防抖三项合称 |
| 投稿包 | 去注释、去辅助文件后打包的可提交 zip |

---

**文档结束。** 本手册对应的产品版本为 YangTex 1.0.0；功能或接口调整时请同步更新本文档与 `web/app.js` 内的「?」帮助文案，两者应保持一致。
