---
title: 课堂笔记 · 偏微分方程
author: 杨建伟
lang: zh
---
# 本次课要点

今天讨论 **Sobolev 空间** 中的先验估计。核心记号：区域 $\Omega \subset \mathbb{R}^n$，
未知函数 $u \in H^1_0(\Omega)$，右端项 $f \in L^2(\Omega)$。

## 三个关键步骤

1. 对方程两边乘以 $u$ 并在 $\Omega$ 上积分
2. 分部积分消去压力项，得到 $\|\nabla u\|_{L^2}^2$
3. 用 *Gronwall 不等式* 得到一致有界性

## 常用不等式

| 名称 | 形式 | 适用条件 |
| --- | --- | --- |
| Poincare | $\|u\|_{L^2} \le C_P \|\nabla u\|_{L^2}$ | $u \in H^1_0$ |
| Cauchy | $|(f,u)| \le \|f\| \|u\|$ | 任意 |

> 注意：常数 $C$ 在不同行可以不同，但必须与 $u$ 无关。

## 待补充

- [ ] 查证 $n \ge 3$ 时 Sobolev 嵌入的临界指数
- [ ] 把离散格式也写一遍
- [ ] 整理成讲义第 4 节

$$
\frac{d}{dt}\|u(t)\|_{L^2}^2 + 2\nu\|\nabla u(t)\|_{L^2}^2 = 2(f,u)
$$

---

本笔记由 YangTex 的 Markdown 模板生成；编辑器里继续用 **Markdown 语法** 修改，保存即自动重新编译。
