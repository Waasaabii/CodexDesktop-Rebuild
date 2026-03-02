import React from "react";

function icon(path) {
  return function Icon({ className = "h-4 w-4" }) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={className}>
        {path}
      </svg>
    );
  };
}

export const IconLogo = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 15.5 15.5 8.5" />
    <path d="m8.5 8.5 7 7" />
  </>,
);

export const IconThread = icon(
  <>
    <rect x="4.5" y="5.5" width="15" height="13" rx="2" />
    <path d="M8 9.5h8M8 12h8M8 14.5h5" />
  </>,
);

export const IconMagic = icon(
  <>
    <path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7Z" />
    <path d="m18.5 14.5.8 2 .2.5.5.2 2 .8-2 .8-.5.2-.2.5-.8 2-.8-2-.2-.5-.5-.2-2-.8 2-.8.5-.2.2-.5Z" />
  </>,
);

export const IconAutomation = icon(
  <>
    <path d="M6 12a6 6 0 0 1 6-6M18 12a6 6 0 0 1-6 6" />
    <path d="M8 5.5h4M12 18.5h4" />
    <circle cx="12" cy="12" r="1.5" />
  </>,
);

export const IconSkill = icon(
  <>
    <path d="M4.5 12h15" />
    <path d="M12 4.5v15" />
    <circle cx="12" cy="12" r="7.5" />
  </>,
);

export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 3.5 3.5" />
  </>,
);

export const IconMenu = icon(
  <>
    <path d="M5 7h14M5 12h14M5 17h14" />
  </>,
);

export const IconSend = icon(
  <>
    <path d="m4 12 16-7-4 7 4 7Z" />
    <path d="M4 12h12" />
  </>,
);

export const IconPin = icon(
  <>
    <path d="m9 4 6 6" />
    <path d="m7 7 10 10" />
    <path d="m12 14-6 6" />
  </>,
);

export const IconArchive = icon(
  <>
    <rect x="4.5" y="5.5" width="15" height="4" rx="1" />
    <path d="M6 9.5v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8" />
    <path d="M10 13h4" />
  </>,
);

export const IconEdit = icon(
  <>
    <path d="M4.5 19.5h5l8-8-5-5-8 8Z" />
    <path d="m11.5 7.5 5 5" />
  </>,
);

export const IconSettings = icon(
  <>
    <circle cx="12" cy="12" r="2.5" />
    <path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1l-.3-2.6h-4l-.3 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.6h4l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1Z" />
  </>,
);

export const IconSquare = icon(
  <>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </>,
);

export const IconMinimize = icon(<path d="M6 18h12" />);

export const IconMaximize = icon(<path d="M6 6h12v12H6z" />);

export const IconClose = icon(
  <>
    <path d="m7 7 10 10M17 7 7 17" />
  </>,
);
