const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const puppeteer = require('puppeteer');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5011;

// Conexión a la base de datos SQLite
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('Error al conectar con SQLite:', err.message);
  else console.log('Conectado a la base de datos SQLite.');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Obtener contenido por tmdb_id
app.get('/api/contenido/:tmdbId', (req, res) => {
  const { tmdbId } = req.params;
  const query = 'SELECT * FROM contenidos WHERE tmdb_id = ? OR id = ?';
  
  db.get(query, [tmdbId, tmdbId], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Error interno en BD' });
    }
    if (!row) {
      return res.status(404).json({ success: false, message: 'Contenido no encontrado' });
    }
    res.json({ success: true, data: row });
  });
});

// 2. Extraer stream real mediante Puppeteer
app.get('/api/resolve-stream/:id', async (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM contenidos WHERE id = ?', [id], async (err, row) => {
    if (err || !row || !row.url_origen) {
      return res.status(404).json({ success: false, message: 'Registro o URL de origen no encontrados' });
    }

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      let foundStreamUrl = null;

      // Interceptar peticiones de red para capturar el archivo manifest HLS / MP4
      page.on('request', (request) => {
        const url = request.url();
        if ((url.includes('.m3u8') || url.includes('.mp4')) && !foundStreamUrl) {
          foundStreamUrl = url;
        }
      });

      await page.goto(row.url_origen, { waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});

      await browser.close();

      if (foundStreamUrl) {
        return res.json({
          success: true,
          data: {
            streamUrl: foundStreamUrl,
            type: foundStreamUrl.includes('.m3u8') ? 'hls' : 'mp4',
            headers: { Referer: row.url_origen }
          }
        });
      } else {
        return res.status(500).json({ success: false, message: 'No se pudo extraer la URL del video' });
      }

    } catch (error) {
      if (browser) await browser.close();
      return res.status(500).json({ success: false, message: 'Error procesando la extracción: ' + error.message });
    }
  });
});

// 3. Proxy para evitar bloqueos por CORS / Referer
app.get('/api/proxy-stream', async (req, res) => {
  const { url, referer } = req.query;

  if (!url) {
    return res.status(400).send('Parámetro URL requerido');
  }

  try {
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer || '',
        'Origin': new URL(url).origin
      }
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'application/x-mpegURL');
    response.data.pipe(res);
  } catch (error) {
    res.status(500).send('Error retransmitiendo el flujo de video');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});