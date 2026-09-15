const COOKIE = 'geo_session'
const TTL_SECONDS = 60 * 60 * 24 * 30
const encoder = new TextEncoder()

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function base64Url(bytes) {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function signature(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

async function equal(left = '', right = '') {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right))),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let difference = 0
  for (let i = 0; i < x.length; i += 1) difference |= x[i] ^ y[i]
  return difference === 0
}

function assertSecrets(env) {
  for (const name of ['VIEWER_PASSWORD', 'ADMIN_PASSWORD', 'SESSION_SECRET']) {
    if (!env[name]) throw new Error(`${name} no está configurada.`)
  }
}

async function makeSessionCookie(role, env) {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS
  const payload = `${role}.${expires}`
  const signed = await signature(payload, env.SESSION_SECRET)
  return `${COOKIE}=${payload}.${signed}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`
}

async function sessionRole(request, env) {
  assertSecrets(env)
  const cookie = request.headers.get('cookie') || ''
  const token = cookie.split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  if (!token) return null
  const [role, expires, provided] = token.split('.')
  if (!['viewer', 'admin'].includes(role) || !expires || !provided) return null
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return null
  const expected = await signature(`${role}.${expires}`, env.SESSION_SECRET)
  return await equal(provided, expected) ? role : null
}

async function handleSession(request, env) {
  assertSecrets(env)
  if (request.method === 'GET') {
    const role = await sessionRole(request, env)
    return json({ authenticated: !!role, role })
  }
  if (request.method === 'DELETE') {
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    })
  }
  if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)

  const { password = '', role = 'viewer' } = await request.json()
  if (!['viewer', 'admin'].includes(role)) return json({ error: 'Rol no válido.' }, 400)
  const expected = role === 'admin' ? env.ADMIN_PASSWORD : env.VIEWER_PASSWORD
  if (!await equal(password, expected)) return json({ error: 'Contraseña incorrecta.' }, 401)

  return json(
    { authenticated: true, role },
    200,
    { 'set-cookie': await makeSessionCookie(role, env) }
  )
}

async function compressText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompressText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

function removePersonalData(row) {
  const safe = { ...row }
  delete safe.CLIENTE
  delete safe['Teléfono principal']
  delete safe['Nombre completo']
  return safe
}

async function readCurrent(env) {
  const stored = await env.DATA.get('current', { type: 'arrayBuffer' })
  if (!stored) return { rows: [], metadata: {} }
  const current = JSON.parse(await decompressText(stored))
  const sourceRows = Array.isArray(current.rows) ? current.rows : []
  const containedPersonalData = sourceRows.some(row =>
    Object.prototype.hasOwnProperty.call(row, 'CLIENTE')
    || Object.prototype.hasOwnProperty.call(row, 'Teléfono principal')
    || Object.prototype.hasOwnProperty.call(row, 'Nombre completo')
  )
  const safeCurrent = { ...current, rows: sourceRows.map(removePersonalData) }
  if (containedPersonalData) {
    await env.DATA.put('current', await compressText(JSON.stringify(safeCurrent)))
    await env.DATA.delete('previous')
  }
  return safeCurrent
}

async function handleOrders(request, env) {
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405)
  const role = await sessionRole(request, env)
  if (!role) return json({ error: 'Se requiere la contraseña de acceso.' }, 401)
  const current = await readCurrent(env)
  return json({ ...current, viewerRole: role })
}

async function handleUpload(request, env) {
  if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)
  if (await sessionRole(request, env) !== 'admin') {
    return json({ error: 'Se requiere autorización administrativa.' }, 403)
  }

  const { filename = '', uploadedBy = '', rows: submittedRows = [], sheetName = '' } = await request.json()
  if (!/\.(xlsx|xlsm|xls)$/i.test(filename)) return json({ error: 'Selecciona un archivo Excel válido.' }, 400)
  if (!uploadedBy.trim()) return json({ error: 'Indica el nombre del responsable de la carga.' }, 400)
  if (!Array.isArray(submittedRows) || !submittedRows.length) return json({ error: 'La carga no contiene órdenes.' }, 400)
  if (submittedRows.length > 20000) return json({ error: 'La carga supera el máximo de 20,000 órdenes.' }, 413)

  const rows = submittedRows
    .filter(row => row && typeof row === 'object' && String(row.Orden ?? '').trim())
    .map(row => ({
      Orden: row.Orden ?? '',
      'Pto.tbjo.resp.': row['Pto.tbjo.resp.'] ?? '',
      Empresa: row.Empresa ?? 'DESCONOCIDO',
      Funcion: row.Funcion ?? 'DESCONOCIDO',
      DEADLINE: row.DEADLINE ?? '',
      Calle: row.Calle ?? '',
      Distrito: row.Distrito ?? '',
      'Status usuario ORDEN': row['Status usuario ORDEN'] ?? '',
      'TIPO MEDIDOR': row['TIPO MEDIDOR'] ?? '',
      'Latitud recomendada': row['Latitud recomendada'] ?? '',
      'Longitud recomendada': row['Longitud recomendada'] ?? '',
      'Transformador DS': row['Transformador DS'] ?? '',
      'Medidor MD': row['Medidor MD'] ?? '',
      'Equipo CT': row['Equipo CT'] ?? '',
      Descripción: row.Descripción ?? '',
      'Tipo de orden': row['Tipo de orden'] ?? '',
      'Clase de orden': row['Clase de orden'] ?? '',
      'Clase de actividad PM': row['Clase de actividad PM'] ?? '',
      'Texto cabecera de la orden': row['Texto cabecera de la orden'] ?? '',
      'Referencia textual': row['Referencia textual'] ?? '',
      'Fuente coordenada': row['Fuente coordenada'] ?? '',
      Confianza: row.Confianza ?? '',
      'ID fuente': row['ID fuente'] ?? '',
      'Orden previa': row['Orden previa'] ?? '',
      Contratista: row.Contratista ?? '',
      'Condiciones conexion': row['Condiciones conexion'] ?? '',
    }))

  if (!rows.length) return json({ error: 'La carga no contiene órdenes válidas.' }, 400)

  const typeCounts = rows.reduce((result, row) => {
    const type = String(row['Tipo de orden'] || row['Clase de orden'] || 'Sin tipo').trim() || 'Sin tipo'
    result[type] = (result[type] || 0) + 1
    return result
  }, {})

  const payload = {
    rows,
    metadata: {
      source: filename,
      uploadedAt: new Date().toISOString(),
      uploadedBy: uploadedBy.trim(),
      recordCount: rows.length,
      sheetName,
      typeCounts,
    },
  }

  const compressed = await compressText(JSON.stringify(payload))
  if (compressed.byteLength > 24 * 1024 * 1024) {
    return json({ error: 'La base procesada supera la capacidad segura de almacenamiento.' }, 413)
  }

  const current = await env.DATA.get('current', { type: 'arrayBuffer' })
  if (current) {
    const existing = JSON.parse(await decompressText(current))
    const safePrevious = {
      ...existing,
      rows: Array.isArray(existing.rows) ? existing.rows.map(removePersonalData) : [],
    }
    await env.DATA.put('previous', await compressText(JSON.stringify(safePrevious)))
  }
  await env.DATA.put('current', compressed)

  return json({ ok: true, metadata: payload.metadata })
}

async function handleApi(request, env) {
  try {
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/session') return await handleSession(request, env)
    if (pathname === '/api/orders') return await handleOrders(request, env)
    if (pathname === '/api/upload') return await handleUpload(request, env)
    return json({ error: 'Ruta no encontrada.' }, 404)
  } catch (error) {
    console.error(error)
    return json({ error: error?.message || 'Error interno del servidor.' }, 500)
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname
    if (pathname.startsWith('/api/')) return handleApi(request, env)
    return env.ASSETS.fetch(request)
  },
}
