/**
 * ADBOARD — Yampi Integration Service
 * 
 * Cobre:
 *  - Autenticação via token (header User-Token + Alias)
 *  - Listagem e sync incremental de pedidos
 *  - Webhook receiver (pedidos em tempo real)
 *  - Mapeamento de UTMs para atribuição de canal
 */

const axios = require('axios');

const YAMPI_BASE = 'https://api.dooki.com.br/v2';

// ─── Mapeamento de UTM source → canal interno ───────────────
const UTM_CHANNEL_MAP = {
  facebook:  'meta',
  instagram: 'meta',
  fb:        'meta',
  meta:      'meta',
  google:    'google',
  google_ads:'google',
  cpc:       'google',
  tiktok:    'tiktok',
  tik_tok:   'tiktok',
  taboola:   'taboola',
  kwai:      'kwai',
  organic:   'organic',
  email:     'email',
};

function resolveChannel(order) {
  const src = (order?.tracking?.utm_source || '').toLowerCase().trim();
  const med = (order?.tracking?.utm_medium || '').toLowerCase().trim();
  return UTM_CHANNEL_MAP[src] || UTM_CHANNEL_MAP[med] || src || 'direct';
}

// ─── Cliente HTTP Yampi ──────────────────────────────────────
function yampiClient(alias, token, secret) {
  return axios.create({
    baseURL: `${YAMPI_BASE}/${alias}`,
    headers: {
      'User-Token': token,
      'User-Secret-Key': secret,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

// ─── Buscar info da loja ────────────────────────────────────
async function getStoreInfo(alias, token) {
  const client = yampiClient(alias, token, secret);
  const { data } = await client.get('/merchant');
  return data.data;
}

// ─── Buscar pedidos (com paginação automática) ───────────────
/**
 * @param {string}  alias   - alias da loja Yampi
 * @param {string}  token   - token de acesso
 * @param {object}  opts
 * @param {string}  opts.since   - ISO date (busca a partir desta data)
 * @param {string}  opts.until   - ISO date
 * @param {number}  opts.limit   - pedidos por página (max 100)
 * @param {function} opts.onPage - callback chamado a cada página: fn(orders, pageInfo)
 */
async function fetchOrders(alias, token, secret, opts = {}) {
  const client = yampiClient(alias, token, secret);
  const perPage = opts.limit || 100;
  let page = 1;
  let allOrders = [];

  const params = {
    include: 'items,transactions,customer,tracking',
    limit: perPage,
    page,
    sort: '-created_at',
  };

  if (opts.since) params['filter[created_at][gte]'] = opts.since;
  if (opts.until) params['filter[created_at][lte]'] = opts.until;

  while (true) {
    params.page = page;

    const { data } = await client.get('/orders', { params });
    const orders = data.data || [];
    const meta   = data.meta?.pagination || {};

    allOrders = allOrders.concat(orders);

    if (opts.onPage) {
      await opts.onPage(orders, { page, total: meta.total, totalPages: meta.total_pages });
    }

    if (!meta.links?.next || orders.length < perPage) break;
    page++;

    // rate-limit gentil
    await sleep(200);
  }

  return allOrders;
}

// ─── Buscar apenas pedidos novos/atualizados ─────────────────
async function fetchOrdersIncremental(alias, token, secret, sinceDate) {
  return fetchOrders(alias, token, secret, { since: sinceDate });
}

// ─── Mapear pedido Yampi → formato do banco ─────────────────
function mapOrder(storeId, raw) {
  const tracking = raw.tracking || {};
  const customer = raw.customer?.data || {};
  const address  = raw.shipping_address || {};
  const trans    = raw.transactions?.data?.[0] || {};

  return {
    store_id:           storeId,
    yampi_order_id:     raw.id,
    yampi_order_number: raw.number || String(raw.id),
    status:             normalizeStatus(raw.status?.data?.alias || raw.status_alias),
    payment_method:     trans.payment_method || null,
    total_amount:       parseFloat(raw.value || 0),
    discount_amount:    parseFloat(raw.discount || 0),
    shipping_amount:    parseFloat(raw.freight_value || 0),
    channel_slug:       resolveChannel(raw),
    utm_source:         tracking.utm_source   || null,
    utm_medium:         tracking.utm_medium   || null,
    utm_campaign:       tracking.utm_campaign || null,
    utm_content:        tracking.utm_content  || null,
    utm_term:           tracking.utm_term     || null,
    customer_email:     customer.email        || null,
    customer_name:      [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
    customer_phone:     customer.phone        || null,
    city:               address.city          || null,
    state:              address.state         || null,
    items_count:        raw.items?.data?.length || 1,
    yampi_created_at:  raw.created_at?.date ? new Date(raw.created_at.date).toISOString() : null,
  };
}

function mapOrderItems(orderId, raw) {
  return (raw.items?.data || []).map(item => ({
    order_id:       orderId,
    yampi_sku_id:   item.sku_id || null,
    product_name:   item.name || item.product_name || null,
    sku:            item.sku || null,
    quantity:       item.quantity || 1,
    unit_price:     parseFloat(item.price || 0),
  }));
}

function normalizeStatus(alias) {
  const map = {
    'paid': 'paid', 'approved': 'paid', 'complete': 'paid',
    'pending': 'pending', 'waiting_payment': 'pending',
    'cancelled': 'cancelled', 'canceled': 'cancelled',
    'refunded': 'refunded', 'chargeback': 'refunded',
  };
  return map[(alias || '').toLowerCase()] || 'pending';
}

// ─── Webhook handler ─────────────────────────────────────────
/**
 * Processa payload recebido do webhook Yampi.
 * Yampi envia um POST com o objeto do pedido no body.
 * 
 * Registre o webhook na Yampi em:
 *   Painel → Configurações → Webhooks → Adicionar
 *   URL: https://seu-dominio.com/api/webhooks/yampi
 *   Eventos: order.paid, order.cancelled, order.status_changed
 */
function parseWebhookPayload(body) {
  const event  = body.event  || 'order.updated';
  const order  = body.order  || body.data || body;
  return { event, order };
}

// ─── Sync completo com o banco (usando pg) ──────────────────
/**
 * @param {object} db      - instância do Pool do pg
 * @param {object} store   - { id, yampi_alias, yampi_token }
 * @param {object} opts    - { since, full }
 */
async function syncOrders(db, store, opts = {}) {
  const logEntry = await startSyncLog(db, store.id, opts.full ? 'orders_full' : 'orders_incremental');

  try {
    let recordsIn  = 0;
    let recordsNew = 0;
    let recordsUpd = 0;

    await fetchOrders(store.yampi_alias, store.yampi_token, store.yampi_secret_key, {
      since: opts.since,
      onPage: async (orders, pageInfo) => {
        console.log(`[Yampi Sync] Página ${pageInfo.page}/${pageInfo.totalPages} — ${orders.length} pedidos`);

        for (const raw of orders) {
          recordsIn++;
          const mapped = mapOrder(store.id, raw);

          const result = await upsertOrder(db, mapped);
          if (result === 'inserted') recordsNew++;
          if (result === 'updated')  recordsUpd++;

          // Inserir itens
          const items = mapOrderItems(result.id || mapped.yampi_order_id, raw);
          if (items.length) await upsertOrderItems(db, result.orderId, items);
        }
      },
    });

    await finishSyncLog(db, logEntry.id, 'success', { recordsIn, recordsNew, recordsUpd });
    return { success: true, recordsIn, recordsNew, recordsUpd };

  } catch (err) {
    await finishSyncLog(db, logEntry.id, 'error', { error: err.message });
    throw err;
  }
}

// ─── Upsert no banco ─────────────────────────────────────────
async function upsertOrder(db, order) {
  const query = `
    INSERT INTO orders (
      store_id, yampi_order_id, yampi_order_number, status,
      payment_method, total_amount, discount_amount, shipping_amount,
      channel_slug, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      customer_email, customer_name, customer_phone, city, state,
      items_count, yampi_created_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
    )
    ON CONFLICT (store_id, yampi_order_id) DO UPDATE SET
      status          = EXCLUDED.status,
      payment_method  = EXCLUDED.payment_method,
      total_amount    = EXCLUDED.total_amount,
      channel_slug    = COALESCE(EXCLUDED.channel_slug, orders.channel_slug),
      utm_source      = COALESCE(EXCLUDED.utm_source, orders.utm_source),
      utm_medium      = COALESCE(EXCLUDED.utm_medium, orders.utm_medium),
      utm_campaign    = COALESCE(EXCLUDED.utm_campaign, orders.utm_campaign),
      synced_at       = NOW()
    RETURNING id, (xmax = 0) AS inserted
  `;

  const values = [
    order.store_id, order.yampi_order_id, order.yampi_order_number, order.status,
    order.payment_method, order.total_amount, order.discount_amount, order.shipping_amount,
    order.channel_slug, order.utm_source, order.utm_medium, order.utm_campaign,
    order.utm_content, order.utm_term, order.customer_email, order.customer_name,
    order.customer_phone, order.city, order.state, order.items_count, order.yampi_created_at,
  ];

  const { rows } = await db.query(query, values);
  return {
    orderId:  rows[0].id,
    status:   rows[0].inserted ? 'inserted' : 'updated',
  };
}

async function upsertOrderItems(db, orderId, items) {
  for (const item of items) {
    await db.query(`
      INSERT INTO order_items (order_id, yampi_sku_id, product_name, sku, quantity, unit_price)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING
    `, [orderId, item.yampi_sku_id, item.product_name, item.sku, item.quantity, item.unit_price]);
  }
}

// ─── Sync log helpers ────────────────────────────────────────
async function startSyncLog(db, storeId, syncType) {
  const { rows } = await db.query(`
    INSERT INTO sync_log (store_id, sync_type, status)
    VALUES ($1, $2, 'running') RETURNING id
  `, [storeId, syncType]);
  return rows[0];
}

async function finishSyncLog(db, logId, status, data = {}) {
  await db.query(`
    UPDATE sync_log SET
      status       = $2,
      records_in   = $3,
      records_new  = $4,
      records_upd  = $5,
      error_msg    = $6,
      finished_at  = NOW()
    WHERE id = $1
  `, [logId, status, data.recordsIn||0, data.recordsNew||0, data.recordsUpd||0, data.error||null]);
}

// ─── Utilitário ──────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  getStoreInfo,
  fetchOrders,
  fetchOrdersIncremental,
  mapOrder,
  mapOrderItems,
  parseWebhookPayload,
  syncOrders,
  upsertOrder,
  resolveChannel,
};
