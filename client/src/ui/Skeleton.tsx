/**
 * Loading placeholders. Prefer these over swapping the whole screen for a
 * spinner — the layout stays put and the nav never unmounts.
 */

export function Skeleton({
  width,
  height = 14,
  radius = 6,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
}) {
  return (
    <span
      className={['vp-skeleton', className].filter(Boolean).join(' ')}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={['vp-skeleton-text', className].filter(Boolean).join(' ')} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className="vp-skeleton"
          style={{ height: 12, width: i === lines - 1 ? '55%' : '100%' }}
        />
      ))}
    </span>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="vp-skeleton-rows" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="vp-skeleton-row">
          <span className="vp-skeleton" style={{ width: 40, height: 40, borderRadius: 8 }} />
          <span className="vp-skeleton-row-lines">
            <span className="vp-skeleton" style={{ width: '45%', height: 13 }} />
            <span className="vp-skeleton" style={{ width: '70%', height: 11 }} />
          </span>
        </div>
      ))}
    </div>
  );
}
