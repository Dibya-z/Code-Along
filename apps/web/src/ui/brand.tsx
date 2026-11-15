export function ProductBrand() {
  return (
    <span className="product-brand">
      <span className="brand-symbol" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" focusable="false">
          <path
            d="m11 8-7 8 7 8m10-16 7 8-7 8"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="14" cy="16" r="1.4" fill="currentColor" />
          <circle cx="18" cy="16" r="1.4" fill="currentColor" />
        </svg>
      </span>
      <span className="brand-name">
        code along<span className="brand-period">.</span>
      </span>
    </span>
  );
}
