// 16px stroke icons drawn for this panel.
import type { JSX } from "preact";

type P = { size?: number; class?: string; title?: string };

function I(paths: JSX.Element, { size = 16, class: cls, title }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
      stroke-linecap="round" stroke-linejoin="round" class={cls} aria-hidden={title ? undefined : "true"} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {paths}
    </svg>
  );
}

export const Icon = {
  logo: (p: P = {}) => I(<><path d="M3 5.5h6M3 8.5h10M3 11.5h7" /></>, p),
  play: (p: P = {}) => I(<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />, p),
  pause: (p: P = {}) => I(<><path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2" /></>, p),
  undo: (p: P = {}) => I(<><path d="M5.5 4L2.5 7l3 3" /><path d="M2.5 7h7a4 4 0 010 8H7" /></>, p),
  redo: (p: P = {}) => I(<><path d="M10.5 4l3 3-3 3" /><path d="M13.5 7h-7a4 4 0 000 8H9" /></>, p),
  search: (p: P = {}) => I(<><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>, p),
  split: (p: P = {}) => I(<><path d="M8 2v12" stroke-dasharray="2 2" /><path d="M5.5 5.5L3 8l2.5 2.5M10.5 5.5L13 8l-2.5 2.5" /></>, p),
  merge: (p: P = {}) => I(<><path d="M3 5.5L5.5 8 3 10.5M13 5.5L10.5 8l2.5 2.5" /><path d="M8 3v10" /></>, p),
  trash: (p: P = {}) => I(<><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></>, p),
  chevron: (p: P = {}) => I(<path d="M4 6l4 4 4-4" />, p),
  chevronRight: (p: P = {}) => I(<path d="M6 4l4 4-4 4" />, p),
  gear: (p: P = {}) => I(<><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" /></>, p),
  help: (p: P = {}) => I(<><circle cx="8" cy="8" r="6.2" /><path d="M6.3 6.2a1.8 1.8 0 113 1.3c-.6.5-1.3.8-1.3 1.7" /><circle cx="8" cy="11.4" r=".4" fill="currentColor" /></>, p),
  check: (p: P = {}) => I(<path d="M3 8.5l3.2 3L13 4.5" />, p),
  x: (p: P = {}) => I(<path d="M4 4l8 8M12 4l-8 8" />, p),
  alert: (p: P = {}) => I(<><path d="M8 2.2l6.3 11H1.7z" /><path d="M8 6.5v3" /><circle cx="8" cy="11.3" r=".4" fill="currentColor" /></>, p),
  info: (p: P = {}) => I(<><circle cx="8" cy="8" r="6.2" /><path d="M8 7.3v3.8" /><circle cx="8" cy="5" r=".4" fill="currentColor" /></>, p),
  folder: (p: P = {}) => I(<path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z" />, p),
  download: (p: P = {}) => I(<><path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2" /><path d="M2.5 13.5h11" /></>, p),
  upload: (p: P = {}) => I(<><path d="M8 10.5v-8M4.8 5.5L8 2.3l3.2 3.2" /><path d="M2.5 13.5h11" /></>, p),
  wave: (p: P = {}) => I(<path d="M2 8h1M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 8h0" />, p),
  film: (p: P = {}) => I(<><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3" /></>, p),
  layers: (p: P = {}) => I(<><path d="M8 2.5L14 5.5 8 8.5 2 5.5z" /><path d="M2 8.5l6 3 6-3M2 11l6 3 6-3" /></>, p),
  text: (p: P = {}) => I(<><path d="M3 4V3h10v1M8 3v10M6 13h4" /></>, p),
  clock: (p: P = {}) => I(<><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.4" /></>, p),
  refresh: (p: P = {}) => I(<><path d="M13 3.5v3h-3" /><path d="M12.6 6.5A5 5 0 103.4 9.8" /></>, p),
  copy: (p: P = {}) => I(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.3" /><path d="M10.5 3.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6.5a1 1 0 001 1h.5" /></>, p),
  shield: (p: P = {}) => I(<><path d="M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4-2.8-1.1-5-3.2-5-6.4v-4z" /><path d="M5.6 8.2l1.7 1.6 3.1-3.3" /></>, p),
  list: (p: P = {}) => I(<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h0M2.5 8h0M2.5 12h0" />, p),
  sparkle: (p: P = {}) => I(<path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4zM12.5 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />, p),
  more: (p: P = {}) => I(<><circle cx="3.5" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="12.5" cy="8" r=".6" fill="currentColor" /></>, p),
  cpu: (p: P = {}) => I(<><rect x="4" y="4" width="8" height="8" rx="1" /><path d="M6.5 1.8V4M9.5 1.8V4M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2" /></>, p),
  stop: (p: P = {}) => I(<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />, p),
  save: (p: P = {}) => I(<><path d="M3 2.5h8l2.5 2.5v8.5H3z" /><path d="M5.5 2.5v3h4v-3M5.5 13.5V9.5h5v4" /></>, p),
  plus: (p: P = {}) => I(<path d="M8 3v10M3 8h10" />, p),
  external: (p: P = {}) => I(<><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3" /></>, p),
};
