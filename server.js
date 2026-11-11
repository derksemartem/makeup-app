require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SECRET = process.env.SECRET || 'dev-secret';
const PORT = process.env.PORT || 3000;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const LESSONS = [
  { id: 1, title: 'Ежедневный макияж за 10 минут',       price: 50, desc: 'База: тон, брови, губы' },
  { id: 2, title: 'Стрелки без страха',                  price: 35, desc: 'Все виды стрелок и подводок' },
  { id: 3, title: 'Вечерний макияж Smokey Eyes',         price: 60, desc: 'Растушёвка и сияние' },
  { id: 4, title: 'Контуринг и скульптурирование',       price: 55, desc: 'Работа со спонжем и кистями' },
];

// --- простая «база» в json-файле ---
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = { users: {} }; // users["12345"] = [1, 3]
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- проверка подписи initData из Telegram ---
function validateInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  params.delete('signature');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const check = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (check !== hash) return null;
  return JSON.parse(params.get('user') || 'null');
}

function auth(req, res, next) {
  const user = validateInitData(req.headers.authorization || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

const ownedBy = (uid) => db.users[String(uid)] || [];

// --- кто я и что купил ---
app.get('/api/me', auth, (req, res) => {
  res.json({
    name: req.user.first_name,
    owned: ownedBy(req.user.id),
    lessons: LESSONS.map(({ id, title, price, desc }) => ({ id, title, price, desc })),
  });
});

// --- создать счёт на оплату в Stars ---
app.post('/api/invoice', auth, async (req, res) => {
  const lesson = LESSONS.find(l => l.id === req.body.lessonId);
  if (!lesson) return res.status(400).json({ error: 'no such lesson' });
  if (ownedBy(req.user.id).includes(lesson.id)) return res.status(400).json({ error: 'already owned' });

  const payload = `${req.user.id}:${lesson.id}`;
  const r = await fetch(`${API}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: lesson.title,
      description: lesson.desc,
      payload,
      currency: 'XTR',            // оплата Telegram Stars
      prices: [{ label: lesson.title, amount: lesson.price }], // amount в звёздах
    }),
  });
  const data = await r.json();
  if (!data.ok) return res.status(500).json({ error: data.description });
  res.json({ link: data.result });
});

// --- временная ссылка на видео для купивших ---
app.get('/api/download-url/:id', auth, (req, res) => {
  const id = +req.params.id;
  if (!ownedBy(req.user.id).includes(id)) return res.status(403).json({ error: 'not owned' });
  const exp = Date.now() + 10 * 60 * 1000;
  const s = crypto.createHmac('sha256', SECRET).update(`${req.user.id}:${id}:${exp}`).digest('hex').slice(0, 32);
  res.json({ url: `/download/${id}?uid=${req.user.id}&exp=${exp}&s=${s}` });
});

app.get('/download/:id', (req, res) => {
  const { uid, exp, s } = req.query;
  const id = +req.params.id;
  if (+exp < Date.now()) return res.status(410).send('Ссылка устарела, откройте урок заново');
  const check = crypto.createHmac('sha256', SECRET).update(`${uid}:${id}:${exp}`).digest('hex').slice(0, 32);
  if (check !== s) return res.status(403).send('Неверная ссылка');
  const file = path.join(__dirname, 'videos', `${id}.mp4`);
  if (!fs.existsSync(file)) return res.status(404).send('Видео не найдено');
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(file).pipe(res);
});

// --- приём уведомлений об оплате (long polling) ---
let offset = 0;
async function poll() {
  try {
    const r = await fetch(`${API}/getUpdates?timeout=5&offset=${offset}`);
    const { result } = await r.json();
    for (const upd of result) {
      offset = upd.update_id + 1;
      const p = upd.message?.successful_payment;
      if (p) {
        const [uid, lid] = p.invoice_payload.split(':');
        db.users[uid] = db.users[uid] || [];
        if (!db.users[uid].includes(+lid)) db.users[uid].push(+lid);
        save();
      }
    }
  } catch {}
  setTimeout(poll, 1000);
}
poll();

app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
