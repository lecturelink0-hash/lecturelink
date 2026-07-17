// 마이크 캡처 → 16kHz PCM base64 스트림 (프로토타입 app.js의 mic 로직 이식)
import { floatTo16kPcmBase64 } from './live.js'

export async function startMic(live) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  })
  const AudioCtor = window.AudioContext || window.webkitAudioContext
  const ctx = new AudioCtor()
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor는 deprecated지만 전 브라우저 동작 확인된 프로토타입 방식 유지.
  // AudioWorklet 전환은 Phase 7 QA에서 검토.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    live.sendAudioChunk(floatTo16kPcmBase64(input, ctx.sampleRate))
  }
  source.connect(processor)
  processor.connect(ctx.destination)
  return {
    stop() {
      try {
        processor.disconnect()
        source.disconnect()
        stream.getTracks().forEach((t) => t.stop())
        ctx.close()
      } catch {
        /* 이미 정리됨 */
      }
      live.endAudioStream()
    },
  }
}
