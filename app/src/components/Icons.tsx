// Line icons for the side rail: 20px, 1.6 stroke, currentColor. Drawn here so the rail needs no icon font or library.
import type { ReactNode } from "react";

const I = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden={!label} aria-label={label}>
    {children}
  </svg>
);

export const Icon = {
  markets: () => (
    <I>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </I>
  ),
  trade: () => (
    <I>
      <path d="M3 17l5-5 4 3 8-9" />
      <path d="M15 6h5v5" />
    </I>
  ),
  plus: () => (
    <I>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v8M8 12h8" />
    </I>
  ),
  launch: () => (
    <I>
      <path d="M12 3c3 2 4.5 5.5 4 10l-2 3h-4l-2-3c-.5-4.5 1-8 4-10z" />
      <circle cx="12" cy="9.5" r="1.6" />
      <path d="M8 13l-3 3 3 1M16 13l3 3-3 1M11 19.5l1 1.5 1-1.5" />
    </I>
  ),
  bag: () => (
    <I>
      <path d="M5 8h14l-1 12H6L5 8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </I>
  ),
  spicy: () => (
    <I>
      <path d="M12 21c-4 0-6.5-2.6-6.5-6 0-3.8 3.2-5.4 3.7-9.5C12 7 13 9 13 11c1-1 1.6-2.2 1.7-3.6 2.6 1.9 3.8 4.6 3.8 7.6 0 3.4-2.5 6-6.5 6z" />
    </I>
  ),
  wrap: () => (
    <I>
      <path d="M4 8l8-4 8 4-8 4-8-4z" />
      <path d="M4 8v8l8 4 8-4V8M12 12v8" />
    </I>
  ),
  arena: () => (
    <I>
      <rect x="5" y="8" width="14" height="11" rx="2.5" />
      <path d="M12 8V4.5M9.5 4.5h5" />
      <circle cx="9.5" cy="13" r="1" />
      <circle cx="14.5" cy="13" r="1" />
      <path d="M9.5 16.5h5" />
    </I>
  ),
  trophy: () => (
    <I>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4z" />
      <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4" />
    </I>
  ),
};
