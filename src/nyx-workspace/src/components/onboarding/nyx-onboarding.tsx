'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { ProviderLogo } from '@/components/provider-logo'
import {
  canSkipInitialSetup,
  hasCompletedInitialSetup,
  markInitialSetupComplete,
} from './onboarding-storage'
import {
  WORKSPACE_AGENT_NAME,
  WORKSPACE_DISPLAY_NAME,
} from '@/lib/workspace-branding'

const KNOWN_PROVIDER_PREFIXES = [
  'openrouter',
  'anthropic',
  'openai',
  'openai-codex',
  'nous',
  'ollama',
  'atomic-chat',
  'zai',
  'kimi-coding',
  'minimax',
  'minimax-cn',
]

function stripProviderPrefix(model: string): string {
  if (!model) return model
  const slash = model.indexOf('/')
  if (slash === -1) return model
  const prefix = model.slice(0, slash)
  if (KNOWN_PROVIDER_PREFIXES.includes(prefix)) {
    return model.slice(slash + 1)
  }
  return model
}

const CHAT_TEST_TIMEOUT_MS = 20_000

type Step = 'welcome' | 'connect' | 'provider' | 'test' | 'done'

type GatewayStatusResponse = {
  capabilities?: {
    health?: boolean
    chatCompletions?: boolean
    models?: boolean
    streaming?: boolean
    sessions?: boolean
    skills?: boolean
    memory?: boolean
    config?: boolean
    jobs?: boolean
  }
  nyxApiUrl?: string
}

const PROVIDERS = [
  {
    id: 'nous',
    name: 'Nous Portal',
    logo: '/providers/nous.png',
    desc: 'Free via OAuth',
    authType: 'oauth',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    logo: '/providers/openai.png',
    desc: 'Free via ChatGPT Pro',
    authType: 'oauth',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: '/providers/anthropic.png',
    desc: 'API key required',
    authType: 'api_key',
    envKey: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    logo: '/providers/openrouter.png',
    desc: 'API key required',
    authType: 'api_key',
    envKey: 'OPENROUTER_API_KEY',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    logo: '/providers/ollama.png',
    desc: 'Local models, no key needed',
    authType: 'none',
  },
  {
    id: 'atomic-chat',
    name: 'Atomic Chat',
    logo: '/providers/atomic-chat.png',
    desc: 'Local LLMs via Atomic Chat desktop app',
    authType: 'none',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compat)',
    logo: '/providers/openai.png',
    desc: 'Any OpenAI-compatible endpoint',
    authType: 'custom',
  },
]

function getEnhancedFeatureNames(
  capabilities?: GatewayStatusResponse['capabilities'],
): Array<string> {
  if (!capabilities) return []
  const features: Array<{ enabled?: boolean; label: string }> = [
    { enabled: capabilities.sessions, label: 'Sessions' },
    { enabled: capabilities.skills, label: 'Skills' },
    { enabled: capabilities.memory, label: 'Memory' },
    { enabled: capabilities.config, label: 'In-app config' },
    { enabled: capabilities.jobs, label: 'Jobs' },
  ]

  return features
    .filter((feature) => feature.enabled)
    .map((feature) => feature.label)
}

export function NyxOnboarding() {
  const [show, setShow] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [backendStatus, setBackendStatus] = useState<
    'idle' | 'checking' | 'ready' | 'error'
  >('idle')
  const [backendInfo, setBackendInfo] = useState<GatewayStatusResponse | null>(
    null,
  )
  const [backendMessage, setBackendMessage] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [availableModels, setAvailableModels] = useState<Array<string>>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [testStatus, setTestStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle')
  const [testMessage, setTestMessage] = useState('')
  const [configuredModel, setConfiguredModel] = useState('')

  const [oauthStep, setOauthStep] = useState<
    'idle' | 'loading' | 'waiting' | 'success' | 'error'
  >('idle')
  const [oauthUserCode, setOauthUserCode] = useState('')
  const [oauthVerificationUrl, setOauthVerificationUrl] = useState('')
  const [oauthError, setOauthError] = useState('')
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const provider = PROVIDERS.find((p) => p.id === selectedProvider)
  const needsApiKey =
    provider?.authType === 'api_key' || provider?.authType === 'custom'
  const needsBaseUrl =
    provider?.id === 'ollama' ||
    provider?.id === 'atomic-chat' ||
    provider?.authType === 'custom'
  const isOAuth = provider?.authType === 'oauth'
  const capabilities = backendInfo?.capabilities
  const canEditConfig = Boolean(capabilities?.config)
  const enhancedFeatures = getEnhancedFeatureNames(capabilities)
  const canFetchModels = Boolean(capabilities?.models)
  const isNyxGateway = Boolean(capabilities?.sessions)
  const backendSupportsChat = Boolean(
    capabilities?.chatCompletions || capabilities?.sessions,
  )

  const loadCurrentConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/nyx-config')
      if (!res.ok) return
      const data = (await res.json()) as {
        activeModel?: string
        activeProvider?: string
      }
      if (data.activeModel) {
        const normalizedModel = stripProviderPrefix(data.activeModel)
        setConfiguredModel(normalizedModel)
        setSelectedModel((current) => current || normalizedModel)
      }
      if (data.activeProvider) {
        setSelectedProvider((current) => current || data.activeProvider || null)
      }
    } catch {}
  }, [])

  const loadModels = useCallback(async () => {
    if (!canFetchModels) return
    try {
      const modelsRes = await fetch('/api/models')
      if (!modelsRes.ok) return
      const modelsData = (await modelsRes.json()) as {
        data?: Array<{ id?: string }>
        models?: Array<{ id?: string }>
      }
      const rawModels = modelsData.data || modelsData.models || []
      const models = rawModels
        .map((model) => (typeof model.id === 'string' ? model.id : ''))
        .filter(Boolean)
        .slice(0, 20)

      setAvailableModels(models)
      setSelectedModel(
        (current) => current || stripProviderPrefix(models[0] || ''),
      )
    } catch {
      setAvailableModels([])
    }
  }, [canFetchModels])

  const checkBackend = useCallback(async () => {
    setBackendStatus('checking')
    setBackendMessage('')

    try {
      const res = await fetch('/api/gateway-status')
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const data = (await res.json()) as GatewayStatusResponse
      setBackendInfo(data)

      if (data.capabilities?.chatCompletions || data.capabilities?.sessions) {
        setBackendStatus('ready')
        setBackendMessage(
          data.capabilities.sessions
            ? 'Backend connected. Nyx enhanced chat and gateway features are available.'
            : 'Backend connected. Core chat is ready.',
        )
        return
      }

      if (data.capabilities?.health) {
        setBackendStatus('error')
        setBackendMessage(
          'Backend is reachable, but no chat-capable endpoint is available yet.',
        )
        return
      }

      setBackendStatus('error')
      setBackendMessage('No compatible backend detected yet.')
    } catch (err) {
      setBackendInfo(null)
      setBackendStatus('error')
      setBackendMessage(
        err instanceof Error ? err.message : 'Connection check failed',
      )
    }
  }, [])

  const saveProviderConfig = useCallback(async () => {
    if (!selectedProvider) return true
    if (!canEditConfig) return true

    setSaving(true)
    setSaveError('')

    try {
      const prov = PROVIDERS.find((p) => p.id === selectedProvider)
      const body: Record<string, unknown> = {
        config: { model: { provider: selectedProvider } },
      }

      if (prov?.envKey && apiKey) {
        body.env = { [prov.envKey]: apiKey }
      }
      if (baseUrl) {
        body.config = {
          model: { provider: selectedProvider, base_url: baseUrl },
        }
      }

      const res = await fetch('/api/nyx-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)

      await loadCurrentConfig()
      await loadModels()
      return true
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
      return false
    } finally {
      setSaving(false)
    }
  }, [
    apiKey,
    baseUrl,
    canEditConfig,
    loadCurrentConfig,
    loadModels,
    selectedProvider,
  ])

  const saveModelSelection = useCallback(async () => {
    const modelToSave = stripProviderPrefix(selectedModel || configuredModel)
    if (!modelToSave) return true

    setConfiguredModel(modelToSave)

    if (!canEditConfig || !selectedProvider) return true

    try {
      const res = await fetch('/api/nyx-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            model: { provider: selectedProvider, default: modelToSave },
          },
        }),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      return true
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save model')
      return false
    }
  }, [canEditConfig, configuredModel, selectedModel, selectedProvider])

  const testConnection = useCallback(async () => {
    setTestStatus('testing')
    setTestMessage('')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CHAT_TEST_TIMEOUT_MS)

    try {
      const res = await fetch('/api/send-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionKey: 'new',
          friendlyId: 'new',
          message:
            'Reply with one short sentence confirming the backend connection works.',
        }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No stream returned')

      const decoder = new TextDecoder()
      let text = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        const matches = chunk.match(/(?:delta|text|content)":"([^"]+)"/g)
        if (matches) {
          for (const match of matches) {
            text += match.replace(/.*":"/, '').replace(/"$/, '')
          }
        }
      }

      setTestMessage(text.slice(0, 240) || 'Chat test succeeded.')
      setTestStatus('success')
      void checkBackend()
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError'
      setTestMessage(
        aborted
          ? 'NyxHive is reachable, but the agent runtime did not answer within 20 seconds. You can skip onboarding and continue while the Codex runtime recovers.'
          : err instanceof Error
            ? err.message
            : 'Connection failed',
      )
      setTestStatus('error')
    } finally {
      clearTimeout(timeout)
    }
  }, [checkBackend])

  const startNousOAuth = useCallback(async () => {
    setOauthStep('loading')
    setOauthError('')

    try {
      const res = await fetch('/api/oauth/device-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'nous' }),
      })
      const data = (await res.json()) as {
        device_code?: string
        user_code?: string
        verification_uri_complete?: string
        interval?: number
        error?: string
      }

      if (!res.ok || data.error) {
        setOauthError(data.error || 'Failed to start OAuth')
        setOauthStep('error')
        return
      }

      setOauthUserCode(data.user_code || '')
      setOauthVerificationUrl(data.verification_uri_complete || '')
      setOauthStep('waiting')

      if (data.verification_uri_complete) {
        window.open(data.verification_uri_complete, '_blank')
      }

      const intervalMs = Math.max((data.interval || 5) * 1000, 3000)
      oauthPollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch('/api/oauth/poll-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: 'nous',
              deviceCode: data.device_code,
            }),
          })
          const pollData = (await pollRes.json()) as {
            status: string
            message?: string
          }

          if (pollData.status === 'success') {
            if (oauthPollRef.current) clearInterval(oauthPollRef.current)
            setOauthStep('success')
            await saveProviderConfig()
            await loadModels()
            return
          }

          if (pollData.status === 'error') {
            if (oauthPollRef.current) clearInterval(oauthPollRef.current)
            setOauthError(pollData.message || 'Authentication failed')
            setOauthStep('error')
          }
        } catch {}
      }, intervalMs)
    } catch (err) {
      setOauthError(
        err instanceof Error ? err.message : 'Failed to start OAuth',
      )
      setOauthStep('error')
    }
  }, [loadModels, saveProviderConfig])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (hasCompletedInitialSetup(localStorage)) return

    let cancelled = false

    const initialize = async () => {
      try {
        const [statusRes, configRes] = await Promise.all([
          fetch('/api/gateway-status'),
          fetch('/api/nyx-config'),
        ])
        const status = statusRes.ok
          ? ((await statusRes.json()) as GatewayStatusResponse)
          : null
        const config = configRes.ok
          ? ((await configRes.json()) as {
              activeModel?: string
              activeProvider?: string
            })
          : null

        if (canSkipInitialSetup(status, config)) {
          markInitialSetupComplete(localStorage)
          if (!cancelled) {
            setBackendInfo(status)
            setConfiguredModel(stripProviderPrefix(config?.activeModel || ''))
            setSelectedModel(stripProviderPrefix(config?.activeModel || ''))
            setSelectedProvider(config?.activeProvider || null)
          }
          return
        }
      } catch {}

      if (!cancelled) setShow(true)
    }

    void initialize()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      if (oauthPollRef.current) clearInterval(oauthPollRef.current)
    }
  }, [])

  useEffect(() => {
    if (oauthPollRef.current) clearInterval(oauthPollRef.current)
    setOauthStep('idle')
    setOauthUserCode('')
    setOauthVerificationUrl('')
    setOauthError('')
  }, [selectedProvider])

  useEffect(() => {
    if (show) {
      void loadCurrentConfig()
    }
  }, [loadCurrentConfig, show])

  const complete = useCallback(() => {
    markInitialSetupComplete(localStorage)
    setShow(false)
  }, [])

  if (!show) return null

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-card)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }
  const mutedStyle: React.CSSProperties = { color: 'var(--theme-muted)' }
  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--theme-bg)',
    border: '1px solid var(--theme-border)',
    color: 'var(--theme-text)',
  }

  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center px-4"
      style={{
        backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.97 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="w-full max-w-md rounded-2xl p-8"
          style={cardStyle}
        >
          {step === 'welcome' && (
            <div className="space-y-4 text-center">
              <img
                src="/nyx-avatar.webp"
                alt={WORKSPACE_AGENT_NAME}
                className="mx-auto size-20 rounded-2xl"
                style={{
                  filter: 'drop-shadow(0 8px 24px rgba(99,102,241,0.3))',
                }}
              />
              <h2 className="text-xl font-bold">
                Welcome to {WORKSPACE_DISPLAY_NAME}
              </h2>
              <p className="text-sm" style={mutedStyle}>
                Works with any OpenAI-compatible backend. Nyx gateway APIs
                unlock sessions, memory, skills, and other extras automatically.
              </p>
              <button
                onClick={() => {
                  setStep('connect')
                  void checkBackend()
                }}
                className="w-full rounded-xl bg-accent-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-600"
              >
                Connect Backend
              </button>
              <button onClick={complete} className="text-xs" style={mutedStyle}>
                Skip setup
              </button>
            </div>
          )}

          {step === 'connect' && (
            <div className="space-y-4 text-center">
              <div className="text-4xl">🔌</div>
              <h2 className="text-lg font-bold">Connect Your Backend</h2>
              <p className="text-sm" style={mutedStyle}>
                Start by verifying that {WORKSPACE_DISPLAY_NAME} can reach your
                OpenAI-compatible backend.
              </p>

              {backendStatus === 'checking' && (
                <div
                  className="flex items-center justify-center gap-2 text-sm"
                  style={mutedStyle}
                >
                  <span className="size-2 animate-pulse rounded-full bg-accent-500" />
                  Checking backend capabilities...
                </div>
              )}

              {backendStatus === 'ready' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2 text-sm text-green-500">
                    <span className="size-2 rounded-full bg-green-500" />
                    {backendMessage}
                  </div>
                  <div
                    className="rounded-xl p-3 text-left text-xs"
                    style={cardStyle}
                  >
                    <p style={mutedStyle}>Backend URL</p>
                    <p className="mt-1 font-mono">
                      {backendInfo?.nyxApiUrl || 'Configured automatically'}
                    </p>
                  </div>
                </div>
              )}

              {backendStatus === 'error' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-center gap-2 text-sm text-red-400">
                    <span className="size-2 rounded-full bg-red-500" />
                    {backendMessage}
                  </div>
                  <div
                    className="rounded-xl p-3 text-left text-xs"
                    style={{ ...cardStyle, borderColor: 'var(--theme-border)' }}
                  >
                    <p className="font-medium text-white">
                      Compatible backends
                    </p>
                    <p className="mt-2" style={mutedStyle}>
                    Use any backend that exposes{' '}
                    <code>/v1/chat/completions</code>, or point {WORKSPACE_DISPLAY_NAME}
                    at a Nyx gateway with session APIs.
                    </p>
                    <div
                      className="mt-3 rounded-lg px-3 py-2 font-mono text-[11px]"
                      style={{ background: 'rgba(0,0,0,0.2)' }}
                    >
                      pnpm dev
                    </div>
                    <div
                      className="mt-2 rounded-lg px-3 py-2 font-mono text-[11px]"
                      style={{ background: 'rgba(0,0,0,0.2)' }}
                    >
                      bun run hive:start
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => void checkBackend()}
                  className="flex-1 rounded-xl border py-3 text-sm font-semibold transition-colors"
                  style={{ borderColor: 'var(--theme-border)' }}
                >
                  Retry
                </button>
                <button
                  onClick={() => {
                    if (backendInfo?.capabilities?.sessions) {
                      setStep('test')
                      setTestStatus('idle')
                      setTestMessage('')
                    } else {
                      setStep('provider')
                      void loadModels()
                    }
                  }}
                  disabled={backendStatus !== 'ready'}
                  className="flex-1 rounded-xl bg-accent-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-600 disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 'provider' && (
            <div className="space-y-4">
              <h2 className="text-center text-lg font-bold">
                Choose Provider and Model
              </h2>
              <p className="text-center text-xs" style={mutedStyle}>
                {isNyxGateway
                  ? 'Nyx gateway manages provider settings. Confirm chat, then continue.'
                  : canEditConfig
                  ? 'Save provider settings here, then choose a model before testing chat.'
                  : `This backend manages provider settings outside ${WORKSPACE_DISPLAY_NAME}. Confirm the model you expect to use, then test chat.`}
              </p>

              <div className="rounded-xl p-3 text-xs" style={cardStyle}>
                <p style={mutedStyle}>Backend mode</p>
                <p className="mt-1">
                  {backendInfo?.capabilities?.sessions
                    ? 'Nyx gateway detected'
                    : 'Portable OpenAI-compatible backend'}
                </p>
                {configuredModel ? (
                  <p className="mt-2" style={mutedStyle}>
                    Current model:{' '}
                    <span className="font-mono text-accent-400">
                      {configuredModel}
                    </span>
                  </p>
                ) : null}
              </div>

              {!isNyxGateway ? (
                <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto pr-1">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setSelectedProvider(p.id)
                        setApiKey('')
                        setBaseUrl('')
                        setSaveError('')
                      }}
                      className={cn(
                        'flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-all',
                        selectedProvider === p.id
                          ? 'ring-2 ring-accent-500'
                          : '',
                      )}
                      style={cardStyle}
                    >
                      <ProviderLogo
                        provider={p.id}
                        size={40}
                        className="shrink-0 rounded-xl"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold">{p.name}</div>
                        <div className="text-xs" style={mutedStyle}>
                          {p.desc}
                        </div>
                      </div>
                      {selectedProvider === p.id ? (
                        <span className="ml-auto size-2.5 shrink-0 rounded-full bg-green-500" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}

              {selectedProvider &&
                isOAuth &&
                selectedProvider === 'nous' &&
                canEditConfig && (
                  <div
                    className="space-y-3 rounded-xl p-4 text-left"
                    style={{ ...cardStyle, borderColor: 'var(--theme-border)' }}
                  >
                    {oauthStep === 'idle' && (
                      <button
                        onClick={startNousOAuth}
                        className="w-full rounded-lg bg-accent-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-600"
                      >
                        Connect with Nous Portal
                      </button>
                    )}
                    {oauthStep === 'loading' && (
                      <div
                        className="flex items-center justify-center gap-2 py-2 text-sm"
                        style={mutedStyle}
                      >
                        <span className="size-2 animate-pulse rounded-full bg-accent-500" />
                        Starting OAuth flow...
                      </div>
                    )}
                    {oauthStep === 'waiting' && (
                      <div className="space-y-3">
                        <div
                          className="flex items-center gap-2 text-sm"
                          style={mutedStyle}
                        >
                          <span className="size-2 animate-pulse rounded-full bg-yellow-400" />
                          Waiting for approval...
                        </div>
                        {oauthUserCode ? (
                          <div className="space-y-1 text-center">
                            <p className="text-xs" style={mutedStyle}>
                              Your code
                            </p>
                            <p className="text-2xl font-mono font-bold tracking-widest">
                              {oauthUserCode}
                            </p>
                          </div>
                        ) : null}
                        {oauthVerificationUrl ? (
                          <button
                            onClick={() =>
                              window.open(oauthVerificationUrl, '_blank')
                            }
                            className="w-full rounded-lg border py-2 text-xs font-medium"
                            style={{ borderColor: 'var(--theme-border)' }}
                          >
                            Open Nous Portal ↗
                          </button>
                        ) : null}
                      </div>
                    )}
                    {oauthStep === 'success' && (
                      <div className="flex items-center gap-2 text-sm text-green-500">
                        <span>✓</span>
                        <span>Authenticated successfully.</span>
                      </div>
                    )}
                    {oauthStep === 'error' && (
                      <div className="space-y-2">
                        <p className="text-xs text-red-400">
                          {oauthError || 'Authentication failed'}
                        </p>
                        <button
                          onClick={startNousOAuth}
                          className="w-full rounded-lg bg-accent-500 py-2 text-xs font-medium text-white"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                )}

              {selectedProvider &&
                isOAuth &&
                selectedProvider === 'openai-codex' &&
                canEditConfig && (
                  <div
                    className="space-y-2 rounded-xl p-4 text-left"
                    style={{ ...cardStyle, borderColor: 'var(--theme-border)' }}
                  >
                    <p className="text-sm font-medium">OpenAI Codex auth</p>
                    <div
                      className="rounded-lg px-3 py-2 font-mono text-xs"
                      style={{ background: 'rgba(0,0,0,0.2)' }}
                    >
                      codex login
                    </div>
                    <p className="text-xs" style={mutedStyle}>
                      Nyx uses your existing Codex CLI login. Run this only if
                      Codex itself is not authenticated, then refresh provider
                      settings.
                    </p>
                    <button
                      onClick={async () => {
                        await saveProviderConfig()
                        await loadModels()
                      }}
                      className="w-full rounded-lg bg-accent-500 py-2 text-xs font-medium text-white"
                    >
                      I&apos;ve authenticated
                    </button>
                  </div>
                )}

              {selectedProvider && (needsApiKey || needsBaseUrl) && (
                <div className="space-y-2 pt-1">
                  {needsBaseUrl ? (
                    <div>
                      <label
                        className="mb-1 block text-xs font-medium"
                        style={mutedStyle}
                      >
                        {selectedProvider === 'ollama'
                          ? 'Ollama URL'
                          : selectedProvider === 'atomic-chat'
                            ? 'Atomic Chat URL'
                            : 'Base URL'}
                      </label>
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={
                          selectedProvider === 'ollama'
                            ? 'http://localhost:11434'
                            : selectedProvider === 'atomic-chat'
                              ? 'http://127.0.0.1:1337/v1'
                              : 'https://api.example.com/v1'
                        }
                        className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-500"
                        style={inputStyle}
                      />
                    </div>
                  ) : null}
                  {needsApiKey ? (
                    <div>
                      <label
                        className="mb-1 block text-xs font-medium"
                        style={mutedStyle}
                      >
                        API Key
                      </label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="fake-provider-key"
                        className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-500"
                        style={inputStyle}
                      />
                    </div>
                  ) : null}
                </div>
              )}

              <div>
                <label
                  className="mb-1 block text-xs font-medium"
                  style={mutedStyle}
                >
                  Model
                </label>
                {availableModels.length > 0 ? (
                  <select
                    value={selectedModel}
                    onChange={(e) =>
                      setSelectedModel(stripProviderPrefix(e.target.value))
                    }
                    className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-500"
                    style={inputStyle}
                  >
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {stripProviderPrefix(model)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    placeholder={configuredModel || 'gpt-4.1'}
                    className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-500"
                    style={inputStyle}
                  />
                )}
                <p className="mt-2 text-xs" style={mutedStyle}>
                  {canFetchModels
                    ? 'Models were fetched from the backend when available.'
                    : 'If your backend does not expose /v1/models, enter the model name manually.'}
                </p>
              </div>

              {!canEditConfig ? (
                <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
                  In-app provider editing is unavailable on this backend. That
                  is optional. If the backend is already configured, continue to
                  the chat test.
                </div>
              ) : null}

              {saveError ? (
                <p className="text-xs text-red-400">{saveError}</p>
              ) : null}

              <div className="flex gap-2">
                {selectedProvider &&
                canEditConfig &&
                (needsApiKey || needsBaseUrl) ? (
                  <button
                    onClick={() => void saveProviderConfig()}
                    disabled={
                      saving || (needsApiKey && !apiKey && !needsBaseUrl)
                    }
                    className="flex-1 rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Settings'}
                  </button>
                ) : null}
                <button
                  onClick={async () => {
                    let ok = true
                    if (
                      selectedProvider &&
                      canEditConfig &&
                      (!isOAuth || oauthStep === 'success')
                    ) {
                      ok = await saveProviderConfig()
                    }
                    if (ok) {
                      ok = await saveModelSelection()
                    }
                    if (ok) {
                      setStep('test')
                      setTestStatus('idle')
                      setTestMessage('')
                    }
                  }}
                  disabled={!backendSupportsChat}
                  className="flex-1 rounded-xl bg-accent-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-600 disabled:opacity-50"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {step === 'test' && (
            <div className="space-y-4 text-center">
              <div className="text-4xl">🧪</div>
              <h2 className="text-lg font-bold">Test Chat</h2>
              <p className="text-sm" style={mutedStyle}>
                Verify that core chat works first. Enhanced Nyx features are
                optional and appear automatically when supported.
              </p>

              <div
                className="rounded-xl p-3 text-left text-xs"
                style={cardStyle}
              >
                <p style={mutedStyle}>Backend</p>
                <p className="mt-1 font-mono">
                  {backendInfo?.nyxApiUrl || 'Configured automatically'}
                </p>
                {selectedModel || configuredModel ? (
                  <p className="mt-2" style={mutedStyle}>
                    Model:{' '}
                    <span className="font-mono text-accent-400">
                      {stripProviderPrefix(selectedModel || configuredModel)}
                    </span>
                  </p>
                ) : null}
              </div>

              {testStatus === 'idle' ? (
                <button
                  onClick={testConnection}
                  className="w-full rounded-xl bg-accent-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-600"
                >
                  Send Test Message
                </button>
              ) : null}

              {testStatus === 'testing' ? (
                <div
                  className="flex items-center justify-center gap-2 text-sm"
                  style={mutedStyle}
                >
                  <span className="size-2 animate-pulse rounded-full bg-accent-500" />
                  Waiting for the backend response...
                </div>
              ) : null}

              {testStatus === 'success' ? (
                <div className="space-y-3">
                  <div
                    className="rounded-xl p-3 text-left text-sm"
                    style={cardStyle}
                  >
                    <span className="font-medium text-green-500">
                      Assistant:
                    </span>{' '}
                    <span>{testMessage}</span>
                  </div>
                  <button
                    onClick={() => setStep('done')}
                    className="w-full rounded-xl bg-green-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-green-700"
                  >
                    Continue
                  </button>
                </div>
              ) : null}

              {testStatus === 'error' ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-red-500/30 bg-red-900/20 p-3 text-left text-sm">
                    <p className="mb-1 font-medium text-red-400">
                      Chat test failed
                    </p>
                    <p className="text-xs" style={mutedStyle}>
                      {testMessage}
                    </p>
                    {testMessage.includes('401') ||
                    testMessage.toLowerCase().includes('key') ? (
                      <p className="mt-2 text-xs text-yellow-400">
                        Check your provider credentials and account access.
                      </p>
                    ) : testMessage.toLowerCase().includes('model') ? (
                      <p className="mt-2 text-xs text-yellow-400">
                        Confirm the selected model exists on this backend.
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-yellow-400">
                        Confirm the backend is running and still reachable from
                        {WORKSPACE_DISPLAY_NAME}.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={testConnection}
                      className="flex-1 rounded-lg bg-accent-500 py-2 text-xs font-medium text-white"
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => setStep('provider')}
                      className="flex-1 rounded-lg border py-2 text-xs font-medium"
                      style={{ borderColor: 'var(--theme-border)' }}
                    >
                      ← Back
                    </button>
                  </div>
                  <button
                    onClick={() => setStep('done')}
                    className="mx-auto block text-xs"
                    style={mutedStyle}
                  >
                    Skip for now
                  </button>
                </div>
              ) : null}
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-4 text-center">
              <div className="text-5xl">🎉</div>
              <h2 className="text-xl font-bold">Workspace Ready</h2>
              <p className="text-sm" style={mutedStyle}>
                Core chat is set up.{' '}
                {enhancedFeatures.length > 0
                  ? 'This backend also exposes Nyx gateway enhancements.'
                  : 'If you later connect a Nyx gateway, enhanced features unlock automatically.'}
              </p>
              <div
                className="grid grid-cols-3 gap-2 text-xs"
                style={mutedStyle}
              >
                <div className="rounded-xl p-2" style={cardStyle}>
                  <div className="mb-1 text-lg">💬</div>
                  <div>Chat Ready</div>
                </div>
                <div className="rounded-xl p-2" style={cardStyle}>
                  <div className="mb-1 text-lg">🔗</div>
                  <div>
                    {enhancedFeatures.length > 0 ? 'Enhanced' : 'Portable'}
                  </div>
                </div>
                <div className="rounded-xl p-2" style={cardStyle}>
                  <div className="mb-1 text-lg">🧠</div>
                  <div>
                    {enhancedFeatures.length > 0
                      ? enhancedFeatures.length
                      : 'Optional'}{' '}
                    Extras
                  </div>
                </div>
              </div>
              {enhancedFeatures.length > 0 ? (
                <p className="text-xs" style={mutedStyle}>
                  Available now: {enhancedFeatures.join(', ')}.
                </p>
              ) : null}
              <button
                onClick={complete}
                className="w-full rounded-xl bg-accent-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-600"
              >
                Open Workspace
              </button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
