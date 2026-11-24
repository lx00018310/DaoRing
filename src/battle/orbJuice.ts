// ============================================================
// 道韵灵印触感反馈（Balatro 级 3D 悬停倾角、玉珠光泽跟随、算分胶囊弹跳）
// 使用事件委托绑定在容器上，手牌重绘零内存泄漏。
// ============================================================

export function attachOrbJuice(container: HTMLElement, selector = '.card'): void {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (reduced) return;

  let active: HTMLElement | null = null;

  const reset = (el: HTMLElement | null): void => {
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--mx', '50%');
    el.style.setProperty('--my', '35%');
  };

  container.addEventListener('pointermove', (e) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(selector) ?? null;
    if (active && active !== target) reset(active);
    active = target;
    if (!target || (target as HTMLButtonElement).disabled) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height) * 2 - 1));
    target.style.setProperty('--ry', `${(nx * 18).toFixed(1)}deg`);
    target.style.setProperty('--rx', `${(-ny * 18).toFixed(1)}deg`);
    target.style.setProperty('--mx', `${((nx * 0.5 + 0.5) * 100).toFixed(1)}%`);
    target.style.setProperty('--my', `${((ny * 0.5 + 0.5) * 100).toFixed(1)}%`);
  });

  container.addEventListener('pointerleave', () => {
    reset(active);
    active = null;
  });
}

/** 触发一次弹簧缩放弹跳（用于基础气/倍率跳动） */
export function popBounce(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('pop');
  // 强制重排以重新触发关键帧
  void el.offsetWidth;
  el.classList.add('pop');
}
