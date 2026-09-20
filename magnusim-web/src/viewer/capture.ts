export async function screenshotFrame(canvas: HTMLCanvasElement | null): Promise<Blob | null> {
  if (!canvas || typeof canvas.toBlob !== 'function') return null;
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}
