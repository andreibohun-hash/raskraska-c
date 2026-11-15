'use strict';
/* =====================================================================================================
   assets/sfx.js — звук «Раскраски»: WebAudio-синтез, ни одного файла (PROTO-BASE §8).

   Звук басистый, мокрый и тактильный: ни колокольчиков, ни стекла, ни маримбы, ни высоких звонов (v0.4.1, Андрей: «колокол убрать
   совсем, вместо — что-то басистое и сатисфайное»). Основа — «тумп»: саб-синус с быстрым падением тона и приглушённый шум низким фильтром.
   Клетка закрашена — низкий сочный «чвяк»: шлепок шума через низкий фильтр и короткий плоп с падающим тоном. Лесенка мягкая: от клетки
   к клетке сдвигаются частоты фильтра и плопа (у каждой краски своя основа), с разбросом — сотни подряд не утомляют.
   Веха серии — плотный басовый «поп», каждая следующая чуть выше и плотнее. Цвет закрашен и финал — глубокий тёплый удар.
   Звенящих голосов не больше CFG.sfx.maxVoices: новый голос глушит самый старый.
   Случайность — свой генератор с сидом (Math.random не используется).
   ===================================================================================================== */
const Sfx = (function(){
const S = { ac: null, muted: false, log: null };
let bus = null, master = null, noiseBuf = null, rollG = null, spinG = null, spinOsc = null, spinF = null, spinN = null, tickAt = 0;
const voices = [];
let seed = 20261113;
function rnd(){ seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const jit = (k) => 1 + (rnd() * 2 - 1) * k;
const SCALE = [0, 2, 4, 7, 9];                                   // мажорная пентатоника, полутона от тоники
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const scaleHz = (base, step) => hz(base + 12 * Math.floor(step / 5) + SCALE[((step % 5) + 5) % 5]);
// Ступень лесенки для i-й монеты слоя (0…9): девять шагов вверх, десятая — в тонику двумя октавами выше начала.
const ladderStep = (i) => i >= 9 ? 10 : i;
const paintNote = (kind) => (CFG.paints[kind] && CFG.paints[kind].note) || 72;
const on = () => S.ac && !S.muted && S.ac.state === 'running';
const note = (name, info) => { if (S.log) S.log('sound', name, info); };

S.init = function(){
  if (S.ac){ if (S.ac.state === 'suspended') S.ac.resume(); return; }
  try { S.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { S.ac = null; return; }
  const ac = S.ac;
  master = ac.createGain(); master.gain.value = S.muted ? 0 : CFG.sfx.master;
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.16;
  bus = ac.createGain(); bus.connect(comp); comp.connect(master); master.connect(ac.destination);
  // маленькое «помещение»: две линии задержки с обратной связью — у звона появляется воздух
  const send = ac.createGain(); send.gain.value = CFG.sfx.room; bus.connect(send);
  for (const [dt, fb] of [[0.031, 0.34], [0.047, 0.3]]){
    const d = ac.createDelay(0.2), g = ac.createGain(), lp = ac.createBiquadFilter(); d.delayTime.value = dt; g.gain.value = fb; lp.type = 'lowpass'; lp.frequency.value = 4200;
    send.connect(d); d.connect(lp); lp.connect(g); g.connect(d); lp.connect(comp);
  }
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = rnd() * 2 - 1;
  // постоянные дорожки: шелест летящей краски и гул разгона ленты (громкость ведёт оболочка)
  const mk = (type, f, q) => { const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true; const flt = ac.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    const g = ac.createGain(); g.gain.value = 0; src.connect(flt); flt.connect(g); g.connect(bus); src.start(); return { g, flt }; };
  const r = mk('bandpass', 1500, 0.9); rollG = r.g;
  const am = ac.createOscillator(), amG = ac.createGain(); am.frequency.value = 13; amG.gain.value = 0; am.connect(amG); amG.connect(rollG.gain); am.start(); S._rollAm = amG;
  const sp = mk('bandpass', 500, 0.8); spinN = sp.g; spinF = sp.flt;
  spinOsc = ac.createOscillator(); spinOsc.type = 'sawtooth'; spinOsc.frequency.value = 70; const sl = ac.createBiquadFilter(); sl.type = 'lowpass'; sl.frequency.value = 520;
  spinG = ac.createGain(); spinG.gain.value = 0; spinOsc.connect(sl); sl.connect(spinG); spinG.connect(bus); spinOsc.start();
};
S.setMuted = function(m){ S.muted = !!m; if (master) master.gain.setTargetAtTime(S.muted ? 0 : CFG.sfx.master, S.ac.currentTime, 0.02); };

// --- кирпичики ---
function osc(freq, type, t, peak, decay, dest, attack, glideTo){
  if (freq > 13000 || peak <= 0.0005) return;
  const ac = S.ac, o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + decay);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + (attack || 0.003)); g.gain.exponentialRampToValueAtTime(0.0001, t + (attack || 0.003) + decay * 3.2);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + (attack || 0.003) + decay * 3.3 + 0.02);
}
function noise(t, dur, peak, type, f, q, dest, fTo){
  const ac = S.ac, src = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = ac.createGain(); src.buffer = noiseBuf; flt.type = type; flt.frequency.setValueAtTime(f, t); flt.Q.value = q || 1;
  if (fTo) flt.frequency.exponentialRampToValueAtTime(fTo, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + Math.min(0.004, dur * 0.3)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt); flt.connect(g); g.connect(dest || bus); src.start(t, rnd() * 1.5); src.stop(t + dur + 0.02);
}
// Лимит звенящих голосов: если все заняты — самый старый быстро гаснет.
function claimVoice(t, dur){
  for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end <= t) voices.splice(i, 1);
  while (voices.length >= CFG.sfx.maxVoices){ const v = voices.shift(); try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0.0001, t, 0.012); } catch (e) {} }
  const g = S.ac.createGain(); g.gain.value = 1; g.connect(bus); voices.push({ end: t + dur, g }); return g;
}
const loud = (f) => Math.min(1, Math.pow(1300 / Math.max(200, f), 0.55));      // высокие ноты тише — ухо не режет

// --- события игры ---
// «Плоп»: синус падает по тону — лопнул пузырь густой краски; dur — длина спада, с.
function plop(f0, t, vel, dest, dur){
  const ac = S.ac, o = ac.createOscillator(), g = ac.createGain(), d = dur || 0.07; o.type = 'sine';
  o.frequency.setValueAtTime(f0 * 1.5, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + d);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.3 * vel, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.03);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + d + 0.05);
}
// «Тумп»: саб-синус падает по тону от f0·2 до f0·0,6 и мягкий шум низким фильтром — басовый мокрый удар. long — длина хвоста.
function thump(f0, t, vel, dest, long){
  const L = long || 1;
  osc(f0 * 2, 'sine', t, 0.42 * vel, 0.05 * L, dest, 0.003, f0 * 0.6);
  noise(t, 0.09 * L, 0.16 * vel, 'lowpass', 420, 0.7, dest, 110);
}
// Клетка закрашена: «шмяк» густой краски. kind — краска (своя основа), i — ступень лесенки (0…9), vel — сила.
S.plip = function(kind, i, vel, delay){
  if (!on()) return; const t = S.ac.currentTime + (delay || 0), v = vel === undefined ? 1 : vel, out = claimVoice(t, 0.2);
  const st = ladderStep(i), k = Math.pow(2, (paintNote(kind) - 66) / 48) * (1 + 0.035 * st) * jit(0.07);
  noise(t, 0.07 * jit(0.15), 0.28 * v, 'lowpass', (340 + 40 * st) * k * jit(0.2), 0.9, out, 120);   // низкий шлепок
  noise(t, 0.022, 0.05 * v, 'bandpass', 800 * k * jit(0.2), 1.1, out, 350);                        // влажное «ч», приглушённое
  plop(105 * k, t + 0.004, 0.85 * v, out, 0.065 * jit(0.15));                                      // низкий плоп
};
// Веха серии: плотный басовый «поп»; step — номер вехи, каждая выше и плотнее (с 3-й — второй пузырь, с 6-й — второй удар).
S.pop = function(step){
  if (!on()) return; const t = S.ac.currentTime, s = Math.min(8, step || 0), f = Math.pow(1.07, s), out = claimVoice(t, 0.3);
  thump(55 * f, t, 0.8, out); plop(120 * f, t + 0.005, 0.8, out, 0.09); noise(t, 0.05, 0.14, 'lowpass', 600 * f, 0.9, out, 180);
  if (s >= 2) plop(160 * f, t + 0.04, 0.35 + 0.05 * s, out, 0.07);
  if (s >= 5) thump(45 * f, t + 0.06, 0.5, out, 0.8);
  note('combo.pop', 'step=' + s);
};
// Цвет закрашен целиком: большой хлюп и глубокий басовый удар (combo — чуть выше на ступень).
S.flood = function(kind, combo){
  if (!on()) return; const t = S.ac.currentTime, c = Math.min(combo, 9);
  const out = S.ac.createGain(); out.gain.value = 0.9; out.connect(bus);
  noise(t, 0.22, 0.22, 'lowpass', 900, 0.7, out, 140); plop(100, t, 1, out, 0.12); thump(48 * Math.pow(1.04, c), t + 0.02, 0.9, out, 1.3);
  note('flood.thump', 'paint=' + CFG.paints[kind].id + ' combo=' + (combo + 1));
};
// Плитка переворачивается: короткий взмах.
S.flip = function(){ if (!on()) return; noise(S.ac.currentTime, 0.16, 0.09, 'bandpass', 900, 0.9, bus, 3200); };
// Пиксель лёг на место: глухой басовый стук; step — ступень.
S.click = function(step, vel){
  if (!on()) return; const t = S.ac.currentTime, v = vel === undefined ? 1 : vel, out = claimVoice(t, 0.4);
  thump(60 * (1 + 0.04 * (step || 0)), t, 0.8 * v, out);
  note('pixel.click');
};
S.ding = function(kind){ if (!on()) return; const t = S.ac.currentTime + 0.03, out = claimVoice(t, 0.4); thump(65, t, 0.7, out); note('layer.ding', CFG.paints[kind].id); };
// Капелька-перевозчик: упругий «боньк» + тихий буль её краски.
S.carrierTap = function(kind){
  if (!on()) return; const t = S.ac.currentTime;
  osc(240, 'sine', t, 0.3, 0.05, bus, 0.002, 420); noise(t, 0.03, 0.08, 'lowpass', 1200, 0.7);
  if (kind >= 0) S.plip(kind, 4, 0.3, 0.04);
  note('carrier.tap');
};
S.carrierPlop = function(kind){
  if (!on()) return; const t = S.ac.currentTime;
  osc(170, 'sine', t, 0.4, 0.06, bus, 0.002, 70); noise(t, 0.07, 0.2, 'lowpass', 700, 0.7);
  if (kind >= 0){ S.plip(kind, 1, 0.3, 0.03); S.plip(kind, 0, 0.22, 0.09); }
  note('carrier.plop');
};
// Выстрел тюбика: «пщ» — короткий напорный шорох из носика; i — какая по счёту колбаска этого тюбика (шорох чуть выше с каждой).
S.squirt = function(kind, i){
  if (!on()) return; const t = S.ac.currentTime, f = 1700 * Math.pow(1.06, i || 0) * jit(0.08);
  noise(t, 0.07, 0.07, 'bandpass', f * 1.8, 1.3, bus, f * 0.7); noise(t + 0.01, 0.04, 0.035, 'highpass', 5200, 0.8);
};
// Пустой тюбик скручивается: хруст жести — серия сухих щелчков с убывающим шагом и скрип.
S.tubeCrunch = function(){
  if (!on()) return; const t = S.ac.currentTime;
  for (let k = 0; k < 6; k++){ const tt = t + k * 0.04 * (1 - k * 0.07); noise(tt, 0.022, 0.13 - k * 0.012, 'bandpass', (2600 + rnd() * 2200), 2.2); osc(900 + rnd() * 500, 'square', tt, 0.012, 0.006, bus, 0.001); }
  osc(340, 'sawtooth', t + 0.02, 0.025, 0.06, bus, 0.01, 520);                           // скрип
  note('tube.crunch');
};
// Рулончик улетел: взмах и мягкий плоп.
S.carrierGone = function(){
  if (!on()) return; const t = S.ac.currentTime;
  noise(t, 0.16, 0.08, 'bandpass', 900, 0.9, bus, 3800); plop(140, t + 0.04, 0.5, bus, 0.08); note('carrier.gone');
};
S.reject = function(){ if (!on()) return; const t = S.ac.currentTime; osc(170, 'triangle', t, 0.28, 0.035, bus, 0.002, 120); osc(140, 'triangle', t + 0.09, 0.26, 0.04, bus, 0.002, 100); note('reject'); };
// Пломба «?» отщёлкнулась: сухой «щёлк», шорох и два буля краски.
S.reveal = function(kind){ if (!on()) return; const t = S.ac.currentTime; noise(t, 0.012, 0.3, 'bandpass', 3800, 2, bus); noise(t + 0.03, 0.1, 0.1, 'bandpass', 1800, 1, bus, 5000); S.plip(kind, 5, 0.5, 0.05); S.plip(kind, 7, 0.4, 0.12); note('secret.reveal'); };
// Клетка стала краем пятна — плитка проседает в лунку: тихий сухой «тк» (не чаще раза в 90 мс: клетки открываются пачками).
let sinkAt = 0;
S.sink = function(){ if (!on()) return; const t = S.ac.currentTime; if (t - sinkAt < 0.09) return; sinkAt = t; noise(t, 0.012, 0.07, 'bandpass', 2600 * jit(0.15), 2.2, bus); plop(190 * jit(0.1), t + 0.004, 0.18, bus, 0.035); note('cell.sink'); };
S.tick = function(){ if (!on()) return; const t = S.ac.currentTime; if (t - tickAt < 0.2) return; tickAt = t; osc(1900, 'square', t, 0.035, 0.008, bus, 0.001); osc(1200, 'sine', t, 0.03, 0.012, bus, 0.001); };
let uiN = 0;
S.ui = function(){ if (!on()) return; S.plip(0, 3 + (uiN++ % 3), 0.5); };                 // кнопки булькают
// Каскад на старте уровня: плитки выкладываются на холст — короткая лесенка мягких плопов.
S.cascade = function(n){
  if (!on()) return; const t = S.ac.currentTime;
  for (let i = 0; i < Math.min(12, n); i++){ const tt = t + 0.1 + i * 0.055; noise(tt, 0.012, 0.12, 'bandpass', 3600 * jit(0.1), 1.6); plop(90 * (1 + 0.04 * (i % 10)), tt, 0.25, bus, 0.04); }
  note('level.cascade');
};
// Шелест летящей краски: уровень 0…1 (сколько капель в воздухе).
S.setRoll = function(level){ if (!S.ac || !rollG) return; const t = S.ac.currentTime, v = on() ? level * CFG.sfx.rollGain : 0; rollG.gain.setTargetAtTime(v, t, 0.05); S._rollAm.gain.setTargetAtTime(v * 0.4, t, 0.05); };
// Разгон ленты: уровень 0…1 — гул поднимается по высоте и громкости.
S.setSpin = function(level){
  if (!S.ac || !spinG) return; const t = S.ac.currentTime, v = on() ? level : 0;
  spinG.gain.setTargetAtTime(v * 0.05, t, 0.12); spinN.gain.setTargetAtTime(v * 0.13, t, 0.12);
  spinOsc.frequency.setTargetAtTime(70 + 130 * level, t, 0.25); spinF.frequency.setTargetAtTime(420 + 1900 * level, t, 0.25);
};
// Проигрыш: тюбики лопаются — глухие хлопки, россыпь булей вниз и низкий вздох.
S.spill = function(kinds, delay){ if (!on()) return; const d0 = delay || 0;
  for (let i = 0; i < 6; i++) noise(S.ac.currentTime + d0 + i * 0.035, 0.05, 0.16, 'lowpass', 1400, 0.8, bus, 300);        // тюбики лопаются
  kinds.forEach((k, i) => S.plip(k, 8 - (i % 8), 0.45 + rnd() * 0.3, d0 + 0.02 + i * 0.05 + rnd() * 0.03)); osc(98, 'sawtooth', S.ac.currentTime, 0.12, 0.2, bus, 0.01, 46); note('lose.spill'); };
S.lose = function(){ if (!on()) return; const t = S.ac.currentTime; osc(hz(55), 'triangle', t, 0.2, 0.25, bus, 0.01, hz(48)); osc(hz(58), 'triangle', t + 0.02, 0.14, 0.25, bus, 0.01, hz(51)); note('lose'); };
// Финал. Волна по картинке: каждый пиксель — мягкий басовый плоп своей ступени (i растёт от центра к краям).
S.pixelWave = function(i){ if (!on()) return; const t = S.ac.currentTime, out = claimVoice(t, 0.3); plop(80 * (1 + 0.05 * i), t, 0.45, out, 0.08); noise(t, 0.05, 0.08, 'lowpass', 500, 0.8, out, 150); };
// Вспышка готовой картинки: глубокий тёплый удар — длинный саб-«тумп», мокрый «пуф» низким фильтром и второй удар следом.
S.winFlash = function(){
  if (!on()) return; const t = S.ac.currentTime, out = S.ac.createGain(); out.gain.value = 1; out.connect(bus);
  thump(40, t, 1, out, 3); noise(t, 0.5, 0.22, 'lowpass', 700, 0.7, out, 160); plop(110, t + 0.01, 0.8, out, 0.16);
  thump(52, t + 0.18, 0.6, out, 2); osc(hz(36), 'sine', t, 0.25, 0.3, out); note('win');
};
S.countTick = function(u){ if (!on()) return; plop(90 * (1 + 0.06 * Math.floor(u * 10)), S.ac.currentTime, 0.35, bus, 0.04); };
// Картинка улетела в галерею: взмах и басовый «тумп» на месте.
S.stamp = function(){ if (!on()) return; const t = S.ac.currentTime; noise(t, 0.2, 0.1, 'bandpass', 700, 0.9, bus, 2600); thump(55, t + 0.2, 0.8, bus, 1.2); note('gallery.stamp'); };
S.voices = () => voices.length;
return S;
})();
