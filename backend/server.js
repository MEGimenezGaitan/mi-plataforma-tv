const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const app = express();
const PORT = 5011;

// Middlewares
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------------
// INICIALIZAR BASE DE DATOS SQLITE (better-sqlite3)
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

// Asegurar compatibilidad de columnas agregadas previamente
try {
  db.exec("ALTER TABLE contenido ADD COLUMN temporada INTEGER;");
  db.exec("ALTER TABLE contenido ADD COLUMN episodio INTEGER;");
} catch (e) {
  // Las columnas ya existen
}

console.log('[+] Base de datos SQLite inicializada correctamente.');

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// -------------------------------------------------------------------
// CONFIGURACIÓN DE CABECERAS PREDETERMINADAS Y PROXY
// -------------------------------------------------------------------
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
};

// Función aux para invocar extractor.py pasándole una URL o título
function resolverConPython(parametro) {
  return new Promise((resolve, reject) => {
    // Apunta a extractor.py en la carpeta raíz o la subcarpeta scraper
    const scriptPath = path.join(__dirname, 'extractor.py'); 
    const pythonProcess = spawn('python', [scriptPath, parametro]);

    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderrData || `Error con código ${code}`));
      }
      try {
        const jsonResult = JSON.parse(stdoutData);
        resolve(jsonResult);
      } catch (err) {
        reject(new Error('Respuesta inválida del extractor.py'));
      }
    });
  });
}

// -------------------------------------------------------------------
// RUTAS DE LA API (ENDPOINTS)
// -------------------------------------------------------------------

// 1. OBTENER TODO EL CATÁLOGO (O FILTRADO POR TIPO)
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

// 3. RESOLVER SERVIDOR DINÁMICO EJECUTANDO EXTRACTOR.PY
app.get('/api/resolve-stream/:id', async (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM contenido WHERE id = ?').get(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Contenido no encontrado en DB' });
    }

    // Ejecuta el script de Python enviando la URL guardada en la base de datos
    const resolved = await resolverConPython(item.stream_url);

    if (!resolved || !resolved.success) {
      return res.status(502).json({
        success: false,
        message: resolved?.message || 'No se pudo resolver el enlace de reproducción.'
      });
    }

    res.json({
      success: true,
      data: {
        id: item.id,
        titulo: item.titulo,
        ...resolved.data
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. PROXY DE VIDEO (REMITENTE Y REFERER)
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

// 5. AGREGAR NUEVO CONTENIDO
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

// 6. SCRAPER EN TIEMPO REAL
app.get('/api/scrape', async (req, res) => {
  const { title } = req.query;

  if (!title) {
    return res.status(400).json({ success: false, error: 'Título requerido' });
  }

  try {
    const jsonResult = await resolverConPython(title);
    res.json(jsonResult);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. ELIMINAR CONTENIDO
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