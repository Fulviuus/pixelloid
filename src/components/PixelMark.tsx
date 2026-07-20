type PixelMarkProps = {
  size?: number;
};

export function PixelMark({ size = 28 }: PixelMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className="pixel-mark"
      height={size}
      viewBox="0 0 28 28"
      width={size}
    >
      <path d="M2 2h10v10H2z" fill="currentColor" />
      <path d="M16 2h10v10H16z" fill="currentColor" opacity=".42" />
      <path d="M2 16h10v10H2z" fill="currentColor" opacity=".42" />
      <path d="M16 16h10v10H16z" fill="currentColor" />
      <path d="M11 11h6v6h-6z" fill="currentColor" />
    </svg>
  );
}
