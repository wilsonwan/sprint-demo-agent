// HTML for each slide at 1920×1080, modelled on the reference demo: a title card, a
// "what this demo proves" agenda, a step slide per feature with the recording inset,
// and a closing card. Every slide shares the top bar and the footer.

export const SLIDE = { width: 1920, height: 1080 };
// Where ffmpeg overlays a step's clip (16:9, matching the 1280×720 recording).
export const INSET = { x: 256, y: 222, width: 1408, height: 792 };

export type Card = { title: string; text: string };
export type Slide =
  | { kind: 'title'; title: string; summary: string; tags: string[]; stats: { value: string; label: string }[] }
  | { kind: 'proves'; subtitle: string; cards: Card[]; outcome: string }
  | { kind: 'step'; title: string; subtitle: string }
  | { kind: 'close'; message: string; delivered: string; next: string; value: string };

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const css = `
  * { box-sizing: border-box; margin: 0; }
  body { width: ${SLIDE.width}px; height: ${SLIDE.height}px; overflow: hidden; position: relative;
    font-family: Inter, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif; color: #0b2a3c; background: #fff; }
  body.dark { background: #062a3e; color: #fff; }
  .bar { position: absolute; inset: 0 0 auto 0; height: 18px; background: linear-gradient(90deg, #2459e0 81%, #16c463 81%); }
  .footer { position: absolute; left: 80px; right: 80px; bottom: 26px; display: flex; justify-content: space-between;
    font-size: 18px; color: #8a99a6; }
  .dark .footer { color: #6f8798; }
  h1 { font-size: 64px; font-weight: 800; letter-spacing: -0.5px; }
  .sub { font-size: 30px; color: #2c4757; margin-top: 18px; }
  .dark .sub { color: #d5e1ea; }

  .title { position: absolute; left: 120px; top: 250px; width: 1100px; }
  .title h1 { font-size: 80px; }
  .tags { display: flex; gap: 20px; margin-top: 56px; }
  .tag { padding: 14px 40px; border-radius: 8px; font-size: 24px; font-weight: 700; background: #2459e0; }
  .tag:nth-child(2n) { background: #79a6f0; }
  .stats { position: absolute; right: 140px; top: 180px; width: 400px; height: 510px; border-radius: 10px;
    background: #2459e0; border: 2px solid #4f7ee8; display: flex; flex-direction: column; justify-content: space-evenly; text-align: center; }
  .stat b { display: block; font-size: 88px; line-height: 1; }
  .stat:nth-child(2) b { color: #a9c3f5; }
  .stat span { display: block; margin-top: 18px; font-size: 26px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }

  .head { position: absolute; left: 96px; top: 64px; right: 96px; }
  .head h1 { font-size: 60px; }
  .head .sub { font-size: 28px; margin-top: 14px; }
  .cards { position: absolute; left: 96px; right: 96px; top: 300px; display: flex; gap: 36px; }
  .card { flex: 1; min-height: 360px; padding: 36px; border-left: 8px solid #2459e0; background: #f6f8fb;
    box-shadow: 0 1px 4px #0b2a3c22; }
  .card h2 { font-size: 32px; margin-bottom: 120px; }
  .card p { font-size: 26px; line-height: 1.4; color: #2c4757; }
  .outcome { position: absolute; left: 96px; right: 96px; top: 760px; text-align: center; font-size: 32px; font-weight: 700; }

  .inset { position: absolute; left: ${INSET.x}px; top: ${INSET.y}px; width: ${INSET.width}px; height: ${INSET.height}px;
    background: #eef2f6; box-shadow: 0 2px 14px #0b2a3c33; border-radius: 6px; }

  .message { position: absolute; left: 96px; right: 96px; top: 230px; height: 230px; padding: 0 120px; border-radius: 10px;
    background: #062a3e; color: #fff; display: flex; align-items: center; justify-content: center; text-align: center;
    font-size: 44px; font-weight: 700; line-height: 1.3; }
  .close-cards { position: absolute; left: 96px; right: 96px; top: 540px; display: flex; gap: 40px; }
  .close-cards .card { min-height: 240px; }
  .close-cards .card h2 { margin-bottom: 40px; }
  .close-cards .card:nth-child(1) { border-color: #16c463; }
`;

function body(slide: Slide) {
  switch (slide.kind) {
    case 'title':
      return `<div class="title"><h1>${esc(slide.title)}</h1><div class="sub">${esc(slide.summary)}</div>
        <div class="tags">${slide.tags.map((t) => `<div class="tag">${esc(t)}</div>`).join('')}</div></div>
        ${slide.stats.length ? `<div class="stats">${slide.stats.map((s) => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}</div>` : ''}`;
    case 'proves':
      return `<div class="head"><h1>What this demo proves</h1><div class="sub">${esc(slide.subtitle)}</div></div>
        <div class="cards">${slide.cards.map((c, i) => `<div class="card"><h2>${i + 1}. ${esc(c.title)}</h2><p>${esc(c.text)}</p></div>`).join('')}</div>
        <div class="outcome">${esc(slide.outcome)}</div>`;
    case 'step':
      return `<div class="head"><h1>${esc(slide.title)}</h1><div class="sub">${esc(slide.subtitle)}</div></div><div class="inset"></div>`;
    case 'close':
      return `<div class="head"><h1>Close</h1></div><div class="message">${esc(slide.message)}</div>
        <div class="close-cards">${[['Delivered now', slide.delivered], ['Next evolution', slide.next], ['Business value', slide.value]]
          .map(([h, p]) => `<div class="card"><h2>${esc(h)}</h2><p>${esc(p)}</p></div>`).join('')}</div>`;
  }
}

export function slideHtml(slide: Slide, footer: string, page: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
    <body class="${slide.kind === 'title' ? 'dark' : ''}"><div class="bar"></div>${body(slide)}
    <div class="footer"><span>${esc(footer)}</span><span>${page}</span></div></body></html>`;
}
