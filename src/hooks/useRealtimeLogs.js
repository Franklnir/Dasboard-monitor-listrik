import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useRealtimeLogs(deviceId) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const asNumber = useCallback((value) => {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const n = parseFloat(value)
      return Number.isFinite(n) ? n : NaN
    }
    return NaN
  }, [])

  useEffect(() => {
    let mounted = true
    let subscription = null

    async function fetchInitialData() {
      try {
        setLoading(true)
        
        // Ambil data 30 hari terakhir untuk performa
        const fromDate = new Date()
        fromDate.setDate(fromDate.getDate() - 30)

        const { data, error: fetchError } = await supabase
          .from('monitoring_log')
          .select('*')
          .eq('device_id', deviceId)
          .gte('ts', fromDate.toISOString())
          .order('ts', { ascending: true })

        if (!mounted) return

        if (fetchError) {
          setError(`Fetch error: ${fetchError.message}`)
          console.error('[useRealtimeLogs] Fetch error:', fetchError)
        } else {
          setLogs(data || [])
          setError(null)
        }
      } catch (err) {
        if (mounted) {
          setError(`Exception: ${err.message}`)
          console.error('[useRealtimeLogs] Exception:', err)
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    fetchInitialData()

    // Subscribe to realtime updates
    subscription = supabase
      .channel(`monitoring_log:${deviceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'monitoring_log',
          filter: `device_id=eq.${deviceId}`
        },
        (payload) => {
          if (mounted) {
            setLogs(prev => {
              // Cegah duplikasi
              const exists = prev.some(log => log.id === payload.new.id)
              if (exists) return prev
              
              // Tambah data baru di akhir dan batasi jumlah data untuk performa
              const newLogs = [...prev, payload.new]
              return newLogs.slice(-1000) // Simpan maksimal 1000 data points
            })
          }
        }
      )
      .subscribe((status) => {
        console.log(`[Realtime] ${deviceId} status:`, status)
        if (status === 'SUBSCRIBED') {
          console.log(`[Realtime] Subscribed to device: ${deviceId}`)
        }
      })

    return () => {
      mounted = false
      if (subscription) {
        supabase.removeChannel(subscription)
      }
    }
  }, [deviceId])

  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null

  return {
    logs,
    lastLog,
    loading,
    error,
    asNumber
  }
}