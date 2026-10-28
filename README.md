# Anlık Çeviri — Türkçe ⇄ Çince

Telefonda çalışan yüz yüze tercüman. Dil seçmeye gerek yok: konuşan durunca konuşma otomatik
algılanır, Türkçe ise Çinceye, Çince ise Türkçeye çevrilir, ekranda gösterilir ve sesli okunur.
Tüm sohbetler telefonda saklanır, dışa aktarılabilir.

- Yazıya döküm + dil tespiti: ElevenLabs Scribe v2
- Çeviri: Claude (Opus 5.5 / Sonnet 5.5), konuşmanın önceki kısmını ve verilen bağlamı bilerek
- Seslendirme: telefonun kendi sesi veya ElevenLabs Flash v2.5
- Karşılıklı mod (⇅): telefon masada dururken üst yarı karşıdaki kişi için ters çevrilmiş Çince gösterir

API anahtarları yalnızca telefonda (tarayıcı deposunda) tutulur; bu depoda hiçbir anahtar yoktur.
Sunucu gerekmez: statik dosyalardır, telefon doğrudan API'lere bağlanır.

## Geliştirme

```bash
python3 -m http.server 8790
```

`http://localhost:8790/?test=kuru` API çağırmadan arayüzü ve konuşma bölmeyi dener
(Ayarlar'da bir ses dosyasını mikrofon yerine verebilirsiniz).

Claude SDK'sı `vendor/anthropic.js` içine gömülüdür (Çin'de CDN'e bağımlı kalmamak için):
`cd arac && npm install && npm run vendor`.
