# QRgram

Tek dosyalık, uçtan uca şifreli olmayan ama isteğe bağlı yerel şifre koruması olan (PBKDF2 + AES-GCM) **cihazdan cihaza P2P sohbet** uygulaması. Mesajlar asla bir sunucudan geçmez; WebRTC DataChannel ile doğrudan cihazdan cihaza gider, IndexedDB'de saklanır.

Bu depoda Node.js + Express + Socket.IO tabanlı **yalnızca sinyalleşme (signaling) sunucusu** bulunur. Sunucu iki tarafı buluşturmak için kullanılan offer/answer SDP'sini birkaç dakika bellekte tutar; mesaj içeriğini **asla** saklamaz, loglamaz veya işlemez.

## Eşleşme yöntemleri

1. **Oda kodu (sunucudan açıldığında):** Davet eden taraf 6 haneli bir kod alır (örn. `7XK2M9`, karıştırılabilen `0 1 I L O` harfleri kullanılmaz). Davet edilen tarafa "Kodu gir" bölümüne yazması yeter. Kod 5 dakika geçerlidir ve tek kullanımlıktır. Sunucuya ulaşılamazsa arayüz sizi otomatik olarak karekod yöntemine yönlendirir.
2. **Karekod (yedek, her zaman çalışır):** Uygulama `file://` ile açıldığında veya Socket.IO yüklenemediğinde sunucusuz çalışmaya devam eder; offer/answer karekodu ya da metin kodu elle paylaşılır.

## Yerel kurulum

```bash
npm install
npm start
# http://localhost:3000
```

`PORT` ortam değişkeniyle bağlantı noktasını değiştirebilirsin (`PORT=8080 npm start`).

## Telefondan test (HTTPS gerekli: ngrok)

Kamera (QR tarama) ve çoğu WebRTC özelliği tarayıcılarda yalnızca HTTPS veya localhost üzerinde çalışır. Telefondan test için:

```bash
npx ngrok http 3000
```

ngrok'un verdiği `https://...ngrok-free.app` adresini telefonla aç. Not: ngrok ücretsiz katmanında her tarayıcıda bir onay sayfası gösterir.

Alternatif olarak aynı yerel ağdaki cihazlar için `http://<bilgisayar-ip>:3000` yeterli (kamera güvenli bağlam dışında çalışmayabilir; "Fotoğraftan seç" ve metin kodu yedekleri kullanılabilir).

## Deploy

### Render

1. Yeni **Web Service** oluşturun, bu depoyu bağlayın.
2. Build command: `npm install` — Start command: `npm start`.
3. Instance type: Free yeterli (odalar bellekte tutulur; tek instance yeterlidir).
4. Render HTTPS'yi otomatik sağlar; `trust proxy` sunucuda zaten açık.

### Railway

1. Yeni proje → Deploy from GitHub repo.
2. Railway `start` script'ini algılar; port olarak `PORT` ortam değişkenini otomatik verir.
3. Deploy sonrası verilen alan adından (`*.up.railway.app`) uygulamayı aç.

### Fly.io

```bash
fly launch --no-deploy          # app yapısını oluştur
fly deploy                      # Node uygulamasını deploy et
fly status                      # uygulama adresini göster
```

Fly.io otomatik TLS sağlar. `fly.toml` içinde `internal_port = 3000` olduğundan emin ol.

## Farklı ağlardan bağlanamıyorum (TURN)

Varsayılan yapı yalnızca Google STUN sunucusunu kullanır. Her iki cihaz sıkı NAT arkasındaysa (simetrik NAT, kurumsal ağ, mobil operatör APN) STUN yetmez; **TURN sunucusu** gerekir. `public/index.html` içinde `RTC_CONFIG` sabitini bulun ve genişletin:

```js
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:a-turn-sunucusu.example.com:3478?transport=udp',
        'turn:a-turn-sunucusu.example.com:3478?transport=tcp'
      ],
      username: 'kullanici',
      credential: 'parola'
    }
  ]
};
```

Popüler seçenekler:

- **Kendi sunucun:** [coturn](https://github.com/coturn/coturn) (VPS üzerinde `docker run -p 3478:3478 -p 3478:3478/udp coturn/coturn -n`). TURN'dan geçen trafik şifrelenebilir (TURN over TLS = port 5349).
- **Yönetilen servis:** Twilio NTS, Xirsys, TPLive/Metered gibi TURN-as-a-Service sağlayıcıları geçici kullanıcı adı/şifre üretir.

Not: TURN üzerinden akış yine cihazdan cihaza gider (uç noktalar arasında şifreli DTLS), uygulama sunucusu bu yolu hiç görmez. Odalar bellekte tutulur; sunucu yeniden başlayınca bekleyen kodlar sıfırlanır, istemciye "kod süresi doldu" bildirimi gider.

## Güvenlik notları

- Sunucu gelen offer/answer'ları önce doğrular (`type/sdp` — en fazla 16 KB), sohbet mesajı görme/izleme olanağı yoktur.
- Oda koduna tahmin/replay saldırısına karşı: 32 karakterlik kod alanı (31^6 ≈ 8.9×10^8 kombinasyon), socket başına rate limit, tek kullanımlık oda, 5 dakikalık TTL.
- Sunucu yalnızca SDP ve görünen adı aktarır; başka hiçbir kişisel veri tutmaz. Sohbet verisi tamamen cihazlarda kalır.
