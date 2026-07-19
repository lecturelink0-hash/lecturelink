// Gemini Live 음성 세션 — 해커톤 프로토타입 live.js 이식본.
// 변경점: ① API 키 대신 서버 발급 ephemeral token으로 연결 (v1alpha)
//        ② 시스템 프롬프트는 서버가 token constraints에 잠금 (클라이언트 비노출)
//        ③ logger.js 의존 제거 → onLog 콜백 (기본 console.debug)
import { GoogleGenAI, Modality } from '@google/genai'

export class GeminiLivePatient {
  constructor({ onStatus, onPatientText, onInputText, onAudioLevel, onAudioStart, onLog } = {}) {
    this.session = null
    this.ready = false
    this.connecting = false
    this.pending = null
    this.outputText = ''
    this.outputAudioParts = []
    this.inputText = ''
    this.lastInputText = ''
    this.onStatus = onStatus || (() => {})
    this.onPatientText = onPatientText || (() => {})
    this.onInputText = onInputText || (() => {})
    this.onAudioLevel = onAudioLevel || (() => {})
    this.onAudioStart = onAudioStart || (() => {})
    this.log = onLog || ((tag, data) => console.debug('[live]', tag, data || ''))
    this.audioContext = null
    this.playTime = 0
    this.lastConfig = null
  }

  async connect({ token, model, locked = true, systemInstruction, voice }) {
    if (!token) throw new Error('ephemeral token이 없습니다.')
    this.disconnect({ silent: true })
    this.ready = false
    this.connecting = true
    this.lastConfig = { model: normalizeLiveModelName(model), voice }
    this.onStatus('connecting', 'Live 연결 중')
    this.log('connect.start', { model: this.lastConfig.model, locked })

    // ephemeral token은 API 키 자리에 넣고 v1alpha로 연결한다 (공식 문서 방식)
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })

    const config = {
      responseModalities: [Modality?.AUDIO || 'AUDIO'],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    }
    if (!locked) {
      // 개발 폴백 모드에서만 클라이언트가 직접 구성
      config.systemInstruction = systemInstruction
      if (voice) config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }

    return await new Promise((resolve, reject) => {
      let settled = false
      let sdkSession = null
      const failTimer = setTimeout(() => {
        if (settled) return
        settled = true
        this.connecting = false
        this.ready = false
        this.onStatus('offline', 'Live 시간 초과')
        this.log('connect.timeout', {})
        reject(new Error('Live 연결 시간 초과'))
      }, 15000)

      const finishReady = (source = 'setupComplete') => {
        if (settled) return
        clearTimeout(failTimer)
        this.session = sdkSession
        this.ready = true
        this.connecting = false
        this.onStatus('online', 'Live 연결됨')
        settled = true
        this.log('connect.ready', { source })
        resolve(this.session)
      }

      ai.live
        .connect({
          model: this.lastConfig.model,
          config,
          callbacks: {
            onmessage: (message) => {
              if (message?.setupComplete) {
                finishReady('setupComplete')
                return
              }
              this.handleMessage(message)
            },
            onerror: (error) => {
              this.log('error', { message: error?.message || String(error) })
              this.connecting = false
              this.ready = false
              this.onStatus('offline', 'Live 오류')
              if (!settled) {
                clearTimeout(failTimer)
                settled = true
                reject(new Error(error?.message || 'Live API 연결 오류'))
              }
              if (this.pending) {
                this.pending.reject(new Error(error?.message || 'Live API 오류'))
                this.pending = null
              }
            },
            onclose: (event) => {
              this.log('close', { reason: event?.reason || '', code: event?.code || '' })
              this.ready = false
              this.connecting = false
              this.session = null
              this.onStatus('offline', 'Live 미연결')
              if (this.pending) {
                this.pending.reject(new Error('Live API 연결이 종료되었습니다.'))
                this.pending = null
              }
            },
          },
        })
        .then((session) => {
          sdkSession = session
          this.session = session
          // 일부 SDK/브라우저 조합은 setupComplete 이전에 세션을 반환한다 (프로토타입 검증 사항)
          setTimeout(() => finishReady('sdk-connect-returned'), 1200)
        })
        .catch((error) => {
          clearTimeout(failTimer)
          this.connecting = false
          this.ready = false
          this.onStatus('offline', 'Live 오류')
          this.log('connect.error', { message: error?.message || String(error) })
          if (!settled) {
            settled = true
            reject(error)
          }
        })
    })
  }

  disconnect(options = {}) {
    if (this.session) {
      try {
        this.session.close?.()
      } catch {
        /* 이미 닫힘 */
      }
    }
    this.session = null
    this.ready = false
    this.connecting = false
    this.outputText = ''
    this.outputAudioParts = []
    this.inputText = ''
    if (this.pending) {
      this.pending.reject(new Error('Live session disconnected.'))
      this.pending = null
    }
    this.onAudioLevel(0)
    this.onStatus('offline', 'Live 미연결')
    if (!options.silent) this.log('disconnect', {})
  }

  sendAudioChunk(base64Pcm16) {
    if (!this.session || !this.ready) return
    try {
      this.session.sendRealtimeInput({ audio: { data: base64Pcm16, mimeType: 'audio/pcm;rate=16000' } })
    } catch (error) {
      this.log('audio.send.error', { message: error?.message || String(error) })
    }
  }

  endAudioStream() {
    if (!this.session || !this.ready) return
    try {
      this.session.sendRealtimeInput({ audioStreamEnd: true })
    } catch (error) {
      this.log('audio.end.error', { message: error?.message || String(error) })
    }
  }

  askText(text) {
    if (!this.session || !this.ready) {
      return Promise.reject(new Error('Live API가 연결되어 있지 않습니다.'))
    }
    this.outputText = ''
    this.outputAudioParts = []
    this.inputText = ''
    this.lastInputText = ''
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending) return
        const out = this.outputText.trim()
        this.pending = null
        if (out) resolve(out)
        else reject(new Error('Live 응답이 없습니다.'))
      }, 30000)
      this.pending = {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      }
      try {
        this.session.sendRealtimeInput({ text })
      } catch (error) {
        this.pending = null
        clearTimeout(timeout)
        reject(error)
      }
    })
  }

  handleMessage(msg) {
    if (!msg) return
    const serverContent = msg.serverContent || {}
    if (serverContent.interrupted) {
      this.outputText = ''
      this.outputAudioParts = []
      this.log('turn.interrupted', {})
    }

    const inputTranscript = serverContent.inputTranscription?.text || msg.inputTranscription?.text || ''
    const outputTranscript = serverContent.outputTranscription?.text || msg.outputTranscription?.text || ''
    if (inputTranscript) {
      this.inputText = mergeTranscriptText(this.inputText, inputTranscript)
      this.lastInputText = this.inputText.trim()
      this.onInputText(this.lastInputText, { final: false, source: 'live_input_transcription' })
    }
    if (outputTranscript) {
      this.outputText += outputTranscript
    }

    const parts = serverContent.modelTurn?.parts || msg.modelTurn?.parts || []
    for (const part of parts) {
      if (part.text && !part.thought) this.outputText += part.text
      const inline = part.inlineData || part.inline_data
      const mimeType = inline?.mimeType || inline?.mime_type || 'audio/pcm;rate=24000'
      if (inline?.data && String(mimeType).includes('audio')) {
        this.outputAudioParts.push({ data: inline.data, mimeType })
        this.playPcm24(inline.data, mimeType)
      }
    }

    if (serverContent.turnComplete || serverContent.generationComplete || msg.turnComplete) {
      const text = this.outputText.trim()
      const inputText = this.inputText.trim()
      const audioParts = this.outputAudioParts.slice()
      this.lastInputText = inputText
      if (inputText) this.onInputText(inputText, { final: true, source: 'live_turn_complete' })
      this.log('turn.complete', { inputLen: inputText.length, textLen: text.length, audioParts: audioParts.length })

      // Live API가 이전 턴 interrupt를 빈 turnComplete로 보내는 경우가 있다 (프로토타입 주석 계승).
      // 텍스트/오디오가 둘 다 없는 완료 신호는 무시하고 다음 실제 완료 또는 timeout을 기다린다.
      if (!text && !audioParts.length) {
        this.outputText = ''
        this.outputAudioParts = []
        this.inputText = ''
        return
      }

      this.outputText = ''
      this.outputAudioParts = []
      this.inputText = ''
      if (text) {
        const clean = sanitizePatientText(text)
        if (clean) this.onPatientText(clean)
      }
      if (this.pending) {
        const pending = this.pending
        this.pending = null
        setTimeout(() => pending.resolve(text), 320)
      }
    }
  }

  playPcm24(base64, mimeType = 'audio/pcm;rate=24000') {
    try {
      const sampleRate = sampleRateFromMime(mimeType) || 24000
      const bytes = base64ToBytes(base64)
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioCtor) throw new Error('이 브라우저는 AudioContext를 지원하지 않습니다.')
      const ctx = this.audioContext || new AudioCtor()
      this.audioContext = ctx
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {})
      }
      const buffer = ctx.createBuffer(1, samples.length, sampleRate)
      const channel = buffer.getChannelData(0)
      let peak = 0
      for (let i = 0; i < samples.length; i += 1) {
        const value = samples[i] / 32768
        channel[i] = value
        peak = Math.max(peak, Math.abs(value))
      }
      this.onAudioLevel(Math.min(1, peak * 1.4))
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.onended = () => this.onAudioLevel(0)
      const now = ctx.currentTime
      this.playTime = Math.max(now + 0.035, this.playTime || now + 0.035)
      source.start(this.playTime)
      this.playTime += buffer.duration
      this.onAudioStart({ sampleRate, duration: buffer.duration })
    } catch (error) {
      this.log('audio.play.error', { message: error?.message || String(error) })
    }
  }
}

export function floatTo16kPcmBase64(input, inputSampleRate) {
  const ratio = inputSampleRate / 16000
  const length = Math.floor(input.length / ratio)
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(i * ratio)
    const s = Math.max(-1, Math.min(1, input[idx] || 0))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return bytesToBase64(new Uint8Array(pcm.buffer))
}

// 모델이 프롬프트 금지에도 붙이는 안전 면책·AI 자기지칭 문구를 자막·전사에서 제거한다.
// 방어층 — 근본 대응은 서버 시스템 프롬프트(prompt.py). 오디오에는 남을 수 있음.
const DISCLAIMER_PATTERNS = [
  /[^.!?…]*(?:본 답변은|이 답변은|제 답변은)[^.!?…]*(?:의학적|의료)[^.!?…]*[.!?…]?/g,
  /[^.!?…]*(?:의학적|의료적)\s*(?:조언|판단|진단)(?:이|을|은)?[^.!?…]*(?:아니|제공하지|드릴 수)[^.!?…]*[.!?…]?/g,
  /[^.!?…]*의료\s*전문가(?:와|에게|께)?\s*상담[^.!?…]*[.!?…]?/g,
  /[^.!?…]*전문의(?:와|에게|께)?\s*상담[^.!?…]*[.!?…]?/g,
  /[^.!?…]*(?:병원|의사)(?:을|를|에)?\s*(?:방문|진료).{0,6}(?:바랍니다|권|하세요)[^.!?…]*[.!?…]?/g,
  /[^.!?…]*저는\s*(?:AI|인공지능|언어\s*모델|챗봇|프로그램|모델)[^.!?…]*[.!?…]?/g,
]

// 환자 발화 텍스트에서 페르소나 이탈 문구(면책·상담권고·AI 자기지칭)와 제어 태그를 제거한다.
function sanitizePatientText(text) {
  let out = String(text || '')
  out = out.replace(/\[SYS_EVENT[^\]]*\]/gi, '')
  out = out.replace(/\[[^\]]{0,40}\]/g, '') // 남은 짧은 대괄호 지문 (예: [당황])
  for (const p of DISCLAIMER_PATTERNS) out = out.replace(p, '')
  out = out.replace(/\s{2,}/g, ' ')
  // 가장자리 따옴표는 짝이 안 맞아도 제거(발화가 따옴표로 감싸져 오거나 문구 제거로 한쪽만 남는 경우).
  return out.replace(/^[\s"“”']+/, '').replace(/[\s"“”']+$/, '').trim()
}

function normalizeTranscriptText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?…]+|[\s.,!?…]+$/g, '')
    .trim()
}

// 부분 전사 중복 병합 (프로토타입 검증 로직 그대로)
function mergeTranscriptText(current, incoming) {
  const prev = normalizeTranscriptText(current)
  const next = normalizeTranscriptText(incoming)
  if (!next) return prev
  if (!prev) return next
  if (prev === next || prev.endsWith(next)) return prev
  if (next.startsWith(prev)) return next
  if (prev.includes(next) && next.length < prev.length) return prev
  const maxOverlap = Math.min(prev.length, next.length)
  for (let size = maxOverlap; size >= 2; size -= 1) {
    if (prev.slice(-size) === next.slice(0, size)) {
      return normalizeTranscriptText(prev + next.slice(size))
    }
  }
  return normalizeTranscriptText(`${prev} ${next}`)
}

function normalizeLiveModelName(model) {
  let value = String(model || 'gemini-3.1-flash-live-preview').trim()
  if (!value) value = 'gemini-3.1-flash-live-preview'
  if (!value.startsWith('models/')) value = `models/${value}`
  return value
}

function sampleRateFromMime(mimeType) {
  const match = String(mimeType || '').match(/rate=(\d+)/i)
  return match ? Number(match[1]) : 0
}

function base64ToBytes(base64) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
