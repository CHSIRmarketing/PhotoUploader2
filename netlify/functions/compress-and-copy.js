const fetch = require('node-fetch');
const sharp = require('sharp');

const {
  DROPBOX_REFRESH_TOKEN,
  DROPBOX_APP_KEY,
  DROPBOX_APP_SECRET
} = process.env;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

async function getAccessToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', DROPBOX_REFRESH_TOKEN);
  params.append('client_id', DROPBOX_APP_KEY);
  params.append('client_secret', DROPBOX_APP_SECRET);

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { path } = JSON.parse(event.body || '{}');
    if (!path) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing "path"' }) };
    }

    const token = await getAccessToken();

    // 1) Download original from Dropbox
    const dlRes = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: `/${path}` })
      }
    });

    if (!dlRes.ok) {
      const t = await dlRes.text();
      throw new Error(`Download failed: ${dlRes.status} ${t}`);
    }
    const original = await dlRes.buffer();

    // 2) Resize/crop to EXACT 1800x1200, center crop
    const meta = await sharp(original, { failOnError: false }).metadata();

    let pipeline = sharp(original, { failOnError: false })
      .rotate()
      .resize({
        width: 1800,
        height: 1200,
        fit: 'cover',
        position: 'centre' // center crop
      });

    let output;
    if ((meta.format || '').toLowerCase() === 'png') {
      // Keep PNG (preserve transparency if present)
      output = await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer();
    } else if ((meta.format || '').toLowerCase() === 'webp') {
      output = await pipeline.webp({ quality: 72 }).toBuffer();
    } else {
      // Default to JPEG
      output = await pipeline.jpeg({ quality: 72, mozjpeg: true }).toBuffer();
    }

    // 3) Compute target path: insert /SIR/ before filename
    const uploadPath = '/' + path.replace(/([^\/]+)$/, 'SIR/$1');

    // 4) Upload compressed copy back to Dropbox
    const upRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: uploadPath,
          mode: 'overwrite',
          autorename: false,
          mute: false
        })
      },
      body: output
    });

    if (!upRes.ok) {
      const t = await upRes.text();
      throw new Error(`Upload failed: ${upRes.status} ${t}`);
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, source: `/${path}`, compressed: uploadPath }) };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
