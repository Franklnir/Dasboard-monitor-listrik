import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Line, Doughnut, Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
} from 'chart.js'

import { useRealtimeLogs } from './hooks/useRealtimeLogs'
import { useRelayConfig } from './hooks/useRelayConfig'
import { supabase } from './lib/supabase'
import './styles.css'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
)

const DEVICE_ID = 'ESP32-S3-Monitoring-01'

// key untuk localStorage
const RANGE_STORAGE_KEY = 'pm_range_hours'
const MONTH_STORAGE_KEY = 'pm_selected_month'
const BUDGET_STORAGE_KEY = 'pm_budget_target'

const rupiahFmt = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0
})

const kwhFmt = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3
})

function asDate(ts) {
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d
}

function startOfDay(d) {
  const t = new Date(d)
  t.setHours(0, 0, 0, 0)
  return t
}

/* ========================================================================
 *  FILTER & UTIL
 * ====================================================================== */

// Filter log per jam terakhir (1–6 jam) dari SEKARANG
function filterLogsByHours(logs, hours) {
  if (!logs?.length || !hours) return []

  // waktu akhir = sekarang
  const end = new Date()
  const from = new Date(end.getTime() - hours * 60 * 60 * 1000)

  // ambil hanya log yang ts-nya berada di antara [from, end]
  const filtered = logs.filter(l => {
    const t = asDate(l.ts)
    return t && t >= from && t <= end
  })

  // urutkan naik berdasarkan waktu supaya label di grafik rapi
  filtered.sort((a, b) => {
    const ta = asDate(a.ts)?.getTime() ?? 0
    const tb = asDate(b.ts)?.getTime() ?? 0
    return ta - tb
  })

  return filtered
}

// Statistik 1 minggu (per hari)
function computeWeeklyStats(logs, asNumber) {
  if (!logs?.length) return null

  const now = new Date()
  const from = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000))

  const weekLogs = logs.filter(l => {
    const t = asDate(l.ts)
    return t && t >= from
  })
  if (!weekLogs.length) return null

  const dayMap = new Map()

  weekLogs.forEach(l => {
    const t = asDate(l.ts)
    if (!t) return
    const dateKey = t.toISOString().slice(0, 10)

    const day = dayMap.get(dateKey) || {
      date: dateKey,
      energyKwh: 0,
      costRp: 0,
      peakWatts: 0,
      peakTs: null
    }

    const eDay = asNumber(l.energi_harian_kwh)
    const totalHarian = asNumber(l.total_harian_rp)
    const P = asNumber(l.daya_aktif_w)

    if (!Number.isNaN(eDay) && eDay > day.energyKwh) {
      day.energyKwh = eDay
    }
    if (!Number.isNaN(totalHarian) && totalHarian > day.costRp) {
      day.costRp = totalHarian
    }
    if (!Number.isNaN(P) && P > day.peakWatts) {
      day.peakWatts = P
      day.peakTs = t
    }

    dayMap.set(dateKey, day)
  })

  const days = Array.from(dayMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
  )
  if (!days.length) return null

  const mostWastefulDay = days.reduce(
    (max, d) => (d.energyKwh > max.energyKwh ? d : max),
    days[0]
  )

  return { days, mostWastefulDay }
}

// Bulan yang tersedia dari log
const MONTH_NAMES_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember'
]

function formatMonthLabel(monthIndex, year) {
  return `${MONTH_NAMES_ID[monthIndex]} ${year}`
}

function getAvailableMonths(logs) {
  const map = new Map()

  logs.forEach(l => {
    const t = asDate(l.ts)
    if (!t) return
    const y = t.getFullYear()
    const m = t.getMonth()
    const key = `${y}-${String(m + 1).padStart(2, '0')}`
    if (!map.has(key)) {
      map.set(key, { key, year: y, month: m })
    }
  })

  return Array.from(map.values())
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map(item => ({
      key: item.key,
      label: formatMonthLabel(item.month, item.year),
      year: item.year,
      month: item.month
    }))
}

// Statistik bulanan per minggu
function computeMonthlyStats(logs, monthKey, asNumber) {
  if (!logs?.length || !monthKey) return null
  const [yearStr, monthStr] = monthKey.split('-')
  const year = parseInt(yearStr, 10)
  const monthIndex = parseInt(monthStr, 10) - 1
  if (Number.isNaN(year) || Number.isNaN(monthIndex)) return null

  const monthLogs = logs.filter(l => {
    const t = asDate(l.ts)
    if (!t) return false
    return t.getFullYear() === year && t.getMonth() === monthIndex
  })
  if (!monthLogs.length) return null

  const weekMap = new Map()

  monthLogs.forEach(l => {
    const t = asDate(l.ts)
    if (!t) return
    const dayNum = t.getDate()
    const weekIdx = 1 + Math.floor((dayNum - 1) / 7)
    const key = weekIdx

    const eDay = asNumber(l.energi_harian_kwh)
    const totalHarian = asNumber(l.total_harian_rp)
    const P = asNumber(l.daya_aktif_w)
    const dateKey = t.toISOString().slice(0, 10)

    const week = weekMap.get(key) || {
      index: weekIdx,
      energyByDate: new Map(),
      costByDate: new Map(),
      peakWatts: 0,
      peakTs: null
    }

    if (!Number.isNaN(eDay)) {
      const prev = week.energyByDate.get(dateKey) || 0
      if (eDay > prev) week.energyByDate.set(dateKey, eDay)
    }
    if (!Number.isNaN(totalHarian)) {
      const prev = week.costByDate.get(dateKey) || 0
      if (totalHarian > prev) week.costByDate.set(dateKey, totalHarian)
    }

    if (!Number.isNaN(P) && P > week.peakWatts) {
      week.peakWatts = P
      week.peakTs = t
    }

    weekMap.set(key, week)
  })

  const weeks = Array.from(weekMap.values())
    .map(w => {
      const energyKwh = Array.from(w.energyByDate.values()).reduce(
        (sum, v) => sum + v,
        0
      )
      const costRp = Array.from(w.costByDate.values()).reduce(
        (sum, v) => sum + v,
        0
      )
      return {
        index: w.index,
        energyKwh,
        costRp,
        peakWatts: w.peakWatts,
        peakTs: w.peakTs
      }
    })
    .sort((a, b) => a.index - b.index)

  if (!weeks.length) return null

  const mostWastefulWeek = weeks.reduce(
    (max, w) => (w.energyKwh > max.energyKwh ? w : max),
    weeks[0]
  )

  return { weeks, mostWastefulWeek }
}

/* ========================================================================
 * SUMMARY CARDS
 * ====================================================================== */

function SummaryCards({
  lastLog,
  asNumber,
  loading,
  onResetKwh,
  resetLoading
}) {
  if (loading) {
    return (
      <section className="section section-summary">
        <div className="section-header">
          <h2>Ringkasan Monitoring</h2>
          <p className="section-subtitle">Memuat data...</p>
        </div>
        <div className="summary-grid">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="card metric-card skeleton">
              <div className="skeleton-line" style={{ width: '60%' }} />
              <div className="skeleton-line" style={{ width: '90%' }} />
              <div className="skeleton-line" style={{ width: '40%' }} />
            </div>
          ))}
        </div>
      </section>
    )
  }

  const metrics = [
    // Listrik
    {
      key: 'p_active',
      group: 'Listrik',
      title: 'Daya Aktif',
      value: asNumber(lastLog?.daya_aktif_w),
      format: v => `${v.toFixed(1)} W`,
      icon: '⚡'
    },
    {
      key: 'i',
      group: 'Listrik',
      title: 'Arus',
      value: asNumber(lastLog?.arus_a),
      format: v => `${v.toFixed(2)} A`,
      icon: '🔌'
    },
    {
      key: 'v',
      group: 'Listrik',
      title: 'Tegangan',
      value: asNumber(lastLog?.tegangan_v),
      format: v => `${v.toFixed(1)} V`,
      icon: '⚡'
    },
    {
      key: 'pf',
      group: 'Listrik',
      title: 'Faktor Daya',
      value: asNumber(lastLog?.faktor_daya),
      format: v => v.toFixed(3),
      icon: '📊'
    },
    {
      key: 's',
      group: 'Listrik',
      title: 'Daya Semu',
      value: asNumber(lastLog?.daya_semu_va),
      format: v => `${v.toFixed(1)} VA`,
      icon: '📈'
    },
    {
      key: 'q',
      group: 'Listrik',
      title: 'Daya Reaktif',
      value: asNumber(lastLog?.daya_reaktif_var),
      format: v => `${v.toFixed(1)} VAR`,
      icon: '📉'
    },
    {
      key: 'freq',
      group: 'Listrik',
      title: 'Frekuensi',
      value: asNumber(lastLog?.frekuensi_hz),
      format: v => `${v.toFixed(2)} Hz`,
      icon: '📡'
    },

    // Energi
    {
      key: 'e_total',
      group: 'Energi',
      title: 'Total Energi',
      value: asNumber(lastLog?.energi_total_kwh),
      format: v => `${kwhFmt.format(v)} kWh`,
      icon: '🔋'
    },
    {
      key: 'e_day',
      group: 'Energi',
      title: 'Energi Hari Ini',
      value: asNumber(lastLog?.energi_harian_kwh),
      format: v => `${kwhFmt.format(v)} kWh`,
      icon: '📅'
    },
    {
      key: 'e_month',
      group: 'Energi',
      title: 'Energi Bulan Ini',
      value: asNumber(lastLog?.energi_bulanan_kwh),
      format: v => `${kwhFmt.format(v)} kWh`,
      icon: '📆'
    },

    // Tagihan
    {
      key: 'bill_day',
      group: 'Tagihan',
      title: 'Tagihan Hari Ini',
      value: asNumber(lastLog?.total_harian_rp),
      format: v => rupiahFmt.format(v),
      icon: '💰'
    },
    {
      key: 'bill_month',
      group: 'Tagihan',
      title: 'Tagihan Bulan Ini',
      value: asNumber(lastLog?.total_bulanan_rp),
      format: v => rupiahFmt.format(v),
      icon: '💳'
    },

    // Lingkungan
    {
      key: 'temp',
      group: 'Lingkungan',
      title: 'Suhu',
      value: asNumber(lastLog?.suhu_c),
      format: v => `${v.toFixed(1)} °C`,
      icon: '🌡️'
    },
    {
      key: 'hum',
      group: 'Lingkungan',
      title: 'Kelembapan',
      value: asNumber(lastLog?.kelembapan_rh),
      format: v => `${v.toFixed(1)} %`,
      icon: '💧'
    },
    {
      key: 'lux',
      group: 'Lingkungan',
      title: 'Cahaya',
      value: asNumber(lastLog?.light_level_lux),
      format: v => `${v.toFixed(0)} lux`,
      icon: '💡'
    },
    {
      key: 'press',
      group: 'Lingkungan',
      title: 'Tekanan',
      value: asNumber(lastLog?.tekanan_hpa),
      format: v => `${v.toFixed(1)} hPa`,
      icon: '🌬️'
    },
    {
      key: 'alt',
      group: 'Lingkungan',
      title: 'Ketinggian',
      value: asNumber(lastLog?.altitude_m),
      format: v => `${v.toFixed(1)} m`,
      icon: '⛰️'
    },
    {
      key: 'wifi',
      group: 'Lingkungan',
      title: 'WiFi RSSI',
      value: asNumber(lastLog?.wifi_rssi),
      format: v => `${v.toFixed(0)} dBm`,
      icon: '📶'
    }
  ]

  const lastTs = lastLog ? asDate(lastLog.ts) : null
  const lastTsStr = lastTs
    ? lastTs.toLocaleString('id-ID', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '-'

  const listrikMetrics = metrics.filter(m => m.group === 'Listrik')
  const energiTagihanMetrics = metrics.filter(
    m => m.group === 'Energi' || m.group === 'Tagihan'
  )
  const lingkunganMetrics = metrics.filter(m => m.group === 'Lingkungan')

  const renderMetricCard = metric => (
    <div key={metric.key} className="card metric-card">
      <div className="metric-header">
        <span className="metric-icon">{metric.icon}</span>
        <div className="card-label">{metric.group.toUpperCase()}</div>
      </div>
      <div className="metric-content">
        <div className="card-title">{metric.title}</div>
        <div className="card-value">
          {metric.value === null || Number.isNaN(metric.value)
            ? '-'
            : metric.format(metric.value)}
        </div>
      </div>
    </div>
  )

  return (
    <section className="section section-summary">
      <div className="section-header">
        <div>
          <h2>Ringkasan Monitoring</h2>
          <p className="section-subtitle">
            Snapshot cepat listrik, energi, tagihan, dan sensor lingkungan.
          </p>
        </div>
        <div className="summary-header-right">
          <div className="update-info">
            <span className="update-dot" />
            Update terakhir: {lastTsStr}
          </div>
          <button
            className="btn btn-small btn-primary reset-btn"
            onClick={onResetKwh}
            disabled={!lastLog || resetLoading}
          >
            {resetLoading ? 'Reset kWh...' : 'Reset kWh Meter'}
          </button>
        </div>
      </div>

      <div className="summary-groups">
        {/* Listrik */}
        <div className="summary-group">
          <div className="summary-group-header">
            <span className="summary-group-title">Listrik</span>
            <span className="summary-group-badge">Realtime</span>
          </div>
          <div className="summary-grid summary-grid--group">
            {listrikMetrics.map(renderMetricCard)}
          </div>
        </div>

        {/* Energi + Tagihan */}
        <div className="summary-group">
          <div className="summary-group-header">
            <span className="summary-group-title">Energi &amp; Tagihan</span>
            <span className="summary-group-badge">Akumulasi</span>
          </div>
          <div className="summary-grid summary-grid--group">
            {energiTagihanMetrics.map(renderMetricCard)}
          </div>
        </div>

        {/* Lingkungan */}
        <div className="summary-group">
          <div className="summary-group-header">
            <span className="summary-group-title">Lingkungan</span>
            <span className="summary-group-badge">Kondisi Ruangan</span>
          </div>
          <div className="summary-grid summary-grid--group">
            {lingkunganMetrics.map(renderMetricCard)}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ========================================================================
 * RIWAYAT (LINE CHART)
 * ====================================================================== */

function RiwayatSection({
  logs,
  lastLog,
  rangeHours,
  setRangeHours,
  asNumber,
  loading
}) {
  const filteredLogs = useMemo(
    () => filterLogsByHours(logs, rangeHours),
    [logs, rangeHours]
  )

  const chartData = useMemo(() => {
    const labels = filteredLogs.map(l => {
      const t = asDate(l.ts)
      return t
        ? t.toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit'
          })
        : ''
    })
    const daya = filteredLogs.map(l => {
      const v = asNumber(l.daya_aktif_w)
      return Number.isNaN(v) ? null : v
    })
    const biayaBulanan = filteredLogs.map(l => {
      const v = asNumber(l.total_bulanan_rp)
      return Number.isNaN(v) ? null : v
    })

    return {
      labels,
      datasets: [
        {
          label: 'Daya Aktif (W)',
          data: daya,
          borderColor: '#28a5ff',
          backgroundColor: 'rgba(40, 165, 255, 0.1)',
          borderWidth: 2,
          tension: 0.2,
          fill: true
        },
        {
          label: 'Tagihan Bulanan (Rp)',
          data: biayaBulanan,
          borderColor: '#ff6b6b',
          backgroundColor: 'rgba(255, 107, 107, 0.1)',
          borderWidth: 2,
          borderDash: [4, 4],
          tension: 0.2,
          yAxisID: 'y1'
        }
      ]
    }
  }, [filteredLogs, asNumber])

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          boxWidth: 18,
          padding: 20,
          usePointStyle: true
        }
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        backgroundColor: 'rgba(255, 255, 255, 0.9)',
        titleColor: '#1f2933',
        bodyColor: '#1f2933',
        borderColor: '#c5e7ff',
        borderWidth: 1
      }
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(183, 196, 212, 0.2)'
        },
        ticks: {
          color: '#7b8ba5'
        }
      },
      y: {
        grid: {
          color: 'rgba(183, 196, 212, 0.2)'
        },
        ticks: {
          color: '#7b8ba5'
        }
      },
      y1: {
        position: 'right',
        grid: {
          drawOnChartArea: false
        },
        ticks: {
          color: '#7b8ba5'
        }
      }
    }
  }

  const last = lastLog ? asDate(lastLog.ts) : null

  if (loading) {
    return (
      <section className="section section-history">
        <div className="section-header">
          <h2>Riwayat Data</h2>
          <p className="section-subtitle">Memuat data...</p>
        </div>
        <div className="chart-wrapper skeleton" style={{ height: '300px' }} />
      </section>
    )
  }

  return (
    <section className="section section-history">
      <div className="section-header">
        <div>
          <h2>Riwayat Data</h2>
          <p className="section-subtitle">
            Log monitoring terakhir + grafik dalam 1–6 jam terakhir.
          </p>
        </div>
        <div className="btn-group">
          {[1, 2, 3, 4, 5, 6].map(h => (
            <button
              key={h}
              className={
                rangeHours === h ? 'btn btn-small btn-primary' : 'btn btn-small'
              }
              onClick={() => setRangeHours(h)}
            >
              {h} jam
            </button>
          ))}
        </div>
      </div>

      <div className="last-log-card">
        <div>
          <div className="card-label">Log terakhir</div>
          <div className="last-log-main">
            {last
              ? last.toLocaleString('id-ID', {
                  weekday: 'long',
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })
              : '-'}
          </div>
          {lastLog && (
            <div className="last-log-meta">
              <span>
                Daya:{' '}
                {!Number.isNaN(asNumber(lastLog.daya_aktif_w))
                  ? `${asNumber(lastLog.daya_aktif_w).toFixed(1)} W`
                  : '-'}
              </span>
              <span>
                Energi hari ini:{' '}
                {!Number.isNaN(asNumber(lastLog.energi_harian_kwh))
                  ? `${kwhFmt.format(asNumber(lastLog.energi_harian_kwh))} kWh`
                  : '-'}
              </span>
              <span>
                Tagihan hari ini:{' '}
                {!Number.isNaN(asNumber(lastLog.total_harian_rp))
                  ? rupiahFmt.format(asNumber(lastLog.total_harian_rp))
                  : '-'}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="chart-wrapper">
        {filteredLogs.length ? (
          <Line options={options} data={chartData} />
        ) : (
          <div className="empty-placeholder">
            Belum ada data dalam {rangeHours} jam terakhir.
          </div>
        )}
      </div>
    </section>
  )
}

/* ========================================================================
 * RINGKASAN 1 MINGGU
 * ====================================================================== */

function WeeklySection({ weeklyStats, loading }) {
  if (loading) {
    return (
      <section className="section section-weekly">
        <div className="section-header">
          <h2>Ringkasan 1 Minggu</h2>
          <p className="section-subtitle">Memuat data...</p>
        </div>
        <div className="skeleton" style={{ height: '200px' }} />
      </section>
    )
  }

  if (!weeklyStats) {
    return (
      <section className="section section-weekly">
        <h2>Ringkasan 1 Minggu</h2>
        <p className="section-subtitle">
          Belum ada data 7 hari terakhir untuk dianalisis.
        </p>
      </section>
    )
  }

  const { days, mostWastefulDay } = weeklyStats

  const formatDay = dateStr => {
    const d = asDate(dateStr)
    if (!d) return dateStr
    return d.toLocaleDateString('id-ID', {
      weekday: 'short',
      day: '2-digit',
      month: 'short'
    })
  }

  const peakTimeStr = d =>
    d
      ? d.toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit'
        })
      : '-'

  // data mini bar chart (tanpa useMemo supaya hooks aman)
  const labels = days.map(d => formatDay(d.date))
  const data = days.map(d => d.costRp || 0)
  const chartData = {
    labels,
    datasets: [
      {
        label: 'Tagihan harian (Rp)',
        data,
        backgroundColor: 'rgba(59, 130, 246, 0.85)',
        borderRadius: 6,
        maxBarThickness: 26
      }
    ]
  }

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 11 } }
      },
      y: {
        grid: { color: 'rgba(148, 163, 184, 0.25)' },
        ticks: { font: { size: 11 } }
      }
    }
  }

  return (
    <section className="section section-weekly">
      <h2>Ringkasan 1 Minggu Terakhir</h2>
      <p className="section-subtitle">
        Cari hari dan jam yang paling boros pemakaian listrik 7 hari terakhir.
      </p>

      <div className="highlight-card">
        <div className="card-label">Hari paling boros</div>
        <div className="highlight-main">
          {formatDay(mostWastefulDay.date)}{' '}
          <span className="highlight-chip">
            {kwhFmt.format(mostWastefulDay.energyKwh)} kWh
          </span>
        </div>
        <div className="highlight-meta">
          Total ~
          {rupiahFmt.format(mostWastefulDay.costRp)} &bull; puncak daya{' '}
          {mostWastefulDay.peakTs
            ? `${mostWastefulDay.peakWatts.toFixed(0)} W @ ${peakTimeStr(
                mostWastefulDay.peakTs
              )}`
            : '-'}
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Hari</th>
            <th>Energi (kWh)</th>
            <th>Tagihan (Rp)</th>
            <th>Jam Puncak</th>
            <th>Daya Puncak (W)</th>
          </tr>
        </thead>
        <tbody>
          {days.map(d => (
            <tr key={d.date}>
              <td>{formatDay(d.date)}</td>
              <td>{kwhFmt.format(d.energyKwh)}</td>
              <td>{rupiahFmt.format(d.costRp)}</td>
              <td>{d.peakTs ? peakTimeStr(d.peakTs) : '-'}</td>
              <td>{d.peakWatts ? `${d.peakWatts.toFixed(0)} W` : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="chart-wrapper" style={{ height: 220, marginTop: 16 }}>
        <Bar data={chartData} options={chartOptions} />
      </div>
    </section>
  )
}

/* ========================================================================
 * RINGKASAN BULANAN
 * ====================================================================== */

function MonthlySection({
  monthlyOptions,
  selectedMonthKey,
  setSelectedMonthKey,
  monthlyStats,
  loading
}) {
  if (loading) {
    return (
      <section className="section section-monthly">
        <div className="section-header">
          <h2>Ringkasan Bulanan</h2>
          <p className="section-subtitle">Memuat data...</p>
        </div>
        <div className="skeleton" style={{ height: '200px' }} />
      </section>
    )
  }

  return (
    <section className="section section-monthly">
      <div className="section-header">
        <div>
          <h2>Ringkasan Bulanan</h2>
          <p className="section-subtitle">
            Pilih bulan untuk melihat minggu mana yang paling boros.
          </p>
        </div>
        <div>
          <select
            className="select"
            value={selectedMonthKey || ''}
            onChange={e => setSelectedMonthKey(e.target.value || null)}
          >
            {monthlyOptions.length === 0 && (
              <option value="">Tidak ada data</option>
            )}
            {monthlyOptions.length > 0 && (
              <>
                <option value="">Pilih bulan...</option>
                {monthlyOptions.map(m => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </>
            )}
          </select>
        </div>
      </div>

      {!selectedMonthKey && (
        <p className="section-subtitle">
          Pilih salah satu bulan untuk menampilkan ringkasan.
        </p>
      )}

      {selectedMonthKey && !monthlyStats && (
        <p className="section-subtitle">
          Belum ada data untuk bulan yang dipilih.
        </p>
      )}

      {selectedMonthKey && monthlyStats && (
        <>
          <div className="highlight-card">
            <div className="card-label">Minggu paling boros</div>
            <div className="highlight-main">
              Minggu {monthlyStats.mostWastefulWeek.index}{' '}
              <span className="highlight-chip">
                {kwhFmt.format(monthlyStats.mostWastefulWeek.energyKwh)} kWh
              </span>
            </div>
            <div className="highlight-meta">
              Total ~
              {rupiahFmt.format(monthlyStats.mostWastefulWeek.costRp)} &bull;
              puncak daya{' '}
              {monthlyStats.mostWastefulWeek.peakTs
                ? `${monthlyStats.mostWastefulWeek.peakWatts.toFixed(
                    0
                  )} W @ ${monthlyStats.mostWastefulWeek.peakTs.toLocaleTimeString(
                    'id-ID',
                    { hour: '2-digit', minute: '2-digit' }
                  )}`
                : '-'}
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>Minggu ke-</th>
                <th>Energi (kWh)</th>
                <th>Tagihan (Rp)</th>
                <th>Jam Puncak</th>
                <th>Daya Puncak (W)</th>
              </tr>
            </thead>
            <tbody>
              {monthlyStats.weeks.map(w => (
                <tr key={w.index}>
                  <td>{w.index}</td>
                  <td>{kwhFmt.format(w.energyKwh)}</td>
                  <td>{rupiahFmt.format(w.costRp)}</td>
                  <td>
                    {w.peakTs
                      ? w.peakTs.toLocaleTimeString('id-ID', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })
                      : '-'}
                  </td>
                  <td>{w.peakWatts ? `${w.peakWatts.toFixed(0)} W` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

/* ========================================================================
 * KONTROL RELAY
 * ====================================================================== */

const DEFAULT_AUTO_RULES = {
  0: { enabled: false, source: 'temperature', operator: '>', threshold: 30 },
  1: { enabled: false, source: 'humidity', operator: '>', threshold: 70 },
  2: { enabled: false, source: 'lux', operator: '<', threshold: 100 },
  3: { enabled: false, source: 'temperature', operator: '<', threshold: 25 }
}

function loadAutoRules() {
  try {
    const raw = localStorage.getItem('relayAutoRules')
    if (!raw) return DEFAULT_AUTO_RULES
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_AUTO_RULES, ...parsed }
  } catch {
    return DEFAULT_AUTO_RULES
  }
}

function RelayPanel({ relays, relaysLoading, toggleRelay, lastLog, asNumber }) {
  const [autoRules, setAutoRules] = useState(loadAutoRules)
  const lastAutoActionRef = useRef({})

  useEffect(() => {
    localStorage.setItem('relayAutoRules', JSON.stringify(autoRules))
  }, [autoRules])

  const getSensorValue = source => {
    if (!lastLog) return NaN
    if (source === 'temperature') return asNumber(lastLog.suhu_c)
    if (source === 'humidity') return asNumber(lastLog.kelembapan_rh)
    if (source === 'lux') return asNumber(lastLog.light_level_lux)
    return NaN
  }

  // Auto mode
  useEffect(() => {
    if (!lastLog || !relays.length) return

    const actions = { ...lastAutoActionRef.current }

    relays.forEach(relay => {
      const ch = relay.channel
      const rule = autoRules[ch]
      if (!rule || !rule.enabled) return

      const sensorValue = getSensorValue(rule.source)
      if (Number.isNaN(sensorValue)) return

      const shouldOn =
        rule.operator === '>'
          ? sensorValue > rule.threshold
          : sensorValue < rule.threshold

      if (actions[ch] === shouldOn) return

      toggleRelay(ch, shouldOn, `auto_${rule.source}`).catch(err => {
        console.error('Auto relay error', err)
      })
      actions[ch] = shouldOn
    })

    lastAutoActionRef.current = actions
  }, [lastLog, relays, autoRules, toggleRelay])

  const handleRuleChange = (ch, patch) => {
    setAutoRules(prev => ({
      ...prev,
      [ch]: {
        ...prev[ch],
        ...patch
      }
    }))
  }

  const formatChannelName = ch => `Relay ${ch + 1}`

  const sensorPreview = source => {
    const val = getSensorValue(source)
    if (Number.isNaN(val)) return '-'
    if (source === 'temperature') return `${val.toFixed(1)} °C`
    if (source === 'humidity') return `${val.toFixed(1)} %`
    if (source === 'lux') return `${val.toFixed(0)} lux`
    return '-'
  }

  if (relaysLoading) {
    return (
      <section className="section section-relay">
        <h2>Kontrol Relay</h2>
        <p className="section-subtitle">Memuat data...</p>
        <div className="relay-grid">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card relay-card skeleton">
              <div className="skeleton-line" style={{ width: '60%' }} />
              <div className="skeleton-line" style={{ width: '90%' }} />
              <div className="skeleton-line" style={{ width: '40%' }} />
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="section section-relay">
      <h2>Kontrol Relay</h2>
      <p className="section-subtitle">
        4 relay: mode manual ON/OFF, dan mode otomatis berdasarkan suhu,
        kelembapan, atau cahaya (lux).
      </p>

      <div className="relay-grid">
        {relays.map(relay => {
          const ch = relay.channel
          const state = !!relay.state
          const rule = autoRules[ch] || DEFAULT_AUTO_RULES[ch]

          return (
            <div key={ch} className="card relay-card">
              <div className="relay-header">
                <div>
                  <div className="card-title">{formatChannelName(ch)}</div>
                  <div className="relay-status-chip">
                    <span
                      className={
                        state
                          ? 'status-dot status-dot-on'
                          : 'status-dot status-dot-off'
                      }
                    />
                    {state ? 'ON' : 'OFF'}
                  </div>
                </div>
                <button
                  className={state ? 'btn btn-danger' : 'btn btn-primary'}
                  onClick={() =>
                    toggleRelay(ch, !state, 'web_manual').catch(err =>
                      console.error(err)
                    )
                  }
                >
                  {state ? 'Matikan' : 'Nyalakan'}
                </button>
              </div>

              <div className="relay-auto">
                <div className="relay-auto-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={e =>
                        handleRuleChange(ch, { enabled: e.target.checked })
                      }
                    />{' '}
                    Mode otomatis
                  </label>
                </div>

                <div className="relay-auto-row">
                  <label className="field-label">Sumber sensor</label>
                  <select
                    className="select"
                    value={rule.source}
                    onChange={e =>
                      handleRuleChange(ch, { source: e.target.value })
                    }
                  >
                    <option value="temperature">Suhu (°C)</option>
                    <option value="humidity">Kelembapan (%)</option>
                    <option value="lux">Cahaya (lux)</option>
                  </select>
                </div>

                <div className="relay-auto-row relay-auto-row-inline">
                  <div>
                    <label className="field-label">Kondisi</label>
                    <select
                      className="select"
                      value={rule.operator}
                      onChange={e =>
                        handleRuleChange(ch, { operator: e.target.value })
                      }
                    >
                      <option value=">">Nyala jika lebih dari (&gt;)</option>
                      <option value="<">Nyala jika kurang dari (&lt;)</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label">Threshold</label>
                    <input
                      className="input"
                      type="number"
                      value={rule.threshold}
                      onChange={e =>
                        handleRuleChange(ch, {
                          threshold: Number(e.target.value)
                        })
                      }
                    />
                  </div>
                </div>

                <div className="relay-auto-preview">
                  Nilai sensor sekarang:{' '}
                  <strong>{sensorPreview(rule.source)}</strong>
                </div>
                <div className="card-foot">
                  Jika mode otomatis aktif, dashboard akan mengirim perintah ke
                  Supabase setiap kali data sensor baru masuk dan kondisi
                  terpenuhi.
                </div>
              </div>
            </div>
          )
        })}

        {relays.length === 0 && !relaysLoading && (
          <div className="empty-placeholder">
            Tidak ada data relay untuk device ini. Pastikan tabel{' '}
            <code>relay_channel</code> berisi 4 baris <code>device_id</code> ={' '}
            <code>{DEVICE_ID}</code>.
          </div>
        )}
      </div>
    </section>
  )
}

/* ========================================================================
 * PANEL VISUAL (DONUT & BAR)
 * ====================================================================== */

function VisualPowerPanel({ logs, lastLog, asNumber, loading }) {
  const energyDay = lastLog ? asNumber(lastLog.energi_harian_kwh) || 0 : 0
  const energyMonth = lastLog ? asNumber(lastLog.energi_bulanan_kwh) || 0 : 0
  const energyTotal = lastLog ? asNumber(lastLog.energi_total_kwh) || 0 : 0
  const energyOther = Math.max(energyTotal - energyMonth, 0)

  const doughnutData = {
    labels: ['Hari ini', 'Bulan ini', 'Total lain'],
    datasets: [
      {
        data: [energyDay, Math.max(energyMonth - energyDay, 0), energyOther],
        backgroundColor: ['#38bdf8', '#a855f7', '#f97316'],
        borderWidth: 0
      }
    ]
  }

  const doughnutOptions = {
    cutout: '68%',
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          boxWidth: 10,
          usePointStyle: true
        }
      }
    }
  }

  const lastSamples = useMemo(() => {
    if (!logs?.length) return []
    const n = 12
    return logs.slice(-n)
  }, [logs])

  const barData = useMemo(() => {
    const labels = lastSamples.map(l => {
      const t = asDate(l.ts)
      return t
        ? t.toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit'
          })
        : ''
    })
    const daya = lastSamples.map(l => {
      const v = asNumber(l.daya_aktif_w)
      return Number.isNaN(v) ? 0 : v
    })

    return {
      labels,
      datasets: [
        {
          label: 'Daya Aktif (W)',
          data: daya,
          backgroundColor: 'rgba(248, 113, 113, 0.8)',
          borderRadius: 8,
          maxBarThickness: 18
        }
      ]
    }
  }, [lastSamples, asNumber])

  const barOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 10 } }
      },
      y: {
        grid: { color: 'rgba(148, 163, 184, 0.2)' },
        ticks: { font: { size: 10 } }
      }
    }
  }

  return (
    <section className="section visual-panel">
      <div className="section-header">
        <div>
          <h2>Profil Energi & Daya</h2>
          <p className="section-subtitle">
            Komposisi energi dan lonjakan daya beberapa sampel terakhir.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: '240px' }} />
      ) : (
        <div className="visual-grid">
          <div className="card doughnut-card">
            <div className="doughnut-wrapper">
              <Doughnut data={doughnutData} options={doughnutOptions} />
              <div className="doughnut-center">
                <div className="center-label">Hari ini</div>
                <div className="center-value">
                  {kwhFmt.format(energyDay)} kWh
                </div>
              </div>
            </div>
            <div className="visual-stats">
              <div className="visual-stat-item">
                <span className="small-label">Bulan ini</span>
                <span className="small-value">
                  {kwhFmt.format(energyMonth)} kWh
                </span>
              </div>
              <div className="visual-stat-item">
                <span className="small-label">Total energi</span>
                <span className="small-value">
                  {kwhFmt.format(energyTotal)} kWh
                </span>
              </div>
            </div>
          </div>

          <div className="card bar-card">
            <div className="bar-card-header">
              <div>
                <div className="card-title">Profil Daya Terakhir</div>
                <div className="section-subtitle">
                  Pantau lonjakan daya per sampel.
                </div>
              </div>
              <span className="small-chip">
                {lastSamples.length} sampel terakhir
              </span>
            </div>
            <div className="bar-wrapper">
              {lastSamples.length ? (
                <Bar data={barData} options={barOptions} />
              ) : (
                <div className="empty-placeholder">
                  Belum ada data daya yang cukup.
                </div>
              )}
            </div>
            <div className="bar-footer">
              <span>
                Maks:{' '}
                {lastSamples.length
                  ? `${Math.max(
                      ...lastSamples.map(l => asNumber(l.daya_aktif_w) || 0)
                    ).toFixed(0)} W`
                  : '-'}
              </span>
              <span>
                Rata-rata:{' '}
                {lastSamples.length
                  ? `${(
                      lastSamples.reduce(
                        (sum, l) => sum + (asNumber(l.daya_aktif_w) || 0),
                        0
                      ) / lastSamples.length
                    ).toFixed(1)} W`
                  : '-'}
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/* ========================================================================
 * INSIGHT LISTRIK + BUDGET + PERKIRAAN TAGIHAN
 * ====================================================================== */

function InsightListrikSection({
  weeklyStats,
  lastLog,
  asNumber,
  budgetTarget,
  setBudgetTarget
}) {
  const totalEnergi7 =
    weeklyStats?.days?.reduce((s, d) => s + (d.energyKwh || 0), 0) || 0
  const totalTagihan7 =
    weeklyStats?.days?.reduce((s, d) => s + (d.costRp || 0), 0) || 0
  const mostWastefulDay = weeklyStats?.mostWastefulDay || null

  const energiHariIni = lastLog ? asNumber(lastLog.energi_harian_kwh) || 0 : 0
  const tagihanHariIni = lastLog ? asNumber(lastLog.total_harian_rp) || 0 : 0
  const energiTotal = lastLog ? asNumber(lastLog.energi_total_kwh) || 0 : 0

  const tarifPerKwh = lastLog
    ? asNumber(lastLog.tarif_harga_per_kwh) || 0
    : 0
  const biayaBeban = lastLog
    ? asNumber(lastLog.tarif_biaya_beban) || 0
    : 0
  const pajakP = lastLog
    ? asNumber(lastLog.tarif_pajak_persen) || 0
    : 0

  const energiHariRp = lastLog
    ? asNumber(lastLog.biaya_energi_harian_rp) || 0
    : 0
  const bebanHari = lastLog
    ? asNumber(lastLog.beban_harian_rp) || 0
    : 0
  const ppjHari = lastLog
    ? asNumber(lastLog.ppj_harian_rp) || 0
    : 0
  const pbjtHari = lastLog
    ? asNumber(lastLog.pbjt_harian_rp) || 0
    : 0

  const tagihanBulanIni = lastLog
    ? asNumber(lastLog.total_bulanan_rp) || 0
    : 0

  // Perkiraan tagihan akhir bulan (proyeksi)
  const now = new Date()
  const dayOfMonth = now.getDate()
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0
  ).getDate()

  const perkiraanAkhirBulan =
    dayOfMonth > 0 ? (tagihanBulanIni / dayOfMonth) * daysInMonth : 0

  // Progress budget
  const percentUsed =
    budgetTarget > 0 ? (tagihanBulanIni / budgetTarget) * 100 : 0
  const clampedPercent = Math.max(0, Math.min(percentUsed, 200))

  return (
    <section className="section section-insights">
      <div className="section-header">
        <div>
          <h2>Insight Listrik</h2>
          <p className="section-subtitle">
            Ringkasan singkat pemakaian energi dan tagihan.
          </p>
        </div>

        {/* Input budget (target tagihan per bulan) */}
        <div className="budget-control">
          <label className="field-label">Target tagihan / bulan</label>
          <div className="budget-input-row">
            <span>Rp</span>
            <input
              className="input budget-input"
              type="number"
              min={0}
              value={budgetTarget || ''}
              onChange={e =>
                setBudgetTarget(Number(e.target.value || 0))
              }
              placeholder="contoh 300000"
            />
          </div>
        </div>
      </div>

      <div className="insights-grid">
        <div className="insight-card insight-1">
          <div className="insight-label">Total energi 7 hari</div>
          <div className="insight-value">
            {kwhFmt.format(totalEnergi7)} kWh
          </div>
          <div className="insight-note">
            {mostWastefulDay
              ? `Hari paling boros: ${mostWastefulDay.date} • ${kwhFmt.format(
                  mostWastefulDay.energyKwh
                )} kWh`
              : 'Belum cukup data 7 hari.'}
          </div>
        </div>

        <div className="insight-card insight-2">
          <div className="insight-label">Total tagihan 7 hari</div>
          <div className="insight-value">
            {rupiahFmt.format(totalTagihan7)}
          </div>
          <div className="insight-note">
            {tagihanHariIni
              ? `Hari ini: ${rupiahFmt.format(tagihanHariIni)}`
              : 'Belum ada tagihan hari ini.'}
          </div>
        </div>

        <div className="insight-card insight-3">
          <div className="insight-label">Tarif listrik aktif</div>
          <div className="insight-value">
            {tarifPerKwh ? `${rupiahFmt.format(tarifPerKwh)} / kWh` : '-'}
          </div>
          <div className="insight-note">
            Beban tetap:{' '}
            {biayaBeban ? rupiahFmt.format(biayaBeban) : '-'}
            {' • '}
            Pajak: {pajakP.toFixed(1)}%
          </div>
        </div>

        <div className="insight-card insight-4">
          <div className="insight-label">Rincian tagihan hari ini</div>
          <div className="insight-note">
            <div>Energi: {rupiahFmt.format(energiHariRp)}</div>
            <div>Beban: {rupiahFmt.format(bebanHari)}</div>
            <div>PPJ: {rupiahFmt.format(ppjHari)}</div>
            <div>PBJT: {rupiahFmt.format(pbjtHari)}</div>
            <div style={{ marginTop: 4 }}>
              Total:{' '}
              <strong>{rupiahFmt.format(tagihanHariIni)}</strong>
            </div>
            <div style={{ marginTop: 4 }}>
              Energi hari ini: {kwhFmt.format(energiHariIni)} kWh • Total
              kumulatif: {kwhFmt.format(energiTotal)} kWh
            </div>
          </div>
        </div>

        {/* Progress budget + prediksi tagihan */}
        <div className="insight-card insight-5">
          <div className="insight-label">Progress tagihan bulan ini</div>
          <div className="budget-progress-top">
            <span>{rupiahFmt.format(tagihanBulanIni)}</span>
            <span>
              dari{' '}
              {budgetTarget ? rupiahFmt.format(budgetTarget) : 'target belum di-set'}
            </span>
          </div>
          <div className="budget-progress-bar">
            <div
              className={
                'budget-progress-fill ' +
                (percentUsed > 100 ? 'over-budget' : '')
              }
              style={{ width: `${clampedPercent}%` }}
            />
          </div>
          <div className="budget-progress-note">
            {budgetTarget
              ? percentUsed <= 100
                ? `Sudah terpakai ${percentUsed.toFixed(1)}% dari target.`
                : `Sudah melewati target (${percentUsed.toFixed(
                    1
                  )}%).`
              : 'Set dulu target tagihan supaya bisa dipantau.'}
          </div>

          <div className="insight-note" style={{ marginTop: 8 }}>
            Perkiraan akhir bulan:{' '}
            <strong>{rupiahFmt.format(perkiraanAkhirBulan)}</strong>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
              Berdasar rata-rata harian bulan ini (hari ke-{dayOfMonth} dari{' '}
              {daysInMonth}).
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ========================================================================
 * Helper load initial range / month / budget
 * ====================================================================== */

function loadInitialRangeHours() {
  if (typeof window === 'undefined') return 1
  const raw = window.localStorage.getItem(RANGE_STORAGE_KEY)
  const n = parseInt(raw, 10)
  return [1, 2, 3, 4, 5, 6].includes(n) ? n : 1
}

function loadInitialMonthKey() {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(MONTH_STORAGE_KEY)
  return raw || null
}

function loadInitialBudget() {
  if (typeof window === 'undefined') return 0
  const raw = window.localStorage.getItem(BUDGET_STORAGE_KEY)
  const n = parseInt(raw, 10)
  return Number.isNaN(n) ? 0 : n
}

/* ========================================================================
 * APP
 * ====================================================================== */

export default function App() {
  const { logs, lastLog, loading, error, asNumber } = useRealtimeLogs(DEVICE_ID)
  const {
    relays,
    loading: relaysLoading,
    error: relayError,
    toggleRelay
  } = useRelayConfig(DEVICE_ID)

  const [rangeHours, setRangeHours] = useState(loadInitialRangeHours)
  const [resetLoading, setResetLoading] = useState(false)
  const [selectedMonthKey, setSelectedMonthKey] = useState(loadInitialMonthKey)
  const [budgetTarget, setBudgetTarget] = useState(loadInitialBudget)

  // simpan range ke localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(RANGE_STORAGE_KEY, String(rangeHours))
  }, [rangeHours])

  // simpan bulan terpilih ke localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (selectedMonthKey) {
      window.localStorage.setItem(MONTH_STORAGE_KEY, selectedMonthKey)
    }
  }, [selectedMonthKey])

  // simpan budget ke localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(BUDGET_STORAGE_KEY, String(budgetTarget))
  }, [budgetTarget])

  // tombol reset kWh -> insert ke device_commands
  const handleResetKwh = async () => {
    if (!lastLog) return
    const currentKwh = asNumber(lastLog.energi_total_kwh)
    if (Number.isNaN(currentKwh)) {
      alert('Nilai energi_total_kwh tidak valid.')
      return
    }

    const ok = window.confirm(
      `Yakin reset kWh meter untuk device ini?\n` +
        `Nilai sekarang: ${kwhFmt.format(currentKwh)} kWh`
    )
    if (!ok) return

    try {
      setResetLoading(true)
      const meter_ts = Math.floor(Date.now() / 1000)

      const { error: insertError } = await supabase
        .from('device_commands')
        .insert({
          device_id: DEVICE_ID,
          cmd_type: 'reset_kwh',
          meter_kwh_ref: currentKwh,
          meter_ts
        })

      if (insertError) throw insertError

      alert(
        'Perintah reset kWh berhasil dikirim. Tunggu beberapa detik sampai device memproses.'
      )
    } catch (err) {
      console.error('Gagal kirim perintah reset kWh', err)
      alert(`Gagal kirim perintah reset kWh: ${err.message || err}`)
    } finally {
      setResetLoading(false)
    }
  }

  const monthlyOptions = useMemo(() => getAvailableMonths(logs), [logs])

  // kalau monthKey di localStorage sudah gak ada di data, fallback ke bulan terakhir
  useEffect(() => {
    if (monthlyOptions.length === 0) return
    const exists = monthlyOptions.some(m => m.key === selectedMonthKey)
    if (!selectedMonthKey || !exists) {
      const last = monthlyOptions[monthlyOptions.length - 1]
      setSelectedMonthKey(last.key)
    }
  }, [monthlyOptions, selectedMonthKey])

  const weeklyStats = useMemo(
    () => computeWeeklyStats(logs, asNumber),
    [logs, asNumber]
  )

  const monthlyStats = useMemo(
    () => computeMonthlyStats(logs, selectedMonthKey, asNumber),
    [logs, selectedMonthKey, asNumber]
  )

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Dashboard Power Monitoring</h1>
          <p className="app-subtitle">
            ESP32-S3 + PZEM004T v3 + BME280/BH1750 + Supabase + Tarif Listrik
          </p>
        </div>
        <div className="tag-chip">
          Device: <span className="tag-chip-label">{DEVICE_ID}</span>
        </div>
      </header>

      {(error || relayError) && (
        <div className="error-banner">
          {error && <div>Monitoring error: {error}</div>}
          {relayError && <div>Relay error: {relayError}</div>}
        </div>
      )}

      {loading && (
        <div className="info-banner">
          Memuat data monitoring dari Supabase...
        </div>
      )}

      <main className="app-main">
        {/* ROW ATAS: 3 kolom */}
        <div className="app-row app-row-top">
          {/* kiri: riwayat + weekly */}
          <div className="dashboard-column col-left">
            <RiwayatSection
              logs={logs}
              lastLog={lastLog}
              rangeHours={rangeHours}
              setRangeHours={setRangeHours}
              asNumber={asNumber}
              loading={loading}
            />
            <WeeklySection weeklyStats={weeklyStats} loading={loading} />
          </div>

          {/* tengah: summary */}
          <div className="dashboard-column col-center">
            <SummaryCards
              lastLog={lastLog}
              asNumber={asNumber}
              loading={loading}
              onResetKwh={handleResetKwh}
              resetLoading={resetLoading}
            />
          </div>

          {/* kanan: relay */}
          <div className="dashboard-column col-right">
            <RelayPanel
              relays={relays}
              relaysLoading={relaysLoading}
              toggleRelay={toggleRelay}
              lastLog={lastLog}
              asNumber={asNumber}
            />
          </div>
        </div>

        {/* ROW BAWAH: 2 kolom */}
        <div className="app-row app-row-bottom">
          {/* kiri: visual + ringkasan bulanan */}
          <div className="dashboard-column col-bottom-left">
            <VisualPowerPanel
              logs={logs}
              lastLog={lastLog}
              asNumber={asNumber}
              loading={loading}
            />
            <MonthlySection
              monthlyOptions={monthlyOptions}
              selectedMonthKey={selectedMonthKey}
              setSelectedMonthKey={setSelectedMonthKey}
              monthlyStats={monthlyStats}
              loading={loading}
            />
          </div>

          {/* kanan: insight listrik & tagihan */}
          <div className="dashboard-column col-bottom-right">
            <InsightListrikSection
              weeklyStats={weeklyStats}
              lastLog={lastLog}
              asNumber={asNumber}
              budgetTarget={budgetTarget}
              setBudgetTarget={setBudgetTarget}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
