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

  // Промпт выбирается ЗДЕСЬ по режиму. Фронт промптов не знает и прислать свой не может.
  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: Math.min(Number(body.max_tokens) || 500, 800),
    system: body.mode === 'lead' ? SYSTEM_LEAD : systemChat(),
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

/* ---------- Мозги Амины живут ЗДЕСЬ, на сервере. Во фронте их нет. ---------- */

const CAT_LABELS = { steaks:'Стейки', shashlik:'Шашлыки', pizza:'Пицца', rolls:'Роллы', dag:'Дагестанская кухня', salads:'Салаты', sets:'Сеты', breakfast:'Завтраки', desserts:'Десерты', other:'Другое' };

function menuText() {
  const byCat = {};
  for (const [id, m] of Object.entries(MENU)) {
    if (id === 'bron') continue;
    (byCat[m.cat] = byCat[m.cat] || []).push('[id ' + id + '] ' + m.title + ' \u2014 ' + m.price + '\u20bd');
  }
  return Object.entries(byCat).map(([c, arr]) => (CAT_LABELS[c] || c) + ': ' + arr.join('; ')).join('. ');
}

const ORDER_RULES = 'ОФОРМЛЕНИЕ И ОПЛАТА: заказ доставки и бронь стола оформляются прямо в чате с онлайн-оплатой, никакого WhatsApp не предлагай. Для доставки собери: блюда с количеством, имя, телефон, адрес. Для брони: дата, время, число гостей, имя, телефон — бронь подтверждается депозитом 500₽. Когда всё собрано, перечисли заказ гостю и спроси подтверждение. Только после явного подтверждения гостя добавь В САМОМ КОНЦЕ ответа служебную строку строго в формате [[ЗАКАЗ]]{"type":"delivery","items":[{"id":1,"qty":2}],"phone":"+7...","address":"улица, дом","name":"имя","comment":""}[[/ЗАКАЗ]] — id блюд бери только из меню выше, ничего не выдумывай. Для брони: "type":"booking", "items":[{"id":"bron","qty":1}], дату, время и число гостей запиши в comment, address не нужен. Гость служебную строку не увидит — после неё на сайте появится кнопка оплаты, так и скажи: сейчас появится кнопка оплаты ниже. Сумму к оплате сам не называй и не считай. Служебную строку [[ЗАКАЗ]] отправляй РОВНО ОДИН РАЗ на заказ. Если в диалоге уже есть пометка (заказ оформлен, кнопка оплаты отправлена) — НИКОГДА не отправляй её повторно: ни на приветствие, ни на вопрос. Повторная строка допустима только если гость собрал совершенно новый заказ и явно подтвердил его. ';

function systemChat() {
  return "Ты — Амина, консультант ресторана RIBAY Steak House в Махачкале (ул. Уллуаинская, 1, посёлок Семендер, Кировский район). Стейк-хаус: стейки из мраморной говядины на живом огне, шашлыки, дагестанская кухня, пицца, роллы. Рейтинг 4.7 в 2ГИС. Работаем ежедневно 12:00–24:00. Залы: основной, кабинки, VIP-зал, банкетный зал — всё бронируется. Есть молельная комната. Доставка: ежедневно 12:00–24:00, в среднем 60 минут, минимальный заказ 500₽, бесплатно от 1500₽. Телефон и WhatsApp: +7 969 770-07-00. МЕНЮ С ЦЕНАМИ: " + menuText() + ". ТОН: тёплый, гостеприимный, живой — как хороший официант, который знает меню наизусть. Простой человеческий язык, без канцелярита и без панибратства. Эмодзи не используй. ОБРАЩЕНИЕ: зеркаль гостя — на ты отвечай на ты, на вы — на вы. ПРАВИЛА: отвечай коротко, 1-3 предложения. Цены называй смело — они из меню. Советуй блюда под вкус, компанию и бюджет гостя, предлагай сочетания (стейк + салат, сет на компанию). " + ORDER_RULES + "Про бронь уточняй дату, время и число гостей, если гость сам не сказал. Чего нет в меню — честно говори, что нет, и предлагай похожее. На вопросы не про ресторан вежливо возвращай к теме. На салам/ассаляму алейкум отвечай: Ваалейкум ассалям.";
}

const SYSTEM_LEAD = 'Составь короткую заявку для менеджера ресторана по диалогу. Формат строго: "Ассаляму алейкум! Пишу с сайта RIBAY. <Бронь стола: дата, время, гостей / Доставка: блюда и адрес если известны / Вопрос: суть>." Только известное из диалога, ничего не выдумывай. Одной строкой, без лишних слов.';

/* ---------- Прайс. ЕДИНСТВЕННЫЙ источник цен ---------- */
/* ИИ в промпте знает только названия ключей. Суммы — только здесь. */

const MENU = {
  '1': { cat: 'steaks', title: 'Стейк Рибай', price: 1800 },
  '2': { cat: 'steaks', title: 'Стейк Стриплойн', price: 1600 },
  '3': { cat: 'steaks', title: 'Стейк Тибон', price: 2100 },
  '4': { cat: 'steaks', title: 'Стейк Мачете', price: 1400 },
  '5': { cat: 'shashlik', title: 'Шашлык из мякоти баранины', price: 800 },
  '6': { cat: 'shashlik', title: 'Шашлык Бастурма', price: 920 },
  '7': { cat: 'shashlik', title: 'Шашлык Пистолеты 620г', price: 1150 },
  '8': { cat: 'shashlik', title: 'Шашлык Куриный', price: 480 },
  '9': { cat: 'shashlik', title: 'Люля из баранины', price: 550 },
  '10': { cat: 'shashlik', title: 'Шашлык Ханский', price: 500 },
  '11': { cat: 'pizza', title: 'Пицца Ассорти', price: 550 },
  '12': { cat: 'pizza', title: 'Пицца Пепперони', price: 520 },
  '13': { cat: 'pizza', title: 'Пицца 4 Сыра', price: 500 },
  '14': { cat: 'rolls', title: 'Горячий ролл Цезарь с курицей', price: 400 },
  '15': { cat: 'rolls', title: 'Ролл Ойси', price: 530 },
  '16': { cat: 'rolls', title: 'Сет Япоша', price: 2150 },
  '17': { cat: 'dag', title: 'Хинкал аварский', price: 450 },
  '18': { cat: 'dag', title: 'Чуду с мясом', price: 320 },
  '19': { cat: 'dag', title: 'Дагестанский завтрак', price: 400 },
  '20': { cat: 'dag', title: 'Шакшука', price: 400 },
  '21': { cat: 'salads', title: 'Цезарь с курицей', price: 380 },
  '22': { cat: 'salads', title: 'Греческий', price: 350 },
  '23': { cat: 'salads', title: 'Тёплый салат с говядиной', price: 490 },
  '33': { cat: 'salads', title: 'Салат с хрустящими баклажанами', price: 420 },
  '24': { cat: 'sets', title: 'Сет Шашлычный', price: 3430 },
  '25': { cat: 'sets', title: 'Сет Хан', price: 4470 },
  '26': { cat: 'sets', title: 'Сет Шик', price: 3230 },
  '27': { cat: 'breakfast', title: 'Английский завтрак', price: 450 },
  '28': { cat: 'breakfast', title: 'Скрэмбл', price: 550 },
  '29': { cat: 'breakfast', title: 'Сырники', price: 380 },
  '30': { cat: 'desserts', title: 'Чизкейк Нью-Йорк', price: 350 },
  '31': { cat: 'desserts', title: 'Шоколадный фондан', price: 380 },
  '32': { cat: 'desserts', title: 'Баклава', price: 250 },
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
