/**
 * ADBOARD — Server principal
 * node server.js
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const api     = require('./routes/api');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '2mb' }));

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Rota raiz → login
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'login.html'));
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

// Rotas principais
app.use('/api', api);

// Erro 404
app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// Erro global
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 ADBOARD API rodando em http://localhost:${PORT}`);
  console.log(`   Banco: ${process.env.DATABASE_URL?.split('@')[1] || 'não configurado'}`);
});
