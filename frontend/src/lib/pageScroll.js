export const getPageScrollTarget = () =>
  document.querySelector('[data-qa="page-scroll"]') ?? window;

export const getPageScrollTop = () => {
  const target = getPageScrollTarget();
  return target === window ? window.scrollY : target.scrollTop;
};
