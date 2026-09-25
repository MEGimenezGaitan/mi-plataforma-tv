const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const app = express();
const PORT = 5011; // Puerto configurado para la plataforma

// Middlewares
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------------
// INICIALIZAR BASE DE DATOS SQLITE
// -------------------------------------------------------------------
const dbPath = path.join(__dirname, 'plataforma.db');
const db = new Database(dbPath);

// Crear la tabla de contenidos si no existe (incluye temporada y episodio)
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

// Intentar agregar columnas si no existen
try {
  db.exec("ALTER TABLE contenido ADD COLUMN temporada INTEGER;");
  db.exec("ALTER TABLE contenido ADD COLUMN episodio INTEGER;");
} catch (e) {}

console.log('[+] Base de datos SQLite inicializada correctamente.');

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// -------------------------------------------------------------------
// MÓDULOS DE EXTRACCIÓN DINÁMICA DE SERVIDORES
// -------------------------------------------------------------------
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function extractStreamwish(url) {
  try {
    const embedUrl = url.replace('/f/', '/e/');
    const response = await axios.get(embedUrl, {
      headers: { ...DEFAULT_HEADERS, 'Referer': embedUrl },
      timeout: 8000
    });
    const match = response.data.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
    if (!match) throw new Error('m3u8 no encontrado');

    return {
      server: 'Streamwish',
      streamUrl: match[1],
      type: 'hls',
      headers: { 'Referer': embedUrl, 'User-Agent': DEFAULT_HEADERS['User-Agent'] }
    };
  } catch (e) {
    console.warn(`[!] Streamwish falló: ${e.message}`);
    return null;
  }
}

async function extractUqload(url) {
  try {
    const embedUrl = url.replace('/f/', '/e/');
    const response = await axios.get(embedUrl, {
      headers: { ...DEFAULT_HEADERS, 'Referer': 'https://uqload.io/' },
      timeout: 8000
    });
    const match = response.data.match(/sources\s*:\s*\[["'](https?:\/\/[^"']+\.mp4[^"']*)["']\]/);
    if (!match) throw new Error('MP4 no encontrado');

    return {
      server: 'Uqload',
      streamUrl: match[1],
      type: 'mp4',
      headers: { 'Referer': 'https://uqload.io/', 'User-Agent': DEFAULT_HEADERS['User-Agent'] }
    };
  } catch (e) {
    console.warn(`[!] Uqload falló: ${e.message}`);
    return null;
  }
}

async function extractDoodstream(url) {
  try {
    const embedUrl = url.replace('/d/', '/e/');
    const response = await axios.get(embedUrl, {
      headers: { ...DEFAULT_HEADERS, 'Referer': embedUrl },
      timeout: 8000
    });
    const passMatch = response.data.match(/\/pass_md5\/[a-zA-Z0-9\-_]+/);
    if (!passMatch) throw new Error('Token pass_md5 no encontrado');

    const passUrl = `https://dood.to${passMatch[0]}`;
    const passResponse = await axios.get(passUrl, {
      headers: { ...DEFAULT_HEADERS, 'Referer': embedUrl },
      timeout: 8000
    });

    const randomChars = Math.random().toString(36).substring(2, 12);
    const token = passMatch[0].split('/').pop();
    const finalUrl = `${passResponse.data}${randomChars}?token=${token}&expiry=${Date.now()}`;

    return {
      server: 'Doodstream',
      streamUrl: finalUrl,
      type: 'mp4',
      headers: { 'Referer': embedUrl, 'User-Agent': DEFAULT_HEADERS['User-Agent'] }
    };
  } catch (e) {
    console.warn(`[!] Doodstream falló: ${e.message}`);
    return null;
  }
}

async function extractMixdrop(url) {
  try {
    const embedUrl = url.replace('/f/', '/e/');
    const response = await axios.get(embedUrl, {
      headers: { ...DEFAULT_HEADERS, 'Referer': 'https://mixdrop.ag/' },
      timeout: 8000
    });
    const match = response.data.match(/MDCore\.(?:wurl|gurl)\s*=\s*["']([^"']+)["']/);
    if (!match) throw new Error('MDCore.wurl no encontrado');

    let videoUrl = match[1];
    if (videoUrl.startsWith('//')) videoUrl = `https:${videoUrl}`;

    return {
      server: 'Mixdrop',
      streamUrl: videoUrl,
      type: 'mp4',
      headers: { 'Referer': embedUrl, 'User-Agent': DEFAULT_HEADERS['User-Agent'] }
    };
  } catch (e) {
    console.warn(`[!] Mixdrop falló: ${e.message}`);
    return null;
  }
}

// Función orquestadora
async function resolveStream(url) {
  const urlLower = url.toLowerCase();

  if (urlLower.includes('streamwish') || urlLower.includes('wish')) {
    return await extractStreamwish(url);
  } else if (urlLower.includes('uqload')) {
    return await extractUqload(url);
  } else if (urlLower.includes('dood')) {
    return await extractDoodstream(url);
  } else if (urlLower.includes('mixdrop')) {
    return await extractMixdrop(url);
  }

  // Si ya es un stream directo (.m3u8 o .mp4) se entrega directamente
  return {
    server: 'Directo',
    streamUrl: url,
    type: url.includes('.m3u8') ? 'hls' : 'mp4',
    headers: DEFAULT_HEADERS
  };
}

// -------------------------------------------------------------------
// RUTAS DE LA API (ENDPOINTS)
// -------------------------------------------------------------------

// 1. OBTENER TODO EL CATÁLOGO
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

// 2. OBTENER UN SOLO ITEM POR ID
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

// 3. NUEVA RUTA: RESOLVER ENLACE DIRECTO PARA EL REPRODUCTOR
app.get('/api/resolve-stream/:id', async (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM contenido WHERE id = ?').get(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Contenido no encontrado' });
    }

    // Intentar resolver la URL usando el extractor adecuado
    const resolved = await resolveStream(item.stream_url);

    if (!resolved) {
      return res.status(502).json({
        success: false,
        message: 'No se pudo obtener el stream funcional desde el servidor de origen.'
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

// 4. RECIBIR Y GUARDAR DATOS DEL SCRAPER (POST)
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
      message: 'Contenido registrado en la base de datos con éxito',
      id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. SCRAPER EN TIEMPO REAL
app.get('/api/scrape', (req, res) => {
  const { title, type, season, episode } = req.query;

  if (!title) {
    return res.status(400).json({ success: false, error: 'Título requerido' });
  }

  const args = [
    path.join(__dirname, '../scraper/extractor.py'),
    title,
    type || 'movie',
    season || '1',
    episode || '1'
  ];

  const pythonProcess = spawn('python3', args);

  let resultData = '';
  let errorData = '';

  pythonProcess.stdout.on('data', (data) => {
    resultData += data.toString();
  });

  pythonProcess.stderr.on('data', (data) => {
    errorData += data.toString();
  });

  pythonProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`[!] Error en el proceso de Python: ${errorData}`);
      return res.status(500).json({ success: false, error: 'Error ejecutando el extractor' });
    }

    try {
      const jsonResult = JSON.parse(resultData);
      res.json(jsonResult);
    } catch (e) {
      res.status(500).json({ success: false, error: 'Respuesta inválida del extractor' });
    }
  });
});

// 6. ELIMINAR UN CONTENIDO
app.delete('/api/contenido/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM contenido WHERE id = ?');
    const result = stmt.run(req.params.id);
    res.json({ success: true, changes: result.changes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`[+] API Backend lista y corriendo en http://localhost:${PORT}`);
});