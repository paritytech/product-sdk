"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// dot.li (and similar sandbox hosts) load each app inside an iframe at
// `<cid>.app.dot.li` and re-validate URL params (`contentBackend`,
// `chainBackend`, `skipArchiveCache`, ...) on every page load. Next.js
// soft navigation rewrites the URL via history.pushState and drops query
// params by default, which trips the host validator the next time anything
// re-bootstraps the iframe.
//
// Strategy: on first navigation effect after mount, capture whatever
// params the host put in the URL. After every subsequent navigation,
// re-add any missing stashed params via history.replaceState — that
// updates the address bar without triggering navigation or pushing a
// history entry.

const STORAGE_KEY = "__host_url_params";

function PreserveHostParamsInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    const current = url.searchParams;

    let stashed = sessionStorage.getItem(STORAGE_KEY);
    if (stashed === null && current.toString().length > 0) {
      stashed = current.toString();
      sessionStorage.setItem(STORAGE_KEY, stashed);
    }
    if (!stashed) return;

    const stashedParams = new URLSearchParams(stashed);
    let changed = false;
    stashedParams.forEach((value, key) => {
      if (!current.has(key)) {
        current.set(key, value);
        changed = true;
      }
    });
    if (changed) {
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, [pathname, searchParams]);

  return null;
}

export function PreserveHostParams() {
  // useSearchParams requires a Suspense boundary in Next 15 / static export.
  return (
    <Suspense fallback={null}>
      <PreserveHostParamsInner />
    </Suspense>
  );
}
