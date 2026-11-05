// The phone shell reserves a separate row for feedback. Its content pane is
// the sole page scroll owner; larger layouts keep their existing window scroll.
export const getPageScrollTarget = () =>
  document.querySelector('[data-qa="page-scroll"]') ?? window;

export const getPageScrollTop = () => {
  const target = getPageScrollTarget();
  return target === window ? window.scrollY : target.scrollTop;
};
