// NightCut icon set — original stroke-style SVG icons (24px grid,
// currentColor), drawn from basic geometry in the style of modern
// editor iconography. No third-party assets.
import { ReactNode } from "react";

function I({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconMedia = ({ size }: { size?: number }) => (
  <I size={size}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.4" />
    <path d="M21 16l-4.5-4.5a1.5 1.5 0 0 0-2 0L7 19" />
  </I>
);
export const IconText = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M5 6V4.5h14V6" />
    <path d="M12 4.5V19" />
    <path d="M9 19h6" />
  </I>
);
export const IconEffects = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M12 3l1.7 4.6L18.5 9l-4.8 1.4L12 15l-1.7-4.6L5.5 9l4.8-1.4z" />
    <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </I>
);
export const IconFilters = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="17" r="2" />
  </I>
);
export const IconTransitions = ({ size }: { size?: number }) => (
  <I size={size}>
    <rect x="2.5" y="6" width="11" height="12" rx="2" />
    <path d="M16.5 4.5H19a2.5 2.5 0 0 1 2.5 2.5v8.5" />
    <path d="M8 10v4M6 12h4" />
  </I>
);
export const IconAudio = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M9 18V5l10-2v13" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="16" r="2.5" />
  </I>
);
export const IconCaptions = ({ size }: { size?: number }) => (
  <I size={size}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M10.5 10.2a2.4 2.4 0 1 0 0 3.6M17 10.2a2.4 2.4 0 1 0 0 3.6" />
  </I>
);
export const IconTemplates = ({ size }: { size?: number }) => (
  <I size={size}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </I>
);
export const IconStickers = ({ size }: { size?: number }) => (
  <I size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" strokeWidth={2.6} />
  </I>
);
export const IconUndo = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M8.5 5.5L5 9l3.5 3.5" />
    <path d="M5 9h9.5a4.5 4.5 0 0 1 0 9H11" />
  </I>
);
export const IconRedo = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M15.5 5.5L19 9l-3.5 3.5" />
    <path d="M19 9H9.5a4.5 4.5 0 0 0 0 9H13" />
  </I>
);
export const IconSplit = ({ size }: { size?: number }) => (
  <I size={size}>
    <circle cx="6" cy="6.5" r="2.3" />
    <circle cx="6" cy="17.5" r="2.3" />
    <path d="M7.8 8.3L20 19M7.8 15.7L20 5" />
  </I>
);
export const IconTrash = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M4 6.5h16M9.5 6V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6" />
    <path d="M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13" />
    <path d="M10 10.5v6M14 10.5v6" />
  </I>
);
export const IconFreeze = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M12 3v18M12 3l-2 2.5M12 3l2 2.5M12 21l-2-2.5M12 21l2-2.5" />
    <path d="M4.2 7.5l15.6 9M4.2 7.5L4 10.4M4.2 7.5L7 7M19.8 16.5l.2-2.9M19.8 16.5L17 17" />
    <path d="M19.8 7.5l-15.6 9M19.8 7.5L20 10.4M19.8 7.5L17 7M4.2 16.5l-.2-2.9M4.2 16.5L7 17" />
  </I>
);
export const IconMagnet = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M6 4v7a6 6 0 0 0 12 0V4" />
    <path d="M6 4h4v4H6zM14 4h4v4h-4z" />
  </I>
);
export const IconFit = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </I>
);
export const IconPlay = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);
export const IconPause = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" />
  </svg>
);
export const IconPrev = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="5" y="5" width="2.6" height="14" rx="1" />
    <path d="M19 5.5v13L9.5 12z" />
  </svg>
);
export const IconFullscreen = ({ size }: { size?: number }) => (
  <I size={size}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </I>
);
export const IconEye = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </I>
);
export const IconEyeOff = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <path d="M4.5 4.5l15 15" />
    <path d="M9.9 6.2A8.6 8.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17.8 17.8 0 0 1-3.3 3.5M6 8A16.9 16.9 0 0 0 2.5 12S6 18 12 18c1.2 0 2.3-.3 3.3-.7" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </I>
);
export const IconVolume = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
  </I>
);
export const IconVolumeX = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" />
    <path d="M15.5 9.8l5 4.4M20.5 9.8l-5 4.4" />
  </I>
);
export const IconLock = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </I>
);
export const IconUnlock = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 7.8-1.3" />
  </I>
);
export const IconFilm = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M7.5 4.5v15M16.5 4.5v15M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />
  </I>
);
export const IconPlus = ({ size = 16 }: { size?: number }) => (
  <I size={size}>
    <path d="M12 5v14M5 12h14" />
  </I>
);
