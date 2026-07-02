interface LingFlowLogoProps {
  readonly className?: string;
  readonly showWordmark?: boolean;
}

export function LingFlowLogo({ className = '', showWordmark = false }: LingFlowLogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        aria-hidden="true"
        className="h-7 w-7 shrink-0"
        fill="none"
        viewBox="0 0 64 64"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect fill="url(#lf-bg)" height="64" rx="16" width="64" />
        <path
          d="M18 18.5C18 15.46 20.46 13 23.5 13H43C46.31 13 49 15.69 49 19V35.5C49 38.54 46.54 41 43.5 41H34.5L24.8 49.19C23.82 50.02 22.3 49.32 22.3 48.03V41H21.2C18.33 41 16 38.67 16 35.8V24.8"
          stroke="white"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
        <path
          d="M23 25H38.5M23 32H34.5M41 48C44.6 45.78 47.27 42.95 49 39.5M14 16C17.52 13.24 21.55 11.9 26.1 12"
          stroke="#A7F3D0"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <defs>
          <linearGradient gradientUnits="userSpaceOnUse" id="lf-bg" x1="11" x2="55" y1="9" y2="58">
            <stop stopColor="#2563EB" />
            <stop offset="0.52" stopColor="#0EA5A4" />
            <stop offset="1" stopColor="#10B981" />
          </linearGradient>
        </defs>
      </svg>
      {showWordmark ? <span className="font-semibold">灵流</span> : null}
    </span>
  );
}
