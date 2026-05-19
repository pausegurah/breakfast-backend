require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { router: breakfastRouter, cache } = require('./routes/breakfast');

// ── Startup env validation (SEGURIDAD 5) ─────────────────────────────────────
const REQUIRED_VARS = ['ULYSSES_BASE_URL', 'ULYSSES_USER', 'ULYSSES_PASS'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`[FATAL] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const IS_PROD    = process.env.NODE_ENV === 'production';
const rawOrigins = (process.env.ALLOWED_ORIGINS || '*').trim();

function ts() { return new Date().toISOString(); }

const app = express();

// ── Helmet (SEGURIDAD 2) ──────────────────────────────────────────────────────
app.use(helmet());

// ── CORS (SEGURIDAD 4) ────────────────────────────────────────────────────────
const allowedList = rawOrigins === '*' ? null : rawOrigins.split(',').map(o => o.trim());

const corsOptions = {
  origin: allowedList
    ? (origin, cb) => {
        // Allow requests with no Origin header (same-origin, curl, mobile apps)
        if (!origin || allowedList.includes(origin)) return cb(null, true);
        console.log(`[${ts()}] [SECURITY] Blocked CORS request from origin: ${origin}`);
        cb(new Error('Not allowed by CORS'));
      }
    : '*',
  methods: ['GET', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));

app.use(express.json());

// ── Rate limiter (SEGURIDAD 1) ────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  skip: (req) => req.path === '/health',
  handler: (req, res) => {
    console.log(`[${ts()}] [SECURITY] Rate limit exceeded from IP ${req.ip}`);
    res.status(429).json({ error: 'Too many requests', retryAfter: 60 });
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ── Request logger + IP + suspicious detection (SEGURIDAD 8) ─────────────────
app.use((req, res, next) => {
  const t0 = Date.now();
  if (!req.headers['user-agent']) {
    console.log(`[${ts()}] [SECURITY] Suspicious request — empty User-Agent from ${req.ip} ${req.method} ${req.path}`);
  }
  res.on('finish', () => {
    console.log(
      `[${ts()}] ${req.ip} ${req.method} ${req.originalUrl}` +
      ` → ${res.statusCode} (${Date.now() - t0}ms)`
    );
  });
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const dates = [...cache.keys()];
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    cache: { entries: dates.length, dates },
  });
});

app.use('/', breakfastRouter);

// ── Startup ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`breakfast-backend listening on :${PORT}`);
  });
}

module.exports = app;
