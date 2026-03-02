const MIN_CHILD_COUNT = 80;
const MIN_SCROLL_HEIGHT = 2400;
const CONTAIN_INTRINSIC_SIZE = "40px 240px";
const APPLIED_ATTR = "data-codex-cv-applied";

const observedContainers = new WeakMap();

function isLikelyLongListContainer(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.childElementCount < MIN_CHILD_COUNT) {
    return false;
  }
  const style = window.getComputedStyle(element);
  const isScrollable = /(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflow);
  if (!isScrollable) {
    return false;
  }
  if (element.scrollHeight < MIN_SCROLL_HEIGHT) {
    return false;
  }
  return true;
}

function applyContentVisibilityToChildren(container) {
  const children = container.children;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!(child instanceof HTMLElement)) {
      continue;
    }
    if (child.getAttribute(APPLIED_ATTR) === "1") {
      continue;
    }
    child.style.contentVisibility = "auto";
    child.style.containIntrinsicSize = CONTAIN_INTRINSIC_SIZE;
    child.style.contain = "layout style paint";
    child.setAttribute(APPLIED_ATTR, "1");
  }
}

function ensureObserved(container) {
  if (observedContainers.has(container)) {
    return;
  }
  const observer = new MutationObserver(() => {
    applyContentVisibilityToChildren(container);
  });
  observer.observe(container, {
    childList: true,
    subtree: false,
  });
  observedContainers.set(container, observer);
}

function scanAndApply() {
  const candidates = document.querySelectorAll("main, section, div, ul, ol");
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!isLikelyLongListContainer(candidate)) {
      continue;
    }
    applyContentVisibilityToChildren(candidate);
    ensureObserved(candidate);
  }
}

function boot() {
  scanAndApply();
  setInterval(scanAndApply, 1500);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

