/**
 * SCALEFY ADS — Auth Routes
 * POST /api/auth/register
 * POST /api/auth/login
 * GET  /api/auth/me
 */

const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const crypto  = require('crypto');

const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'scalefy_secret')
    .update(password).digest('hex');
}

function generateToken(userId) {
  const payload = { id: userId, ts: Date.now() };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig  = crypto.createHmac('sha256', process.env.JWT_SECRET || 'scalefy_secret')
    .update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'scalefy_secret')
      .update(data).digest('hex');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(data, 'base64').toString());
  } catch { return null; }
}

// Middleware de autenticação para rotas protegidas
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Não autenticado' });
  req.userId = payload.id;
  next();
}

// ─── CADASTRO ────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  }

  try {
    // Verificar se email já existe
    const exists = await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Este email já está cadastrado' });
    }

    const hash = hashPassword(password);
    const { rows } = await db.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, 'admin')
      RETURNING id, name, email, role, created_at
    `, [name.trim(), email.toLowerCase().trim(), hash]);

    const user  = rows[0];
    const token = generateToken(user.id);

    res.status(201).json({ success: true, token, user });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Erro ao criar conta' });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email=$1 AND active=true',
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }

    const user = rows[0];
    const hash = hashPassword(password);

    if (hash !== user.password_hash) {
      return res.status(401).json({ error: 'Email ou senha incorretos' });
    }

    const token = generateToken(user.id);

    res.json({
      success: true,
      token,
      user: {
        id:    user.id,
        name:  user.name,
        email: user.email,
        role:  user.role,
      }
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// ─── DADOS DO USUÁRIO LOGADO ─────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

module.exports = { router, authMiddleware };
