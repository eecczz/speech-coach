// Simple aggregator client: opens WS to /ws/signals, sends 5fps vision frames.
// Resilient to disconnects — drops frames silently when closed (we'd rather lose a frame
// than crash the practice page mid-session).

import type { VisionFrame } from '../signals/compute';

export interface ProsodyFrame {
  t_start: number;
  t_end: number;
  wpm?: number;
  filler_count?: number;
  filler_terms?: string[];
  pause_seconds?: number;
  silence_seconds?: number;
  rms_mean?: number;
}

export interface AudioAnalysisResult {
  session_id?: string;
  full_transcript?: string;
  stt_segments?: unknown[];
  prosody_frames?: unknown[];
  elapsed_s?: number;
}

export interface AggregatorClient {
  start(sessionId: string, scenario?: string): Promise<void>;
  sendVision(frame: VisionFrame): void;
  sendProsody(frame: ProsodyFrame): void;
  /** Optional audio analysis result (from /analyze) gets merged into the bundle. */
  end(audioResult?: AudioAnalysisResult | null): Promise<unknown>;
  close(): void;
}

export function createAggregatorClient(opts: {
  httpBase?: string;
  wsBase?: string;
} = {}): AggregatorClient {
  const httpBase = opts.httpBase ?? ''; // Vite dev proxy handles /session/* and /ws/signals
  const wsBase = opts.wsBase ?? '';
  let ws: WebSocket | null = null;
  let sessionId: string | null = null;

  return {
    async start(sid, scenario = 'presentation') {
      sessionId = sid;
      // 1. POST /session/start (REST) — scenario picks the coach's rubric YAML.
      try {
        const r = await fetch(`${httpBase}/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid, scenario }),
        });
        if (!r.ok) console.warn('[ws] session/start failed', r.status);
      } catch (e) {
        console.warn('[ws] session/start error — aggregator unreachable?', e);
        return;
      }

      // 2. Open WebSocket for signal stream.
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = wsBase || `${proto}//${location.host}/ws/signals`;
      ws = new WebSocket(url);
      await new Promise<void>((resolve) => {
        if (!ws) return resolve();
        ws.onopen = () => {
          console.log('[ws] aggregator connected');
          resolve();
        };
        ws.onerror = (e) => {
          console.warn('[ws] connect error', e);
          resolve();
        };
      });
    },

    sendVision(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ kind: 'vision', data: frame }));
      } catch (e) {
        // Silently drop — frame loss is acceptable.
      }
    },

    sendProsody(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ kind: 'prosody', data: frame }));
      } catch (e) {
        // Silently drop.
      }
    },

    async end(audioResult?: AudioAnalysisResult | null) {
      if (!sessionId) return null;
      const body: Record<string, unknown> = { session_id: sessionId };
      // Merge in audio-pipeline /analyze result so aggregator can replace the
      // browser-side stub prosody with server-side STT + prosody.
      if (audioResult) {
        if (audioResult.stt_segments) body.stt_segments = audioResult.stt_segments;
        if (audioResult.prosody_frames) body.prosody_frames = audioResult.prosody_frames;
        if (audioResult.full_transcript) body.full_transcript = audioResult.full_transcript;
      }
      // /session/end can take a while when audio is included (whisper+librosa)
      // but we already analyzed before calling this — body is just JSON ship.
      try {
        const r = await fetch(`${httpBase}/session/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await r.json();
      } catch (e) {
        console.warn('[ws] session/end failed', e);
        return null;
      }
    },

    close() {
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}
