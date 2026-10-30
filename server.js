'use strict';

/*
 * QRgram signaling server.
 *
 * Bu sunucu YALNIZCA sinyalleşme (offer/answer SDP paylaşımı) içindir.
 * Hiçbir sohbet mesajı buradan geçmez, içerik saklanmaz ya da
 * loglanmaz; sadece oda kodu -> offer eşlemesi kısa süre bellekte tutulur.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Oda kodu: 6 karakter, karışan harfler (I, L, O) ve rakamlar (0, 1) çıkarılır
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS, 10) || 5 * 60 * 1000; // varsayılan: 5 dakika (testlerde kısaltılabilir)

// Güvenlik sınırları
const MAX_SDP_CHARS = 16 * 1024;      // offer/answer SDP için makul üst sınır
const MAX_ID_CHARS = 64;              // WebRTC peer id
const MAX_NAME_CHARS = 24;            // görünen ad (yalnızca relay edilir)
const MAX_ROOMS_PER_SOCKET = 3;

// Kaba kuvvet kod tahminine karşı socket başına basit rate limit
const JOIN_ATTEMPTS_MAX = 10;
const JOIN_ATTEMPTS_WINDOW_MS = 60 * 1000;
const ANSWER_ATTEMPTS_MAX = 10;
const ANSWER_ATTEMPTS_WINDOW_MS = 60 * 1000;
const CREATE_MAX = 6;
const CREATE_WINDOW_MS = 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // SDP birkaç KB'yi geçmez; daha büyük her şeyi reddet
  maxHttpBufferSize: 64 * 1024
});

// Production'da HTTPS reverse proxy arkasında çalışır
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();        // code -> { offer, ownerId, timer }
const roomsByOwner = new Map(); // socketId -> Set<code>
const rateBuckets = new Map();  // socketId -> { kind: [timestamps] }

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return null; // pratikte imkansız; teorik çakışma koruması
}

function hasSdpShape(payload, expectedType) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const sdp = payload.sdp;
  if (!sdp || typeof sdp !== 'object' || Array.isArray(sdp)) return false;
  if (typeof sdp.type !== 'string' || typeof sdp.sdp !== 'string' || !sdp.sdp) return false;
  if (sdp.sdp.length > MAX_SDP_CHARS) return false;
  if (expectedType && sdp.type !== expectedType) return false;
  if (payload.id !== undefined && payload.id !== null &&
      (typeof payload.id !== 'string' || payload.id.length > MAX_ID_CHARS)) return false;
  if (payload.n !== undefined && payload.n !== null &&
      (typeof payload.n !== 'string' || payload.n.length > MAX_NAME_CHARS)) return false;
  return true;
}

function rateAllow(socketId, kind, max, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(socketId);
  if (!bucket) { bucket = {}; rateBuckets.set(socketId, bucket); }
  const arr = Array.isArray(bucket[kind]) ? bucket[kind] : [];
  bucket[kind] = arr.filter((t) => now - t < windowMs);
  if (bucket[kind].length >= max) return false;
  bucket[kind].push(now);
  return true;
}

function destroyRoom(code, notifyOwner) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  rooms.delete(code);
  const set = roomsByOwner.get(room.ownerId);
  if (set) {
    set.delete(code);
    if (set.size === 0) roomsByOwner.delete(room.ownerId);
  }
  if (notifyOwner) {
    const owner = io.sockets.sockets.get(room.ownerId);
    if (owner) owner.emit('room-expired', { code });
  }
}

io.on('connection', (socket) => {

  // Davet eden taraf: oda açar, 6 haneli kod alır
  socket.on('create-room', (offer, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!hasSdpShape(offer, 'offer')) {
      cb({ error: 'Geçersiz offer verisi.' });
      return;
    }
    if (!rateAllow(socket.id, 'create', CREATE_MAX, CREATE_WINDOW_MS)) {
      cb({ error: 'Çok sık oda açıyorsun, kısa süre sonra tekrar dene.' });
      return;
    }
    const owned = roomsByOwner.get(socket.id);
    if (owned && owned.size >= MAX_ROOMS_PER_SOCKET) {
      cb({ error: 'Aynı anda en fazla ' + MAX_ROOMS_PER_SOCKET + ' oda açabilirsin.' });
      return;
    }
    const code = generateCode();
    if (!code) {
      cb({ error: 'Oda kodu üretilemedi, tekrar dene.' });
      return;
    }
    const timer = setTimeout(() => destroyRoom(code, true), ROOM_TTL_MS);
    rooms.set(code, { offer, ownerId: socket.id, timer });
    const set = roomsByOwner.get(socket.id) || new Set();
    set.add(code);
    roomsByOwner.set(socket.id, set);
    cb({ code });
  });

  // Katılan taraf: koda karşılık offer'ı alır
  socket.on('join-room', (code, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    if (!rateAllow(socket.id, 'join', JOIN_ATTEMPTS_MAX, JOIN_ATTEMPTS_WINDOW_MS)) {
      cb({ error: 'Çok fazla deneme yaptın, biraz bekle ve tekrar dene.' });
      return;
    }
    const norm = normalizeCode(code);
    if (norm.length !== CODE_LENGTH) {
      cb({ error: 'Kod 6 karakter olmalı (harf ve rakam).' });
      return;
    }
    const room = rooms.get(norm);
    if (!room) {
      cb({ error: 'Oda bulunamadı ya da süresi doldu.' });
      return;
    }
    cb({ offer: room.offer });
  });

  // Katılan taraf: cevabı oda sahibine iletir, oda tek kullanımlık silinir
  socket.on('answer', (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const code = normalizeCode(data.code);
    if (code.length !== CODE_LENGTH) return;
    if (!hasSdpShape(data.answer, 'answer')) return;
    if (!rateAllow(socket.id, 'answer', ANSWER_ATTEMPTS_MAX, ANSWER_ATTEMPTS_WINDOW_MS)) return;
    const room = rooms.get(code);
    if (!room) return;
    const owner = io.sockets.sockets.get(room.ownerId);
    if (owner) owner.emit('answer', { code, answer: data.answer });
    destroyRoom(code, false);
  });

  // Oda sahibinin bağlantısı koptuğunda odaları temizle
  socket.on('disconnect', () => {
    const set = roomsByOwner.get(socket.id);
    if (set) {
      for (const code of Array.from(set)) destroyRoom(code, false);
      roomsByOwner.delete(socket.id);
    }
    rateBuckets.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log('QRgram signaling server listening on port ' + PORT + ' (mesajlar sunucudan gecmez)');
});
