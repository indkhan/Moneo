"use client";

import { useCallback, useEffect, useRef, type DependencyList, type RefObject } from "react";

const NEAR_BOTTOM = 120;

function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Keeps new output in view while the reader is at the end. Scrolling up to read leaves them there until they return to
 * the end, send something (call the returned function) or open another chat (`resetKey`).
 */
export function useFollowOutput(end: RefObject<HTMLElement | null>, changes: DependencyList, resetKey?: unknown) {
  const following = useRef(true);
  useEffect(() => {
    following.current = true;
    const scroller = scrollParent(end.current);
    const measure = () => {
      const box = scroller ?? document.documentElement;
      following.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    };
    const target = scroller ?? window;
    target.addEventListener("scroll", measure, { passive: true });
    // Cards and charts in a reply finish loading after it renders; growing content is new output too.
    const content = end.current?.parentElement;
    const growth = new ResizeObserver(() => { if (following.current) end.current?.scrollIntoView({ block: "end" }); });
    if (content) growth.observe(content);
    return () => { target.removeEventListener("scroll", measure); growth.disconnect(); };
  }, [end, resetKey]);
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
  }, [resetKey, ...changes]); // eslint-disable-line react-hooks/exhaustive-deps
  return useCallback(() => { following.current = true; }, []);
}
