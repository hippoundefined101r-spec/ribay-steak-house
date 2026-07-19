/**
 * RIBAY — платёжный Worker
 * Эндпоинты:
 *   POST /order     — фронт сохраняет заказ, получает order_id
 *   POST /yoomoney  — HTTP-уведомление от ЮMoney о входящем переводе
 *
 * Нужны переменные окружения (Settings → Variables в Cloudflare):
 *   AI_API_KEY       — ключ API для чата Амины (НИКОГДА не класть во фронт)
 *   YOOMONEY_SECRET  — секрет из настроек HTTP-уведомлений ЮMoney
 *   YOOMONEY_WALLET  — номер кошелька (410011...)
 *   TG_BOT_TOKEN     — токен бота
 *   TG_CHAT_ID       — id канала доставщиков (вида -100xxxxxxxxxx)
 * И KV namespace с биндингом ORDERS.
 */

// ДЕМО-РЕЖИМ: пока true — любая ссылка на оплату будет на 10₽.
// Перед продом поставить false.
const DEMO_MODE = true;
const DEMO_PRICE = 10;

const CORS = {
  'Access-Control-Allow-Origin': 'https://hippoundefined101r-spec.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return handleStatus(url, env);
    }

    if (url.pathname === '/ai' && request.method === 'POST') {
      return handleAI(request, env);
    }

    if (url.pathname === '/order' && request.method === 'POST') {
      return handleOrder(request, env);
    }

    if (url.pathname === '/yoomoney' && request.method === 'POST') {
      return handleYoomoney(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

/* ---------- 0. AI-прокси: ключ живёт здесь, не во фронте ---------- */
/* Нужна переменная окружения AI_API_KEY (Settings → Variables). */

const AI_URL = 'https://blank.aigcbest.top/v1/messages';

async function handleAI(request, env) {
  // Простая защита от слива баланса: не больше 30 запросов в час с одного IP
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = 'rl:' + ip + ':' + Math.floor(Date.now() / 3600000);
  const used = parseInt((await env.ORDERS.get(bucket)) || '0', 10);
  if (used >= 30) {
    return json({ error: 'Слишком много запросов, попробуйте позже' }, 429);
  }
  await env.ORDERS.put(bucket, String(used + 1), { expirationTtl: 3700 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  // Модель и потолок токенов фиксируем на сервере — фронту не доверяем
  const sys = String(body.system || '');
  // Прокси работает только на промпты этого сайта — чужие задачи через наш ключ не гоняем
  if (!sys.startsWith('Ты — Амина') && !sys.startsWith('Составь короткую заявку')) {
    return json({ error: 'forbidden' }, 403);
  }
  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: Math.min(Number(body.max_tokens) || 300, 400),
    system: sys.slice(0, 8000),
    messages: Array.isArray(body.messages) ? body.messages.slice(-20) : [],
  };

  const r = await fetch(AI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/* ---------- Статус заказа (для экрана после возврата с оплаты) ---------- */

async function handleStatus(url, env) {
  const id = url.searchParams.get('id') || '';
  if (!/^R[a-z0-9]{6,20}$/i.test(id)) return json({ error: 'bad id' }, 400);
  const raw = await env.ORDERS.get(id);
  if (!raw) return json({ error: 'not found' }, 404);
  const o = JSON.parse(raw);
  // Наружу — только безличные поля. Телефон и адрес не отдаём.
  return json({ id: o.id, paid: !!o.paid, total: o.total, paySum: o.paySum, type: o.type });
}

/* ---------- 1. Фронт присылает заказ ---------- */

async function handleOrder(request, env) {
  // Лимит: не больше 10 заказов в час с одного IP — защита KV от спама
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = 'rlo:' + ip + ':' + Math.floor(Date.now() / 3600000);
  const used = parseInt((await env.ORDERS.get(bucket)) || '0', 10);
  if (used >= 10) {
    return json({ error: 'Слишком много заказов, попробуйте позже' }, 429);
  }
  await env.ORDERS.put(bucket, String(used + 1), { expirationTtl: 3700 });

  let order;
  try {
    order = await request.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  // Минимальная валидация — суммы считает КОД, не ИИ
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return json({ error: 'no items' }, 400);
  }
  if (!order.phone || String(order.phone).length < 7) {
    return json({ error: 'no phone' }, 400);
  }
  const isBooking = order.type === 'booking';
  if (!isBooking && !order.address) {
    return json({ error: 'no address' }, 400);
  }

  // Пересчитываем сумму на сервере по прайсу — защита от подмены на фронте
  const total = calcTotal(order.items);
  if (total === null) {
    return json({ error: 'unknown item' }, 400);
  }

  const orderId = 'R' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Сумма, которую реально попросим оплатить
  const paySum = DEMO_MODE ? DEMO_PRICE : total;

  const record = {
    id: orderId,
    type: isBooking ? 'booking' : 'delivery',
    items: order.items,
    total,
    paySum,
    demo: DEMO_MODE,
    phone: String(order.phone).slice(0, 20),
    address: String(order.address || '').slice(0, 200),
    name: String(order.name || '').slice(0, 60),
    comment: String(order.comment || '').slice(0, 300),
    created: new Date().toISOString(),
    paid: false,
  };

  await env.ORDERS.put(orderId, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 }); // сутки

  // Ссылка на оплату ЮMoney (quickpay)
  const payUrl =
    'https://yoomoney.ru/quickpay/confirm?' +
    new URLSearchParams({
      receiver: env.YOOMONEY_WALLET,
      'quickpay-form': 'button',
      sum: String(paySum),
      label: orderId,
      paymentType: 'AC', // банковская карта; 'PC' — кошелёк ЮMoney
      successURL: safeSuccessURL(order.successURL),
      targets: 'Заказ ' + orderId + ' — RIBAY',
    }).toString();

  return json({ orderId, total, paySum, payUrl });
}

/* Возврат после оплаты — только на наш сайт, чужие адреса не подставляем */
function safeSuccessURL(u) {
  try {
    const parsed = new URL(String(u || ''));
    if (parsed.origin === 'https://hippoundefined101r-spec.github.io') return parsed.href;
  } catch {}
  return 'https://hippoundefined101r-spec.github.io/ribay-steak-house/';
}

/* ---------- Прайс. ЕДИНСТВЕННЫЙ источник цен ---------- */
/* ИИ в промпте знает только названия ключей. Суммы — только здесь. */

const MENU = {
  '1': { title: 'Стейк Рибай', price: 1800 },
  '2': { title: 'Стейк Стриплойн', price: 1600 },
  '3': { title: 'Стейк Тибон', price: 2100 },
  '4': { title: 'Стейк Мачете', price: 1400 },
  '5': { title: 'Шашлык из мякоти баранины', price: 800 },
  '6': { title: 'Шашлык Бастурма', price: 920 },
  '7': { title: 'Шашлык Пистолеты 620г', price: 1150 },
  '8': { title: 'Шашлык Куриный', price: 480 },
  '9': { title: 'Люля из баранины', price: 550 },
  '10': { title: 'Шашлык Ханский', price: 500 },
  '11': { title: 'Пицца Ассорти', price: 550 },
  '12': { title: 'Пицца Пепперони', price: 520 },
  '13': { title: 'Пицца 4 Сыра', price: 500 },
  '14': { title: 'Горячий ролл Цезарь с курицей', price: 400 },
  '15': { title: 'Ролл Ойси', price: 530 },
  '16': { title: 'Сет Япоша', price: 2150 },
  '17': { title: 'Хинкал аварский', price: 450 },
  '18': { title: 'Чуду с мясом', price: 320 },
  '19': { title: 'Дагестанский завтрак', price: 400 },
  '20': { title: 'Шакшука', price: 400 },
  '21': { title: 'Цезарь с курицей', price: 380 },
  '22': { title: 'Греческий', price: 350 },
  '23': { title: 'Тёплый салат с говядиной', price: 490 },
  '33': { title: 'Салат с хрустящими баклажанами', price: 420 },
  '24': { title: 'Сет Шашлычный', price: 3430 },
  '25': { title: 'Сет Хан', price: 4470 },
  '26': { title: 'Сет Шик', price: 3230 },
  '27': { title: 'Английский завтрак', price: 450 },
  '28': { title: 'Скрэмбл', price: 550 },
  '29': { title: 'Сырники', price: 380 },
  '30': { title: 'Чизкейк Нью-Йорк', price: 350 },
  '31': { title: 'Шоколадный фондан', price: 380 },
  '32': { title: 'Баклава', price: 250 },
  'bron': { title: 'Депозит за бронь стола', price: 500 },
};

function calcTotal(items) {
  let sum = 0;
  for (const it of items) {
    const pos = MENU[String(it.id)];
    if (!pos) return null;
    const qty = Math.min(Math.max(parseInt(it.qty) || 1, 1), 20);
    sum += pos.price * qty;
  }
  return sum;
}

/* ---------- 2. Вебхук ЮMoney ---------- */

async function handleYoomoney(request, env) {
  let p;
  try {
    const body = await request.formData();
    p = Object.fromEntries(body.entries());
  } catch {
    return new Response('bad body', { status: 400 });
  }

  // Отсутствующее поле = пустая строка, НЕ undefined
  const f = (k) => (p[k] === undefined || p[k] === null) ? '' : String(p[k]);

  // Проверка подписи по актуальной документации ЮMoney (sign = HMAC-SHA256).
  // Старый sha1_hash перестал приходить с 18.05.2026.
  // Алгоритм: все параметры кроме sign -> сортировка ключей по алфавиту ->
  // URL-кодирование значений (RFC 3986) -> строка key=value&key=value -> HMAC-SHA256 hex.
  const checkString = Object.keys(p)
    .filter((k) => k !== 'sign')
    .sort()
    .map((k) => k + '=' + rfc3986(f(k)))
    .join('&');

  const computed = await hmacSha256Hex(env.YOOMONEY_SECRET || '', checkString);
  const receivedSign = f('sign').toLowerCase();

  if (computed !== receivedSign) {
    console.log('YOOMONEY BAD SIGNATURE', JSON.stringify({
      fields: Object.keys(p),
      notification_type: f('notification_type'),
      amount: f('amount'),
      label: f('label'),
      computed,
      received: receivedSign,
      secretLen: (env.YOOMONEY_SECRET || '').length,
    }));
    return new Response('bad signature', { status: 400 });
  }
  console.log('YOOMONEY OK', f('notification_type'), f('amount'), 'label=' + f('label'),
    f('test_notification') === 'true' ? 'TEST' : '');

  // Тестовое уведомление: подпись сошлась, заказа нет — просто подтверждаем приём
  if (f('test_notification') === 'true') {
    return new Response('ok');
  }

  const orderId = p.label;
  if (!orderId) return new Response('ok'); // перевод без label — не наш заказ

  const raw = await env.ORDERS.get(orderId);
  if (!raw) {
    await tgSend(env, '⚠️ Оплата ' + p.amount + '₽ с label=' + orderId + ', но заказ не найден');
    return new Response('ok');
  }

  const order = JSON.parse(raw);
  // Заказ оплачен И заявка доставлена — дубль уведомления, молча подтверждаем
  if (order.paid && order.notified) return new Response('ok');

  // amount приходит уже за вычетом комиссии — сверяем с запасом ~6%
  const received = parseFloat(p.amount);
  const expected = order.paySum ?? order.total;

  // НЕДОПЛАТА: заказ оплаченным НЕ считаем, людям — тревога.
  // Ссылку quickpay можно собрать руками с любой суммой, поэтому сверка обязательна.
  if (!order.paid && received < expected * 0.94) {
    order.underpaid = received;
    await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 });
    await tgSend(env,
      '🔴 <b>НЕДОПЛАТА по заказу ' + order.id + '</b>\nПоступило ' + received +
      '₽, ожидалось ' + expected + '₽.\nТелефон гостя: ' + esc(order.phone) +
      '\nЗаказ НЕ передан на кухню.');
    return new Response('ok');
  }

  if (!order.paid) {
    order.paid = true;
    order.paidAmount = received;
    order.operationId = p.operation_id;
    await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 7 });
  }

  const lines = order.items
    .map((it) => {
      const pos = MENU[String(it.id)];
      const qty = parseInt(it.qty) || 1;
      return '• ' + (pos ? pos.title : 'позиция ' + it.id) + ' × ' + qty;
    })
    .join('\n');

  const msg =
    (order.type === 'booking' ? '🟡 <b>Оплаченная бронь ' : '🟢 <b>Оплаченный заказ ') + order.id + '</b>' +
    (order.demo ? ' <i>(ДЕМО — оплачено ' + received + '₽)</i>' : '') +
    '\n\n' +
    lines +
    '\n\nСумма заказа: <b>' + order.total + '₽</b>' +
    '\nИмя: ' + esc(order.name || '—') +
    '\nТелефон: ' + esc(order.phone) +
    '\nАдрес: ' + esc(order.address || '—') +
    (order.comment ? '\nКоммент: ' + esc(order.comment) : '');

  // Заявка на кухню — самое важное звено. Не дошла — отвечаем ЮMoney ошибкой,
  // она повторит уведомление, и мы попробуем снова (paid уже true, notified ещё нет).
  const sent = await tgSend(env, msg);
  if (!sent) {
    console.log('TG SEND FAILED for', order.id, '— ждём повтора от ЮMoney');
    return new Response('tg failed, retry', { status: 500 });
  }
  order.notified = true;
  await env.ORDERS.put(orderId, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 7 });
  return new Response('ok');
}

/* ---------- Утилиты ---------- */

async function tgSend(env, text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!r.ok) console.log('TG error', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.log('TG fetch failed', String(e));
    return false;
  }
}

function rfc3986(str) {
  // encodeURIComponent + доэкранирование символов, которые RFC 3986 требует кодировать
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha256Hex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
