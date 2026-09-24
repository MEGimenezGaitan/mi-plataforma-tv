const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

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

// Intentar agregar columnas de temporada y episodio si la tabla ya existía de antes
try {
  db.exec("ALTER TABLE contenido ADD COLUMN temporada INTEGER;");
  db.exec("ALTER TABLE contenido ADD COLUMN episodio INTEGER;");
} catch (e) {
  // Las columnas ya existen en la base de datos
}

console.log('[+] Base de datos SQLite inicializada correctamente.');

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// -------------------------------------------------------------------
// RUTAS DE LA API (ENDPOINTS)
// -------------------------------------------------------------------

// 1. OBTENER TODO EL CATÁLOGO (O FILTRAR POR TIPO: 'movie' O 'tv')
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

// 3. RECIBIR Y GUARDAR DATOS DEL SCRAPER (POST)
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

// 4. SCRAPER EN TIEMPO REAL (Admite tipo, temporada y episodio)
app.get('/api/scrape', (req, res) => {
  const { title, type, season, episode } = req.query;

  if (!title) {
    return res.status(400).json({ success: false, error: 'Título requerido' });
  }

  // Argumentos enviando título, tipo (movie/serie), temporada y episodio a Python
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

// 5. ELIMINAR UN CONTENIDO
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