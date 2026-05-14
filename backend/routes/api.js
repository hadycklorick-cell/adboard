/**
 * ADBOARD — API Routes
 * 
 * POST /api/stores                    → cadastrar loja + token Yampi
 * POST /api/stores/:id/sync           → sync manual
 * GET  /api/stores/:id/sync/status    → status do último sync
 * POST /api/webhooks/yampi            → receber webhook Yampi (tempo real)
 * 
 * GET  /api/dashboard/overview        → KPIs gerais
 * GET  /api/dashboard/daily           → receita+gasto por dia
 * GET  /api/dashboard/channels        → breakdown por canal
 * GET  /api/dashboard/orders          → últimos pedidos (paginado)
 * GET  /api/dashboard/roas            → ROAS por canal
 * 
 * POST /api/spend                     → lançar gasto de mídia
 * GET  /api/spend                     → listar gastos
 * POST /api/costs                     → lançar custo operacional
 */

const express  = require('express');
const router   = express.Router();
const { Pool } = require('pg');
const yampi    = require('../services/yampi');

// ─── Pool PostgreSQL ─────────────────────────────────────────
// Configure via variável de ambiente DATABASE_URL
// Ex: postgresql://user:pass@localhost:5432/adboard
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Middleware de autenticação simples ──────────────────────
// Substitua por JWT/session em produção
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// ════════════════════════════════════════════════════════════
//  LOJAS
// ════════════════════════════════════════════════════════════

// Cadastrar / atualizar loja com token Yampi
router.post('/stores', auth, async (req, res) => {
  const { name, yampi_alias, yampi_token } = req.body;

  if (!yampi_alias || !yampi_token) {
    return res.status(400).json({ error: 'yampi_alias e yampi_token são obrigatórios' });
  }

  try {
    const { rows } = await db.query(`
      INSERT INTO stores (name, yampi_alias, yampi_token)
      VALUES ($1, $2, $3)
      ON CONFLICT (yampi_alias) DO UPDATE SET
        yampi_token = EXCLUDED.yampi_token,
        name        = COALESCE(EXCLUDED.name, stores.name),
        updated_at  = NOW()
      RETURNING id, name, yampi_alias, created_at
    `, [name || yampi_alias, yampi_alias, yampi_token]);

    res.json({ success: true, store: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar loja: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  SYNC
// ════════════════════════════════════════════════════════════

// Disparar sync manual (roda em background)
router.post('/stores/:storeId/sync', auth, async (req, res) => {
  const { storeId } = req.params;
  const { full, since } = req.body;

  const { rows } = await db.query(
    'SELECT * FROM stores WHERE id=$1 AND active=true', [storeId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Loja não encontrada' });

  const store = rows[0];

  // Responde imediatamente, sync roda em background
  res.json({ success: true, message: 'Sync iniciado em background', store_id: storeId });

  const sinceDate = since || (full ? null : getDefaultSince());

  yampi.syncOrders(db, store, { since: sinceDate, full: !!full })
    .then(r => console.log(`[Sync] Concluído: ${JSON.stringify(r)}`))
    .catch(e => console.error(`[Sync] Erro: ${e.message}`));
});

// Status do último sync
router.get('/stores/:storeId/sync/status', auth, async (req, res) => {
  const { rows } = await db.query(`
    SELECT * FROM sync_log
    WHERE store_id = $1
    ORDER BY started_at DESC
    LIMIT 5
  `, [req.params.storeId]);
  res.json({ logs: rows });
});

// ════════════════════════════════════════════════════════════
//  WEBHOOK YAMPI (tempo real)
// ════════════════════════════════════════════════════════════

router.post('/webhooks/yampi', async (req, res) => {
  // Yampi pode enviar um header X-Yampi-Token para validação
  // Configure o mesmo token em: Painel Yampi → Webhooks → Token
  const webhookToken = req.headers['x-yampi-token'];
  if (process.env.YAMPI_WEBHOOK_TOKEN && webhookToken !== process.env.YAMPI_WEBHOOK_TOKEN) {
    return res.status(401).json({ error: 'Webhook token inválido' });
  }

  // Responde 200 imediatamente (Yampi exige resposta rápida)
  res.json({ received: true });

  try {
    const { event, order } = yampi.parseWebhookPayload(req.body);
    console.log(`[Webhook] Evento: ${event} — Pedido #${order.number || order.id}`);

    // Buscar loja pelo alias (vem no header ou no payload)
    const alias = req.headers['x-yampi-alias'] || req.body.store_alias;
    if (!alias) return;

    const { rows } = await db.query(
      'SELECT * FROM stores WHERE yampi_alias=$1', [alias]
    );
    if (!rows.length) return;

    const store = rows[0];

    // Para webhook de pedido único, não precisamos re-buscar a API
    // apenas upsert direto com o payload recebido
    const mapped = yampi.mapOrder(store.id, order);
    await yampi.upsertOrder(db, mapped);

    console.log(`[Webhook] Pedido ${mapped.yampi_order_id} salvo — status: ${mapped.status}`);
  } catch (err) {
    console.error('[Webhook] Erro ao processar:', err.message);
  }
});

// ════════════════════════════════════════════════════════════
//  DASHBOARD — KPIs
// ════════════════════════════════════════════════════════════

router.get('/dashboard/overview', auth, async (req, res) => {
  const { store_id, start, end } = req.query;
  const { startDate, endDate } = parseDateRange(start, end);

  const [revenue, spend, costs] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='paid')           AS orders_paid,
        COUNT(*) FILTER (WHERE status='pending')        AS orders_pending,
        COUNT(*) FILTER (WHERE status='cancelled')      AS orders_cancelled,
        COALESCE(SUM(total_amount) FILTER (WHERE status='paid'), 0) AS gross_revenue,
        COALESCE(AVG(total_amount) FILTER (WHERE status='paid'), 0) AS avg_ticket,
        COUNT(DISTINCT customer_email)
          FILTER (WHERE status='paid')                  AS unique_customers
      FROM orders
      WHERE store_id=$1
        AND yampi_created_at BETWEEN $2 AND $3
    `, [store_id, startDate, endDate]),

    db.query(`
      SELECT
        COALESCE(SUM(amount), 0)        AS total_spend,
        COALESCE(SUM(impressions), 0)   AS impressions,
        COALESCE(SUM(clicks), 0)        AS clicks,
        COALESCE(SUM(conversions), 0)   AS conversions
      FROM ad_spend
      WHERE store_id=$1
        AND spend_date BETWEEN $2 AND $3
    `, [store_id, startDate, endDate]),

    db.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_op_costs
      FROM operational_costs
      WHERE store_id=$1 AND cost_date BETWEEN $2 AND $3
    `, [store_id, startDate, endDate]),
  ]);

  const rev   = revenue.rows[0];
  const sp    = spend.rows[0];
  const op    = costs.rows[0];
  const gross = parseFloat(rev.gross_revenue);
  const adSp  = parseFloat(sp.total_spend);
  const opSp  = parseFloat(op.total_op_costs);

  res.json({
    period: { start: startDate, end: endDate },
    revenue: {
      gross:           gross,
      net:             gross - opSp,
      profit:          gross - adSp - opSp,
      avg_ticket:      parseFloat(rev.avg_ticket),
      orders_paid:     parseInt(rev.orders_paid),
      orders_pending:  parseInt(rev.orders_pending),
      orders_cancelled:parseInt(rev.orders_cancelled),
      unique_customers:parseInt(rev.unique_customers),
    },
    spend: {
      ads:          adSp,
      operational:  opSp,
      total:        adSp + opSp,
    },
    metrics: {
      roas:         adSp > 0 ? +(gross / adSp).toFixed(2) : 0,
      cpa:          parseInt(rev.orders_paid) > 0
                      ? +(adSp / parseInt(rev.orders_paid)).toFixed(2) : 0,
      profit_margin:gross > 0
                      ? +((gross - adSp - opSp) / gross * 100).toFixed(1) : 0,
      impressions:  parseInt(sp.impressions),
      clicks:       parseInt(sp.clicks),
      ctr:          parseInt(sp.impressions) > 0
                      ? +(parseInt(sp.clicks) / parseInt(sp.impressions) * 100).toFixed(2) : 0,
    },
  });
});

// KPIs por canal
router.get('/dashboard/channels', auth, async (req, res) => {
  const { store_id, start, end } = req.query;
  const { startDate, endDate } = parseDateRange(start, end);

  const { rows } = await db.query(`
    SELECT
      channel_slug,
      COUNT(*) FILTER (WHERE status='paid')                         AS orders,
      COALESCE(SUM(total_amount) FILTER (WHERE status='paid'), 0)  AS revenue,
      COALESCE(AVG(total_amount) FILTER (WHERE status='paid'), 0)  AS avg_ticket
    FROM orders
    WHERE store_id=$1
      AND yampi_created_at BETWEEN $2 AND $3
    GROUP BY channel_slug
    ORDER BY revenue DESC
  `, [store_id, startDate, endDate]);

  const spendRows = await db.query(`
    SELECT channel_slug, SUM(amount) AS spend
    FROM ad_spend
    WHERE store_id=$1 AND spend_date BETWEEN $2 AND $3
    GROUP BY channel_slug
  `, [store_id, startDate, endDate]);

  const spendMap = {};
  spendRows.rows.forEach(r => { spendMap[r.channel_slug] = parseFloat(r.spend); });

  const channels = rows.map(r => {
    const rev   = parseFloat(r.revenue);
    const spend = spendMap[r.channel_slug] || 0;
    return {
      channel:    r.channel_slug,
      orders:     parseInt(r.orders),
      revenue:    rev,
      avg_ticket: parseFloat(r.avg_ticket),
      spend:      spend,
      roas:       spend > 0 ? +(rev / spend).toFixed(2) : null,
      cpa:        parseInt(r.orders) > 0 ? +(spend / parseInt(r.orders)).toFixed(2) : null,
    };
  });

  res.json({ channels });
});

// Receita+gasto por dia (para gráficos)
router.get('/dashboard/daily', auth, async (req, res) => {
  const { store_id, start, end } = req.query;
  const { startDate, endDate } = parseDateRange(start, end);

  const [revRows, spendRows] = await Promise.all([
    db.query(`
      SELECT
        DATE(yampi_created_at) AS day,
        COALESCE(SUM(total_amount) FILTER (WHERE status='paid'), 0) AS revenue,
        COUNT(*) FILTER (WHERE status='paid')  AS orders
      FROM orders
      WHERE store_id=$1 AND yampi_created_at BETWEEN $2 AND $3
      GROUP BY DATE(yampi_created_at)
      ORDER BY day
    `, [store_id, startDate, endDate]),

    db.query(`
      SELECT spend_date AS day, SUM(amount) AS spend
      FROM ad_spend
      WHERE store_id=$1 AND spend_date BETWEEN $2 AND $3
      GROUP BY spend_date ORDER BY day
    `, [store_id, startDate, endDate]),
  ]);

  const spendMap = {};
  spendRows.rows.forEach(r => { spendMap[r.day.toISOString().slice(0,10)] = parseFloat(r.spend); });

  const days = revRows.rows.map(r => {
    const day   = r.day.toISOString().slice(0,10);
    const rev   = parseFloat(r.revenue);
    const spend = spendMap[day] || 0;
    return {
      date:   day,
      revenue: rev,
      spend:   spend,
      orders:  parseInt(r.orders),
      roas:    spend > 0 ? +(rev / spend).toFixed(2) : null,
      profit:  rev - spend,
    };
  });

  res.json({ days });
});

// Últimos pedidos
router.get('/dashboard/orders', auth, async (req, res) => {
  const { store_id, page = 1, limit = 20, status, channel } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE o.store_id=$1';
  const params = [store_id];
  let i = 2;

  if (status)  { where += ` AND o.status=$${i++}`;       params.push(status); }
  if (channel) { where += ` AND o.channel_slug=$${i++}`; params.push(channel); }

  params.push(parseInt(limit), offset);

  const { rows } = await db.query(`
    SELECT
      o.yampi_order_number AS number,
      o.status,
      o.total_amount,
      o.channel_slug,
      o.customer_name,
      o.utm_campaign,
      o.yampi_created_at,
      o.items_count
    FROM orders o
    ${where}
    ORDER BY o.yampi_created_at DESC
    LIMIT $${i} OFFSET $${i+1}
  `, params);

  const count = await db.query(
    `SELECT COUNT(*) FROM orders ${where.replace(`LIMIT $${i} OFFSET $${i+1}`,'')}`,
    params.slice(0, -2)
  );

  res.json({
    orders: rows,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: parseInt(count.rows[0].count),
    },
  });
});

// ════════════════════════════════════════════════════════════
//  GASTOS DE MÍDIA
// ════════════════════════════════════════════════════════════

router.post('/spend', auth, async (req, res) => {
  const {
    store_id, channel_slug, campaign_name, adset_name,
    spend_date, amount, impressions, clicks, conversions,
  } = req.body;

  if (!store_id || !channel_slug || !spend_date || !amount) {
    return res.status(400).json({ error: 'store_id, channel_slug, spend_date e amount são obrigatórios' });
  }

  const { rows } = await db.query(`
    INSERT INTO ad_spend
      (store_id, channel_slug, campaign_name, adset_name, spend_date,
       amount, impressions, clicks, conversions, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')
    ON CONFLICT (store_id, channel_slug, campaign_id, spend_date) DO UPDATE SET
      amount      = EXCLUDED.amount,
      impressions = EXCLUDED.impressions,
      clicks      = EXCLUDED.clicks,
      conversions = EXCLUDED.conversions,
      updated_at  = NOW()
    RETURNING *
  `, [store_id, channel_slug, campaign_name, adset_name, spend_date,
      amount, impressions||0, clicks||0, conversions||0]);

  res.json({ success: true, spend: rows[0] });
});

router.get('/spend', auth, async (req, res) => {
  const { store_id, start, end, channel } = req.query;
  const { startDate, endDate } = parseDateRange(start, end);

  let where = 'WHERE store_id=$1 AND spend_date BETWEEN $2 AND $3';
  const params = [store_id, startDate, endDate];
  if (channel) { where += ' AND channel_slug=$4'; params.push(channel); }

  const { rows } = await db.query(
    `SELECT * FROM ad_spend ${where} ORDER BY spend_date DESC`, params
  );
  res.json({ spend: rows });
});

// ════════════════════════════════════════════════════════════
//  CUSTOS OPERACIONAIS
// ════════════════════════════════════════════════════════════

router.post('/costs', auth, async (req, res) => {
  const { store_id, category, description, amount, cost_date, recurrent, notes } = req.body;

  if (!store_id || !category || !amount || !cost_date) {
    return res.status(400).json({ error: 'store_id, category, amount e cost_date são obrigatórios' });
  }

  const { rows } = await db.query(`
    INSERT INTO operational_costs
      (store_id, category, description, amount, cost_date, recurrent, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [store_id, category, description, amount, cost_date, !!recurrent, notes]);

  res.json({ success: true, cost: rows[0] });
});

// ─── Helpers ─────────────────────────────────────────────────
function parseDateRange(start, end) {
  const now = new Date();
  const endDate   = end   ? new Date(end)   : now;
  const startDate = start ? new Date(start) : new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    startDate: startDate.toISOString(),
    endDate:   endDate.toISOString(),
  };
}

function getDefaultSince() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

module.exports = router;
