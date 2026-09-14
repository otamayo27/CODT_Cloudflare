export const clean = (value) =>
  value === null || value === undefined || String(value).trim() === ''
    ? ''
    : String(value).trim()

export const validCoordinate = (lat, lon) => {
  const a = Number(lat)
  const b = Number(lon)
  return Number.isFinite(a) && Number.isFinite(b) &&
    a >= 12.5 && a <= 14.6 && b >= -90.5 && b <= -87.5
}

export const mapsUrl = (lat, lon) =>
  validCoordinate(lat, lon)
    ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
    : ''

export const wazeUrl = (lat, lon) =>
  validCoordinate(lat, lon)
    ? `https://waze.com/ul?ll=${lat}%2C${lon}&navigate=yes`
    : ''

export const parseDate = (value) => {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12)
  }

  const text = clean(value)
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12)
    return Number.isNaN(d.getTime()) ? null : d
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
}

export const formatDate = (value) => {
  const date = parseDate(value)
  if (!date) return clean(value) || '—'
  return new Intl.DateTimeFormat('es-SV', {
    day: '2-digit', month: 'short', year: 'numeric'
  }).format(date)
}

export const getDeadlineInfo = (value, now = new Date()) => {
  const deadline = parseDate(value)
  if (!deadline) {
    return { days: null, tone: 'neutral', label: 'Sin deadline', shortLabel: 'Sin fecha' }
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const diff = Math.round((deadline.getTime() - today.getTime()) / 86400000)

  if (diff < 0) {
    const days = Math.abs(diff)
    return {
      days: diff,
      tone: 'overdue',
      label: `Vencida hace ${days} ${days === 1 ? 'día' : 'días'}`,
      shortLabel: 'Vencida'
    }
  }
  if (diff === 0) return { days: 0, tone: 'today', label: 'Vence hoy', shortLabel: 'Hoy' }
  if (diff === 1) return { days: 1, tone: 'urgent', label: 'Vence mañana', shortLabel: 'Mañana' }
  if (diff <= 3) return { days: diff, tone: 'urgent', label: `Vence en ${diff} días`, shortLabel: `${diff} días` }
  if (diff <= 7) return { days: diff, tone: 'warning', label: `Vence en ${diff} días`, shortLabel: `${diff} días` }
  return { days: diff, tone: 'safe', label: `En plazo · ${diff} días`, shortLabel: `${diff} días` }
}

export const getInfoQuality = (row) => {
  const hasGps = validCoordinate(row['Latitud recomendada'], row['Longitud recomendada'])
  const hasPhone = !!clean(row['Teléfono principal'])
  if (hasGps && hasPhone) return 'Completa'
  if (hasGps || hasPhone) return 'Parcial'
  return 'Crítica'
}
