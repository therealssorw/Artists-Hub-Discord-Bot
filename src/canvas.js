/** Shared drawing helpers for the images the bot renders (milestones, rank cards). */
import { createRequire } from 'node:module';

import { GlobalFonts, loadImage } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);
/** Bundled so text renders on a bare VM without system fonts. */
export const FONT = 'DejaVu Sans';
GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), FONT);
GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'), FONT);

/** Draw `image` clipped to a circle, or a coloured circle with an initial when it is null. */
export function circleImage(ctx, image, x, y, size, fallbackText) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (image) {
    ctx.drawImage(image, x, y, size, size);
  } else {
    ctx.fillStyle = '#5865f2';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(size * 0.42)}px "${FONT}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((fallbackText || '?').slice(0, 1).toUpperCase(), x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

export function ring(ctx, x, y, size, color, width) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + width / 2, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/** Shrink `text` until it fits in `maxWidth`, adding an ellipsis if it must be cut. */
export function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Download an image for drawing, or null if it cannot be fetched. */
export async function fetchImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}
