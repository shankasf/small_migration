// The Circini mark: a drafting-compass reticle — concentric ring, crosshair, hub.
export function CirciniMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="12.5" stroke="currentColor" strokeWidth="1.25" opacity="0.9" />
      <circle cx="16" cy="16" r="8" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      {/* crosshair with a gap at the hub */}
      <path
        d="M16 2.5v9M16 20.5v9M2.5 16h9M20.5 16h9"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.55"
      />
      {/* the compass needle */}
      <path d="M16 8 L18.5 16 L16 16 Z" fill="currentColor" />
      <path d="M16 24 L13.5 16 L16 16 Z" fill="currentColor" opacity="0.45" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}

// The real Circini company logo. Placed on a light "logo plate" so it stays
// legible on the dark console theme regardless of the artwork's own background.
export function CirciniLogo({ height = 24, className }: { height?: number; className?: string }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-md bg-white/95 px-2.5 py-1.5 shadow-sm ring-1 ring-black/10 " +
        (className || "")
      }
    >
      <img
        src="/brand/Circini-logo-landscape.png"
        alt="Circini"
        style={{ height }}
        className="block w-auto"
      />
    </span>
  );
}

export function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <CirciniLogo height={compact ? 18 : 22} />
      {!compact && (
        <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-faint">
          Migration&nbsp;Agent
        </span>
      )}
    </div>
  );
}
