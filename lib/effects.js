'use strict';
// Hiệu ứng phủ lên từng cảnh (chạy bằng FFmpeg, không cần file ngoài).
// Các lớp hạt/vệt được tạo một lần (1 khung) rồi cuộn theo thời gian -> nhẹ khi render.

const EFFECTS = {
  fire: { label: 'Lửa bập bùng', icon: '🔥', hint: 'ánh lửa chập chờn + tàn lửa bay lên tại vị trí đống lửa / đuốc / đèn' },
  rain: { label: 'Mưa rơi', icon: '🌧', hint: 'vệt mưa rơi, cảnh hơi tối lạnh' },
  snow: { label: 'Tuyết rơi', icon: '❄️', hint: 'bông tuyết rơi chậm, đung đưa' },
  fog: { label: 'Sương mù trôi', icon: '🌫', hint: 'màn sương mỏng trôi ngang' },
  dust: { label: 'Hạt lơ lửng', icon: '✨', hint: 'bụi / đom đóm lấp lánh bay chậm' },
  lightning: { label: 'Chớp sáng', icon: '⚡', hint: 'loé sáng như sét đánh' },
  grain: { label: 'Phim cũ', icon: '📽', hint: 'nhiễu hạt + viền tối' },
};
const IDS = Object.keys(EFFECTS);

/** Chuẩn hoá dữ liệu hiệu ứng của một ảnh từ form / AI. */
function normalizeFx(fx) {
  if (!fx || typeof fx !== 'object') return null;
  const effects = [...new Set((Array.isArray(fx.effects) ? fx.effects : []).filter((e) => IDS.includes(e)))].slice(0, 5);
  const fire = (Array.isArray(fx.fire) ? fx.fire : [])
    .map((p) => ({ x: Number(p?.x), y: Number(p?.y) }))
    .filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
    .slice(0, 3)
    .map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
  const out = { effects, fire };
  if (fx.ai && typeof fx.ai === 'object') {
    out.ai = { provider: String(fx.ai.provider || '').slice(0, 20), model: String(fx.ai.model || '').slice(0, 80), reason: String(fx.ai.reason || '').slice(0, 300) };
    if (fx.ai.desc) out.ai.desc = String(fx.ai.desc).slice(0, 300);
  }
  return effects.length || fire.length || out.ai ? out : null;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Lớp hạt tĩnh (RGBA) kích thước w x h, lặp vô hạn.
 * density: tỉ lệ ô sáng; cell: [cw, ch] độ phóng của mỗi hạt (kéo dài theo chiều dọc = vệt mưa).
 */
let seedN = 0;
// băm theo toạ độ kiểu shader -> phân bố đều, không lặp thành cột như random() của geq
const hash = (seed) => `mod(abs(sin(X*12.9898+Y*78.233+${seed})*43758.5453),1)`;

function particleLayer(label, { w, h, fps, density, cell = [1, 1], blur = 0, color = 'white', alpha = 1, flags = 'bilinear' }) {
  const sw = Math.max(2, Math.round(w / cell[0]));
  const sh = Math.max(2, Math.round(h / cell[1]));
  let g = `color=black:s=${sw}x${sh}:r=${fps},format=gray,geq=lum='if(lt(${hash(++seedN * 7.31)},${density}),255,0)',trim=end_frame=1`;
  g += `,scale=${w}:${h}:flags=${flags}`;
  if (blur) g += `,gblur=sigma=${blur}`;
  if (alpha !== 1) g += `,lut=c0='val*${alpha}'`;
  g += `,loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB[${label}g];`;
  g += `color=c=${color}:s=${w}x${h}:r=${fps}[${label}c];[${label}c][${label}g]alphamerge[${label}]`;
  return g;
}

/** Lớp sương: nhiễu thô phóng to rất mờ, ghép gương để cuộn ngang không lộ đường nối. */
function fogLayer(label, { w, h, fps, alpha }) {
  const sw = Math.max(4, Math.round(w / 48));
  const sh = Math.max(4, Math.round(h / 48));
  let g = `color=black:s=${sw}x${sh}:r=${fps},format=gray,geq=lum='255*${hash(++seedN * 7.31)}',trim=end_frame=1,scale=${w}:${h}:flags=bicubic,gblur=sigma=${Math.round(h / 40)}`;
  g += `,lut=c0='clip((val-90)*1.6,0,255)*${alpha}',split[${label}a][${label}b];[${label}b]hflip[${label}f];[${label}a][${label}f]hstack`;
  g += `,loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB[${label}g];`;
  g += `color=c=0xe8edf2:s=${w * 2}x${h}:r=${fps}[${label}c];[${label}c][${label}g]alphamerge[${label}]`;
  return g;
}

/** Cuộn lớp dọc (dy>0: rơi xuống, dy<0: bay lên) bằng cách ghép đôi rồi cắt khung chạy. */
function scrollV(src, out, { w, h, speed }) {
  // cửa sổ đi lên -> nội dung rơi xuống
  const y = speed > 0 ? `${h}-mod(t*${speed},${h})` : `mod(t*${-speed},${h})`;
  return `[${src}]split[${out}a][${out}b];[${out}a][${out}b]vstack,crop=${w}:${h}:0:'${y}'[${out}]`;
}

/**
 * Chuỗi filter hiệu ứng cho một cảnh.
 * fires: [{ X, Y }] là biểu thức toạ độ khung hình (có thể phụ thuộc t) của từng đống lửa.
 * Trả về đoạn filtergraph đọc [inLabel] và ghi [outLabel].
 */
function effectChain({ W, H, fps, effects, fires, inLabel, outLabel }) {
  const on = new Set(effects);
  const parts = [];
  let cur = inLabel;
  let n = 0;
  const next = () => `fx${n++}`;
  const chain = (f) => {
    const o = next();
    parts.push(`[${cur}]${f}[${o}]`);
    cur = o;
  };
  const over = (layer, x = '0', y = '0') => {
    const o = next();
    parts.push(`[${cur}][${layer}]overlay=x='${x}':y='${y}':format=auto:eof_action=repeat[${o}]`);
    cur = o;
  };
  const m = Math.min(W, H);

  if (on.has('rain')) chain(`eq=brightness=-0.05:saturation=0.82,colorbalance=bs=0.05:bm=0.03`);
  if (on.has('snow')) chain(`colorbalance=bs=0.04:bm=0.02`);
  if (on.has('fire')) chain(`colorbalance=rm=0.05:gm=0.01:bm=-0.05,eq=brightness='0.018*sin(t*12.7)+0.012*sin(t*5.3)+0.008*sin(t*31)':eval=frame`);
  if (on.has('lightning')) {
    const p = 'mod(t+1.1,5.3)';
    chain(`eq=brightness='if(lt(${p},0.09),0.42,if(between(${p},0.17,0.24),0.28,0))':eval=frame`);
  }

  if (on.has('fog')) {
    const L = next();
    parts.push(fogLayer(L, { w: W, h: H, fps, alpha: 0.38 }));
    const S = next();
    parts.push(`[${L}]crop=${W}:${H}:x='mod(t*${Math.round(W * 0.03)},${W})':y=0[${S}]`);
    over(S);
  }
  if (on.has('rain')) {
    const L1 = next();
    parts.push(particleLayer(L1, { w: W, h: H, fps, density: 0.06, cell: [3, 28], blur: 0.6, color: '0xdde6f0', alpha: 0.5, flags: 'neighbor' }));
    const S1 = next();
    parts.push(scrollV(L1, S1, { w: W, h: H, speed: Math.round(H * 1.7) }));
    over(S1);
    const L2 = next();
    parts.push(particleLayer(L2, { w: W, h: H, fps, density: 0.04, cell: [2, 16], blur: 0.4, color: '0xc8d4e2', alpha: 0.3, flags: 'neighbor' }));
    const S2 = next();
    parts.push(scrollV(L2, S2, { w: W, h: H, speed: Math.round(H * 1.15) }));
    over(S2);
  }
  if (on.has('snow')) {
    const L1 = next();
    parts.push(particleLayer(L1, { w: W, h: H, fps, density: 0.012, cell: [Math.max(4, Math.round(m / 140)), Math.max(4, Math.round(m / 140))], blur: 1.4, alpha: 0.95 }));
    const S1 = next();
    parts.push(scrollV(L1, S1, { w: W, h: H, speed: Math.round(H * 0.11) }));
    over(S1, `${Math.round(W * 0.006)}*sin(t*0.9)`);
    const L2 = next();
    parts.push(particleLayer(L2, { w: W, h: H, fps, density: 0.006, cell: [Math.max(3, Math.round(m / 300)), Math.max(3, Math.round(m / 300))], blur: 0.8, alpha: 0.7 }));
    const S2 = next();
    parts.push(scrollV(L2, S2, { w: W, h: H, speed: Math.round(H * 0.18) }));
    over(S2, `${Math.round(W * 0.004)}*sin(t*1.4+1)`);
  }
  if (on.has('fire')) {
    const pts = fires.length ? fires : [{ X: String(Math.round(W / 2)), Y: String(Math.round(H * 0.75)) }];
    pts.forEach((p, i) => {
      // vầng sáng cam chập chờn quanh đống lửa
      const R = even(m * 0.3) / 2;
      const G = next();
      parts.push(
        `color=c=black@0:s=${R * 2}x${R * 2}:r=${fps},format=rgba,geq=r=255:g=150:b=60:a='200*pow(max(0,1-hypot(X-${R},Y-${R})/${R}),2.2)*(0.78+0.22*sin(T*11+${i})*sin(T*3.7))'[${G}]`,
      );
      over(G, `(${p.X})-${R}`, `(${p.Y})-${R}`);
      // tàn lửa bay lên
      const ew = even(m * 0.34);
      const eh = even(m * 0.55);
      const E = next();
      parts.push(particleLayer(E, { w: ew, h: eh, fps, density: 0.02, cell: [Math.max(3, Math.round(m / 240)), Math.max(3, Math.round(m / 240))], blur: 0.6, color: '0xffc060', alpha: 1 }));
      const ES = next();
      parts.push(scrollV(E, ES, { w: ew, h: eh, speed: -Math.round(m * 0.16) }));
      over(ES, `(${p.X})-${ew / 2}+${Math.round(m * 0.012)}*sin(t*1.7+${i})`, `(${p.Y})-${eh}+${Math.round(m * 0.03)}`);
    });
  }
  if (on.has('dust')) {
    const L = next();
    parts.push(particleLayer(L, { w: W, h: H, fps, density: 0.004, cell: [Math.max(2, Math.round(m / 260)), Math.max(2, Math.round(m / 260))], blur: 0.9, color: '0xfff2c8', alpha: 0.85 }));
    const S = next();
    parts.push(scrollV(L, S, { w: W, h: H, speed: -Math.round(H * 0.03) }));
    over(S, `${Math.round(W * 0.01)}*sin(t*0.6)`);
  }
  if (on.has('grain')) chain(`noise=alls=10:allf=t,vignette=PI/4.5`);

  if (!parts.length) return { graph: '', out: inLabel };
  parts.push(`[${cur}]null[${outLabel}]`);
  return { graph: parts.join(';'), out: outLabel };
}

module.exports = { EFFECTS, IDS, normalizeFx, effectChain };
