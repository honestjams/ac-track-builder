// Draws the sign artwork atlas with a 2D canvas: street name blades, shop
// and landmark signs, and Australian-style traffic signs.

import type { ArtAtlas, ArtCell, ArtRequest } from "../core/art";

const ATLAS_W = 2048;
const FONT = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif';

interface Box {
  w: number;
  h: number;
  draw(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): void;
}

function fitText(ctx: OffscreenCanvasRenderingContext2D, text: string, weight: string, size: number, maxW: number): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(text).width > maxW && s > 10) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function boxFor(req: ArtRequest, measure: OffscreenCanvasRenderingContext2D): Box {
  const text = req.text ?? "";
  switch (req.kind) {
    case "street": {
      // Blue blade, white border and lettering (Queensland / NSW style).
      const h = 64;
      measure.font = `bold 44px ${FONT}`;
      const w = Math.min(ATLAS_W - 8, Math.max(220, Math.ceil(measure.measureText(text.toUpperCase()).width) + 48));
      return {
        w, h, draw(ctx, x, y) {
          ctx.fillStyle = "#1c3f94";
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 4;
          ctx.strokeRect(x + 5, y + 5, w - 10, h - 10);
          ctx.fillStyle = "#fff";
          fitText(ctx, text.toUpperCase(), "bold", 44, w - 40);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(text.toUpperCase(), x + w / 2, y + h / 2 + 2);
        },
      };
    }
    case "poi":
    case "tourist": {
      const w = 384, h = 160;
      const bg = req.kind === "tourist" ? "#6b3d1f" : req.colour ?? "#2d3a4a";
      return {
        w, h, draw(ctx, x, y) {
          ctx.fillStyle = bg;
          roundRect(ctx, x, y, w, h, 14);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = 5;
          roundRect(ctx, x + 8, y + 8, w - 16, h - 16, 10);
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          // Up to two lines, split at the space nearest the middle.
          let lines = [text];
          if (text.length > 16 && text.includes(" ")) {
            const mid = text.length / 2;
            let best = -1;
            for (let i = 0; i < text.length; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
            lines = [text.slice(0, best), text.slice(best + 1)];
          }
          const size = Math.min(...lines.map((l) => fitText(ctx, l, "bold", lines.length > 1 ? 52 : 64, w - 48)));
          ctx.font = `bold ${size}px ${FONT}`;
          lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * size * 1.05));
        },
      };
    }
    case "speed":
      return {
        w: 160, h: 192, draw(ctx, x, y) {
          // White plate with a red roundel and black number.
          ctx.fillStyle = "#fff";
          roundRect(ctx, x + 2, y + 2, 156, 188, 12);
          ctx.fill();
          ctx.strokeStyle = "#222";
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x + 80, y + 96, 66, 0, Math.PI * 2);
          ctx.strokeStyle = "#d0201a";
          ctx.lineWidth = 16;
          ctx.stroke();
          ctx.fillStyle = "#111";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          fitText(ctx, text, "bold", 68, 96);
          ctx.fillText(text, x + 80, y + 100);
        },
      };
    case "stop":
      return {
        w: 160, h: 160, draw(ctx, x, y) {
          ctx.beginPath();
          for (let i = 0; i < 8; i++) {
            const a = Math.PI / 8 + (i * Math.PI) / 4;
            ctx.lineTo(x + 80 + Math.cos(a) * 78, y + 80 + Math.sin(a) * 78);
          }
          ctx.closePath();
          ctx.fillStyle = "#c8102e";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `bold 50px ${FONT}`;
          ctx.fillText("STOP", x + 80, y + 82);
        },
      };
    case "giveway":
      return {
        w: 160, h: 140, draw(ctx, x, y) {
          ctx.beginPath();
          ctx.moveTo(x + 4, y + 4);
          ctx.lineTo(x + 156, y + 4);
          ctx.lineTo(x + 80, y + 136);
          ctx.closePath();
          ctx.fillStyle = "#c8102e";
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(x + 28, y + 18);
          ctx.lineTo(x + 132, y + 18);
          ctx.lineTo(x + 80, y + 108);
          ctx.closePath();
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.fillStyle = "#111";
          ctx.textAlign = "center";
          ctx.font = `bold 20px ${FONT}`;
          ctx.fillText("GIVE", x + 80, y + 46);
          ctx.fillText("WAY", x + 80, y + 68);
        },
      };
    case "warning":
      return {
        w: 160, h: 160, draw(ctx, x, y) {
          ctx.beginPath();
          ctx.moveTo(x + 80, y + 2);
          ctx.lineTo(x + 158, y + 80);
          ctx.lineTo(x + 80, y + 158);
          ctx.lineTo(x + 2, y + 80);
          ctx.closePath();
          ctx.fillStyle = "#f6c700";
          ctx.fill();
          ctx.strokeStyle = "#111";
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.strokeStyle = "#111";
          ctx.fillStyle = "#111";
          ctx.lineWidth = 12;
          ctx.lineCap = "round";
          ctx.beginPath();
          if (/curve-left|turn-left|winding/.test(text)) {
            ctx.moveTo(x + 92, y + 118);
            ctx.quadraticCurveTo(x + 92, y + 66, x + 62, y + 56);
          } else if (/curve-right|turn-right/.test(text)) {
            ctx.moveTo(x + 68, y + 118);
            ctx.quadraticCurveTo(x + 68, y + 66, x + 98, y + 56);
          } else if (/crossroads|intersection/.test(text)) {
            ctx.moveTo(x + 80, y + 40);
            ctx.lineTo(x + 80, y + 120);
            ctx.moveTo(x + 44, y + 80);
            ctx.lineTo(x + 116, y + 80);
          } else if (/roundabout/.test(text)) {
            ctx.arc(x + 80, y + 84, 24, 0.3, Math.PI * 2 - 0.3);
            ctx.moveTo(x + 104, y + 70);
            ctx.lineTo(x + 108, y + 88);
          } else if (/traffic-signals/.test(text)) {
            ctx.lineWidth = 4;
            ctx.strokeRect(x + 66, y + 42, 28, 76);
            for (const [k, c] of [[0, "#d0201a"], [1, "#f6a700"], [2, "#1b8a3a"]] as const) {
              ctx.save();
              ctx.beginPath();
              ctx.arc(x + 80, y + 56 + k * 24, 9, 0, Math.PI * 2);
              ctx.fillStyle = c;
              ctx.fill();
              ctx.restore();
            }
            ctx.beginPath();
          } else if (/pedestrian/.test(text)) {
            ctx.arc(x + 80, y + 50, 8, 0, Math.PI * 2);
            ctx.moveTo(x + 80, y + 62);
            ctx.lineTo(x + 76, y + 96);
            ctx.lineTo(x + 64, y + 120);
            ctx.moveTo(x + 76, y + 96);
            ctx.lineTo(x + 94, y + 120);
          } else {
            ctx.moveTo(x + 80, y + 46);
            ctx.lineTo(x + 80, y + 96);
            ctx.moveTo(x + 80, y + 116);
            ctx.lineTo(x + 80, y + 118);
          }
          ctx.stroke();
        },
      };
    case "chevron":
      return {
        w: 128, h: 160, draw(ctx, x, y) {
          // Chevron alignment marker: black chevron on yellow.
          ctx.fillStyle = "#f6c700";
          ctx.fillRect(x, y, 128, 160);
          ctx.strokeStyle = "#111";
          ctx.lineWidth = 26;
          ctx.lineJoin = "miter";
          ctx.beginPath();
          const d = text === "left" ? -1 : 1;
          ctx.moveTo(x + 64 - d * 30, y + 30);
          ctx.lineTo(x + 64 + d * 26, y + 80);
          ctx.lineTo(x + 64 - d * 30, y + 130);
          ctx.stroke();
        },
      };
    case "noentry":
      return {
        w: 160, h: 160, draw(ctx, x, y) {
          ctx.beginPath();
          ctx.arc(x + 80, y + 80, 76, 0, Math.PI * 2);
          ctx.fillStyle = "#c8102e";
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.fillRect(x + 28, y + 68, 104, 24);
        },
      };
    case "keepleft":
      return {
        w: 128, h: 160, draw(ctx, x, y) {
          ctx.fillStyle = "#fff";
          roundRect(ctx, x + 2, y + 2, 124, 156, 10);
          ctx.fill();
          ctx.strokeStyle = "#111";
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.strokeStyle = "#111";
          ctx.lineWidth = 14;
          ctx.beginPath();
          ctx.moveTo(x + 84, y + 40);
          ctx.lineTo(x + 44, y + 110);
          ctx.moveTo(x + 44, y + 110);
          ctx.lineTo(x + 44, y + 80);
          ctx.moveTo(x + 44, y + 110);
          ctx.lineTo(x + 72, y + 106);
          ctx.stroke();
        },
      };
    case "bus":
      return {
        w: 128, h: 160, draw(ctx, x, y) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(x, y, 128, 160);
          ctx.fillStyle = "#1c3f94";
          ctx.fillRect(x + 6, y + 6, 116, 148);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `bold 40px ${FONT}`;
          ctx.fillText("BUS", x + 64, y + 56);
          ctx.font = `bold 30px ${FONT}`;
          ctx.fillText("STOP", x + 64, y + 104);
        },
      };
    case "info":
      return {
        w: 160, h: 160, draw(ctx, x, y) {
          ctx.fillStyle = "#1c3f94";
          roundRect(ctx, x + 2, y + 2, 156, 156, 12);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          fitText(ctx, text || "i", "bold", 60, 140);
          ctx.fillText(text || "i", x + 80, y + 82);
        },
      };
    case "gate": {
      // START: white on green. FINISH: chequered band with the word on black.
      const finish = text === "FINISH";
      return {
        w: 480, h: 150, draw(ctx, x, y) {
          ctx.fillStyle = finish ? "#111" : "#1d7a3a";
          ctx.fillRect(x, y, 480, 150);
          if (finish) {
            for (let c = 0; c < 24; c++) {
              for (let r = 0; r < 2; r++) {
                ctx.fillStyle = (c + r) % 2 ? "#111" : "#f4f4f4";
                ctx.fillRect(x + c * 20, y + r * 20, 20, 20);
                ctx.fillRect(x + c * 20, y + 110 + r * 20, 20, 20);
              }
            }
          }
          ctx.strokeStyle = "#f4f4f4";
          ctx.lineWidth = 6;
          ctx.strokeRect(x + 3, y + 3, 474, 144);
          ctx.fillStyle = "#f4f4f4";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          fitText(ctx, text, "bold", finish ? 60 : 90, 420);
          ctx.fillText(text, x + 240, y + 77);
        },
      };
    }
    case "banner": {
      // A sponsor banner: the name across a band of its colour, a thin border.
      const w = 768, h = 128;
      return {
        w, h, draw(ctx, x, y) {
          ctx.fillStyle = req.colour ?? "#c8102e";
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = req.ink ?? "#fff";
          ctx.fillRect(x, y + h - 10, w, 4);
          ctx.fillRect(x, y + 6, w, 4);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const t = text.toUpperCase();
          const size = fitText(ctx, t, "italic bold", 88, w - 60);
          ctx.font = `italic bold ${size}px ${FONT}`;
          ctx.fillText(t, x + w / 2, y + h / 2 + 3);
        },
      };
    }
    case "feather": {
      // A feather flag: rounded top, the name running up it.
      const w = 128, h = 448;
      return {
        w, h, draw(ctx, x, y) {
          ctx.beginPath();
          ctx.moveTo(x + 6, y + h);
          ctx.lineTo(x + 6, y + 70);
          ctx.quadraticCurveTo(x + 10, y + 4, x + w - 4, y + 10);
          ctx.lineTo(x + w - 18, y + h - 30);
          ctx.closePath();
          ctx.fillStyle = req.colour ?? "#c8102e";
          ctx.fill();
          ctx.save();
          ctx.translate(x + w / 2 - 2, y + h / 2 + 20);
          ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = req.ink ?? "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const t = text.toUpperCase();
          const size = fitText(ctx, t, "italic bold", 56, h - 120);
          ctx.font = `italic bold ${size}px ${FONT}`;
          ctx.fillText(t, 0, 0);
          ctx.restore();
        },
      };
    }
    case "lights": {
      const w = 320, h = 128;
      return {
        w, h, draw(ctx, x, y) {
          ctx.fillStyle = "#111";
          roundRect(ctx, x, y, w, h, 10);
          ctx.fill();
          for (let r = 0; r < 2; r++) {
            for (let i = 0; i < 5; i++) {
              ctx.beginPath();
              ctx.arc(x + 40 + i * 60, y + 36 + r * 56, 22, 0, Math.PI * 2);
              ctx.fillStyle = r === 0 ? "#e0261b" : "#3a0d0b";
              ctx.fill();
            }
          }
        },
      };
    }
    case "flag": {
      const w = 160, h = 112;
      const colours: Record<string, string> = { yellow: "#f4d000", green: "#1f9a3a", blue: "#1f4fbf" };
      return {
        w, h, draw(ctx, x, y) {
          if (text === "chequered") {
            for (let c = 0; c < 8; c++) {
              for (let r = 0; r < 6; r++) {
                ctx.fillStyle = (c + r) % 2 ? "#111" : "#f4f4f4";
                ctx.fillRect(x + c * 20, y + r * 18.67, 20, 18.67);
              }
            }
            return;
          }
          ctx.fillStyle = colours[text] ?? "#f4d000";
          ctx.fillRect(x, y, w, h);
          if (text === "blue") {
            ctx.fillStyle = "#f4d000";
            ctx.beginPath();
            ctx.moveTo(x, y + h * 0.7);
            ctx.lineTo(x + w, y + h * 0.2);
            ctx.lineTo(x + w, y + h * 0.4);
            ctx.lineTo(x, y + h * 0.9);
            ctx.fill();
          }
        },
      };
    }
    case "back":
      return {
        w: 32, h: 32, draw(ctx, x, y) {
          ctx.fillStyle = "#9a9ea3";
          ctx.fillRect(x, y, 32, 32);
        },
      };
  }
}

/** Shelf-packs every request into one atlas and returns it as PNG. */
export async function renderArt(items: ArtRequest[]): Promise<ArtAtlas> {
  const measure = new OffscreenCanvas(8, 8).getContext("2d")!;
  const boxes = items.map((r) => ({ r, b: boxFor(r, measure) }));
  // Tallest first packs tighter.
  boxes.sort((a, b) => b.b.h - a.b.h);
  const placed: { r: ArtRequest; b: Box; x: number; y: number }[] = [];
  let x = 4, y = 4, row = 0;
  for (const it of boxes) {
    if (x + it.b.w + 4 > ATLAS_W) {
      x = 4;
      y += row + 6;
      row = 0;
    }
    placed.push({ ...it, x, y });
    x += it.b.w + 6;
    row = Math.max(row, it.b.h);
  }
  let height = 64;
  while (height < y + row + 4) height *= 2;
  const canvas = new OffscreenCanvas(ATLAS_W, height);
  const ctx = canvas.getContext("2d")!;
  const cells: Record<string, ArtCell> = {};
  for (const p of placed) {
    ctx.save();
    p.b.draw(ctx, p.x, p.y);
    ctx.restore();
    // Half a pixel in, so filtering doesn't bleed the neighbours in.
    cells[p.r.key] = {
      u0: (p.x + 0.5) / ATLAS_W, u1: (p.x + p.b.w - 0.5) / ATLAS_W,
      v0: (p.y + 0.5) / height, v1: (p.y + p.b.h - 0.5) / height,
      aspect: p.b.w / p.b.h,
    };
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { data: new Uint8Array(await blob.arrayBuffer()), cells, canvas } as ArtAtlas & { canvas: OffscreenCanvas };
}
