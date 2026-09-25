const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
const PORT = 5011;

// Middlewares
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------------
// 1. INICIALIZAR BASE DE DATOS SQLITE (better-sqlite3)
// -------------------------------------------------------------------
const dbPath = path.join(__dirname, 'plataforma.db');
const db = new Database(dbPath);

// Crear la tabla de contenidos si no existe
db.exec(`
  CREATE TABLE IF NOT EXISTS contenido (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    tipo TEXT DEFAULT 'movie',
    año TEXT,
    sinopsis TEXT,
    poster_url TEXT,
    backdrop_url TEXT,
    rating REAL,
    stream_url TEXT NOT NULL,
    user_agent TEXT,
    referer TEXT,
    temporada INTEGER,
    episodio INTEGER,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Garantizar columnas de temporada y episodio
try {
  db.exec("ALTER TABLE contenido ADD COLUMN temporada INTEGER;");
  db.exec("ALTER TABLE contenido ADD COLUMN episodio INTEGER;");
} catch (e) {
  // Las columnas ya existen
}

console.log('[+] Base de datos SQLite inicializada correctamente.');

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../frontend')));

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

// -------------------------------------------------------------------
// 2. EXTRACTOR HEADLESS (PUPPETEER) - CAPTURA DE RED DIRECTA
// -------------------------------------------------------------------
async function extractStreamWithBrowser(targetUrl) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_HEADERS['User-Agent']);

    let streamUrlFound = null;
    let streamType = 'hls';

    // Interceptar peticiones para capturar el flujo de video limpio
    page.on('request', request => {
      const reqUrl = request.url();
      if ((reqUrl.includes('.m3u8') || reqUrl.includes('.mp4')) && !streamUrlFound) {
        // Ignorar previews, miniaturas y tracking
        if (!reqUrl.includes('preview') && !reqUrl.includes('thumb') && !reqUrl.includes('analytics')) {
          streamUrlFound = reqUrl;
          streamType = reqUrl.includes('.m3u8') ? 'hls' : 'mp4';
        }
      }
    });

    // Convertir URLs normales a formato de inserción/embed si aplica
    let embedUrl = targetUrl;
    if (targetUrl.includes('/f/')) embedUrl = targetUrl.replace('/f/', '/e/');
    if (targetUrl.includes('/d/')) embedUrl = targetUrl.replace('/d/', '/e/');

    await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 15000 });

    // Si la reproducción no inicia sola, forzar click en el reproductor
    if (!streamUrlFound) {
      await page.mouse.click(150, 150);
      await new Promise(r => setTimeout(r, 2000));
    }

    await browser.close();

    if (streamUrlFound) {
      return {
        streamUrl: streamUrlFound,
        type: streamType,
        headers: {
          'Referer': embedUrl,
          'User-Agent': DEFAULT_HEADERS['User-Agent']
        }
      };
    }

    return null;
  } catch (error) {
    console.error(`[!] Error extrayendo enlace con Puppeteer: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

// -------------------------------------------------------------------
// 3. RUTAS DE LA API
// -------------------------------------------------------------------

// Obtener todo el catálogo o filtrar por tipo
app.get('/api/contenido', (req, res) => {
  try {
    const { tipo } = req.query;
    let query = 'SELECT * FROM contenido ORDER BY id DESC';
    let params = [];

    if (tipo) {
      query = 'SELECT * FROM contenido WHERE tipo = ? ORDER BY id DESC';
      params.push(tipo);
    }

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener un ítem por ID
app.get('/api/contenido/:id', (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM contenido WHERE id = ?').get(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Contenido no encontrado' });
    }
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resolver flujo de video mediante Puppeteer
app.get('/api/resolve-stream/:id', async (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM contenido WHERE id = ?').get(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Contenido no encontrado' });
    }

    console.log(`[*] Resolviendo stream para: ${item.titulo}`);
    const resolved = await extractStreamWithBrowser(item.stream_url);

    if (!resolved) {
      return res.status(502).json({
        success: false,
        message: 'No se pudo capturar la URL del stream desde el servidor.'
      });
    }

    res.json({
      success: true,
      data: {
        id: item.id,
        titulo: item.titulo,
        ...resolved
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Proxy de transmisión para omitir bloqueos por Referer/CORS
app.get('/api/proxy-stream', async (req, res) => {
  const { url, referer } = req.query;

  if (!url) {
    return res.status(400).send('URL de video requerida');
  }

  try {
    const response = await axios({
      method: 'get',
      url: decodeURIComponent(url),
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        'Referer': referer ? decodeURIComponent(referer) : ''
      },
      responseType: 'stream'
    });

    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (error) {
    console.error('[Proxy Stream Error]:', error.message);
    res.status(500).send('Error redirigiendo el flujo multimedia.');
  }
});

// Registrar nuevo contenido
app.post('/api/contenido', (req, res) => {
  const {
    titulo,
    tipo,
    año,
    sinopsis,
    poster_url,
    backdrop_url,
    rating,
    stream_url,
    headers,
    temporada,
    episodio
  } = req.body;

  if (!titulo || !stream_url) {
    return res.status(400).json({
      success: false,
      message: 'Se requieren obligatoriamente "titulo" y "stream_url"'
    });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO contenido (
        titulo, tipo, año, sinopsis, poster_url, backdrop_url, rating, stream_url, user_agent, referer, temporada, episodio
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      titulo,
      tipo || 'movie',
      año || 'N/A',
      sinopsis || '',
      poster_url || '',
      backdrop_url || '',
      rating || 0.0,
      stream_url,
      headers?.['User-Agent'] || '',
      headers?.['Referer'] || '',
      temporada || null,
      episodio || null
    );

    res.status(201).json({
      success: true,
      message: 'Contenido registrado con éxito',
      id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Eliminar contenido
app.delete('/api/contenido/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM contenido WHERE id = ?');
    const result = stmt.run(req.params.id);
    res.json({ success: true, changes: result.changes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`[+] API Backend corriendo en http://localhost:${PORT}`);
});