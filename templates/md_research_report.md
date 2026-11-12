---
title: Short Research Report
author: J. Yang
lang: en
---
# Abstract

We report a preliminary **energy estimate** for a parabolic problem.
The main quantity is $u \in L^2(0,T;H^1_0(\Omega))$ with data $f \in L^2$.

## Setup

Consider the weak formulation

$$
  (u_t, v) + \nu (\nabla u, \nabla v) = (f, v)
  \qquad \text{for all } v \in H^1_0(\Omega).
$$

## Assumptions

1. $\Omega \subset \mathbb{R}^n$ is bounded and Lipschitz.
2. $u_0 \in L^2(\Omega)$ and $f \in L^2(0,T;L^2(\Omega))$.
3. The viscosity satisfies $\nu > 0$.

## Notation

| Symbol | Meaning | Space |
| --- | --- | --- |
| $u$ | velocity | $H^1_0$ |
| $p$ | pressure | $L^2$ |
| $\nu$ | viscosity | $\mathbb{R}^{+}$ |

> The constant $C$ may change from line to line but never depends on $u$.

## Result

:::latex
\begin{theorem}[A priori bound]
Let $u_0 \in L^2(\Omega)$ and $f \in L^2(0,T;L^2(\Omega))$. Then
\begin{equation}
  \sup_{0<t<T}\|u(t)\|_{L^2}^2 + 2\nu\int_0^T\|\nabla u\|^2\,dt
  \le \|u_0\|_{L^2}^2 + C\|f\|_{L^2}^2 .
\end{equation}
\end{theorem}
:::

## Next steps

- Extend to the *nonlinear* case.
- Check the discrete counterpart.
- Prepare the numerical section.

---

Generated from a YangTex Markdown template.
