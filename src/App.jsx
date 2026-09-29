import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { CircleMarker, MapContainer, Pane, Polyline, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet'
import {
  AlertTriangle, ArrowLeft, Building2, CheckCircle2, ChevronRight,
  Database, ExternalLink, LocateFixed, MapPinned, Navigation, Phone,
  RefreshCw, Search, Smartphone, UserRound, WifiOff, Zap, LockKeyhole, UploadCloud, X,
  Layers3, Route
} from 'lucide-react'
import {
  clean, getInfoQuality, mapsUrl, validCoordinate, wazeUrl
} from './utils'
import { personnelByResponsible } from './personnel'

// La base se actualiza de forma administrativa; consultar KV cada 30 segundos
// consume innecesariamente la cuota gratuita. Diez minutos mantiene una vista
// suficientemente fresca y deja el botón manual para actualizaciones urgentes.
const AUTO_REFRESH_MS = 10 * 60_000
const ROUTE_MAX_STOPS = 15
const ZDESC_EXPECTED_RETURN_RATE = 0.70
const ROUTE_COMPACT_INCREMENT_METERS = 6_000
const ROUTE_DISTANCE_BUDGET_METERS = 45_000
const INITIAL_FILTERS = {
  company: '',
  responsible: '',
  query: '',
  selectedTypes: [],
  selectedActivity: '',
}
const EMPTY_ROUTE_PLAN = { ids: [], geometry: [], source: '', distanceMeters: 0, durationSeconds: 0, notice: '' }

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
    ...options,
  })
  const responseText = await response.text()
  let body = {}
  try { body = responseText ? JSON.parse(responseText) : {} } catch { body = {} }
  if (!response.ok) {
    const error = new Error(body.error || `El servidor rechazó la solicitud (HTTP ${response.status}).`)
    error.status = response.status
    throw error
  }
  return body
}

async function loadOrders(signal) {
  const result = await apiJson(`/api/orders?v=${Date.now()}`, { signal })
  if (!Array.isArray(result.rows)) throw new Error('La respuesta de la base operativa no es válida.')
  return {
    rows: result.rows.filter(row => clean(row.Orden)),
    metadata: result.metadata || {},
    role: result.viewerRole || 'viewer',
  }
}

function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState(null)
  useEffect(() => {
    const handler = event => { event.preventDefault(); setPromptEvent(event) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])
  const install = async () => {
    if (!promptEvent) return
    await promptEvent.prompt()
    await promptEvent.userChoice
    setPromptEvent(null)
  }
  return { canInstall: !!promptEvent, install }
}

function FitMap({ rows }) {
  const map = useMap()
  useEffect(() => {
    const points = rows
      .filter(row => validCoordinate(row['Latitud recomendada'], row['Longitud recomendada']))
      .map(row => [Number(row['Latitud recomendada']), Number(row['Longitud recomendada'])])
    setTimeout(() => map.invalidateSize(true), 50)
    if (!points.length) return
    if (points.length === 1) map.setView(points[0], 16)
    else map.fitBounds(points, { padding: [28, 28], maxZoom: 15 })
  }, [rows, map])
  return null
}

function LoadingScreen() {
  return <main className="state-shell"><section className="state-card"><div className="app-logo"><MapPinned size={30}/></div><div className="loader"/><h1>GeoOperación</h1><p>Sincronizando la base operativa…</p><span>Consultando la base operativa protegida.</span></section></main>
}

function ErrorScreen({ message, onRetry }) {
  return <main className="state-shell"><section className="state-card error-state"><div className="app-logo danger"><WifiOff size={29}/></div><h1>Base no disponible</h1><p>{message}</p><div className="stale-warning"><AlertTriangle size={18}/><span>Por seguridad no se muestran registros de una versión anterior.</span></div><button className="primary-button" onClick={onRetry}><RefreshCw size={18}/> Reintentar</button></section></main>
}

function AccessScreen({ onAuthenticated }) {
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async event => {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const result = await apiJson('/api/session', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ password, role:'viewer' }) })
      onAuthenticated(result.role)
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }
  return <main className="state-shell access-shell"><form className="state-card access-card" onSubmit={submit}><div className="app-logo"><LockKeyhole size={29}/></div><span className="eyebrow">Acceso operativo</span><h1>GeoOperación</h1><p>Ingresa la contraseña compartida para consultar las órdenes.</p><label className="access-field"><span>Contraseña</span><input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required autoFocus/></label>{message&&<div className="form-error">{message}</div>}<button className="primary-button full-button" disabled={busy}>{busy?'Verificando…':'Ingresar'}</button><small>La sesión permanecerá activa durante 30 días en este dispositivo.</small></form></main>
}

const UPLOAD_REQUIRED = ['Orden actual', 'Puesto de trabajo responsable en medidas de mantenimiento', 'Clase de orden', 'Clase de actividad PM']

function firstUploadValue(row, keys) {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim() !== '') return value
  }
  return ''
}

function normalizeUploadValue(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : value
}

function normalizeUploadRow(row) {
  const responsible = clean(firstUploadValue(row, ['Puesto de trabajo responsable en medidas de mantenimiento', 'Pto.tbjo.resp.']))
  const personnel = personnelByResponsible[responsible] || { empresa: 'DESCONOCIDO', funcion: 'DESCONOCIDO' }
  return {
    Orden: firstUploadValue(row, ['Orden actual', 'Orden', 'Número de orden']),
    'Pto.tbjo.resp.': responsible,
    Empresa: personnel.empresa,
    Funcion: personnel.funcion,
    'Fecha de creación': normalizeUploadValue(firstUploadValue(row, ['Fecha de creación', 'Fecha creación', 'Fecha entrada', 'Fecha liberación de la orden'])),
    DEADLINE: normalizeUploadValue(firstUploadValue(row, ['DEADLINE', 'Fecha entrada'])),
    Calle: firstUploadValue(row, ['Calle', 'Calle 4']),
    Distrito: firstUploadValue(row, ['Distrito', 'Población']),
    'Status usuario ORDEN': firstUploadValue(row, ['Status Usuario Orden', 'Status usuario ORDEN']),
    'TIPO MEDIDOR': firstUploadValue(row, ['Denominación de tipo del fabricante', 'TIPO MEDIDOR']),
    'Latitud recomendada': firstUploadValue(row, ['Latitud recomendada', 'Latitud']),
    'Longitud recomendada': firstUploadValue(row, ['Longitud recomendada', 'Longitud']),
    'Transformador DS': firstUploadValue(row, ['Transformador DS', 'Placa transformador']),
    'Medidor MD': firstUploadValue(row, ['Medidor MD', 'Número de serie']),
    'Equipo CT': firstUploadValue(row, ['Equipo CT', 'Número de equipo']),
    Descripción: firstUploadValue(row, ['Texto cabecera de la orden', 'Clase de actividad PM', 'Descripción']),
    'Tipo de orden': firstUploadValue(row, ['Unnamed', 'Clase de orden']),
    'Clase de orden': firstUploadValue(row, ['Clase de orden']),
    'Clase de actividad PM': firstUploadValue(row, ['Clase de actividad PM']),
    'Texto cabecera de la orden': firstUploadValue(row, ['Texto cabecera de la orden']),
    'Referencia textual': firstUploadValue(row, ['Referencia textual']),
    'Fuente coordenada': firstUploadValue(row, ['Fuente coordenada']),
    Confianza: firstUploadValue(row, ['Confianza']),
    'ID fuente': firstUploadValue(row, ['ID fuente']),
    'Orden previa': firstUploadValue(row, ['Orden previa']),
    Contratista: firstUploadValue(row, ['Contratista']),
    'Condiciones conexion': firstUploadValue(row, ['Condiciones conexion', 'Condiciones conexión']),
  }
}

async function parseOperationalFile(file) {
  const bytes = await file.arrayBuffer()
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames.find(name => name.toUpperCase().includes('BASE CONSOLIDADA'))
    || workbook.SheetNames.find(name => name.toUpperCase().includes('BASE OPERATIVA'))
    || workbook.SheetNames[0]
  if (!sheetName) throw new Error('El archivo no contiene hojas.')

  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true })
  if (!rawRows.length) throw new Error('La hoja no contiene órdenes.')

  const missing = UPLOAD_REQUIRED.filter(column => !(column in rawRows[0]))
  if (missing.length) throw new Error(`Faltan columnas obligatorias: ${missing.join(', ')}.`)

  const rows = rawRows.map(normalizeUploadRow).filter(row => clean(row.Orden))
  if (!rows.length) throw new Error('La hoja no contiene órdenes válidas.')
  return { rows, sheetName }
}

function AdminPanel({ initialRole, onClose, onUploaded }) {
  const [unlocked,setUnlocked]=useState(initialRole==='admin')
  const [password,setPassword]=useState('')
  const [uploadedBy,setUploadedBy]=useState('')
  const [file,setFile]=useState(null)
  const [message,setMessage]=useState('')
  const [success,setSuccess]=useState('')
  const [busy,setBusy]=useState(false)
  const unlock=async event=>{event.preventDefault();setBusy(true);setMessage('');try{await apiJson('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password,role:'admin'})});setUnlocked(true);setPassword('')}catch(error){setMessage(error.message)}finally{setBusy(false)}}
  const upload=async event=>{event.preventDefault();if(!file)return setMessage('Selecciona el archivo Excel.');if(file.size>12*1024*1024)return setMessage('El archivo supera el límite de 12 MB.');setBusy(true);setMessage('');setSuccess('');try{const parsed=await parseOperationalFile(file);const result=await apiJson('/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:file.name,uploadedBy,rows:parsed.rows,sheetName:parsed.sheetName})});setSuccess(`Base actualizada: ${result.metadata.recordCount} órdenes procesadas.`);setFile(null);await onUploaded(result.metadata)}catch(error){setMessage(error.message)}finally{setBusy(false)}}
  return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className="admin-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={onClose}><X size={20}/></button><div className="admin-heading"><div className="admin-icon"><UploadCloud size={24}/></div><div><span className="eyebrow">Gestión de datos</span><h2>Administrar base</h2></div></div>{!unlocked?<form onSubmit={unlock} className="admin-form"><p>Ingresa la clave administrativa para habilitar la carga.</p><label className="access-field"><span>Clave administrativa</span><input type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoFocus/></label>{message&&<div className="form-error">{message}</div>}<button className="primary-button full-button" disabled={busy}>{busy?'Verificando…':'Continuar'}</button></form>:<form onSubmit={upload} className="admin-form"><p>La carga sustituirá la base actual únicamente después de superar todas las validaciones.</p><label className="access-field"><span>Responsable de la carga</span><input value={uploadedBy} onChange={e=>setUploadedBy(e.target.value)} placeholder="Nombre y apellido" required/></label><label className="upload-zone"><UploadCloud size={28}/><strong>{file?file.name:'Seleccionar Base Operativa Consolidada'}</strong><span>Formatos .xlsx, .xlsm o .xls · máximo 12 MB</span><input type="file" accept=".xlsx,.xlsm,.xls" onChange={e=>setFile(e.target.files?.[0]||null)} required/></label>{message&&<div className="form-error">{message}</div>}{success&&<div className="form-success"><CheckCircle2 size={18}/>{success}</div>}<button className="primary-button full-button" disabled={busy}>{busy?'Validando y publicando…':'Actualizar base'}</button></form>}</section></div>
}

function formatUpdateDate(value){if(!value)return'—';const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('es-SV',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d)}
function orderType(row){return clean(row['Tipo de orden'])||clean(row['Clase de orden'])||'Sin tipo'}
const TYPE_PALETTE = [
  { background:'#ecfdf3', border:'#a6f4c5', ink:'#067647', marker:'#16a34a' },
  { background:'#eff8ff', border:'#b2ddff', ink:'#175cd3', marker:'#2563eb' },
  { background:'#fff6ed', border:'#f9dbaf', ink:'#b54708', marker:'#ea580c' },
  { background:'#f4f3ff', border:'#d9d6fe', ink:'#5925dc', marker:'#7c3aed' },
  { background:'#fdf2fa', border:'#fcceee', ink:'#c11574', marker:'#db2777' },
  { background:'#f0fdfa', border:'#99f6e4', ink:'#0f766e', marker:'#0d9488' },
]
const TYPE_COLORS = {
  // Colores operativos fijos: no dependen del orden ni del contenido de la base.
  ZCON:  { background:'#edfff1', border:'#86e99d', ink:'#087c26', marker:'#0FB837' },
  ZDES:  { background:'#fff0f1', border:'#ff9ca4', ink:'#b20d19', marker:'#F72533' },
  ZDESC: { background:'#fff0f1', border:'#ff9ca4', ink:'#b20d19', marker:'#F72533' },
  ZREC:  { background:'#fff1f2', border:'#f7b0b5', ink:'#a53d45', marker:'#F2777F' },
  ZCOR:  { background:'#fffbea', border:'#fae169', ink:'#725d00', marker:'#FAE169' },
  ZPRE:  { background:'#fff0fd', border:'#fa9cec', ink:'#a71992', marker:'#FA69E7' },
}
function typeColor(type) {
  const normalized=clean(type).toLocaleLowerCase('es')
  const explicit=TYPE_COLORS[clean(type).toUpperCase()]
  if(explicit)return explicit
  let hash=0
  for(let index=0;index<normalized.length;index+=1) hash=((hash<<5)-hash+normalized.charCodeAt(index))|0
  return TYPE_PALETTE[Math.abs(hash)%TYPE_PALETTE.length]
}
function isNewService(row){return orderType(row).toUpperCase()==='ZCON'}
function typeStyle(type) {
  const color=typeColor(type)
  return { '--type-bg':color.background, '--type-border':color.border, '--type-ink':color.ink }
}
function activity(row){return clean(row['Clase de actividad PM'])||clean(row.Descripción)||'Sin actividad'}

function elapsedDays(value){
  const created=parseOrderDate(value)
  if(!created)return -1
  const today=new Date()
  const start=Date.UTC(created.getFullYear(),created.getMonth(),created.getDate())
  const end=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())
  return Math.max(0,Math.floor((end-start)/86400000))
}
function orderPriority(row){
  const type=orderType(row).toUpperCase()
  if(type==='ZCON')return 0
  if(type==='ZREC')return 1
  if(type==='ZDES'||type==='ZDESC')return 2
  return 3
}
function distanceBetween(left,right){
  const toRadians=value=>value*Math.PI/180
  const lat1=toRadians(Number(left['Latitud recomendada']))
  const lat2=toRadians(Number(right['Latitud recomendada']))
  const deltaLat=lat2-lat1
  const deltaLon=toRadians(Number(right['Longitud recomendada'])-Number(left['Longitud recomendada']))
  const a=Math.sin(deltaLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(deltaLon/2)**2
  return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
}
function deadlineDays(row){
  const deadline=parseOrderDate(row.DEADLINE)
  if(!deadline)return null
  const today=new Date()
  const start=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate())
  const end=Date.UTC(deadline.getFullYear(),deadline.getMonth(),deadline.getDate())
  return Math.round((end-start)/86400000)
}
function routeTier(row){
  const type=orderType(row).toUpperCase()
  const remaining=deadlineDays(row)
  if(type==='ZCON'&&remaining!==null&&remaining<=0)return 0
  if(type==='ZREC'&&(remaining===null||remaining<=0))return 1
  if(type==='ZCON')return 2
  if(type==='ZREC')return 3
  if(type==='ZDES'||type==='ZDESC')return 4
  return 5
}
function compareOperationalUrgency(left,right){
  const tierDifference=routeTier(left)-routeTier(right)
  if(tierDifference)return tierDifference
  const leftDeadline=deadlineDays(left)
  const rightDeadline=deadlineDays(right)
  if(leftDeadline!==null||rightDeadline!==null){
    if(leftDeadline===null)return 1
    if(rightDeadline===null)return -1
    if(leftDeadline!==rightDeadline)return leftDeadline-rightDeadline
  }
  return elapsedDays(right['Fecha de creación'])-elapsedDays(left['Fecha de creación'])
}
function routeDistanceMeters(rows){
  return rows.slice(1).reduce((total,row,index)=>total+distanceBetween(rows[index],row),0)
}
function routeCenter(rows){
  if(!rows.length)return null
  return {
    'Latitud recomendada':rows.reduce((sum,row)=>sum+Number(row['Latitud recomendada']),0)/rows.length,
    'Longitud recomendada':rows.reduce((sum,row)=>sum+Number(row['Longitud recomendada']),0)/rows.length,
  }
}
function nearestDistance(row,rows){
  return rows.length?Math.min(...rows.map(candidate=>distanceBetween(row,candidate))):0
}
function sequenceFromAnchor(rows,anchor=null){
  if(rows.length<2)return rows.slice()
  const pending=rows.slice()
  const ordered=[]
  let current=anchor
  while(pending.length){
    let nearestIndex=0
    if(current){
      for(let index=1;index<pending.length;index+=1){
        if(distanceBetween(current,pending[index])<distanceBetween(current,pending[nearestIndex]))nearestIndex=index
      }
    }
    current=pending.splice(nearestIndex,1)[0]
    ordered.push(current)
  }
  return ordered
}
function sequenceByProximity(rows){
  if(rows.length<2)return rows
  const pending=rows.slice(1)
  const ordered=[rows[0]]
  while(pending.length){
    const last=ordered[ordered.length-1]
    let nearestIndex=0
    for(let index=1;index<pending.length;index+=1){
      if(distanceBetween(last,pending[index])<distanceBetween(last,pending[nearestIndex]))nearestIndex=index
    }
    ordered.push(pending.splice(nearestIndex,1)[0])
  }
  return ordered
}
function recommendDailyRoute(rows,limit=ROUTE_MAX_STOPS){
  const located=rows.filter(row=>validCoordinate(row['Latitud recomendada'],row['Longitud recomendada']))
  if(!located.length)return []
  const ordered=located.slice().sort(compareOperationalUrgency)
  const selected=[]
  const selectedIds=new Set(selected.map(row=>clean(row.Orden)))
  const add=row=>{selected.push(row);selectedIds.add(clean(row.Orden))}

  // Las ZCON y ZREC conservan su prioridad operativa aunque impliquen más distancia.
  for(const row of ordered.filter(row=>routeTier(row)<=3)){
    if(selected.length>=limit)break
    add(row)
  }

  // El 70 % se usa como costo esperado de volver a la zona ZDESC, nunca como
  // predicción de qué orden individual generará una reconexión.
  const criticalCenter=routeCenter(selected)
  const disconnections=ordered.filter(row=>routeTier(row)===4)
  while(selected.length<limit&&disconnections.length){
    disconnections.sort((left,right)=>{
      const leftScore=nearestDistance(left,selected)+(criticalCenter?ZDESC_EXPECTED_RETURN_RATE*distanceBetween(left,criticalCenter):0)
      const rightScore=nearestDistance(right,selected)+(criticalCenter?ZDESC_EXPECTED_RETURN_RATE*distanceBetween(right,criticalCenter):0)
      return leftScore-rightScore
    })
    const candidate=disconnections.shift()
    const increment=nearestDistance(candidate,selected)
    const projected=routeDistanceMeters(sequenceByProximity([...selected,candidate]))
    if(selected.length&&increment>ROUTE_COMPACT_INCREMENT_METERS&&projected>ROUTE_DISTANCE_BUDGET_METERS)break
    add(candidate)
  }

  // Las órdenes restantes solo completan la jornada si mantienen una zona
  // compacta; por eso la recomendación puede contener menos de 15 paradas.
  const remaining=ordered.filter(row=>!selectedIds.has(clean(row.Orden)))
  while(selected.length<limit&&remaining.length){
    remaining.sort((left,right)=>nearestDistance(left,selected)-nearestDistance(right,selected)||compareOperationalUrgency(left,right))
    const candidate=remaining.shift()
    const increment=nearestDistance(candidate,selected)
    const projected=routeDistanceMeters(sequenceByProximity([...selected,candidate]))
    if(selected.length&&increment>ROUTE_COMPACT_INCREMENT_METERS&&projected>ROUTE_DISTANCE_BUDGET_METERS)break
    add(candidate)
  }

  const immediate=selected.filter(row=>routeTier(row)<=1).sort(compareOperationalUrgency)
  const morningDisconnections=sequenceFromAnchor(selected.filter(row=>routeTier(row)===4),immediate.at(-1)||null)
  const scheduledCritical=selected.filter(row=>routeTier(row)===2||routeTier(row)===3).sort(compareOperationalUrgency)
  const other=sequenceFromAnchor(selected.filter(row=>routeTier(row)===5),scheduledCritical.at(-1)||morningDisconnections.at(-1)||immediate.at(-1)||null)
  return [...immediate,...morningDisconnections,...scheduledCritical,...other]
}

function OrdersMap({ rows, routeRows, routeGeometry, onSelect }) {
  const mapped=useMemo(()=>rows.filter(r=>validCoordinate(r['Latitud recomendada'],r['Longitud recomendada'])),[rows])
  const routePositions=useMemo(()=>routeRows.map(row=>[Number(row['Latitud recomendada']),Number(row['Longitud recomendada'])]),[routeRows])
  const routeIndex=useMemo(()=>new Map(routeRows.map((row,index)=>[clean(row.Orden),index+1])),[routeRows])
  const legend=useMemo(()=>[...new Set(mapped.map(orderType))].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'})),[mapped])
  const renderMarker=(row,idx)=>{const color=typeColor(orderType(row));const routeNumber=routeIndex.get(clean(row.Orden));const inRoute=Boolean(routeNumber);return <CircleMarker key={`${clean(row.Orden)}-${idx}`} pane={isNewService(row)?'new-service-markers':'markerPane'} center={[Number(row['Latitud recomendada']),Number(row['Longitud recomendada'])]} radius={inRoute?10:isNewService(row)?8:7} pathOptions={{color:inRoute?'#111827':'#fff',weight:inRoute?4:isNewService(row)?3:2,fillColor:color.marker,fillOpacity:1}} eventHandlers={{click:()=>onSelect(row)}}>{inRoute&&<Tooltip permanent direction="top" offset={[0,-10]} opacity={1} className="route-map-label">{routeNumber}</Tooltip>}<Popup><div className="popup"><span className="popup-order">OT {clean(row.Orden)}</span>{inRoute&&<span className="popup-route">Parada {routeNumber} de {routeRows.length}</span>}<strong style={{color:color.ink}}>{orderType(row)}</strong><span>{activity(row)}</span><button onClick={()=>onSelect(row)}>Ver detalle</button></div></Popup></CircleMarker>}
  const fitRows=routeRows.length?routeRows:mapped
  const displayedRoute=routeGeometry?.length>1?routeGeometry:routePositions
  return <div className="map-card"><div className="map-legend" aria-label="Colores por tipo de orden">{legend.map(type=><span className="map-legend-item" key={type}><i style={{background:typeColor(type).marker}}/>{type}</span>)}</div><MapContainer center={[13.69,-89.22]} zoom={9} scrollWheelZoom className="map"><TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><FitMap rows={fitRows}/><Pane name="new-service-markers" style={{zIndex:640}}/>{displayedRoute.length>1&&<Polyline positions={displayedRoute} pathOptions={{color:routeGeometry?.length?'#175cd3':'#111827',weight:4,opacity:.78,dashArray:routeGeometry?.length?undefined:'8 8'}}/>}{mapped.filter(row=>!isNewService(row)).map(renderMarker)}{mapped.filter(isNewService).map(renderMarker)}</MapContainer></div>
}

function TypeSummary({ rows, selectedTypes, onToggle, onClear }) {
  const data=useMemo(()=>{
    const counts=new Map();rows.forEach(r=>{const t=orderType(r);counts.set(t,(counts.get(t)||0)+1)});return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0],'es',{sensitivity:'base'}))
  },[rows])
  return <section className="type-dashboard" aria-label="Órdenes por tipo"><button className={`type-card type-color-all ${selectedTypes.length===0?'active':''}`} onClick={onClear}><Layers3 size={18}/><strong>{rows.length}</strong><span>Todas</span></button>{data.map(([type,count])=><button key={type} style={typeStyle(type)} className={`type-card categorized ${selectedTypes.includes(type)?'active':''}`} aria-pressed={selectedTypes.includes(type)} onClick={()=>onToggle(type)}><span className="type-code">{type.replace('Orden ','').slice(0,18)}</span><strong>{count}</strong><span>pendientes</span></button>)}</section>
}

function OrdersPage({ rows, metadata, onSelect, canInstall, onInstall, onRefresh, refreshing, onAdmin, filters, setFilters, routePlan, setRoutePlan }) {
  const {company,responsible,query,selectedTypes,selectedActivity}=filters
  const [routeLoading,setRouteLoading]=useState(false)
  const clearRoute=()=>setRoutePlan({...EMPTY_ROUTE_PLAN})
  const updateFilters=changes=>{setFilters(current=>({...current,...changes}));clearRoute()}

  const companies=useMemo(()=>[...new Set(rows.map(r=>clean(r.Empresa)||'DESCONOCIDO'))].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'})),[rows])
  const companyRows=useMemo(()=>rows.filter(r=>!company||(clean(r.Empresa)||'DESCONOCIDO')===company),[rows,company])
  const responsibles=useMemo(()=>[...new Set(companyRows.map(r=>clean(r['Pto.tbjo.resp.'])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'})),[companyRows])
  const responsibleRows=useMemo(()=>companyRows.filter(r=>!responsible||clean(r['Pto.tbjo.resp.'])===responsible),[companyRows,responsible])
  const activities=useMemo(()=>[...new Set(responsibleRows.filter(r=>selectedTypes.length===0||selectedTypes.includes(orderType(r))).map(activity).filter(Boolean))].sort(),[responsibleRows,selectedTypes])
  const filtered=useMemo(()=>responsibleRows.filter(row=>{
    const typeOk=selectedTypes.length===0||selectedTypes.includes(orderType(row))
    const activityOk=!selectedActivity||activity(row)===selectedActivity
    const q=query.toLowerCase().trim()
    const searchOk=!q||[row.Orden,row.Distrito,row.Calle,row.Empresa,row['Pto.tbjo.resp.'],orderType(row),activity(row)].some(v=>clean(v).toLowerCase().includes(q))
    return typeOk&&activityOk&&searchOk
  }).sort((a,b)=>
    orderPriority(a)-orderPriority(b) ||
    elapsedDays(b['Fecha de creación'])-elapsedDays(a['Fecha de creación']) ||
    String(activity(a)).localeCompare(String(activity(b)))
  ),[responsibleRows,selectedTypes,selectedActivity,query])

  const located=filtered.filter(r=>validCoordinate(r['Latitud recomendada'],r['Longitud recomendada'])).length
  const filteredById=useMemo(()=>new Map(filtered.map(row=>[clean(row.Orden),row])),[filtered])
  const routeRows=useMemo(()=>routePlan.ids.map(id=>filteredById.get(id)).filter(Boolean),[routePlan.ids,filteredById])
  const routePositionById=useMemo(()=>new Map(routeRows.map((row,index)=>[clean(row.Orden),index+1])),[routeRows])
  const routeStats=useMemo(()=>({
    urgent:routeRows.filter(row=>routeTier(row)<=1).length,
    disconnections:routeRows.filter(row=>routeTier(row)===4).length,
    distanceKm:((routePlan.distanceMeters||routeDistanceMeters(routeRows))/1000).toFixed(1),
    travelMinutes:routePlan.durationSeconds?Math.round(routePlan.durationSeconds/60):null,
  }),[routeRows,routePlan.distanceMeters,routePlan.durationSeconds])
  const buildRoute=async()=>{
    const suggested=recommendDailyRoute(filtered)
    const fallback={...EMPTY_ROUTE_PLAN,ids:suggested.map(row=>clean(row.Orden)),source:'heuristic'}
    if(suggested.length<2){setRoutePlan(fallback);return}
    setRouteLoading(true)
    try{
      const result=await apiJson('/api/route',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uploadedAt:metadata.uploadedAt||'',stops:suggested.map(row=>({id:clean(row.Orden),lat:Number(row['Latitud recomendada']),lon:Number(row['Longitud recomendada']),tier:routeTier(row)}))})})
      if(!result.available){setRoutePlan({...fallback,notice:result.reason||'El servicio vial no está disponible.'});return}
      setRoutePlan({ids:result.orderIds,geometry:result.geometry||[],source:'openrouteservice',distanceMeters:result.distanceMeters||0,durationSeconds:result.durationSeconds||0,notice:result.cached?'Ruta vial recuperada de la caché diaria.':''})
    }catch(error){
      setRoutePlan({...fallback,notice:`No fue posible consultar la red vial: ${error.message} Se usó la heurística geográfica.`})
    }finally{setRouteLoading(false)}
  }

  return <main className="app-shell">
    <header className="mobile-topbar"><div className="brand-line"><div className="mini-logo"><MapPinned size={22}/></div><div><span className="eyebrow">GeoOperación</span><h1>Órdenes pendientes</h1></div></div><div className="top-actions"><button className="install-button admin-button" onClick={onAdmin}><LockKeyhole size={16}/> Administrar base</button><button className={`icon-button ${refreshing?'spinning':''}`} onClick={onRefresh}><RefreshCw size={18}/></button>{canInstall&&<button className="install-button" onClick={onInstall}><Smartphone size={16}/> Instalar</button>}</div></header>

    <section className="welcome-panel"><div className="welcome-copy"><span className="eyebrow light">Base operativa consolidada</span><h2>Todo lo pendiente de ejecutar, separado por tipo de orden.</h2><p>Selecciona la dupla y luego el tipo de orden para organizar la jornada.</p></div><div className="database-card"><Database size={20}/><strong>{rows.length}</strong><span>órdenes activas</span><small>Actualizado {formatUpdateDate(metadata.uploadedAt)}</small></div></section>

    <section className="filters-card"><div className="field"><label><Building2 size={16}/> Empresa</label><select value={company} onChange={e=>updateFilters({company:e.target.value,responsible:'',selectedTypes:[],selectedActivity:''})}><option value="">Todas las empresas</option>{companies.map(item=><option key={item} value={item}>{item}</option>)}</select></div><div className="field"><label><UserRound size={16}/> Dupla / responsable</label><select value={responsible} onChange={e=>updateFilters({responsible:e.target.value,selectedTypes:[],selectedActivity:''})}><option value="">Todas las duplas</option>{responsibles.map(item=><option key={item} value={item}>{item}</option>)}</select></div><div className="field search-field"><label><Search size={16}/> Buscar</label><input value={query} onChange={e=>updateFilters({query:e.target.value})} placeholder="OT, distrito, empresa, dupla, tipo o actividad"/></div></section>

    <TypeSummary rows={responsibleRows} selectedTypes={selectedTypes} onClear={()=>updateFilters({selectedTypes:[],selectedActivity:''})} onToggle={type=>updateFilters({selectedTypes:selectedTypes.includes(type)?selectedTypes.filter(item=>item!==type):[...selectedTypes,type],selectedActivity:''})}/>

    <section className="filters-card secondary-filters"><div className="field"><label>Actividad / trabajo</label><select value={selectedActivity} onChange={e=>updateFilters({selectedActivity:e.target.value})}><option value="">Todas las actividades</option>{activities.map(item=><option key={item} value={item}>{item}</option>)}</select></div><div className="selection-summary"><strong>{filtered.length}</strong><span>órdenes visibles</span><small>{selectedTypes.length?selectedTypes.join(' + '):'Todos los tipos'}{selectedActivity?` · ${selectedActivity}`:''}</small></div></section>

    <section className="section-block"><div className="section-heading route-heading"><div><span className="eyebrow">Ubicación</span><h2>Mapa operativo</h2></div><div className="route-actions"><span className="muted">{located} con coordenadas</span>{responsible&&<button className="route-button" onClick={buildRoute} disabled={!located||routeLoading}><Route size={17}/> {routeLoading?'Calculando vía…':'Ruta recomendada'}</button>}</div></div>{responsible&&routeRows.length>0&&<div className="route-panel"><div className="route-summary"><strong>Jornada sugerida · {routeRows.length} paradas</strong><span>{routeStats.urgent} urgentes · {routeStats.disconnections} desconexiones · {routeStats.distanceKm} km {routePlan.source==='openrouteservice'?'por carretera':'en línea recta'}{routeStats.travelMinutes?` · ${routeStats.travelMinutes} min de traslado`:''}</span><span>Calculada con la carga del {formatUpdateDate(metadata.uploadedAt)}.</span><small>{routePlan.source==='openrouteservice'?'Secuencia influenciada por tiempos de conducción de openrouteservice; conserva las prioridades operativas.':'Heurística geográfica de respaldo; no representa calles.'} No incorpora tráfico en tiempo real, duración del trabajo, horario ni punto de salida.</small>{routePlan.notice&&<small className="route-notice">{routePlan.notice}</small>}</div><div className="route-stops">{routeRows.map((row,index)=><button key={clean(row.Orden)} onClick={()=>onSelect(row)}><b>{index+1}</b><span>{clean(row.Orden)}</span></button>)}</div><button className="clear-route" onClick={clearRoute}>Quitar ruta</button></div>}<OrdersMap rows={filtered} routeRows={responsible?routeRows:[]} routeGeometry={responsible?routePlan.geometry:[]} onSelect={onSelect}/></section>

    <section className="orders-section"><div className="section-heading"><div><span className="eyebrow">Ejecución</span><h2>Órdenes por tipo</h2></div><span className="muted">{filtered.length} visibles</span></div><div className="orders-list">{filtered.map((row,idx)=>{const quality=getInfoQuality(row);const days=elapsedDays(row['Fecha de creación']);const routePosition=routePositionById.get(clean(row.Orden));return <button className={`order-card ${routePosition?'route-selected':''}`} key={`${clean(row.Orden)}-${idx}`} onClick={()=>onSelect(row)}><div className="urgency-strip"/><div className="order-card-main"><div className="order-title-line"><span className="order-number">OT {clean(row.Orden)||'—'}</span><span className="order-badges">{routePosition&&<span className="route-chip">Ruta {routePosition}</span>}{days>=0&&<span className="age-chip">{days} d</span>}<span className={`status-chip ${quality.toLowerCase().replace('í','i')}`}>{quality}</span></span></div><div className="type-chip">{orderType(row)}</div><div className="activity-title">{activity(row)}</div><div className="order-location"><MapPinned size={14}/> {clean(row.Distrito)||'Sin distrito'}{clean(row.Calle)?` · ${clean(row.Calle)}`:''}</div></div><ChevronRight className="chevron" size={22}/></button>})}{!filtered.length&&<div className="empty">No hay órdenes que coincidan con los filtros actuales.</div>}</div></section>
  </main>
}

function ValueBlock({ label, value, wide=false }){return <div className={`value-block ${wide?'wide':''}`}><span>{label}</span><strong>{clean(value)||'—'}</strong></div>}

function parseOrderDate(value){
  if(!value)return null
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return value
  const text=clean(value)
  const iso=text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  const latin=text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/)
  const date=iso?new Date(Number(iso[1]),Number(iso[2])-1,Number(iso[3])):latin?new Date(Number(latin[3]),Number(latin[2])-1,Number(latin[1])):new Date(text)
  return Number.isNaN(date.getTime())?null:date
}
function orderAge(value){
  const days=elapsedDays(value)
  if(days<0)return 'Fecha de creación no disponible'
  return `${days.toLocaleString('es-SV')} ${days===1?'día calendario':'días calendario'}`
}
function formatOrderDate(value){const date=parseOrderDate(value);return date?new Intl.DateTimeFormat('es-SV',{day:'2-digit',month:'long',year:'numeric'}).format(date):'—'}

function DetailPage({ row, onBack }) {
  const lat=row['Latitud recomendada']
  const lon=row['Longitud recomendada']
  const hasMap=validCoordinate(lat,lon)
  return <main className="detail-shell"><header className="detail-topbar"><button className="back-button" onClick={onBack}><ArrowLeft size={20}/> Órdenes</button><span className="eyebrow">GeoOperación</span></header><section className="hero-card"><div className="hero-main"><span className="eyebrow light">Orden de trabajo</span><h1>{clean(row.Orden)||'—'}</h1></div><div className="hero-deadline"><span>Tipo de orden</span><strong>{orderType(row)}</strong><em>{activity(row)}</em></div></section><section className="detail-section priority-section"><div className="section-title">Clasificación</div><div className="detail-grid"><ValueBlock label="Clase de orden" value={row['Clase de orden']}/><ValueBlock label="Tipo de orden" value={orderType(row)}/><ValueBlock label="Actividad" value={activity(row)} wide/><ValueBlock label="Estado" value={row['Status usuario ORDEN']}/><ValueBlock label="Fecha de creación" value={formatOrderDate(row['Fecha de creación'])}/><ValueBlock label="Tiempo transcurrido" value={orderAge(row['Fecha de creación'])}/><ValueBlock label="Empresa" value={row.Empresa}/><ValueBlock label="Dupla / responsable" value={row['Pto.tbjo.resp.']}/></div></section><section className="detail-section"><div className="section-title"><LocateFixed size={18}/> Ubicación</div><div className="reference-card"><span>Referencia</span><p>{clean(row['Referencia textual'])||clean(row.Calle)||'Sin referencia disponible.'}</p></div><div className="detail-grid compact"><ValueBlock label="Distrito" value={row.Distrito}/><ValueBlock label="Fuente" value={row['Fuente coordenada']}/><ValueBlock label="Confianza" value={row.Confianza}/><ValueBlock label="ID fuente" value={row['ID fuente']}/></div><div className="action-grid"><a className={`action-button ${!hasMap?'disabled':''}`} href={hasMap?mapsUrl(lat,lon):undefined} target="_blank" rel="noreferrer"><MapPinned size={20}/> Google Maps <ExternalLink size={15}/></a><a className={`action-button secondary ${!hasMap?'disabled':''}`} href={hasMap?wazeUrl(lat,lon):undefined} target="_blank" rel="noreferrer"><Navigation size={20}/> Waze <ExternalLink size={15}/></a></div>{hasMap&&<div className="detail-map"><MapContainer center={[Number(lat),Number(lon)]} zoom={16} scrollWheelZoom={false} className="map"><TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><CircleMarker center={[Number(lat),Number(lon)]} radius={9} pathOptions={{color:'#fff',weight:2,fillColor:typeColor(orderType(row)).marker,fillOpacity:1}}/></MapContainer></div>}</section><section className="detail-section"><div className="section-title"><Zap size={18}/> Información de red</div><div className="detail-grid"><ValueBlock label="Transformador" value={row['Transformador DS']}/><ValueBlock label="Medidor contiguo" value={row['Medidor MD']}/><ValueBlock label="Equipo" value={row['Equipo CT']}/><ValueBlock label="Orden previa" value={row['Orden previa']}/></div></section></main>
}

export default function App() {
  const [rows,setRows]=useState(null)
  const [metadata,setMetadata]=useState({})
  const [role,setRole]=useState(null)
  const [accessRequired,setAccessRequired]=useState(false)
  const [adminOpen,setAdminOpen]=useState(false)
  const [selected,setSelected]=useState(null)
  const [filters,setFilters]=useState(INITIAL_FILTERS)
  const [routePlan,setRoutePlan]=useState(EMPTY_ROUTE_PLAN)
  const [error,setError]=useState('')
  const [refreshing,setRefreshing]=useState(false)
  const {canInstall,install}=useInstallPrompt()
  const refresh=useCallback(async(showLoader=false)=>{
    const controller=new AbortController()
    if(showLoader)setRows(null)
    setRefreshing(true);setError('')
    try{const result=await loadOrders(controller.signal);setRows(result.rows);setMetadata(result.metadata);setRole(result.role);setAccessRequired(false);setSelected(current=>{if(!current)return null;const id=clean(current.Orden);return result.rows.find(r=>clean(r.Orden)===id)||null})}
    catch(err){
      if(err.status===401){setRows(null);setSelected(null);setAccessRequired(true);setError('')}
      else if(showLoader){setRows(null);setSelected(null);setError(err.message||'Error de carga')}
      else console.warn('No fue posible actualizar la base en segundo plano:',err)
    }
    finally{setRefreshing(false)}
  },[])
  useEffect(()=>{refresh(true);const interval=window.setInterval(()=>refresh(false),AUTO_REFRESH_MS);return()=>window.clearInterval(interval)},[refresh])
  if(accessRequired)return <AccessScreen onAuthenticated={newRole=>{setRole(newRole);refresh(true)}}/>
  if(error)return <ErrorScreen message={error} onRetry={()=>refresh(true)}/>
  if(!rows)return <LoadingScreen/>
  if(selected)return <DetailPage row={selected} onBack={()=>setSelected(null)}/>
  return <><OrdersPage rows={rows} metadata={metadata} onSelect={setSelected} canInstall={canInstall} onInstall={install} onRefresh={()=>refresh(false)} refreshing={refreshing} onAdmin={()=>setAdminOpen(true)} filters={filters} setFilters={setFilters} routePlan={routePlan} setRoutePlan={setRoutePlan}/>{adminOpen&&<AdminPanel initialRole={role} onClose={()=>setAdminOpen(false)} onUploaded={async()=>{setRole('admin');setRoutePlan({...EMPTY_ROUTE_PLAN});await refresh(false)}}/>}</>
}
