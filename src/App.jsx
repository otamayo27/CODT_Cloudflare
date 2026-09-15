import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import {
  AlertTriangle, ArrowLeft, Building2, CheckCircle2, ChevronRight,
  Database, ExternalLink, LocateFixed, MapPinned, Navigation, Phone,
  RefreshCw, Search, Smartphone, UserRound, WifiOff, Zap, LockKeyhole, UploadCloud, X,
  Layers3
} from 'lucide-react'
import {
  clean, getInfoQuality, mapsUrl, validCoordinate, wazeUrl
} from './utils'
import { personnelByResponsible } from './personnel'

const AUTO_REFRESH_MS = 30_000

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
function activity(row){return clean(row['Clase de actividad PM'])||clean(row.Descripción)||'Sin actividad'}

function OrdersMap({ rows, onSelect }) {
  const mapped=rows.filter(r=>validCoordinate(r['Latitud recomendada'],r['Longitud recomendada']))
  return <div className="map-card"><MapContainer center={[13.69,-89.22]} zoom={9} scrollWheelZoom className="map"><TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><FitMap rows={mapped}/>{mapped.map((row,idx)=><CircleMarker key={`${clean(row.Orden)}-${idx}`} center={[Number(row['Latitud recomendada']),Number(row['Longitud recomendada'])]} radius={7} pathOptions={{color:'#fff',weight:2,fillColor:'#0f766e',fillOpacity:1}} eventHandlers={{click:()=>onSelect(row)}}><Popup><div className="popup"><span className="popup-order">OT {clean(row.Orden)}</span><strong>{orderType(row)}</strong><span>{activity(row)}</span><button onClick={()=>onSelect(row)}>Ver detalle</button></div></Popup></CircleMarker>)}</MapContainer></div>
}

function TypeSummary({ rows, selectedType, onSelect }) {
  const data=useMemo(()=>{
    const counts=new Map();rows.forEach(r=>{const t=orderType(r);counts.set(t,(counts.get(t)||0)+1)});return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0],'es',{sensitivity:'base'}))
  },[rows])
  return <section className="type-dashboard" aria-label="Órdenes por tipo"><button className={`type-card type-color-all ${selectedType===''?'active':''}`} onClick={()=>onSelect('')}><Layers3 size={18}/><strong>{rows.length}</strong><span>Todas</span></button>{data.map(([type,count],index)=><button key={type} className={`type-card type-color-${index%6} ${selectedType===type?'active':''}`} onClick={()=>onSelect(selectedType===type?'':type)}><span className="type-code">{type.replace('Orden ','').slice(0,18)}</span><strong>{count}</strong><span>pendientes</span></button>)}</section>
}

function OrdersPage({ rows, metadata, onSelect, canInstall, onInstall, onRefresh, refreshing, onAdmin }) {
  const [company,setCompany]=useState('')
  const [responsible,setResponsible]=useState('')
  const [query,setQuery]=useState('')
  const [selectedType,setSelectedType]=useState('')
  const [selectedActivity,setSelectedActivity]=useState('')

  const companies=useMemo(()=>[...new Set(rows.map(r=>clean(r.Empresa)||'DESCONOCIDO'))].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'})),[rows])
  const companyRows=useMemo(()=>rows.filter(r=>!company||(clean(r.Empresa)||'DESCONOCIDO')===company),[rows,company])
  const responsibles=useMemo(()=>[...new Set(companyRows.map(r=>clean(r['Pto.tbjo.resp.'])).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'})),[companyRows])
  const responsibleRows=useMemo(()=>companyRows.filter(r=>!responsible||clean(r['Pto.tbjo.resp.'])===responsible),[companyRows,responsible])
  const activities=useMemo(()=>[...new Set(responsibleRows.filter(r=>!selectedType||orderType(r)===selectedType).map(activity).filter(Boolean))].sort(),[responsibleRows,selectedType])
  const filtered=useMemo(()=>responsibleRows.filter(row=>{
    const typeOk=!selectedType||orderType(row)===selectedType
    const activityOk=!selectedActivity||activity(row)===selectedActivity
    const q=query.toLowerCase().trim()
    const searchOk=!q||[row.Orden,row.Distrito,row.Calle,row.Empresa,row['Pto.tbjo.resp.'],orderType(row),activity(row)].some(v=>clean(v).toLowerCase().includes(q))
    return typeOk&&activityOk&&searchOk
  }).sort((a,b)=>
    String(orderType(a)).localeCompare(String(orderType(b))) ||
    String(activity(a)).localeCompare(String(activity(b)))
  ),[responsibleRows,selectedType,selectedActivity,query])

  const located=filtered.filter(r=>validCoordinate(r['Latitud recomendada'],r['Longitud recomendada'])).length

  return <main className="app-shell">
    <header className="mobile-topbar"><div className="brand-line"><div className="mini-logo"><MapPinned size={22}/></div><div><span className="eyebrow">GeoOperación</span><h1>Órdenes pendientes</h1></div></div><div className="top-actions"><button className="install-button admin-button" onClick={onAdmin}><LockKeyhole size={16}/> Administrar base</button><button className={`icon-button ${refreshing?'spinning':''}`} onClick={onRefresh}><RefreshCw size={18}/></button>{canInstall&&<button className="install-button" onClick={onInstall}><Smartphone size={16}/> Instalar</button>}</div></header>

    <section className="welcome-panel"><div className="welcome-copy"><span className="eyebrow light">Base operativa consolidada</span><h2>Todo lo pendiente de ejecutar, separado por tipo de orden.</h2><p>Selecciona la dupla y luego el tipo de orden para organizar la jornada.</p></div><div className="database-card"><Database size={20}/><strong>{rows.length}</strong><span>órdenes activas</span><small>Actualizado {formatUpdateDate(metadata.uploadedAt)}</small></div></section>

    <section className="filters-card"><div className="field"><label><Building2 size={16}/> Empresa</label><select value={company} onChange={e=>{setCompany(e.target.value);setResponsible('');setSelectedType('');setSelectedActivity('')}}><option value="">Todas las empresas</option>{companies.map(item=><option key={item} value={item}>{item}</option>)}</select></div><div className="field"><label><UserRound size={16}/> Dupla / responsable</label><select value={responsible} onChange={e=>{setResponsible(e.target.value);setSelectedType('');setSelectedActivity('')}}><option value="">Todas las duplas</option>{responsibles.map(item=><option key={item} value={item}>{item}</option>)}</select></div><div className="field search-field"><label><Search size={16}/> Buscar</label><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="OT, distrito, empresa, dupla, tipo o actividad"/></div></section>

    <TypeSummary rows={responsibleRows} selectedType={selectedType} onSelect={type=>{setSelectedType(type);setSelectedActivity('')}}/>

    <section className="filters-card secondary-filters"><div className="field"><label>Actividad / trabajo</label><select value={selectedActivity} onChange={e=>setSelectedActivity(e.target.value)}><option value="">Todas las actividades</option>{activities.map(item=><option key={item} value={item}>{item}</option>)}</select></div><div className="selection-summary"><strong>{filtered.length}</strong><span>órdenes visibles</span><small>{selectedType||'Todos los tipos'}{selectedActivity?` · ${selectedActivity}`:''}</small></div></section>

    <section className="section-block"><div className="section-heading"><div><span className="eyebrow">Ubicación</span><h2>Mapa operativo</h2></div><span className="muted">{located} con coordenadas</span></div><OrdersMap rows={filtered} onSelect={onSelect}/></section>

    <section className="orders-section"><div className="section-heading"><div><span className="eyebrow">Ejecución</span><h2>Órdenes por tipo</h2></div><span className="muted">{filtered.length} visibles</span></div><div className="orders-list">{filtered.map((row,idx)=>{const quality=getInfoQuality(row);return <button className="order-card" key={`${clean(row.Orden)}-${idx}`} onClick={()=>onSelect(row)}><div className="urgency-strip"/><div className="order-card-main"><div className="order-title-line"><span className="order-number">OT {clean(row.Orden)||'—'}</span><span className={`status-chip ${quality.toLowerCase().replace('í','i')}`}>{quality}</span></div><div className="type-chip">{orderType(row)}</div><div className="activity-title">{activity(row)}</div><div className="order-location"><MapPinned size={14}/> {clean(row.Distrito)||'Sin distrito'}{clean(row.Calle)?` · ${clean(row.Calle)}`:''}</div></div><ChevronRight className="chevron" size={22}/></button>})}{!filtered.length&&<div className="empty">No hay órdenes que coincidan con los filtros actuales.</div>}</div></section>
  </main>
}

function ValueBlock({ label, value, wide=false }){return <div className={`value-block ${wide?'wide':''}`}><span>{label}</span><strong>{clean(value)||'—'}</strong></div>}

function DetailPage({ row, onBack }) {
  const lat=row['Latitud recomendada']
  const lon=row['Longitud recomendada']
  const hasMap=validCoordinate(lat,lon)
  return <main className="detail-shell"><header className="detail-topbar"><button className="back-button" onClick={onBack}><ArrowLeft size={20}/> Órdenes</button><span className="eyebrow">GeoOperación</span></header><section className="hero-card"><div className="hero-main"><span className="eyebrow light">Orden de trabajo</span><h1>{clean(row.Orden)||'—'}</h1></div><div className="hero-deadline"><span>Tipo de orden</span><strong>{orderType(row)}</strong><em>{activity(row)}</em></div></section><section className="detail-section priority-section"><div className="section-title">Clasificación</div><div className="detail-grid"><ValueBlock label="Clase de orden" value={row['Clase de orden']}/><ValueBlock label="Tipo de orden" value={orderType(row)}/><ValueBlock label="Actividad" value={activity(row)} wide/><ValueBlock label="Estado" value={row['Status usuario ORDEN']}/><ValueBlock label="Empresa" value={row.Empresa}/><ValueBlock label="Dupla / responsable" value={row['Pto.tbjo.resp.']}/></div></section><section className="detail-section"><div className="section-title"><LocateFixed size={18}/> Ubicación</div><div className="reference-card"><span>Referencia</span><p>{clean(row['Referencia textual'])||clean(row.Calle)||'Sin referencia disponible.'}</p></div><div className="detail-grid compact"><ValueBlock label="Distrito" value={row.Distrito}/><ValueBlock label="Fuente" value={row['Fuente coordenada']}/><ValueBlock label="Confianza" value={row.Confianza}/><ValueBlock label="ID fuente" value={row['ID fuente']}/></div><div className="action-grid"><a className={`action-button ${!hasMap?'disabled':''}`} href={hasMap?mapsUrl(lat,lon):undefined} target="_blank" rel="noreferrer"><MapPinned size={20}/> Google Maps <ExternalLink size={15}/></a><a className={`action-button secondary ${!hasMap?'disabled':''}`} href={hasMap?wazeUrl(lat,lon):undefined} target="_blank" rel="noreferrer"><Navigation size={20}/> Waze <ExternalLink size={15}/></a></div>{hasMap&&<div className="detail-map"><MapContainer center={[Number(lat),Number(lon)]} zoom={16} scrollWheelZoom={false} className="map"><TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><CircleMarker center={[Number(lat),Number(lon)]} radius={9} pathOptions={{color:'#fff',weight:2,fillColor:'#0f766e',fillOpacity:1}}/></MapContainer></div>}</section><section className="detail-section"><div className="section-title"><Zap size={18}/> Información de red</div><div className="detail-grid"><ValueBlock label="Transformador" value={row['Transformador DS']}/><ValueBlock label="Medidor contiguo" value={row['Medidor MD']}/><ValueBlock label="Equipo" value={row['Equipo CT']}/><ValueBlock label="Orden previa" value={row['Orden previa']}/></div></section></main>
}

export default function App() {
  const [rows,setRows]=useState(null)
  const [metadata,setMetadata]=useState({})
  const [role,setRole]=useState(null)
  const [accessRequired,setAccessRequired]=useState(false)
  const [adminOpen,setAdminOpen]=useState(false)
  const [selected,setSelected]=useState(null)
  const [error,setError]=useState('')
  const [refreshing,setRefreshing]=useState(false)
  const {canInstall,install}=useInstallPrompt()
  const refresh=useCallback(async(showLoader=false)=>{
    const controller=new AbortController()
    if(showLoader)setRows(null)
    setRefreshing(true);setError('')
    try{const result=await loadOrders(controller.signal);setRows(result.rows);setMetadata(result.metadata);setRole(result.role);setAccessRequired(false);setSelected(current=>{if(!current)return null;const id=clean(current.Orden);return result.rows.find(r=>clean(r.Orden)===id)||null})}
    catch(err){setRows(null);setSelected(null);if(err.status===401){setAccessRequired(true);setError('')}else setError(err.message||'Error de carga')}
    finally{setRefreshing(false)}
  },[])
  useEffect(()=>{refresh(true);const interval=window.setInterval(()=>refresh(false),AUTO_REFRESH_MS);const onFocus=()=>refresh(false);const onVisibility=()=>{if(document.visibilityState==='visible')refresh(false)};window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onVisibility);return()=>{window.clearInterval(interval);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onVisibility)}},[refresh])
  if(accessRequired)return <AccessScreen onAuthenticated={newRole=>{setRole(newRole);refresh(true)}}/>
  if(error)return <ErrorScreen message={error} onRetry={()=>refresh(true)}/>
  if(!rows)return <LoadingScreen/>
  if(selected)return <DetailPage row={selected} onBack={()=>setSelected(null)}/>
  return <><OrdersPage rows={rows} metadata={metadata} onSelect={setSelected} canInstall={canInstall} onInstall={install} onRefresh={()=>refresh(false)} refreshing={refreshing} onAdmin={()=>setAdminOpen(true)}/>{adminOpen&&<AdminPanel initialRole={role} onClose={()=>setAdminOpen(false)} onUploaded={async()=>{setRole('admin');await refresh(false)}}/>}</>
}
