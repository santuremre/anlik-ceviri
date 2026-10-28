// Anlık Çeviri — Türkçe ⇄ Çince yüz yüze konuşma tercümanı.
// Akış: mikrofon → telefonda konuşma sonu algılama → ElevenLabs Scribe (yazıya döküm + dil tespiti)
//       → Claude (yön otomatik: Çince→Türkçe, Türkçe→Çince) → seslendirme → kayıt (IndexedDB).
import Anthropic from './vendor/anthropic.js';

const MODELLER = {
  'claude-opus-5-5': 'Claude Opus 5.5 — en yüksek kalite',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 — biraz daha hızlı',
};
const VARSAYILAN = {
  anthropicKey: '', elevenKey: '', model: 'claude-opus-5-5', seslendirme: 'cihaz',
  elevenSes: '', bekleme: 900, baglam: '', karsilikli: false,
};
const DIL_ADI = { tr: 'Türkçe', zh: 'Çince', diger: 'Diğer' };
const BAYRAK = { tr: '🇹🇷', zh: '🇨🇳', diger: '🌐' };
const $ = s => document.querySelector(s);
// ?test=kuru: API çağırmadan arayüzü ve konuşma bölmeyi denemek için sahte yanıtlar
const KURU = new URLSearchParams(location.search).get('test') === 'kuru';
const bekle = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- ayarlar
let A = ayarOku();
function ayarOku() {
  try { return { ...VARSAYILAN, ...JSON.parse(localStorage.getItem('ayarlar') || '{}') }; }
  catch { return { ...VARSAYILAN }; }
}
function ayarYaz() { try { localStorage.setItem('ayarlar', JSON.stringify(A)); } catch {} }

// ---------------------------------------------------------------- kayıt (IndexedDB)
const DB = {
  db: null,
  async ac() {
    if (this.db) return this.db;
    this.db = await new Promise((ok, red) => {
      const r = indexedDB.open('anlik-ceviri', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sohbetler', { keyPath: 'id' });
      r.onsuccess = () => ok(r.result);
      r.onerror = () => red(r.error);
    });
    return this.db;
  },
  async islem(mod, fn) {
    const db = await this.ac();
    return new Promise((ok, red) => {
      const tx = db.transaction('sohbetler', mod);
      const r = fn(tx.objectStore('sohbetler'));
      tx.oncomplete = () => ok(r && r.result);
      tx.onerror = () => red(tx.error);
    });
  },
  kaydet(s) { return this.islem('readwrite', st => st.put(s)); },
  hepsi() { return this.islem('readonly', st => st.getAll()); },
  sil(id) { return this.islem('readwrite', st => st.delete(id)); },
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let sohbet = yeniSohbet();
function yeniSohbet() { return { id: uid(), bas: Date.now(), turlar: [] }; }
const kayitZamanlayici = new Map();
function kaydet(s = sohbet, hemen = false) {
  // akış sırasında her harfte değil, kısa aralıklarla yaz
  clearTimeout(kayitZamanlayici.get(s.id));
  const yaz = () => {
    kayitZamanlayici.delete(s.id);
    if (s.turlar.length) DB.kaydet(structuredClone(s)).catch(e => console.warn('kayıt', e));
  };
  if (hemen) yaz(); else kayitZamanlayici.set(s.id, setTimeout(yaz, 400));
}

// ---------------------------------------------------------------- ses yakalama + konuşma sonu algılama
class Dinleyici {
  constructor({ onSoz, onSeviye, onDurum }) {
    Object.assign(this, { onSoz, onSeviye, onDurum });
    this.duraklat = false;
    this.sifirla();
  }
  sifirla() {
    this.taban = null; this.konusma = false; this.ardisik = 0;
    this.onceki = []; this.parcalar = []; this.sesliKare = 0; this.sessizMs = 0;
  }
  async baslat(kaynak) {
    this.ctx = new AudioContext();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('yakala-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'yakala');
    this.node.port.onmessage = e => this.cerceve(e.data);
    const sessiz = this.ctx.createGain();
    sessiz.gain.value = 0;
    this.node.connect(sessiz).connect(this.ctx.destination);
    if (kaynak instanceof AudioBuffer) {   // test modu: dosyayı gerçek zamanlı besle
      this.src = this.ctx.createBufferSource();
      this.src.buffer = kaynak;
      this.src.onended = () => setTimeout(() => this.zorla(), this.bekleme + 100);
      this.src.connect(this.node);
      this.src.start();
    } else {
      this.akis = kaynak;
      this.src = this.ctx.createMediaStreamSource(kaynak);
      this.src.connect(this.node);
    }
    this.sifirla();
  }
  async durdur() {
    try { this.src && this.src.disconnect(); } catch {}
    this.akis && this.akis.getTracks().forEach(t => t.stop());
    this.ctx && await this.ctx.close();
    this.ctx = this.akis = this.src = this.node = null;
    this.sifirla();
  }
  get bekleme() { return +A.bekleme || 900; }
  cerceve(x) {
    let t = 0;
    for (let i = 0; i < x.length; i++) t += x[i] * x[i];
    const db = 10 * Math.log10(t / x.length + 1e-12);
    if (this.taban === null) this.taban = db;
    // gürültü tabanı: düşüşü hızlı, yükselişi yavaş (~0.5 dB/sn) izle
    if (!this.konusma) this.taban = db < this.taban ? 0.7 * this.taban + 0.3 * db : this.taban + 0.01;
    this.onSeviye(Math.max(0, Math.min(1, (db - this.taban) / 30)));
    // telefon çeviriyi sesli okurken dinlemeye devam et ama yalnızca belirgin konuşmayı al;
    // hoparlörden mikrofona geri dönen kendi sesimiz yazıya döküldükten sonra ayıklanır
    const ses = db > Math.max(this.taban + (this.duraklat ? 18 : 10), -62);
    const sessiz = db < this.taban + 8;
    if (!this.konusma) {
      this.onceki.push(x);
      if (this.onceki.length > 15) this.onceki.shift();   // 300 ms ön tampon
      this.ardisik = ses ? this.ardisik + 1 : 0;
      if (this.ardisik >= 3) {
        this.konusma = true;
        this.parcalar = this.onceki.slice();
        this.onceki = [];
        this.sesliKare = 3; this.sessizMs = 0;
        this.okurkenBasladi = this.duraklat;
        this.onDurum('konusma');
      }
      return;
    }
    this.parcalar.push(x);
    if (ses) this.sesliKare++;
    // sessizlik sayacını yalnızca açık konuşma sıfırlar; aradaki belirsiz kareler yarım sayılır
    // (tek tük gürültü karesi cümle sonunu kaçırtmasın)
    this.sessizMs = ses ? 0 : this.sessizMs + (sessiz ? 20 : 10);
    if (this.sessizMs >= this.bekleme || this.parcalar.length * 20 >= 30000) this.bitir();
  }
  bitir() {
    if (!this.konusma) return;
    const fazla = Math.max(0, Math.floor((this.sessizMs - 250) / 20));  // sondaki sessizliği kırp
    const parcalar = fazla ? this.parcalar.slice(0, -fazla) : this.parcalar;
    const yeterli = this.sesliKare * 20 >= 350;   // öksürük, kapı sesi vb. gönderme
    this.konusma = false; this.parcalar = []; this.sesliKare = 0; this.sessizMs = 0; this.ardisik = 0;
    this.onDurum('dinliyor');
    if (yeterli && this.ctx) this.onSoz(parcalar, this.ctx.sampleRate, this.okurkenBasladi || this.duraklat);
  }
  zorla() { this.bitir(); }
}

function wav16k(parcalar, sr) {
  const n = parcalar.reduce((a, p) => a + p.length, 0);
  const x = new Float32Array(n);
  let o = 0, tepe = 0;
  for (const p of parcalar) { x.set(p, o); o += p.length; }
  const oran = sr / 16000, m = Math.floor(n / oran);
  const y = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * oran), b = Math.max(a + 1, Math.min(n, Math.floor((i + 1) * oran)));
    let s = 0;
    for (let k = a; k < b; k++) s += x[k];
    y[i] = s / (b - a);
    tepe = Math.max(tepe, Math.abs(y[i]));
  }
  // kısık/uzak konuşanı yükselt (en fazla 8 kat)
  const kazanc = tepe > 0 ? Math.min(8, 0.9 / tepe) : 1;
  const buf = new ArrayBuffer(44 + m * 2), v = new DataView(buf);
  const yaz = (i, s) => { for (let k = 0; k < s.length; k++) v.setUint8(i + k, s.charCodeAt(k)); };
  yaz(0, 'RIFF'); v.setUint32(4, 36 + m * 2, true); yaz(8, 'WAVE'); yaz(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); yaz(36, 'data'); v.setUint32(40, m * 2, true);
  for (let i = 0; i < m; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, y[i] * kazanc)) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- yazıya döküm (ElevenLabs Scribe)
async function fetchSure(url, opt, ms) {
  const ac = new AbortController();
  const z = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ac.signal }); }
  finally { clearTimeout(z); }
}
async function yaziyaDok(blob) {
  if (KURU) {
    await bekle(600);
    const sn = ((blob.size - 44) / 32000).toFixed(1);
    return Math.random() < 0.5 ? { metin: `测试句子，长度 ${sn} 秒。`, dil: 'zho' } : { metin: `Deneme cümlesi, ${sn} saniye.`, dil: 'tur' };
  }
  for (let deneme = 0; ; deneme++) {
    const fd = new FormData();
    fd.append('model_id', 'scribe_v2');
    fd.append('tag_audio_events', 'false');
    fd.append('file', blob, 'soz.wav');
    try {
      const r = await fetchSure('https://api.elevenlabs.io/v1/speech-to-text',
        { method: 'POST', headers: { 'xi-api-key': A.elevenKey }, body: fd }, 30000);
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        if (r.status === 401) throw new Error('ElevenLabs anahtarı geçersiz (Ayarlar)');
        if (r.status >= 500 && deneme < 1) continue;
        throw new Error(`ElevenLabs ${r.status}: ${t}`);
      }
      const d = await r.json();
      return { metin: (d.text || '').trim(), dil: d.language_code };
    } catch (e) {
      if (deneme < 1 && (e.name === 'AbortError' || e instanceof TypeError)) continue;  // ağ kopması: bir kez daha
      if (e.name === 'AbortError') throw new Error('Yazıya döküm zaman aşımı (bağlantı yavaş)');
      if (e instanceof TypeError) throw new Error('ElevenLabs\'e bağlanılamadı (internet / VPN?)');
      throw e;
    }
  }
}
function dilBul(kod, metin) {
  const cjk = (metin.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (metin.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
  if (cjk && cjk * 3 >= latin) return 'zh';
  const k = (kod || '').toLowerCase();
  if (k === 'tur' || k === 'tr') return 'tr';
  if (['zho', 'cmn', 'yue', 'zh', 'chi'].includes(k)) return 'zh';
  if (/[çğışöüÇĞİŞÖÜ]/.test(metin)) return 'tr';
  return 'diger';
}
const anlamsiz = m => m.replace(/[\s.,!?。，！？…\-()\[\]]/g, '').length < 2;

// ---------------------------------------------------------------- çeviri (Claude)
const SISTEM = `Sen bir Türk ile bir Çinli arasındaki yüz yüze iş konuşmasında çalışan birinci sınıf ardıl tercümansın. Senin çevirin doğrudan karşı tarafa gösterilir ve sesli okunur.

Kurallar:
- Kaynak Çince ise doğal, akıcı Türkçeye çevir. Kaynak Türkçe ise doğal, sade Mandarin Çinceye (basitleştirilmiş karakterler) çevir.
- Kaynak başka bir dildeyse (ör. İngilizce) iki satır yaz: "TR: <Türkçe çeviri>" ve "ZH: <Çince çeviri>".
- Yalnızca çeviriyi yaz. Açıklama, not, tırnak, pinyin, "Çeviri:" gibi önekler ekleme.
- Kelime kelime değil, anlamı ve niyeti aktar; konuşulan dil gibi doğal olsun. Nezaket ve hitap düzeyini koru (王总 → Wang Bey; "Ahmet Bey" → 艾哈迈德先生).
- Rakam, fiyat, adet, ölçü, tarih ve birimleri birebir doğru aktar. 块/元/人民币 = yuan (RMB); asla "lira" deme. Türkçedeki "lira" ise 土耳其里拉'dır.
- Metin otomatik konuşma tanımadan geliyor: eş sesli Çince karakter hatası veya yanlış duyulmuş kelime olabilir. Kelimesi kelimesine çeviri konuşmanın akışına uymayan bir anlam çıkarıyorsa (ör. teslim süresi konuşulurken "benzin tüketimi"), önceki konuşmadan ve bağlamdan en olası doğru anlamı çevir. Bunu açıklama ya da not olarak belirtme.
- Cümle yarım kaldıysa yarım haliyle, anlamlı biçimde çevir; tahmin ederek tamamlama.`;

let _istemci = null, _istemciAnahtar = null;
function istemci() {
  if (!_istemci || _istemciAnahtar !== A.anthropicKey) {
    _istemci = new Anthropic({ apiKey: A.anthropicKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 45000 });
    _istemciAnahtar = A.anthropicKey;
  }
  return _istemci;
}
function baglamMetni(tur, s) {
  const i = s.turlar.indexOf(tur);
  const onceki = s.turlar.slice(0, i).filter(t => t.durum === 'tamam').slice(-8);
  let m = '';
  if (A.baglam.trim()) m += `Konuşmanın bağlamı (kullanıcıdan): ${A.baglam.trim()}\n\n`;
  if (onceki.length) {
    m += 'Önceki konuşma (eskiden yeniye):\n' + onceki.map(t =>
      `- [${DIL_ADI[t.kaynak]}] ${t.metin}\n  → ${t.ceviri}`).join('\n') + '\n\n';
  }
  return m + `Şimdi çevrilecek (${DIL_ADI[tur.kaynak]} olarak algılandı):\n${tur.metin}`;
}
async function cevir(tur, s, guncelle) {
  if (KURU) {
    tur.ceviri = '';
    for (const p of (tur.kaynak === 'zh' ? 'Deneme çevirisi akarak geliyor.' : '测试翻译正在流式显示。').split('')) {
      tur.ceviri += p; guncelle(); await bekle(25);
    }
    return;
  }
  const stream = istemci().beta.messages.stream({
    model: A.model,
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SISTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: baglamMetni(tur, s) }],
  });
  tur.ceviri = '';
  stream.on('text', d => { tur.ceviri += d; guncelle(); });
  const m = await stream.finalMessage();
  if (m.stop_reason === 'refusal') throw new Error('Model bu cümleyi çevirmeyi reddetti');
  tur.ceviri = m.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
function claudeHatasi(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude anahtarı geçersiz (Ayarlar)';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Claude bu ağdan bağlantıya izin vermiyor — Çin\'deyseniz telefonda VPN açık olmalı';
  if (e instanceof Anthropic.RateLimitError) return 'Claude hız sınırı — birkaç saniye sonra tekrar deneyin';
  if (e instanceof Anthropic.APIConnectionError) return 'Claude\'a bağlanılamadı (internet / VPN?)';
  if (e instanceof Anthropic.APIError) return `Claude hatası ${e.status ?? ''}: ${e.message}`;
  return e.message || String(e);
}

// ---------------------------------------------------------------- seslendirme
const oynatici = new Audio();
oynatici.setAttribute('playsinline', '');
let konusmaKuyrugu = Promise.resolve();
function sesKilidiAc() {   // iOS: ilk dokunuşta ses çıkışını aç
  try { oynatici.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; oynatici.play().catch(() => {}); } catch {}
  try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch {}
}
function cihazSesi(dil) {
  const sesler = speechSynthesis.getVoices();
  const on = dil === 'zh' ? ['zh-CN', 'zh'] : ['tr-TR', 'tr'];
  for (const o of on) {
    const uygun = sesler.filter(v => v.lang.replace('_', '-').startsWith(o));
    if (uygun.length) return uygun.find(v => /premium|enhanced|yüksek/i.test(v.name)) || uygun[0];
  }
  return null;
}
function cihazSoyle(metin, dil) {
  return new Promise(ok => {
    const u = new SpeechSynthesisUtterance(metin);
    u.lang = dil === 'zh' ? 'zh-CN' : 'tr-TR';
    const v = cihazSesi(dil);
    if (v) u.voice = v;
    u.rate = 1.0;
    const bitti = () => { clearTimeout(z); ok(); };
    const z = setTimeout(bitti, 4000 + metin.length * 180);
    u.onend = u.onerror = bitti;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}
async function elevenSoyle(metin, dil) {
  const ses = A.elevenSes || await varsayilanSes();
  const r = await fetchSure(`https://api.elevenlabs.io/v1/text-to-speech/${ses}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': A.elevenKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text: metin, model_id: 'eleven_flash_v2_5', language_code: dil === 'zh' ? 'zh' : 'tr' }),
  }, 20000);
  if (!r.ok) throw new Error('ElevenLabs seslendirme ' + r.status);
  const url = URL.createObjectURL(await r.blob());
  try {
    oynatici.src = url;
    await new Promise((ok, red) => {
      oynatici.onended = ok; oynatici.onerror = red;
      oynatici.play().catch(red);
    });
  } finally { URL.revokeObjectURL(url); }
}
// ElevenLabs'in her hesapta bulunan hazır sesleri (anahtarda ses listeleme izni olmasa da çalışır)
const HAZIR_SESLER = [
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', labels: { gender: 'kadın' } },
  { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', labels: { gender: 'kadın' } },
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', labels: { gender: 'erkek' } },
];
let _sesListesi = null;
async function sesListesi() {
  if (_sesListesi) return _sesListesi;
  let hesap = [];
  try {
    const r = await fetchSure('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': A.elevenKey } }, 15000);
    if (r.ok) hesap = (await r.json()).voices || [];
  } catch {}
  const kimlikler = new Set(hesap.map(v => v.voice_id));
  _sesListesi = [...hesap, ...HAZIR_SESLER.filter(v => !kimlikler.has(v.voice_id))];
  return _sesListesi;
}
async function varsayilanSes() { return HAZIR_SESLER[0].voice_id; }
async function seslendir(metin, dil) {
  if (A.seslendirme === 'kapali' || !metin) return;
  okunanlar.push({ metin, zaman: Date.now() });
  if (okunanlar.length > 5) okunanlar.shift();
  dinleyici.duraklat = true;
  durumGoster('soyluyor');
  try {
    if (A.seslendirme === 'elevenlabs' && A.elevenKey) await elevenSoyle(metin, dil);
    else await cihazSoyle(metin, dil);
  } catch (e) {
    console.warn('seslendirme', e);
    try { await cihazSoyle(metin, dil); } catch {}
  } finally {
    setTimeout(() => {
      dinleyici.duraklat = false;
      durumGoster(dinliyor ? 'dinliyor' : 'hazir');
    }, 350);
  }
}

// ---------------------------------------------------------------- akış
// kendi seslendirmemizin mikrofondan geri dönüşünü tanımak için son okunan metinler
const okunanlar = [];
function benzerlik(a, b) {
  const ikili = s => {
    const x = s.toLowerCase().replace(/[\s\p{P}]/gu, ''), r = new Set();
    for (let i = 0; i < x.length - 1; i++) r.add(x.slice(i, i + 2));
    return r;
  };
  const p = ikili(a), q = ikili(b);
  if (!p.size || !q.size) return 0;
  let k = 0;
  for (const x of p) if (q.has(x)) k++;
  return k / Math.min(p.size, q.size);
}
const kendiSesimiz = metin => okunanlar.some(o => Date.now() - o.zaman < 30000 && benzerlik(metin, o.metin) >= 0.45);
const sesBellek = new Map();   // tekrar deneme ve birleştirme için ham ses (yalnızca bu oturum)
// Yarım kalmış görünen söz: kişi kısa süre içinde devam ederse iki parça tek cümle olarak işlenir
let acik = null;
const DEVAM_SURESI = 1500;
const yarim = m => /[,，、:：;；]\s*$/.test(m)
  || /(^|\s)(ve|ama|fakat|ancak|çünkü|ile|veya|ya da|yani|ki|eğer|mesela)\s*$/i.test(m)
  || /(和|跟|但是|可是|而且|因为|所以|然后|就是|如果|比如|还有)\s*$/.test(m);
async function sozGeldi(parcalar, sr, okurken = false) {
  if (acik && acik.s === sohbet) {
    const { tur, coz } = acik;
    const once = sesBellek.get(tur.id);
    const ara = new Float32Array(Math.round(sr * 0.25));
    sesBellek.set(tur.id, { parcalar: [...once.parcalar, ara, ...parcalar], sr });
    acik = null;
    Object.assign(tur, { metin: '', kaynak: null, durum: 'yaziya' });
    coz(true);
    await turuIsle(tur, sohbet);
    return;
  }
  const tur = { id: uid(), zaman: Date.now(), durum: 'yaziya', metin: '', ceviri: '', kaynak: null, sureler: {} };
  if (okurken) tur.okurken = true;
  sesBellek.set(tur.id, { parcalar, sr });
  sohbet.turlar.push(tur);
  turCiz(tur, true);
  await turuIsle(tur, sohbet);
}
function devaminiBekle(tur, s) {
  return new Promise(coz => {
    const kontrol = () => {
      if (!acik || acik.tur !== tur) return;
      // süre doldu ama kişi hâlâ konuşuyorsa sözü bitene kadar bekle (sozGeldi birleştirir)
      if (dinleyici.konusma) { acik.z = setTimeout(kontrol, 250); return; }
      acik = null; coz(false);
    };
    acik = { tur, s, coz, z: setTimeout(kontrol, DEVAM_SURESI) };
  });
}
async function turuIsle(tur, s) {
  const gorunur = () => s === sohbet;   // kullanıcı bu arada başka sohbete geçmiş olabilir
  const ciz = () => gorunur() && turCiz(tur);
  const t0 = performance.now();
  try {
    if (!tur.metin) {
      tur.durum = 'yaziya'; ciz();
      const ham = sesBellek.get(tur.id);
      const r = await yaziyaDok(wav16k(ham.parcalar, ham.sr));
      tur.sureler.yazi = Math.round(performance.now() - t0);
      if (anlamsiz(r.metin) || (tur.okurken && kendiSesimiz(r.metin))) { s.turlar = s.turlar.filter(x => x !== tur); if (gorunur()) turSil(tur); return; }
      tur.metin = r.metin;
      tur.kaynak = dilBul(r.dil, r.metin);
      if (yarim(tur.metin) && dinliyor && s === sohbet) {
        tur.durum = 'devam'; ciz();
        if (await devaminiBekle(tur, s)) return;   // birleştirilmiş haliyle yeniden işleniyor
      }
    }
    tur.durum = 'ceviri'; ciz();
    const t1 = performance.now();
    try { await cevir(tur, s, ciz); }
    catch (e) { throw new Error(claudeHatasi(e)); }
    tur.sureler.ceviri = Math.round(performance.now() - t1);
    tur.sureler.toplam = Math.round(performance.now() - t0);
    tur.durum = 'tamam'; tur.hata = '';
    ciz(); kaydet(s);
    const hedef = tur.kaynak === 'zh' ? 'tr' : tur.kaynak === 'tr' ? 'zh' : null;
    if (hedef && gorunur()) konusmaKuyrugu = konusmaKuyrugu.then(() => seslendir(tur.ceviri, hedef));
  } catch (e) {
    tur.durum = 'hata'; tur.hata = e.message || String(e);
    ciz(); kaydet(s);
  }
}

// ---------------------------------------------------------------- arayüz
const liste = $('#liste'), ust = $('#ust-liste');
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const saat = ts => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function turHtml(t) {
  const yon = t.kaynak ? `${BAYRAK[t.kaynak]} ${DIL_ADI[t.kaynak]} → ${t.kaynak === 'zh' ? '🇹🇷 Türkçe' : t.kaynak === 'tr' ? '🇨🇳 中文' : '🇹🇷 + 🇨🇳'}` : '';
  const durum = { yaziya: 'Yazıya dökülüyor…', devam: 'Devamı bekleniyor…', ceviri: 'Çevriliyor…', hata: '' }[t.durum] || '';
  const sure = t.sureler && t.sureler.toplam ? `${(t.sureler.toplam / 1000).toFixed(1)} sn` : '';
  return `<div class="ust"><span>${yon}</span><span>${saat(t.zaman)}${sure ? ' · ' + sure : ''}</span></div>
    ${t.metin ? `<div class="kaynak" lang="${t.kaynak === 'zh' ? 'zh-CN' : 'tr'}">${esc(t.metin)}</div>` : ''}
    ${t.ceviri ? `<div class="ceviri" lang="${t.kaynak === 'zh' ? 'tr' : 'zh-CN'}">${esc(t.ceviri)}</div>` : ''}
    ${durum ? `<div class="bekle"><i></i>${durum}</div>` : ''}
    ${t.durum === 'hata' ? `<div class="hata">${esc(t.hata)} <button data-tekrar="${t.id}">Tekrar dene</button></div>` : ''}
    ${t.durum === 'tamam' ? `<div class="eylem"><button data-oku="${t.id}" title="Tekrar seslendir">🔊</button></div>` : ''}`;
}
// karşılıklı modda üst (Çinli tarafa dönük) panelde yalnızca Çince metin
function cinceMetin(t) {
  if (t.kaynak === 'zh') return t.metin;
  if (t.kaynak === 'tr') return t.ceviri;
  const m = (t.ceviri || '').match(/ZH:\s*([\s\S]*)/);
  return m ? m[1].trim() : '';
}
function turCiz(t, yeni = false) {
  let el = document.getElementById('t-' + t.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 't-' + t.id;
    liste.appendChild(el);
    $('#bos').hidden = true;
  }
  el.className = `tur ${t.kaynak || 'bilinmiyor'} ${t.durum}`;
  el.innerHTML = turHtml(t);
  let u = document.getElementById('u-' + t.id);
  const zh = cinceMetin(t);
  if (!u) { u = document.createElement('div'); u.id = 'u-' + t.id; ust.appendChild(u); }
  u.className = `tur ${t.kaynak === 'zh' ? 'kendi' : 'karsi'}`;
  u.innerHTML = zh ? `<div class="ceviri" lang="zh-CN">${esc(zh)}</div>` : '<div class="bekle"><i></i>…</div>';
  if (yeni || t.durum !== 'tamam') { liste.scrollTop = liste.scrollHeight; ust.scrollTop = ust.scrollHeight; }
}
function turSil(t) {
  sohbet.turlar = sohbet.turlar.filter(x => x !== t);
  document.getElementById('t-' + t.id)?.remove();
  document.getElementById('u-' + t.id)?.remove();
  sesBellek.delete(t.id);
  if (!sohbet.turlar.length) $('#bos').hidden = false;
}
function hepsiniCiz() {
  liste.querySelectorAll('.tur').forEach(e => e.remove());
  ust.innerHTML = '';
  $('#bos').hidden = sohbet.turlar.length > 0;
  sohbet.turlar.forEach(t => turCiz(t));
  liste.scrollTop = liste.scrollHeight;
}
liste.addEventListener('click', e => {
  const tk = e.target.closest('[data-tekrar]');
  if (tk) {
    const t = sohbet.turlar.find(x => x.id === tk.dataset.tekrar);
    if (t && (t.metin || sesBellek.has(t.id))) turuIsle(t, sohbet);
    else if (t) { t.hata = 'Ses bu oturumda saklanmadığı için tekrar denenemiyor'; turCiz(t); }
  }
  const ok = e.target.closest('[data-oku]');
  if (ok) {
    const t = sohbet.turlar.find(x => x.id === ok.dataset.oku);
    const hedef = t && (t.kaynak === 'zh' ? 'tr' : 'zh');
    if (t) { sesKilidiAc(); konusmaKuyrugu = konusmaKuyrugu.then(() => seslendir(t.ceviri, hedef)); }
  }
});

// durum + mikrofon düğmesi
const DURUM = {
  hazir: ['Başlatmak için dokunun', '点击开始'],
  dinliyor: ['Dinliyorum… konuşun', '正在听… 请说话'],
  konusma: ['Konuşma algılandı…', '正在听…'],
  soyluyor: ['Seslendiriliyor…', '正在播放翻译…'],
  izin: ['Mikrofon izni gerekiyor', '需要麦克风权限'],
};
function durumGoster(d) {
  const [tr, zh] = DURUM[d] || DURUM.hazir;
  $('#durum').textContent = tr;
  $('#ust-durum').textContent = zh;
  document.body.dataset.durum = d;
}
let dinliyor = false, kilit = null;
const dinleyici = new Dinleyici({
  onSoz: sozGeldi,
  onSeviye: s => document.body.style.setProperty('--seviye', s.toFixed(2)),
  onDurum: durumGoster,
});
async function dinlemeyiBaslat(testTamponu) {
  if (!KURU && (!A.anthropicKey || !A.elevenKey)) { ayarlariAc('Önce iki API anahtarını girin.'); return; }
  sesKilidiAc();
  try {
    const kaynak = testTamponu || await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await dinleyici.baslat(kaynak);
  } catch (e) {
    console.warn(e);
    durumGoster('izin');
    return;
  }
  dinliyor = true;
  document.body.classList.add('acik');
  durumGoster('dinliyor');
  if (!KURU) istemci().models.retrieve(A.model).catch(() => {});   // bağlantıyı önceden ısıt
  try { kilit = await navigator.wakeLock?.request('screen'); } catch {}
}
async function dinlemeyiDurdur() {
  dinleyici.zorla();
  await dinleyici.durdur();
  dinliyor = false;
  document.body.classList.remove('acik');
  durumGoster('hazir');
  try { await kilit?.release(); } catch {}
  kilit = null;
}
$('#mik').addEventListener('click', () => (dinliyor ? dinlemeyiDurdur() : dinlemeyiBaslat()));
$('#gonder').addEventListener('click', () => dinleyici.zorla());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && dinliyor && !kilit) {
    try { kilit = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// karşılıklı mod
function karsilikliUygula() {
  document.body.classList.toggle('karsilikli', !!A.karsilikli);
  $('#karsilikli').setAttribute('aria-pressed', A.karsilikli ? 'true' : 'false');
}
$('#karsilikli').addEventListener('click', () => {
  A.karsilikli = !A.karsilikli; ayarYaz(); karsilikliUygula();
  liste.scrollTop = liste.scrollHeight; ust.scrollTop = ust.scrollHeight;
});

// yeni sohbet
$('#yeni').addEventListener('click', () => {
  if (!sohbet.turlar.length) return;
  kaydet(sohbet, true);
  sohbet = yeniSohbet();
  hepsiniCiz();
});

// ---------------------------------------------------------------- geçmiş
function sohbetBasligi(s) {
  const t = s.turlar.find(x => x.kaynak === 'tr' ? x.metin : x.ceviri);
  const ilk = t ? (t.kaynak === 'tr' ? t.metin : t.ceviri) : '';
  return ilk.length > 60 ? ilk.slice(0, 60) + '…' : ilk || 'Boş sohbet';
}
async function gecmisiAc() {
  const hepsi = (await DB.hepsi()).sort((a, b) => b.bas - a.bas);
  const tarih = ts => new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#gecmis-liste').innerHTML = hepsi.length ? hepsi.map(s => `
    <div class="gecmis-satir">
      <button class="ac" data-ac="${s.id}"><b>${esc(tarih(s.bas))}</b> · ${s.turlar.length} konuşma<br><span>${esc(sohbetBasligi(s))}</span></button>
      <button data-disa="${s.id}" title="Dışa aktar">⤴︎</button>
      <button data-sil="${s.id}" title="Sil">🗑</button>
    </div>`).join('') : '<p class="ipucu">Henüz kayıtlı sohbet yok.</p>';
  $('#gecmis').showModal();
}
$('#gecmis-ac').addEventListener('click', gecmisiAc);
$('#gecmis-liste').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const hepsi = await DB.hepsi();
  const s = hepsi.find(x => x.id === (b.dataset.ac || b.dataset.disa || b.dataset.sil));
  if (!s) return;
  if (b.dataset.ac) {
    if (dinliyor) await dinlemeyiDurdur();
    sohbet = s; hepsiniCiz(); $('#gecmis').close();
  } else if (b.dataset.disa) {
    disaAktar(s);
  } else if (b.dataset.sil && confirm('Bu sohbet bu telefondan silinsin mi?')) {
    await DB.sil(s.id);
    if (sohbet.id === s.id) { sohbet = yeniSohbet(); hepsiniCiz(); }
    gecmisiAc();
  }
});
$('#disa-aktar').addEventListener('click', () => sohbet.turlar.length && disaAktar(sohbet));
async function disaAktar(s) {
  const tarih = new Date(s.bas);
  const ad = `ceviri_${tarih.toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const satirlar = [`Anlık Çeviri — ${tarih.toLocaleString('tr-TR')}`, ''];
  for (const t of s.turlar) {
    if (t.durum !== 'tamam') continue;
    satirlar.push(`[${saat(t.zaman)}] ${DIL_ADI[t.kaynak]}: ${t.metin}`);
    satirlar.push(`           → ${t.ceviri}`, '');
  }
  const txt = new File([satirlar.join('\n')], ad + '.txt', { type: 'text/plain' });
  const json = new File([JSON.stringify(s, null, 1)], ad + '.json', { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [txt, json] })) {
      await navigator.share({ files: [txt, json], title: 'Çeviri kaydı' });
      return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  for (const f of [txt, json]) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}

// ---------------------------------------------------------------- ayarlar ekranı
function ayarlariAc(mesaj = '') {
  const f = $('#ayar-form');
  f.anthropicKey.value = A.anthropicKey; f.elevenKey.value = A.elevenKey;
  f.model.innerHTML = Object.entries(MODELLER).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  f.model.value = A.model; f.seslendirme.value = A.seslendirme;
  f.bekleme.value = A.bekleme; f.baglam.value = A.baglam;
  $('#bekleme-deger').textContent = (A.bekleme / 1000).toFixed(1) + ' sn';
  $('#ayar-mesaj').textContent = mesaj;
  $('#test-sonuc').innerHTML = '';
  sesSeciminiDoldur();
  $('#ayarlar').showModal();
}
async function sesSeciminiDoldur() {
  const sel = $('#ayar-form').elevenSes;
  if (!A.elevenKey) { sel.innerHTML = '<option value="">(önce ElevenLabs anahtarı)</option>'; return; }
  try {
    const l = await sesListesi();
    sel.innerHTML = '<option value="">Otomatik</option>' +
      l.map(v => `<option value="${v.voice_id}">${esc(v.name)}${v.labels?.gender ? ' · ' + esc(v.labels.gender) : ''}</option>`).join('');
    sel.value = A.elevenSes;
  } catch { sel.innerHTML = '<option value="">Otomatik</option>'; }
}
$('#ayar-ac').addEventListener('click', () => ayarlariAc());
$('#ayar-form').bekleme.addEventListener('input', e => { $('#bekleme-deger').textContent = (e.target.value / 1000).toFixed(1) + ' sn'; });
$('#ayar-form').addEventListener('submit', e => {
  if (e.submitter?.value !== 'kaydet') return;
  const f = e.target;
  const anahtarDegisti = f.elevenKey.value.trim() !== A.elevenKey;
  Object.assign(A, {
    anthropicKey: f.anthropicKey.value.trim(), elevenKey: f.elevenKey.value.trim(), model: f.model.value,
    seslendirme: f.seslendirme.value, elevenSes: f.elevenSes.value, bekleme: +f.bekleme.value, baglam: f.baglam.value,
  });
  if (anahtarDegisti) _sesListesi = null;
  ayarYaz();
});
$('#anahtar-test').addEventListener('click', async () => {
  const f = $('#ayar-form');
  const eskiA = { ...A };
  A.anthropicKey = f.anthropicKey.value.trim(); A.elevenKey = f.elevenKey.value.trim(); A.model = f.model.value;
  const o = $('#test-sonuc');
  o.innerHTML = '<p class="ipucu">Test ediliyor…</p>';
  const sonuc = [];
  try { const m = await istemci().models.retrieve(A.model); sonuc.push(['ok', `Claude: bağlantı tamam (${m.display_name})`]); }
  catch (e) { sonuc.push(['hata', 'Claude: ' + claudeHatasi(e)]); }
  try {
    // anahtarın gerçekten işe yaradığı tek ölçüt: kısa bir seslendirme isteği (izin kapsamından bağımsız)
    const r = await fetchSure(`https://api.elevenlabs.io/v1/text-to-speech/${HAZIR_SESLER[0].voice_id}?output_format=mp3_22050_32`, {
      method: 'POST', headers: { 'xi-api-key': A.elevenKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Test', model_id: 'eleven_flash_v2_5' }),
    }, 15000);
    const izin = r.status === 401 ? ((await r.text()).includes('missing the permission') ? 'anahtarda Text to Speech izni kapalı (seslendirme için gerekli; yazıya döküm yine çalışabilir)' : 'anahtar geçersiz') : 'HTTP ' + r.status;
    sonuc.push(r.ok ? ['ok', 'ElevenLabs: bağlantı tamam'] : ['hata', `ElevenLabs: ${izin}`]);
  } catch { sonuc.push(['hata', 'ElevenLabs: bağlanılamadı (internet / VPN?)']); }
  o.innerHTML = sonuc.map(([k, m]) => `<p class="${k}">${k === 'ok' ? '✓' : '✗'} ${esc(m)}</p>`).join('');
  Object.assign(A, eskiA);
});

// test modu: ?test ile bir ses dosyasını mikrofon yerine besle
if (new URLSearchParams(location.search).has('test')) {
  $('#test-alan').hidden = false;
  $('#test-dosya').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const ctx = new AudioContext();
    const tampon = await ctx.decodeAudioData(await f.arrayBuffer());
    await ctx.close();
    $('#ayarlar').close();
    if (dinliyor) await dinlemeyiDurdur();
    await dinlemeyiBaslat(tampon);
  });
}

// ---------------------------------------------------------------- başlangıç
karsilikliUygula();
durumGoster('hazir');
hepsiniCiz();
speechSynthesis?.getVoices();   // bazı tarayıcılar listeyi geç yükler
navigator.storage?.persist?.().catch(() => {});
// yerel geliştirmede önbellek eski kodu göstermesin
const yerel = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && !yerel) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!KURU && (!A.anthropicKey || !A.elevenKey)) setTimeout(() => ayarlariAc('Başlamak için Claude ve ElevenLabs anahtarlarını girin. Anahtarlar yalnızca bu telefonda saklanır.'), 300);
window.__ceviri = { sohbet: () => sohbet, A: () => A };   // tanılama
