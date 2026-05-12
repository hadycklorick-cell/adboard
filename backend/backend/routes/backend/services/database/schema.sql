-- ============================================================
--  ADBOARD — Schema PostgreSQL completo
--  Versão 1.0
-- ============================================================

-- Extensões
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- TABELA: lojas (multi-tenant, suporte a várias lojas Yampi)
-- ============================================================
CREATE TABLE stores (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100) NOT NULL,
  yampi_alias   VARCHAR(100) NOT NULL UNIQUE,  -- alias da loja na Yampi (ex: minhaloja)
  yampi_token   TEXT,                           -- token de acesso Yampi (encriptado)
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABELA: canais de mídia
-- ============================================================
CREATE TABLE media_channels (
  id          SERIAL PRIMARY KEY,
  store_id    UUID REFERENCES stores(id) ON DELETE CASCADE,
  slug        VARCHAR(30) NOT NULL,   -- 'meta', 'google', 'tiktok', 'taboola', 'kwai'
  label       VARCHAR(60) NOT NULL,
  color_hex   VARCHAR(7),
  api_token   TEXT,                   -- token da plataforma (encriptado)
  account_id  VARCHAR(100),
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, slug)
);

-- ============================================================
-- TABELA: pedidos (sincronizados da Yampi)
-- ============================================================
CREATE TABLE orders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id          UUID REFERENCES stores(id) ON DELETE CASCADE,
  yampi_order_id    BIGINT NOT NULL,
  yampi_order_number VARCHAR(30),
  status            VARCHAR(30) NOT NULL,   -- paid, pending, cancelled, refunded
  payment_method    VARCHAR(50),
  total_amount      NUMERIC(12,2) NOT NULL,
  discount_amount   NUMERIC(12,2) DEFAULT 0,
  shipping_amount   NUMERIC(12,2) DEFAULT 0,
  net_amount        NUMERIC(12,2) GENERATED ALWAYS AS (total_amount - discount_amount) STORED,
  channel_slug      VARCHAR(30),             -- origem atribuída (meta, google…)
  utm_source        VARCHAR(100),
  utm_medium        VARCHAR(100),
  utm_campaign      VARCHAR(200),
  utm_content       VARCHAR(200),
  utm_term          VARCHAR(200),
  customer_email    VARCHAR(200),
  customer_name     VARCHAR(200),
  customer_phone    VARCHAR(30),
  city              VARCHAR(100),
  state             VARCHAR(50),
  items_count       INTEGER DEFAULT 1,
  yampi_created_at  TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, yampi_order_id)
);

CREATE INDEX idx_orders_store_status   ON orders(store_id, status);
CREATE INDEX idx_orders_store_date     ON orders(store_id, yampi_created_at DESC);
CREATE INDEX idx_orders_channel        ON orders(store_id, channel_slug);
CREATE INDEX idx_orders_yampi_id       ON orders(yampi_order_id);

-- ============================================================
-- TABELA: produtos dos pedidos
-- ============================================================
CREATE TABLE order_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES orders(id) ON DELETE CASCADE,
  yampi_sku_id    BIGINT,
  product_name    VARCHAR(300),
  sku             VARCHAR(100),
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_price      NUMERIC(12,2) NOT NULL,
  total_price     NUMERIC(12,2) GENERATED ALWAYS AS (unit_price * quantity) STORED
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ============================================================
-- TABELA: gastos de mídia (lançados manualmente ou via API)
-- ============================================================
CREATE TABLE ad_spend (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id        UUID REFERENCES stores(id) ON DELETE CASCADE,
  channel_slug    VARCHAR(30) NOT NULL,
  campaign_id     VARCHAR(200),
  campaign_name   VARCHAR(300),
  adset_name      VARCHAR(300),
  ad_name         VARCHAR(300),
  spend_date      DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  impressions     BIGINT DEFAULT 0,
  clicks          BIGINT DEFAULT 0,
  conversions     INTEGER DEFAULT 0,
  revenue_attributed NUMERIC(12,2) DEFAULT 0,
  source          VARCHAR(20) DEFAULT 'manual',  -- 'manual' | 'api'
  raw_data        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, channel_slug, campaign_id, spend_date)
);

CREATE INDEX idx_ad_spend_store_date    ON ad_spend(store_id, spend_date DESC);
CREATE INDEX idx_ad_spend_channel       ON ad_spend(store_id, channel_slug);
CREATE INDEX idx_ad_spend_campaign      ON ad_spend(store_id, campaign_name);

-- ============================================================
-- TABELA: custos operacionais / gastos não-mídia
-- ============================================================
CREATE TABLE operational_costs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id        UUID REFERENCES stores(id) ON DELETE CASCADE,
  category        VARCHAR(80) NOT NULL,   -- 'produto', 'frete', 'plataforma', 'funcionario', 'outro'
  description     VARCHAR(300),
  amount          NUMERIC(12,2) NOT NULL,
  cost_date       DATE NOT NULL,
  recurrent       BOOLEAN DEFAULT false,
  recurrence      VARCHAR(20),            -- 'monthly', 'weekly'
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_op_costs_store_date ON operational_costs(store_id, cost_date DESC);

-- ============================================================
-- TABELA: pixels (rastreamento)
-- ============================================================
CREATE TABLE pixels (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id      UUID REFERENCES stores(id) ON DELETE CASCADE,
  channel_slug  VARCHAR(30) NOT NULL,
  pixel_id      VARCHAR(200) NOT NULL,
  label         VARCHAR(100),
  active        BOOLEAN DEFAULT true,
  events_today  INTEGER DEFAULT 0,
  last_event_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, channel_slug, pixel_id)
);

-- ============================================================
-- TABELA: sync_log (auditoria de sincronizações Yampi)
-- ============================================================
CREATE TABLE sync_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id      UUID REFERENCES stores(id) ON DELETE CASCADE,
  sync_type     VARCHAR(30),   -- 'orders_full', 'orders_incremental', 'webhook'
  status        VARCHAR(20),   -- 'running', 'success', 'error'
  records_in    INTEGER DEFAULT 0,
  records_new   INTEGER DEFAULT 0,
  records_upd   INTEGER DEFAULT 0,
  error_msg     TEXT,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

-- ============================================================
-- VIEWS úteis
-- ============================================================

-- Resumo de vendas por dia e canal
CREATE VIEW v_daily_sales AS
SELECT
  store_id,
  DATE(yampi_created_at) AS sale_date,
  channel_slug,
  COUNT(*) FILTER (WHERE status = 'paid')       AS orders_paid,
  COUNT(*) FILTER (WHERE status = 'pending')    AS orders_pending,
  COUNT(*) FILTER (WHERE status = 'cancelled')  AS orders_cancelled,
  SUM(total_amount) FILTER (WHERE status = 'paid') AS revenue,
  AVG(total_amount) FILTER (WHERE status = 'paid') AS avg_ticket
FROM orders
GROUP BY 1, 2, 3;

-- ROAS por canal por dia
CREATE VIEW v_daily_roas AS
SELECT
  s.store_id,
  s.spend_date,
  s.channel_slug,
  s.amount                                         AS spend,
  COALESCE(r.revenue, 0)                           AS revenue,
  CASE WHEN s.amount > 0
       THEN ROUND(COALESCE(r.revenue,0) / s.amount, 2)
       ELSE 0 END                                  AS roas,
  COALESCE(r.orders_paid, 0)                       AS conversions,
  CASE WHEN COALESCE(r.orders_paid, 0) > 0
       THEN ROUND(s.amount / r.orders_paid, 2)
       ELSE 0 END                                  AS cpa
FROM (
  SELECT store_id, spend_date, channel_slug, SUM(amount) AS amount
  FROM ad_spend GROUP BY 1,2,3
) s
LEFT JOIN (
  SELECT store_id, DATE(yampi_created_at) AS d, channel_slug,
         SUM(total_amount) AS revenue, COUNT(*) AS orders_paid
  FROM orders WHERE status = 'paid'
  GROUP BY 1,2,3
) r ON r.store_id = s.store_id AND r.d = s.spend_date AND r.channel_slug = s.channel_slug;

-- Lucro líquido por dia (receita - mídia - custos operacionais)
CREATE VIEW v_daily_profit AS
SELECT
  o.store_id,
  DATE(o.yampi_created_at)          AS sale_date,
  SUM(o.total_amount)
    FILTER (WHERE o.status='paid')  AS gross_revenue,
  COALESCE(sp.total_spend, 0)       AS ad_spend,
  COALESCE(op.total_op_costs, 0)    AS op_costs,
  SUM(o.total_amount)
    FILTER (WHERE o.status='paid')
    - COALESCE(sp.total_spend, 0)
    - COALESCE(op.total_op_costs,0) AS net_profit
FROM orders o
LEFT JOIN (
  SELECT store_id, spend_date, SUM(amount) AS total_spend
  FROM ad_spend GROUP BY 1,2
) sp ON sp.store_id = o.store_id AND sp.spend_date = DATE(o.yampi_created_at)
LEFT JOIN (
  SELECT store_id, cost_date, SUM(amount) AS total_op_costs
  FROM operational_costs GROUP BY 1,2
) op ON op.store_id = o.store_id AND op.cost_date = DATE(o.yampi_created_at)
GROUP BY o.store_id, DATE(o.yampi_created_at), sp.total_spend, op.total_op_costs;
