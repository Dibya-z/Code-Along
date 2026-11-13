import { useEffect, useState } from 'react';
import type { RasterPlot } from '@code-along/contracts/execution/plots';
function Plot({ plot }: { plot: RasterPlot }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const created = URL.createObjectURL(
      new Blob([Uint8Array.from(plot.png)], { type: 'image/png' }),
    );
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [plot]);
  return (
    <figure className="raster-plot">
      <figcaption>
        Plot {plot.index + 1} · {plot.title || 'Python plot'}
      </figcaption>
      {url && (
        <>
          <img src={url} alt={plot.title || `Python plot ${plot.index + 1}`} />
          <a href={url} download={`plot-${plot.index + 1}.png`}>
            Download PNG
          </a>
        </>
      )}
    </figure>
  );
}
export function PlotGallery({ plots }: { plots: readonly RasterPlot[] }) {
  return plots.length ? (
    <section className="plot-gallery" aria-label="Python plots">
      {plots.map((plot) => (
        <Plot key={plot.index} plot={plot} />
      ))}
    </section>
  ) : null;
}
