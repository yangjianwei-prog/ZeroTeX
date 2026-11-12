% ==================================================================
% YangTex · 编译产物，请勿直接编辑（改动会在下次保存时被覆盖）
% 由 Markdown 源 main.md 自动生成
% 请编辑同目录下的 main.md / main.mdtex：那才是主文档，
% 用的是 Markdown 语法；本文件只交给 TeX 引擎编译。
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
\title{课堂笔记 · 偏微分方程}
\author{杨建伟}
\date{\today}
\begin{document}
\maketitle

\section{本次课要点}

今天讨论 \textbf{Sobolev 空间} 中的先验估计。核心记号：区域 $\Omega \subset \mathbb{R}^n$， 未知函数 $u \in H^1_0(\Omega)$，右端项 $f \in L^2(\Omega)$。

\subsection{三个关键步骤}

\begin{enumerate}
  \item 对方程两边乘以 $u$ 并在 $\Omega$ 上积分
  \item 分部积分消去压力项，得到 $\|\nabla u\|_{L^2}^2$
  \item 用 \textit{Gronwall 不等式} 得到一致有界性
\end{enumerate}

\subsection{常用不等式}

\begin{center}
\begin{tabular}{l|l|l}
\hline
名称 & 形式 & 适用条件 \\
\hline
Poincare & $\|u\|_{L^2} \le C_P \|\nabla u\|_{L^2}$ & $u \in H^1_0$ \\
Cauchy & $|(f,u)| \le \|f\| \|u\|$ & 任意 \\
\hline
\end{tabular}
\end{center}

\begin{quote}
注意：常数 $C$ 在不同行可以不同，但必须与 $u$ 无关。
\end{quote}

\subsection{待补充}

\begin{itemize}
  \item [ ] 查证 $n \ge 3$ 时 Sobolev 嵌入的临界指数
  \item [ ] 把离散格式也写一遍
  \item [ ] 整理成讲义第 4 节
\end{itemize}

\[
\frac{d}{dt}\|u(t)\|_{L^2}^2 + 2\nu\|\nabla u(t)\|_{L^2}^2 = 2(f,u)
\]

\par\noindent\rule{\textwidth}{0.4pt}\par

本笔记由 YangTex 的 Markdown 模板生成；编辑器里继续用 \textbf{Markdown 语法} 修改，保存即自动重新编译。

\end{document}
