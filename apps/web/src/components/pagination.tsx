import { Button } from '@code-along/design-system';
export function Pagination({
  offset,
  count,
  limit,
  onChange,
}: {
  offset: number;
  count: number;
  limit: number;
  onChange: (n: number) => void;
}) {
  if (count <= limit) return null;
  return (
    <nav aria-label="Pagination" className="actions content-section">
      <Button
        variant="secondary"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Previous page
      </Button>
      <span>
        {offset + 1}–{Math.min(offset + limit, count)} of {count}
      </span>
      <Button
        variant="secondary"
        disabled={offset + limit >= count}
        onClick={() => onChange(offset + limit)}
      >
        Next page
      </Button>
    </nav>
  );
}
