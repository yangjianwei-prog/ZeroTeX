---
title: 文献精读卡
author: 杨建伟
lang: zh
---
# 文献信息

- **题目**：On the regularity of weak solutions to the Navier--Stokes equations
- **作者 / 年份**：待填写
- **期刊 / 卷页**：待填写

## 一句话结论

本文在 $L^3$ 临界空间中给出了弱解的 **局部正则性** 判据。

## 主要假设

- 区域 $\Omega \subset \mathbb{R}^3$ 有界且边界光滑
- $u_0 \in L^2_\sigma(\Omega)$
- 外力 $f \in L^2(0,T;H^{-1})$

## 核心估计

$$
\|u(t)\|_{L^\infty} \le C t^{-1/2} \|u_0\|_{L^3}
$$

> 关键技巧：把非线性项放进 *Carleson 型* 估计，而非直接做能量估计。

## 我关心的问题

1. 条件中的 $C$ 是否依赖 $\nu$？
2. 结论能否推广到有界区域的 **Navier 滑移边界**？
3. 与 Serrin 条件 $2/p + 3/q \le 1$ 的关系

## 可复用的引理

| 引理 | 作用 | 是否需要改写 |
| --- | --- | --- |
| Lemma 2.1 | 局部能量不等式 | 需要 |
| Lemma 3.4 | 紧性 | 可直接引用 |

## 评价

- 证明结构清晰，但第 4 节缩放论证略简
- 值得在自己的 PDE 笔记里重写一遍

---

精读卡由 YangTex Markdown 模板生成。
