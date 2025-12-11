import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useRelayConfig(deviceId) {
  const [relays, setRelays] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Fetch awal
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        setError(null)

        const { data, error } = await supabase
          .from('relay_channel')
          .select('*')
          .eq('device_id', deviceId)
          .order('channel', { ascending: true })

        if (cancelled) return

        if (error) {
          console.error('[useRelayConfig] Fetch error', error)
          setError(error.message)
        } else {
          setRelays(data || [])
        }
      } catch (e) {
        if (!cancelled) {
          console.error(e)
          setError(e.message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    const channel = supabase
      .channel('relay_channel_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'relay_channel',
          filter: `device_id=eq.${deviceId}`
        },
        payload => {
          const row = payload.new
          const type = payload.eventType
          setRelays(prev => {
            if (type === 'DELETE') {
              return prev.filter(r => r.id !== payload.old?.id)
            }
            if (!row) return prev
            const idx = prev.findIndex(
              r =>
                (r.id && r.id === row.id) ||
                (r.device_id === row.device_id && r.channel === row.channel)
            )
            if (idx === -1) return [...prev, row]
            const clone = [...prev]
            clone[idx] = row
            return clone
          })
        }
      )
      .subscribe(status => {
        console.log('[Realtime relay_channel] status:', status)
      })

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [deviceId])

  const toggleRelay = useCallback(
    async (channelIndex, newState, metaBy = 'web_manual') => {
      const payload = {
        device_id: deviceId,
        channel: channelIndex,
        state: newState,
        meta_by: metaBy,
        meta_ts: new Date().toISOString()
      }

      const { data, error } = await supabase
        .from('relay_channel')
        .upsert(payload, {
          onConflict: 'device_id,channel'
        })
        .select()
        .maybeSingle()

      if (error) {
        console.error('[toggleRelay] Error:', error)
        throw error
      }

      if (data) {
        setRelays(prev => {
          const idx = prev.findIndex(
            r =>
              (r.id && r.id === data.id) ||
              (r.device_id === data.device_id && r.channel === data.channel)
          )
          if (idx === -1) return [...prev, data]
          const clone = [...prev]
          clone[idx] = data
          return clone
        })
      }
    },
    [deviceId]
  )

  return { relays, loading, error, toggleRelay }
}
