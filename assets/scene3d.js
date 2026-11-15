'use strict';
/* =====================================================================================================
   assets/scene3d.js — сцена «Раскраски» на three.js (vendor/three.js, 0.185.1).

   Сцена ничего не знает о правилах: оболочка (index.html) каждый кадр называет, что и где нарисовать
   («плитка тут, капля там»), сцена рисует. Всё массовое — инстансы, по одному вызову отрисовки на вид:
     плитки   — клетки картинки: незакрашенная (выпуклая, светлая, с меткой цвета по центру) и готовый пиксель
                (плоский, целиком своего цвета): один меш, свой шейдер;
     капли    — летящая краска, брызги, конфетти победы (шарики, вытянутые по ходу);
     тюбики-перевозчики — тело (форму считает шейдер), контур, крышка, рулончик: по мешу на часть, на все тюбики сразу;
     тени     — пятна под плитками, перевозчиками, каплями;
     гнёзда   — шестиугольные клетки холста и круглые места на прилавке.

   Цвета — чистые и плоские: лицо плитки и пиксель не затеняются вовсе, объём дают только фаски и бока
   («тун» в три ступени). Цвета приходят как sRGB и уходят в кадр без пересчёта.
   Мир: X вправо, Y вверх, Z на зрителя; гекс радиуса 1 (плоской стороной вверх), сосед на √3.
   Камера орто, наклон CFG.camPitchDeg.
   ===================================================================================================== */
const R3 = (function(){
const T = window.THREE;
const R = { ready: false };
let renderer = null, scene = null, camera = null;
let SP = 0.766, CP = 0.643;                      // sin/cos наклона камеры
const view = { cx: 0, cy: 0, half: 10, W: 1, H: 1, k: 20, left: 0, top: 0 };   // текущий ортобокс и размер холста в CSS px
const baseView = { cx: 0, cy: 0, hw: 10, hh: 10 };            // кадр уровня
const focusView = { cx: 0, cy: 0, hw: 5, hh: 6 };             // крупный план (финал: наезд на картинку; R3.look для съёмки)
const LIGHT = new T.Vector3(-0.5, 0.82, 0.2).normalize();     // направление НА свет (сверху-слева, чуть от зрителя)
const U = { uL: { value: LIGHT }, uV: { value: new T.Vector3(0, SP, CP) } };

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function rgb(hex){ const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }
const v3 = (hex) => new T.Vector3(...rgb(hex));

// ------------------------------------------------------------------ общий тун-свет
const GLSL_TOON = `
uniform vec3 uL; uniform vec3 uV;
vec3 toon(vec3 base, vec3 N, float specAmt){
  float ndl = dot(N, uL) * 0.5 + 0.5;
  float ramp = smoothstep(0.34, 0.40, ndl) * 0.55 + smoothstep(0.66, 0.72, ndl) * 0.45;
  vec3 dark = mix(base * base, base * 0.55, 0.4) * vec3(0.92, 0.90, 1.08);      // тень насыщеннее и холоднее, а не серее
  vec3 col = mix(dark, base, ramp);
  float sp = pow(max(dot(N, normalize(uL + uV)), 0.0), 30.0);
  col += specAmt * smoothstep(0.25, 0.38, sp) * vec3(1.0, 0.98, 0.9);
  return col;
}`;
// Расстояние в «шестиугольной» метрике: 0 в центре, 1 на кромке гекса единичного радиуса (плоские стороны сверху и снизу).
const GLSL_HEX = `
float hexd(vec2 p){ p = abs(p); return max(p.y, p.x * 0.8660254 + p.y * 0.5) / 0.8660254; }`;

// ------------------------------------------------------------------ плитка
// Контур шестиугольника радиуса Rv (вершины на оси X) со скруглёнными углами: точки и внешние нормали по кругу.
function hexOutline(Rv, round, seg){
  const out = [];
  for (let k = 0; k < 6; k++){
    const a0 = k * Math.PI / 3, cr = Rv - round / Math.cos(Math.PI / 6), cx = Math.cos(a0) * cr, cz = Math.sin(a0) * cr;
    for (let s = 0; s <= seg; s++){ const a = a0 + (s / seg - 0.5) * Math.PI / 3; out.push([cx + Math.cos(a) * round, cz + Math.sin(a) * round, Math.cos(a), Math.sin(a)]); }
  }
  out.push(out[0]);
  return out;
}
// Геометрия плитки: призма по контуру, две фаски; нормали лица строго вверх/вниз (по ним шейдер отличает лицо, изнанку и бок).
// Центр в нуле, высота H (от −H/2 до H/2), b — фаска.
function tileGeometry(Rv, H, b, round){
  const O = hexOutline(Rv, round, 4), n = O.length - 1, pos = [], nor = [], idx = [], h = H / 2, K = Math.SQRT1_2;
  const ring = (inset, y, nk, ny) => { const s = pos.length / 3; for (const p of O){ pos.push(p[0] - p[2] * inset, y, p[1] - p[3] * inset); nor.push(p[2] * nk, ny, p[3] * nk); } return s; };
  const strip = (u, l) => { for (let i = 0; i < n; i++) idx.push(u + i, u + i + 1, l + i, u + i + 1, l + i + 1, l + i); };
  const tc = pos.length / 3; pos.push(0, h, 0); nor.push(0, 1, 0);
  const t1 = ring(b, h, 0, 1); for (let i = 0; i < n; i++) idx.push(tc, t1 + i + 1, t1 + i);
  strip(ring(b, h, K, K), ring(0, h - b, K, K));
  strip(ring(0, h - b, 1, 0), ring(0, -h + b, 1, 0));
  strip(ring(0, -h + b, K, -K), ring(b, -h, K, -K));
  const bc = pos.length / 3; pos.push(0, -h, 0); nor.push(0, -1, 0);
  const b1 = ring(b, -h, 0, -1); for (let i = 0; i < n; i++) idx.push(bc, b1 + i, b1 + i + 1);
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
  return g;
}
// Плитка-заготовка: лицо — основа (бумага или высохший прошлый слой), по центру клякса текущего слоя (радиус растёт с каждой каплей),
// у кромки — полоски следующих слоёв (ближняя к центру — следующий, крайняя — последний). Изнанка — цвет пикселя картинки.
// Готовый пиксель (mode = 1): лицо целиком своего цвета, бока — он же в тени.
const TILE_VS = `
attribute vec4 aFace; attribute vec4 aBlob; attribute vec4 aRim1; attribute vec4 aRim2; attribute vec4 aBack;
varying vec3 vN; varying vec3 vLP; varying vec3 vLN; varying vec4 vFace; varying vec4 vBlob; varying vec4 vRim1; varying vec4 vRim2; varying vec4 vBack; varying float vSeed; varying vec2 vC;
void main(){
  mat3 im = mat3(instanceMatrix); vC = instanceMatrix[3].xz;
  vN = normalize(im * normal); vLP = position; vLN = normal;
  vFace = aFace; vBlob = aBlob; vRim1 = aRim1; vRim2 = aRim2; vBack = aBack;
  vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(position, 1.0));
}`;
const TILE_FS = GLSL_TOON + GLSL_HEX + `
uniform float uR; uniform vec3 uPaper;
varying vec3 vN; varying vec3 vLP; varying vec3 vLN; varying vec4 vFace; varying vec4 vBlob; varying vec4 vRim1; varying vec4 vRim2; varying vec4 vBack; varying float vSeed; varying vec2 vC;
void main(){
  vec3 N = normalize(vN);
  vec2 p = vLP.xz / uR;
  float mode = clamp(vBack.a, 0.0, 1.0), wet = max(vBack.a - 1.0, 0.0);   // 0 — незакрашенная, 1 — готовый пиксель, 2 — «мокрая» краска (вид Б)
  vec3 col;
  if (vBack.a < -0.5 && vLN.y > 0.9){                          // вид В v0.3: лунка в полу — ободок своего цвета, внутри тёмная чаша (свет сверху слева:
    float d = hexd(p), r = length(p);                          //   у вогнутой чаши освещена дальняя, правая нижняя стенка), налив — клякса краски по дну
    vec3 lip = vFace.rgb, inner = vBack.rgb;
    float lit = clamp(dot(p / max(r, 0.001), vec2(0.62, 0.78)), -1.0, 1.0);
    vec3 bowl = inner * (0.78 + 0.32 * lit * smoothstep(0.12, 0.52, r)) * (1.0 - 0.18 * smoothstep(0.35, 0.0, r));
    float onLip = smoothstep(0.5, 0.56, d);
    col = mix(bowl, lip, onLip);
    col = mix(col, vec3(1.0), 0.24 * smoothstep(0.58, 0.64, d) * (1.0 - smoothstep(0.72, 0.82, d)) * clamp(-dot(normalize(p + 1e-4), vec2(0.62, 0.78)), 0.0, 1.0));   // блик на ободке к свету
    col = mix(col, lip * 0.6, smoothstep(0.5, 0.54, d) * (1.0 - smoothstep(0.54, 0.58, d)) * 0.8);   // внутренняя кромка ободка
    float bR = vFace.a;
    if (bR > 0.001){ float rr = r * (1.0 + 0.06 * sin(atan(p.y, p.x) * 3.0 + vSeed * 6.2832)); col = mix(col, mix(vBlob.rgb, vBlob.rgb * 0.8, smoothstep(bR - 0.18, bR, rr)), smoothstep(bR, bR - 0.05, rr)); }
    if (vRim1.a > 0.0) col = mix(col, vRim1.rgb, smoothstep(0.7, 0.8, d) * vRim1.a);   // зажат тюбик / тёмная краска: ободок светлеет
  } else if (vLN.y > 0.9){                                     // лицо
    col = vFace.rgb;
    float bR = vFace.a;
    if (bR > 0.001){                                           // метка цвета (или разливающаяся краска): круг с тёмной кромкой — видно и белую на светлом
      float r = length(p), ang = atan(p.y, p.x);
      float rr = r * (1.0 + 0.05 * sin(ang * 3.0 + vSeed * 6.2832));
      float inB = smoothstep(bR, bR - 0.06, rr);
      vec3 bc = mix(vBlob.rgb, vBlob.rgb * 0.72, smoothstep(bR - 0.2, bR - 0.08, rr) * step(bR, 1.0));
      col = mix(col, bc, inB);
    }
    col += mode * 0.06 * smoothstep(0.35, -0.75, p.x * 0.6 + p.y);     // готовый пиксель: лёгкий глянец к свету
    if (wet > 0.0){                                                       // вид Б: мокрая краска — глянец к свету и короткий блик у левого верхнего края
      col = mix(col, vec3(1.0), wet * 0.1 * smoothstep(0.3, -0.9, p.x * 0.6 + p.y));
      col = mix(col, vec3(1.0), wet * 0.42 * smoothstep(0.3, 0.12, length((p - vec2(-0.32, -0.38)) * vec2(1.0, 1.7))));
    }
    if (vRim1.a > 0.0) col = mix(col, vRim1.rgb, smoothstep(0.8, 0.88, hexd(p)) * vRim1.a);   // светлая кромка: достижимая клетка; тёмный пиксель на тёмном холсте
  } else if (vLN.y < -0.9){
    col = vBack.rgb;
  } else {                                                     // фаски и бока
    vec3 base = vBack.rgb;                                     // бока — полный цвет клетки: у стоящего блока цвет виден и сбоку
    col = toon(base, N, 0.0);
    col = mix(col, base, 0.35);                                // мягче, чем у блестящих предметов: цвет остаётся чистым
    col *= 1.0 - mode * 0.13 - (1.0 - mode) * 0.08;            // кромка чуть темнее: соседние клетки одного цвета не сливаются
  }
  col += vBlob.a * vec3(1.0, 0.98, 0.92);                      // вспышка
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ капли и перевозчики
const DROP_VS = `
attribute vec4 aCol;
varying vec3 vN; varying vec4 vCol;
void main(){ vN = normalize(mat3(instanceMatrix) * normal); vCol = aCol; gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(position, 1.0)); }`;
// Желе: цвет остаётся чистым — мягкая тень снизу-справа, чёткий блик и светлая кромка (без тун-ступеней: на шарике они дают грани).
const DROP_FS = `
uniform vec3 uL; uniform vec3 uV;
varying vec3 vN; varying vec4 vCol;
void main(){
  vec3 N = normalize(vN), base = vCol.rgb;
  float ndl = dot(N, uL) * 0.5 + 0.5;
  vec3 dark = mix(base * base, base * 0.6, 0.5) * vec3(0.94, 0.92, 1.06);
  vec3 col = mix(dark, base, smoothstep(0.18, 0.62, ndl));
  float sp = pow(max(dot(N, normalize(vec3(-0.52, 0.46, 0.72))), 0.0), 26.0);       // блик — круглым пятном на левой щеке, а не штрихом на макушке
  col = mix(col, vec3(1.0), smoothstep(0.42, 0.5, sp) * 0.9);
  col += pow(1.0 - max(dot(N, uV), 0.0), 3.0) * 0.16;
  gl_FragColor = vec4(col + vCol.a, 1.0);
}`;
// Контур: та же геометрия изнанкой, раздвинута по нормали, ровный тёмный цвет.
const OUT_VS = `
attribute vec4 aCol; uniform float uOut;
varying vec4 vCol;
void main(){ vCol = aCol; gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(position + normal * uOut, 1.0)); }`;
const OUT_FS = `varying vec4 vCol; void main(){ gl_FragColor = vec4(vCol.rgb, 1.0); }`;
// ------------------------------------------------------------------ пятна-тени и гнёзда (плоские квадраты, форма — в шейдере)
const QUAD_VS = `
attribute vec4 aQ;                         // x, z, радиус, альфа/состояние
varying vec2 vP; varying float vA;
void main(){ vP = position.xy * 2.0; vA = aQ.w; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(aQ.x + position.x * 2.0 * aQ.z, uY, aQ.y - position.y * 2.0 * aQ.z, 1.0); }`;
const SHADOW_FS = `
uniform vec3 uColor; varying vec2 vP; varying float vA;
void main(){ float d = length(vP); gl_FragColor = vec4(uColor, smoothstep(1.0, 0.25, d) * vA); }`;
// Клетка холста: шестиугольное гнездо — тёмное дно и светлая кромка. vA > 0 — подсветка (клетка вспыхивает).
const CELL_FS = GLSL_HEX + `
uniform vec3 uIn; uniform vec3 uEdge; varying vec2 vP; varying float vA;
void main(){
  float d = hexd(vP); if (d > 1.0) discard;
  vec3 c = mix(uIn, uEdge, smoothstep(0.86, 0.90, d));
  c = mix(c, uEdge * 1.3, vA);
  gl_FragColor = vec4(c, smoothstep(1.0, 0.97, d));
}`;
// Место на прилавке: круглая лунка с тенью у стенки со стороны света.
const SEAT_FS = `
uniform vec3 uIn; uniform vec3 uEdge; varying vec2 vP; varying float vA;
void main(){
  float d = length(vP); if (d > 1.0) discard;
  vec3 c = mix(uIn, uEdge, smoothstep(0.80, 0.90, d));
  gl_FragColor = vec4(c, smoothstep(1.0, 0.96, d));
}`;

// ------------------------------------------------------------------ статика: один материал
const PROP_VS = `
varying vec3 vN;
void main(){ vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PROP_FS = `
uniform vec3 uColor; uniform float uAlpha;
varying vec3 vN;
void main(){ gl_FragColor = vec4(uColor, uAlpha); }`;
function propMat(hex, o = {}){
  return new T.ShaderMaterial({ vertexShader: PROP_VS, fragmentShader: PROP_FS, side: o.side || T.FrontSide, transparent: !!o.transparent, depthWrite: o.depthWrite !== false,
    uniforms: { uColor: { value: typeof hex === 'string' ? v3(hex) : hex }, uAlpha: { value: o.alpha === undefined ? 1 : o.alpha } } });
}
// Шестиугольник с апофемой ap (расстояние до плоской стороны) и скруглением углов; вершины — сверху и снизу, как у поля ядра.
function hexShape(ap, round){
  const Rv = ap / Math.cos(Math.PI / 6), V = [], s = new T.Shape();
  for (let k = 0; k < 6; k++){ const a = Math.PI / 2 + k * Math.PI / 3; V.push([Math.cos(a) * Rv, Math.sin(a) * Rv]); }
  for (let k = 0; k < 6; k++){
    const p = V[(k + 5) % 6], v = V[k], n = V[(k + 1) % 6], l1 = Math.hypot(v[0] - p[0], v[1] - p[1]), l2 = Math.hypot(n[0] - v[0], n[1] - v[1]);
    const a = [v[0] + (p[0] - v[0]) / l1 * round, v[1] + (p[1] - v[1]) / l1 * round], b = [v[0] + (n[0] - v[0]) / l2 * round, v[1] + (n[1] - v[1]) / l2 * round];
    if (k === 0) s.moveTo(a[0], a[1]); else s.lineTo(a[0], a[1]);
    s.quadraticCurveTo(v[0], v[1], b[0], b[1]);
  }
  s.closePath(); return s;
}

// ------------------------------------------------------------------ инстансные буферы
function makeInst(geo, mat, cap, attrs){
  const m = new T.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.instanceMatrix.setUsage(T.DynamicDrawUsage); m.count = 0;
  const out = { mesh: m, n: 0, cap, mx: m.instanceMatrix.array, attrs: [] };
  for (const [name, size] of attrs){ const a = new T.InstancedBufferAttribute(new Float32Array(cap * size), size); a.setUsage(T.DynamicDrawUsage); geo.setAttribute(name, a); out[name] = a; out.attrs.push(a); }
  return out;
}
function flush(b){ b.mesh.count = b.n; b.mesh.instanceMatrix.needsUpdate = true; for (const a of b.attrs) a.needsUpdate = true; }
function makeQuads(fs, uniforms, cap, y){
  const geo = new T.PlaneGeometry(1, 1);
  const mat = new T.ShaderMaterial({ vertexShader: 'uniform float uY;\n' + QUAD_VS, fragmentShader: fs, transparent: true, depthWrite: false,
    uniforms: Object.assign({ uY: { value: y } }, uniforms) });
  const m = new T.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.count = 0;
  const a = new T.InstancedBufferAttribute(new Float32Array(cap * 4), 4); a.setUsage(T.DynamicDrawUsage); geo.setAttribute('aQ', a);
  return { mesh: m, a, n: 0, cap };
}
let tiles, drops, bodies, outlines, caps, capOut, rolls, shadows, cells, seatsQ;

// Тюбик краски — перевозчик. Собран из простых форм (урок мешка: модель в 30 px читается пятном — нужны силуэт, контур и контраст):
//   тело    — параметрическая трубка: у хвоста плоская (обжим с насечкой, металл), к плечу круглая; корпус в цвет краски,
//             сверху белая этикетка (на ней число), плечо металлическое. Форму считает вершинный шейдер по (u, θ) и параметрам экземпляра:
//             скручено с хвоста (r), сплющено (f), сжатие выстрела (p), раздувание перед тем, как лопнуть (b);
//   крышка  — ребристый колпачок на носике (у спящего «?» — золотая пломба, отщёлкивается);
//   рулончик — скрученный хвост: цилиндр поперёк тюбика, на торцах спираль;
//   контур  — изнанка тела и крышки, раздвинутая по нормали: у тёмных красок светлый, у остальных — тёмный.
// Локальные оси: X — от хвоста к носику, Y — вверх, тюбик лежит на столе (низ сечения на y = 0). Длина от хвоста до кончика крышки — 2,55.
const TUBE = { x0: -1.1, len: 1.85, crimp: 0.13, sh: 0.2, axisY: 0.46, capX0: 0.9, capX1: 1.3, capR: 0.22, labelU: 0.58 };
const GLSL_TUBE = `
const float X0 = ${TUBE.x0.toFixed(3)}, LEN = ${TUBE.len.toFixed(3)}, CRIMP = ${TUBE.crimp.toFixed(3)}, SH = ${TUBE.sh.toFixed(3)};
// u: < 0 — обжим хвоста, 0…1 — корпус, 1…1+SH/LEN — плечо к носику. T = (скручено, сплющено, сжатие, раздувание)
vec3 tubeP(float u, float th, vec4 T){
  float ue = max(u, T.x);                                       // скрученная часть стянута в сечение у рулончика
  float x = X0 + ue * LEN;
  float a, b;
  if (ue < 0.0){ a = 0.66; b = 0.035; x = X0 + ue / 0.12 * CRIMP; }
  else if (ue <= 1.0){
    float s = 1.0 - pow(1.0 - min(1.0, ue / 0.62), 2.0);
    a = mix(0.66, 0.46, s); b = mix(0.05, 0.46, s);
    float fl = T.y * (1.0 - smoothstep(0.62, 1.0, ue));       // пустеет — сплющивается (плечо остаётся круглым)
    b *= 1.0 - 0.5 * fl; a *= 1.0 + 0.07 * fl;
    float w = smoothstep(T.x, T.x + 0.32, ue);                  // у рулончика тюбик расплющен
    if (T.x > 0.001){ b *= mix(0.12, 1.0, w); a *= mix(1.05, 1.0, w); }
    float bump = exp(-pow((ue - 0.5) / 0.2, 2.0));              // сжатие пальцами посередине
    b *= 1.0 - 0.42 * T.z * bump; a *= 1.0 + 0.2 * T.z * bump;
    a *= 1.0 + 0.4 * T.w; b *= 1.0 + 0.55 * T.w;
  } else {
    float k = clamp((ue - 1.0) * LEN / SH, 0.0, 1.0);
    x = X0 + LEN + k * SH;
    a = mix(0.46, 0.19, k * k) * (1.0 + 0.25 * T.w); b = a;
  }
  float cy = ue >= 1.0 ? 0.46 : mix(b, 0.46, smoothstep(0.75, 1.0, ue));   // ось: хвост лежит на столе, у плеча — на высоте носика
  return vec3(x, cy + b * sin(th), a * cos(th));
}`;
const TUBE_VS = GLSL_TUBE + `
attribute vec2 aUV; attribute vec4 aT; attribute vec4 aCol; uniform float uOut;
varying vec3 vN; varying vec4 vCol; varying vec2 vUV; varying vec3 vLP;
void main(){
  float u = aUV.x, th = aUV.y;
  vec3 p = tubeP(u, th, aT), pu = tubeP(u + 0.01, th, aT) - tubeP(u - 0.01, th, aT), pt = tubeP(u, th + 0.02, aT) - tubeP(u, th - 0.02, aT);
  vec3 n = cross(pu, pt); float nl = length(n);
  n = nl > 1e-6 ? n / nl : vec3(0.0, sin(th), cos(th));
  if (dot(n, vec3(0.0, sin(th), cos(th))) < 0.0) n = -n;
  vN = normalize(mat3(instanceMatrix) * n); vCol = aCol; vUV = vec2(max(u, aT.x), th); vLP = p;
  gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(p + n * uOut, 1.0));
}`;
// Тело: корпус краски, этикетка сверху, металл на обжиме и плече; мягкая тень, блик, светлая кромка по силуэту (тёмные краски не тонут в фоне).
const TUBE_FS = `
uniform vec3 uL; uniform vec3 uV; uniform vec3 uLabel; uniform vec3 uMetal;
varying vec3 vN; varying vec4 vCol; varying vec2 vUV; varying vec3 vLP;
void main(){
  vec3 N = normalize(vN), base = vCol.rgb; float u = vUV.x, th = vUV.y, spec = 0.6, rimK = 0.2;
  float lum = dot(base, vec3(0.3, 0.59, 0.11));
  if (u < 0.0){ base = uMetal * (0.84 + 0.16 * step(0.5, fract(vLP.x * 34.0))); spec = 1.0; }          // обжим с насечкой
  else if (u > 1.0){ base = uMetal; spec = 1.0; }                                                    // металлическое плечо
  else {
    float lab = smoothstep(0.2, 0.23, u) * smoothstep(0.92, 0.89, u) * smoothstep(1.32, 1.24, abs(th - 1.5708));   // этикетка сверху
    float edge = lab * (1.0 - smoothstep(0.25, 0.28, u) * smoothstep(0.87, 0.84, u) * smoothstep(1.2, 1.12, abs(th - 1.5708)));
    base = mix(base, uLabel, lab); base = mix(base, vCol.rgb * 0.85, edge * 0.9);
    if (lum < 0.3) rimK = 0.42;
  }
  float ndl = dot(N, uL) * 0.5 + 0.5;
  vec3 col = mix(mix(base * base, base * 0.6, 0.5) * vec3(0.94, 0.92, 1.06), base, smoothstep(0.2, 0.62, ndl));
  float sp = pow(max(dot(N, normalize(uL + uV)), 0.0), 16.0);
  col = mix(col, vec3(1.0), smoothstep(0.3, 0.75, sp) * 0.45 * spec);
  col += pow(1.0 - max(dot(N, uV), 0.0), 2.5) * rimK * vec3(0.85, 0.88, 1.0);
  gl_FragColor = vec4(col + vCol.a, 1.0);
}`;
const TUBE_OUT_FS = `varying vec4 vCol; void main(){ gl_FragColor = vec4(vCol.rgb, 1.0); }`;
// Сетка параметров тела: u от обжима до носика, θ по кругу.
function tubeGrid(){
  const us = [];
  for (let i = 0; i <= 3; i++) us.push(-0.12 + i * 0.04);
  for (let i = 1; i <= 26; i++) us.push(i / 26);
  for (let i = 1; i <= 5; i++) us.push(1 + i / 5 * TUBE.sh / TUBE.len);
  const NT = 22, uv = [], idx = [];
  for (const u of us) for (let j = 0; j <= NT; j++) uv.push(u, -Math.PI + j / NT * 2 * Math.PI);
  for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < NT; j++){ const a = i * (NT + 1) + j, b = a + NT + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new T.BufferGeometry();
  g.setAttribute('aUV', new T.Float32BufferAttribute(uv, 2)); g.setAttribute('position', new T.Float32BufferAttribute(new Array(uv.length / 2 * 3).fill(0), 3)); g.setIndex(idx);
  return g;
}
// Крышка: ребристый колпачок вдоль оси X (основание на носике), скруглённый торец.
function tubeCap(){
  const r = TUBE.capR, L = TUBE.capX1 - TUBE.capX0, P = [[0, 0], [r * 0.92, 0], [r, 0.03], [r, L - 0.07], [r * 0.82, L - 0.01], [0, L]];
  const g = new T.LatheGeometry(P.map(p => new T.Vector2(p[0], p[1])), 18); g.computeVertexNormals();
  g.rotateZ(-Math.PI / 2); g.translate(TUBE.capX0, TUBE.axisY, 0); return g;
}
const CAP_FS = `
uniform vec3 uL; uniform vec3 uV;
varying vec3 vN; varying vec4 vCol; varying vec3 vLP;
void main(){
  vec3 N = normalize(vN), base = vCol.rgb;
  float rib = step(0.5, fract(atan(vLP.z, vLP.y - ${TUBE.axisY.toFixed(3)}) * 2.865)) * (1.0 - smoothstep(0.75, 0.9, abs(N.x)));
  base *= 1.0 - 0.1 * rib;
  float ndl = dot(N, uL) * 0.5 + 0.5;
  vec3 col = mix(mix(base * base, base * 0.62, 0.5), base, smoothstep(0.2, 0.62, ndl));
  float sp = pow(max(dot(N, normalize(uL + uV)), 0.0), 26.0);
  col = mix(col, vec3(1.0), smoothstep(0.42, 0.55, sp) * 0.85);
  gl_FragColor = vec4(col + vCol.a, 1.0);
}`;
const LP_VS = `
attribute vec4 aCol; uniform float uOut;
varying vec3 vN; varying vec4 vCol; varying vec3 vLP;
void main(){ vN = normalize(mat3(instanceMatrix) * normal); vCol = aCol; vLP = position; gl_Position = projectionMatrix * viewMatrix * (instanceMatrix * vec4(position + normal * uOut, 1.0)); }`;
// Рулончик: цилиндр (ось — локальная Z), на торцах спираль витков.
const ROLL_FS = `
uniform vec3 uL; uniform vec3 uV;
varying vec3 vN; varying vec4 vCol; varying vec3 vLP;
void main(){
  vec3 N = normalize(vN), base = vCol.rgb;
  if (abs(vLP.z) > 0.49){ float r = length(vLP.xy), a = atan(vLP.y, vLP.x) / 6.2832; base *= 0.72 + 0.28 * smoothstep(0.35, 0.6, abs(fract(r * 3.2 - a) - 0.5) * 2.0); }
  float ndl = dot(N, uL) * 0.5 + 0.5;
  vec3 col = mix(mix(base * base, base * 0.6, 0.5), base, smoothstep(0.2, 0.62, ndl));
  col += pow(1.0 - max(dot(N, uV), 0.0), 2.5) * 0.25;
  gl_FragColor = vec4(col + vCol.a, 1.0);
}`;

// ------------------------------------------------------------------ сборка
R.init = function(canvas){
  renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  scene = new T.Scene();
  camera = new T.OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
  const p = CFG.camPitchDeg * Math.PI / 180; SP = Math.sin(p); CP = Math.cos(p);
  camera.position.set(0, SP * 90, CP * 90); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  U.uV.value.set(0, SP, CP);

  // статика — раскладка Hexa Glide: холст-шестиугольник с клетками, лента вплотную к нему, шевроны хода, места прилавка
  const stat = new T.Group(); scene.add(stat); R.stat = stat;
  const flat = (geo, hex, y) => { const m = new T.Mesh(geo, propMat(hex)); m.rotation.x = -Math.PI / 2; m.position.y = y; return m; };
  R.plates = [flat(new T.ShapeGeometry(hexShape(CFG.trackAp + 0.17, 1.9), 8), css('--track-edge'), -0.08), flat(new T.ShapeGeometry(hexShape(CFG.trackAp, 1.8), 8), css('--track'), -0.07),
              flat(new T.ShapeGeometry(hexShape(CFG.boardAp + 0.16, 1.3), 8), css('--board-edge'), -0.06), flat(new T.ShapeGeometry(hexShape(CFG.boardAp, 1.2), 8), css('--board'), -0.05)];
  stat.add(...R.plates);
  R.slotRings = [];
  for (let i = 0; i < CFG.maxSlots; i++){
    const m = new T.Mesh(new T.RingGeometry(CFG.slotR * 0.97, CFG.slotR * 1.13, 44), propMat(css('--accent'), { transparent: true, alpha: 0, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set((i - (CFG.maxSlots - 1) / 2) * CFG.slotDX, 0.03, CFG.slotZ); stat.add(m); R.slotRings.push(m);
  }
  cells = makeQuads(CELL_FS, { uIn: { value: v3(css('--well')) }, uEdge: { value: v3(css('--well-edge')) } }, 480, 0.0);
  seatsQ = makeQuads(SEAT_FS, { uIn: { value: v3(css('--slot')) }, uEdge: { value: v3(css('--slot-edge')) } }, 16, 0.0);
  scene.add(cells.mesh, seatsQ.mesh);
  // шевроны хода ленты: по одному между клетками, волна яркости бежит по ходу; в разгоне — ярче и быстрее
  { const geo = new T.PlaneGeometry(1, 1), a = new T.InstancedBufferAttribute(new Float32Array(96 * 4), 4); geo.setAttribute('aQ', a);
    const mat = new T.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uColor: { value: v3(css('--chev')) }, uPhase: { value: 0 }, uGlow: { value: 0 }, uS: { value: 0.42 } },
      vertexShader: 'attribute vec4 aQ; uniform float uS; varying vec2 vP; varying float vI; void main(){ float c = cos(aQ.z), s = sin(aQ.z); vec2 p = position.xy * 2.0; vP = p; vI = aQ.w; vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c) * uS; gl_Position = projectionMatrix * viewMatrix * vec4(aQ.x + r.x, -0.04, aQ.y - r.y, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uPhase; uniform float uGlow; varying vec2 vP; varying float vI; void main(){ float d = abs(vP.y - 0.3 + abs(vP.x) * 0.8); float a = smoothstep(0.3, 0.18, d) * smoothstep(1.0, 0.82, abs(vP.x)); float wave = 0.5 + 0.5 * sin(6.2831853 * (vI * 3.0 - uPhase)); gl_FragColor = vec4(mix(uColor, vec3(1.0), wave * uGlow * 0.6), a * mix(0.55, 1.0, wave)); }' });
    const m = new T.InstancedMesh(geo, mat, 96); m.frustumCulled = false; m.count = 0; m.renderOrder = 1; scene.add(m); R.chev = { mesh: m, a }; }
  shadows = makeQuads(SHADOW_FS, { uColor: { value: v3(css('--shadow')) } }, 700, 0.012);
  scene.add(shadows.mesh);
  cells.mesh.renderOrder = 1; seatsQ.mesh.renderOrder = 1; shadows.mesh.renderOrder = 3; for (const m of R.slotRings) m.renderOrder = 2;
  // затемнение поля под финал: тёмная плоскость чуть выше холста — поднятая картинка над ней остаётся яркой
  R.veil = new T.Mesh(new T.PlaneGeometry(80, 120), propMat(css('--veil'), { transparent: true, alpha: 0, depthWrite: false }));
  R.veil.rotation.x = -Math.PI / 2; R.veil.position.set(0, 0.05, 4); R.veil.renderOrder = 4; R.veil.visible = false; scene.add(R.veil);
  // лучи за готовой картинкой: вращающийся веер на плоскости между затемнением и приподнятыми пикселями
  R.rays = new T.Mesh(new T.PlaneGeometry(2, 2), new T.ShaderMaterial({ transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    uniforms: { uColor: { value: v3(css('--accent')) }, uAlpha: { value: 0 }, uRot: { value: 0 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; uniform float uRot; varying vec2 vP; void main(){ float r = length(vP); float a = atan(vP.y, vP.x) + uRot; float ray = smoothstep(-0.1, 0.5, sin(a * 12.0)); float fade = smoothstep(1.0, 0.15, r); gl_FragColor = vec4(uColor, (0.25 + 0.75 * ray) * fade * fade * uAlpha); }' }));
  R.rays.rotation.x = -Math.PI / 2; R.rays.position.y = 0.06; R.rays.renderOrder = 5; R.rays.visible = false; scene.add(R.rays);
  R.colAccent = v3(css('--accent')); R.colDanger = v3(css('--danger')); R.colAmber = v3(css('--amber'));

  // плитки
  const tileMat = new T.ShaderMaterial({ vertexShader: TILE_VS, fragmentShader: TILE_FS,
    uniforms: { uL: U.uL, uV: U.uV, uR: { value: CFG.tileR }, uPaper: { value: v3(css('--paper')) } } });
  tiles = makeInst(tileGeometry(CFG.tileR, CFG.tileH, CFG.tileBevel, CFG.tileRound), tileMat, CFG.maxTiles, [['aFace', 4], ['aBlob', 4], ['aRim1', 4], ['aRim2', 4], ['aBack', 4]]);
  scene.add(tiles.mesh);
  // капли
  drops = makeInst(new T.SphereGeometry(1, 14, 10), new T.ShaderMaterial({ vertexShader: DROP_VS, fragmentShader: DROP_FS, uniforms: { uL: U.uL, uV: U.uV } }), CFG.maxDrops, [['aCol', 4]]);
  scene.add(drops.mesh);
  // перевозчики — тюбики: тело и его контур, крышка и её контур, рулончик скрученного хвоста
  const tubeU = (fs, side, out) => ({ uL: U.uL, uV: U.uV, uOut: { value: out || 0 }, uLabel: { value: v3('#fbf8f0') }, uMetal: { value: v3('#c4cbe0') } });
  const tg = tubeGrid();
  bodies = makeInst(tg, new T.ShaderMaterial({ vertexShader: TUBE_VS, fragmentShader: TUBE_FS, uniforms: tubeU() }), CFG.maxCarriers, [['aT', 4], ['aCol', 4]]);
  outlines = makeInst(tg.clone(), new T.ShaderMaterial({ vertexShader: TUBE_VS, fragmentShader: TUBE_OUT_FS, side: T.BackSide, uniforms: tubeU(0, 0, CFG.carrierOutline) }), CFG.maxCarriers, [['aT', 4], ['aCol', 4]]);
  const cg = tubeCap();
  caps = makeInst(cg, new T.ShaderMaterial({ vertexShader: LP_VS, fragmentShader: CAP_FS, uniforms: { uL: U.uL, uV: U.uV, uOut: { value: 0 } } }), CFG.maxCarriers + 8, [['aCol', 4]]);
  capOut = makeInst(cg.clone(), new T.ShaderMaterial({ vertexShader: LP_VS, fragmentShader: TUBE_OUT_FS, side: T.BackSide, uniforms: { uL: U.uL, uV: U.uV, uOut: { value: CFG.carrierOutline } } }), CFG.maxCarriers + 8, [['aCol', 4]]);
  const rg = new T.CylinderGeometry(1, 1, 1, 20); rg.rotateX(Math.PI / 2);
  rolls = makeInst(rg, new T.ShaderMaterial({ vertexShader: LP_VS, fragmentShader: ROLL_FS, uniforms: { uL: U.uL, uV: U.uV, uOut: { value: 0 } } }), CFG.maxCarriers, [['aCol', 4]]);
  scene.add(outlines.mesh, bodies.mesh, capOut.mesh, caps.mesh, rolls.mesh);
  R.TUBE = TUBE;
  R.ready = true;
};

// ------------------------------------------------------------------ уровень: клетки холста, места прилавка, кадр
R.buildLevel = function(lay){
  let a = cells.a.array, n = 0;
  for (const p of lay.wells){ a[n * 4] = p[0]; a[n * 4 + 1] = p[1]; a[n * 4 + 2] = (R.cellR || 1) * CFG.wellR; a[n * 4 + 3] = 0; n++; }
  cells.mesh.count = n; cells.a.needsUpdate = true;
  a = seatsQ.a.array; n = 0;
  for (const p of lay.slots){ a[n * 4] = p[0]; a[n * 4 + 1] = p[1]; a[n * 4 + 2] = CFG.slotR; a[n * 4 + 3] = 0; n++; }
  seatsQ.mesh.count = n; seatsQ.a.needsUpdate = true;
  a = R.chev.a.array; n = 0;
  for (const c of lay.chev){ a[n * 4] = c[0]; a[n * 4 + 1] = c[1]; a[n * 4 + 2] = c[2]; a[n * 4 + 3] = n / lay.chev.length; n++; }
  R.chev.mesh.count = n; R.chev.a.needsUpdate = true;
  // кадр: габариты содержимого в координатах камеры (x вправо, y = Y·cos − Z·sin)
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const b of lay.bounds){ const cy = b[1] * CP - b[2] * SP; x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[0]); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy); }
  baseView.cx = (x0 + x1) / 2; baseView.cy = (y0 + y1) / 2; baseView.hw = (x1 - x0) / 2 * CFG.camPad; baseView.hh = (y1 - y0) / 2 * CFG.camPad;
  R.setView(0);
};
// Сетка уровня: h — радиус клетки в мире (кольцо ленты всегда на апофеме 7,5; чем больше клеток, тем они мельче).
// Лента сужается до ширины клетки, холст подходит к ней вплотную, шевроны мельчают.
R.setGrid = function(h){
  const tr = (7.5 + h) / CFG.trackAp, bd = (7.5 - 0.5 * h) / CFG.boardAp;
  R.plates[0].scale.set(tr, tr, 1); R.plates[1].scale.set(tr, tr, 1); R.plates[2].scale.set(bd, bd, 1); R.plates[3].scale.set(bd, bd, 1);
  R.chev.mesh.material.uniforms.uS.value = 0.42 * Math.pow(h, 0.8);
  R.cellR = h;
};
// Подсветка клетки холста: i — номер клетки уровня, a — 0…1.
R.cellGlow = function(i, a){ cells.a.array[i * 4 + 3] = a; cells.a.needsUpdate = true; };

R.resize = function(w, h, dpr){ view.W = w; view.H = h; renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); R.setView(R.focus || 0); };
R.pad = [0, 0];                                   // px: сверху под панель цели, снизу под панель бустеров
R.setPad = function(top, bottom){ R.pad = [top, bottom]; R.setView(R.focus || 0); };
// Кадр: f = 0 — весь уровень (с отступами под панели), f = 1 — крупный план focusView; между ними — плавный наезд.
R.setView = function(f){
  R.focus = f;
  const fit = (v, pt, pb, bias) => { const He = Math.max(50, view.H - pt - pb), k = Math.min(view.W / (2 * v.hw), He / (2 * v.hh)), extra = Math.max(0, He - 2 * v.hh * k) * bias;
    return { k, cx: v.cx, cy: v.cy + (pt - pb) / (2 * k) - extra / (2 * k) }; };
  const a = fit(baseView, R.pad[0], R.pad[1], CFG.topBias);
  let k = a.k, cx = a.cx, cy = a.cy;
  if (f > 0){ const b = fit(focusView, focusView.pt || 0, focusView.pb || 0, 0); k = a.k * Math.pow(b.k / a.k, f); cx = a.cx + (b.cx - a.cx) * f; cy = a.cy + (b.cy - a.cy) * f; }
  const asp = view.W / Math.max(1, view.H);
  view.k = k; view.half = view.H / (2 * k); view.cx = cx; view.cy = cy;
  camera.left = cx - view.half * asp; camera.right = cx + view.half * asp; camera.top = cy + view.half; camera.bottom = cy - view.half;
  camera.updateProjectionMatrix();
  view.left = camera.left; view.top = camera.top;
};
// Крупный план: центр в мире, полуширина и полувысота (в единицах мира по экрану), отступы сверху и снизу в px.
R.setFocus = function(x, y, z, hw, hh, pt, pb){ focusView.cx = x; focusView.cy = y * CP - z * SP; focusView.hw = hw; focusView.hh = hh; focusView.pt = pt || 0; focusView.pb = pb || 0; };
// Крупный план для проверки и съёмки; R3.setView(0) возвращает кадр уровня.
R.look = function(x, y, z, half){ R.setFocus(x, y, z, half * 0.5, half, 0, 0); R.setView(1); };
// Мир → экран (CSS px от левого верхнего угла игрового поля).
R.project = function(x, y, z){ return [(x - view.left) * view.k, (view.top - (y * CP - z * SP)) * view.k]; };
// Экран → мир на высоте y.
R.unproject = function(sx, sy, y){ return [sx / view.k + view.left, (y * CP - (view.top - sy / view.k)) / SP]; };
R.pxPerUnit = function(){ return view.k; };
R.SP = () => SP; R.CP = () => CP;

// ------------------------------------------------------------------ кадр: подача предметов
R.begin = function(){ tiles.n = 0; drops.n = 0; bodies.n = 0; outlines.n = 0; caps.n = 0; capOut.n = 0; rolls.n = 0; shadows.n = 0; };
function quatMatrix(m, o, x, y, z, qx, qy, qz, qw, sx, sy, sz){
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz, xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  m[o] = (1 - (yy + zz)) * sx; m[o + 1] = (xy + wz) * sx; m[o + 2] = (xz - wy) * sx; m[o + 3] = 0;
  m[o + 4] = (xy - wz) * sy; m[o + 5] = (1 - (xx + zz)) * sy; m[o + 6] = (yz + wx) * sy; m[o + 7] = 0;
  m[o + 8] = (xz + wy) * sz; m[o + 9] = (yz - wx) * sz; m[o + 10] = (1 - (xx + yy)) * sz; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}
const set4 = (arr, i, c, a) => { arr[i * 4] = c[0]; arr[i * 4 + 1] = c[1]; arr[i * 4 + 2] = c[2]; arr[i * 4 + 3] = a; };
const NONE = [0, 0, 0];
// Плитка: центр (x, y, z), кватернион q (или null — лежит ровно), масштаб по ширине s и по высоте sy.
//   face — цвет лица, blobR — радиус кляксы (0 — нет, ≥ 1,3 — лицо залито целиком), blob — её цвет, glow — вспышка 0…1,
//   rim1/rim2 — цвета полосок у кромки (null — нет), back — цвет изнанки, mode: 0 — незакрашенная клетка, 1 — готовый пиксель.
R.tile = function(x, y, z, q, s, sy, face, blobR, blob, glow, rim1, rim2, back, mode){
  const i = tiles.n; if (i >= tiles.cap) return; tiles.n++;
  if (q) quatMatrix(tiles.mx, i * 16, x, y, z, q[0], q[1], q[2], q[3], s, sy, s); else quatMatrix(tiles.mx, i * 16, x, y, z, 0, 0, 0, 1, s, sy, s);
  set4(tiles.aFace.array, i, face, blobR); set4(tiles.aBlob.array, i, blob || NONE, glow || 0);
  set4(tiles.aRim1.array, i, rim1 || NONE, rim1 ? 1 : 0);
  set4(tiles.aRim2.array, i, rim2 || NONE, rim2 ? 1 : 0); set4(tiles.aBack.array, i, back || face, mode || 0);
};
// Капля краски: центр, радиус, цвет; (vx, vy, vz) — куда летит (вытягивается по ходу на stretch), flash — вспышка.
R.drop = function(x, y, z, r, col, vx, vy, vz, stretch, flash){
  const i = drops.n; if (i >= drops.cap) return; drops.n++;
  const m = drops.mx, o = i * 16, l = Math.hypot(vx || 0, vy || 0, vz || 0);
  if (!stretch || l < 1e-4){ m[o] = r; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0; m[o + 4] = 0; m[o + 5] = r; m[o + 6] = 0; m[o + 7] = 0; m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = r; m[o + 11] = 0; }
  else {                                            // ось Z капли — по ходу; поперёк она чуть тоньше (объём сохраняется на глаз)
    const fx = vx / l, fy = vy / l, fz = vz / l; let rx = fz, rz = -fx, rl = Math.hypot(rx, rz);
    if (rl < 1e-4){ rx = 1; rz = 0; rl = 1; } rx /= rl; rz /= rl;
    const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx, w = r / Math.sqrt(stretch), f = r * stretch;
    m[o] = rx * w; m[o + 1] = 0; m[o + 2] = rz * w; m[o + 3] = 0; m[o + 4] = ux * w; m[o + 5] = uy * w; m[o + 6] = uz * w; m[o + 7] = 0; m[o + 8] = fx * f; m[o + 9] = fy * f; m[o + 10] = fz * f; m[o + 11] = 0;
  }
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
  set4(drops.aCol.array, i, col, flash || 0);
};
// Тюбик-перевозчик. (x, y, z) — точка под центром тюбика на столе, yaw — куда смотрит носик (0 — вдоль +X мира, π/2 — от зрителя),
//   tilt — носик вверх (кувырок), sxz/sy — масштаб по ширине-длине и по высоте; col — корпус, dark — контур, flash — вспышка;
//   roll — скручено с хвоста 0…1, flat — сплющено 0…1, sq — сжатие выстрела 0…1, inflate — раздувание 0…1 (лопается);
//   cap — цвет крышки (null — без крышки), spin — поворот рулончика.
function quatYT(yaw, tilt){ const hy = yaw / 2, ht = (tilt || 0) / 2, cy = Math.cos(hy), sy = Math.sin(hy), ct = Math.cos(ht), st = Math.sin(ht); return [-sy * st, sy * ct, cy * st, cy * ct]; }
function rotQ(q, x, y, z){ const [qx, qy, qz, qw] = q, ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx]; }
function qmul(a, b){ return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
R.tubeQ = quatYT; R.rotQ = rotQ;
R.carrier = function(x, y, z, yaw, tilt, sxz, sy, col, dark, flash, roll, flat, sq, inflate, cap, capCol, spin){
  const i = bodies.n; if (i >= bodies.cap) return; bodies.n++; outlines.n++;
  const q = quatYT(yaw, tilt);
  quatMatrix(bodies.mx, i * 16, x, y, z, q[0], q[1], q[2], q[3], sxz, sy, sxz); quatMatrix(outlines.mx, i * 16, x, y, z, q[0], q[1], q[2], q[3], sxz, sy, sxz);
  for (const A of [bodies.aT.array, outlines.aT.array]){ A[i * 4] = roll || 0; A[i * 4 + 1] = flat || 0; A[i * 4 + 2] = sq || 0; A[i * 4 + 3] = inflate || 0; }
  set4(bodies.aCol.array, i, col, flash || 0); set4(outlines.aCol.array, i, dark, 0);
  if (cap && caps.n < caps.cap){ const j = caps.n++; capOut.n++;
    quatMatrix(caps.mx, j * 16, x, y, z, q[0], q[1], q[2], q[3], sxz * (1 + 0.25 * (inflate || 0)), sy, sxz); quatMatrix(capOut.mx, j * 16, x, y, z, q[0], q[1], q[2], q[3], sxz, sy, sxz);
    set4(caps.aCol.array, j, capCol, (flash || 0) * 0.5); set4(capOut.aCol.array, j, dark, 0); }
  if (roll > 0.02 && rolls.n < rolls.cap){                        // рулончик скрученного хвоста: лежит на столе в начале оставшейся части
    const rr = 0.06 + 0.3 * Math.sqrt(roll), lx = TUBE.x0 + roll * TUBE.len - rr * 0.3, us = 1 - Math.pow(1 - Math.min(1, roll / 0.62), 2), wd = 2.12 * (0.66 - 0.2 * us), o = rotQ(q, lx * sxz, rr * sy, 0), qs = qmul(q, [0, 0, Math.sin((spin || 0) / 2), Math.cos((spin || 0) / 2)]);
    const j = rolls.n++; quatMatrix(rolls.mx, j * 16, x + o[0], y + o[1], z + o[2], qs[0], qs[1], qs[2], qs[3], rr * sxz, rr * sy, wd * sxz); set4(rolls.aCol.array, j, col, flash || 0);
  }
};
// Крышка отдельно (пломба «?» и отлетающая пломба): (x, y, z) — центр крышки, кватернион, масштаб, цвет и контур.
R.cap = function(x, y, z, q, s, col, dark){
  if (caps.n >= caps.cap) return; const j = caps.n++; capOut.n++;
  const o = rotQ(q, (TUBE.capX0 + TUBE.capX1) / 2 * s, TUBE.axisY * s, 0); x -= o[0]; y -= o[1]; z -= o[2];
  quatMatrix(caps.mx, j * 16, x, y, z, q[0], q[1], q[2], q[3], s, s, s); quatMatrix(capOut.mx, j * 16, x, y, z, q[0], q[1], q[2], q[3], s, s, s);
  set4(caps.aCol.array, j, col, 0); set4(capOut.aCol.array, j, dark, 0);
};
R.shadow = function(x, z, r, a){
  const i = shadows.n; if (i >= shadows.cap) return; shadows.n++;
  const q = shadows.a.array; q[i * 4] = x - LIGHT.x * r * 0.22; q[i * 4 + 1] = z - LIGHT.z * r * 0.22 + r * 0.1; q[i * 4 + 2] = r; q[i * 4 + 3] = a;
};
R.setVeil = function(al){ R.veil.visible = al > 0.01; R.veil.material.uniforms.uAlpha.value = al; };
// Лучи за картинкой: центр, радиус, яркость 0…1, поворот.
R.setRays = function(x, z, rad, al, rot){ R.rays.visible = al > 0.01; R.rays.position.x = x; R.rays.position.z = z; R.rays.scale.set(rad, rad, 1); R.rays.material.uniforms.uAlpha.value = al; R.rays.material.uniforms.uRot.value = rot; };
// Лента: фаза волны шевронов (в клетках хода) и сила свечения 0…1.
R.setTrack = function(phase, glow){ const u = R.chev.mesh.material.uniforms; u.uPhase.value = phase; u.uGlow.value = glow; };
R.setSlotRing = function(i, col, a){ const m = R.slotRings[i]; if (!m) return; m.visible = a > 0.01; m.material.uniforms.uAlpha.value = a; if (col) m.material.uniforms.uColor.value = col; };

R.render = function(){
  flush(tiles); flush(drops); flush(bodies); flush(outlines); flush(caps); flush(capOut); flush(rolls);
  shadows.mesh.count = shadows.n; shadows.a.needsUpdate = true;
  renderer.render(scene, camera);
};
R.stats = function(){ return { tiles: tiles.n, drops: drops.n, carriers: bodies.n, shadows: shadows.n, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; };
// Прогрев (урок lesson-threejs-first-draw-warmup): один раз нарисовать всё, что появится позже — плитку, каплю, перевозчика,
// тень, кольца мест, затемнение — крошечным, чтобы первый пиксель и первый проигрыш не дёргали кадр.
R.warmUp = function(){
  R.begin();
  const c = [1, 1, 1];
  R.tile(0, -50, 0, null, 0.001, 0.001, c, 0.5, c, 0, c, c, c, 0); R.tile(0, -50, 0, null, 0.001, 0.001, c, 0, c, 0, null, null, c, 1);
  R.drop(0, -50, 0, 0.001, c, 0, 1, 0, 1.5, 0); R.carrier(0, -50, 0, 0, 0, 0.001, 0.001, c, c, 0, 0.3, 0.5, 0, 0, true, c, 0); R.cap(0, -50, 0, [0, 0, 0, 1], 0.001, c, c); R.shadow(0, 0, 0.001, 0.01);
  for (const m of R.slotRings) m.visible = true;
  const veil = R.veil.visible; R.veil.visible = true; R.rays.visible = true;
  R.render();
  for (const m of R.slotRings) m.visible = false;
  R.veil.visible = veil; R.rays.visible = false;
  R.begin();
};
R.T = T; R.scene = () => scene; R.rgb = rgb; R.css = css;
return R;
})();
