% ==================================================================
% YangTex · 由 Markdown 模板自动生成（内置 Markdown -> LaTeX 转换器）
% 源模板：md_meeting_minutes.md
% 这是标准 LaTeX：可直接编辑，实时编译 / SyncTeX 双向同步照常可用。
% 需要继续用 Markdown 写时，选中文本后点「MD→TeX 转换」。
% ==================================================================
\documentclass[UTF8,a4paper,11pt,fontset=fandol]{ctexart}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{mathtools}
\usepackage{amsthm}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage{enumitem}
\usepackage{geometry}
\usepackage{hyperref}
\geometry{margin=2.5cm}
\newtheorem{theorem}{定理}[section]
\newtheorem{lemma}[theorem]{引理}
\newtheorem{definition}[theorem]{定义}
\newtheorem{proposition}[theorem]{命题}
\newtheorem{corollary}[theorem]{推论}
\title{组会纪要}
\author{数学与统计学院}
\date{\today}
\begin{document}
\maketitle
\section{组会基本信息}

\begin{itemize}
  \item \textbf{时间}：每周三 15:00
  \item \textbf{地点}：理科楼研讨室
  \item \textbf{主题}：不可压缩流体方程的正则性
\end{itemize}

\subsection{本次汇报}

\begin{enumerate}
  \item 博士生甲：能量估计与紧性论证进展
  \item 博士生乙：数值格式稳定性测试
  \item 教师小结：下一步重点
\end{enumerate}

\subsection{问题与结论}

\begin{quote}
先验估计中的常数 $C$ 需统一口径，避免与 $\nu$ 混淆。
\end{quote}

\begin{center}
\begin{tabular}{l|l|l|l}
\hline
事项 & 负责人 & 截止 & 状态 \\
\hline
补齐 $n=3$ 的估计 & 甲 & 本周五 & 进行中 \\
复现算例 2 & 乙 & 下周 & 未开始 \\
整理参考文献 & 全体 & 月底 & 进行中 \\
\hline
\end{tabular}
\end{center}

\subsection{下次议程}

\begin{itemize}
  \item 检查 $\|\nabla u\|_{L^2}$ 的一致性估计
  \item 讨论投稿期刊选择
  \item 确定课程讲义分工
\end{itemize}

\par\noindent\rule{\textwidth}{0.4pt}\par

纪要由 YangTex Markdown 模板生成，表格与列表可直接照常编辑。

\end{document}
