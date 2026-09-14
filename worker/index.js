import * as XLSX from 'xlsx'

const COOKIE = 'geo_session'
const TTL_SECONDS = 60 * 60 * 24 * 30
const MAX_BYTES = 12 * 1024 * 1024
const REQUIRED = ['Orden actual', 'Puesto de trabajo responsable en medidas de mantenimiento', 'Clase de orden', 'Clase de actividad PM']
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

async function readCurrent(env) {
  const stored = await env.DATA.get('current', { type: 'arrayBuffer' })
  if (!stored) return { rows: [], metadata: {} }
  return JSON.parse(await decompressText(stored))
}

async function handleOrders(request, env) {
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405)
  const role = await sessionRole(request, env)
  if (!role) return json({ error: 'Se requiere la contraseña de acceso.' }, 401)
  const current = await readCurrent(env)
  return json({ ...current, viewerRole: role })
}

function normalizeValue(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : value
}

function first(row, keys) {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return ''
}

function normalizeRow(row) {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  )
  normalized.Orden = first(row, ['Orden actual', 'Orden', 'Número de orden'])
  normalized.CLIENTE = first(row, ['Nombre completo', 'CLIENTE'])
  normalized['Pto.tbjo.resp.'] = first(row, ['Puesto de trabajo responsable en medidas de mantenimiento', 'Pto.tbjo.resp.'])
  normalized.DEADLINE = first(row, ['DEADLINE', 'Fecha entrada'])
  normalized.Calle = first(row, ['Calle', 'Calle 4'])
  normalized.Distrito = first(row, ['Distrito', 'Población'])
  normalized['Status usuario ORDEN'] = first(row, ['Status Usuario Orden', 'Status usuario ORDEN'])
  normalized['TIPO MEDIDOR'] = first(row, ['Denominación de tipo del fabricante', 'TIPO MEDIDOR'])
  normalized['Latitud recomendada'] = first(row, ['Latitud recomendada', 'Latitud'])
  normalized['Longitud recomendada'] = first(row, ['Longitud recomendada', 'Longitud'])
  normalized['Transformador DS'] = first(row, ['Transformador DS', 'Placa transformador'])
  normalized['Medidor MD'] = first(row, ['Medidor MD', 'Número de serie'])
  normalized['Equipo CT'] = first(row, ['Equipo CT', 'Número de equipo'])
  normalized.Descripción = first(row, ['Texto cabecera de la orden', 'Clase de actividad PM', 'Descripción'])
  normalized['Tipo de orden'] = first(row, ['Unnamed', 'Clase de orden'])
  normalized['Clase de orden'] = first(row, ['Clase de orden'])
  normalized['Clase de actividad PM'] = first(row, ['Clase de actividad PM'])
  normalized['Texto cabecera de la orden'] = first(row, ['Texto cabecera de la orden'])
  return normalized
}

function decodeBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function handleUpload(request, env) {
  if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)
  if (await sessionRole(request, env) !== 'admin') {
    return json({ error: 'Se requiere autorización administrativa.' }, 403)
  }

  const { filename = '', uploadedBy = '', fileBase64 = '' } = await request.json()
  if (!/\.(xlsx|xlsm|xls)$/i.test(filename)) return json({ error: 'Selecciona un archivo Excel válido.' }, 400)
  if (!uploadedBy.trim()) return json({ error: 'Indica el nombre del responsable de la carga.' }, 400)

  const bytes = decodeBase64(fileBase64)
  if (!bytes.length || bytes.length > MAX_BYTES) {
    return json({ error: 'El archivo está vacío o supera el límite de 12 MB.' }, 400)
  }

  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames.find(name => name.toUpperCase().includes('BASE CONSOLIDADA'))
    || workbook.SheetNames.find(name => name.toUpperCase().includes('BASE OPERATIVA'))
    || workbook.SheetNames[0]
  if (!sheetName) return json({ error: 'El archivo no contiene hojas.' }, 400)

  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true })
  if (!rawRows.length) return json({ error: 'La hoja no contiene órdenes.' }, 400)

  const missing = REQUIRED.filter(column => !(column in rawRows[0]))
  if (missing.length) {
    return json({ error: `La base consolidada no contiene columnas obligatorias: ${missing.join(', ')}.` }, 400)
  }

  const rows = rawRows.map(normalizeRow).filter(row => String(row.Orden ?? '').trim())
  if (!rows.length) return json({ error: 'La hoja no contiene órdenes válidas.' }, 400)

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
  if (current) await env.DATA.put('previous', current)
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
