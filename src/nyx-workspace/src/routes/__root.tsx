import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, lazy, useEffect, useState } from 'react'
import appCss from '../styles.css?url'
import { initializeSettingsAppearance } from '@/hooks/use-settings'
import {
  WORKSPACE_AGENT_NAME,
  WORKSPACE_API_URL,
  WORKSPACE_DISPLAY_NAME,
  buildWorkspaceBrandingBootstrapScript,
} from '@/lib/workspace-branding'



const GlobalShortcutListener = lazy(async () => {
  const module = await import('@/components/global-shortcut-listener')
  return { default: module.GlobalShortcutListener }
})

const TerminalShortcutListener = lazy(async () => {
  const module = await import('@/components/terminal-shortcut-listener')
  return { default: module.TerminalShortcutListener }
})

const MobilePromptTrigger = lazy(async () => {
  const module = await import('@/components/mobile-prompt/MobilePromptTrigger')
  return { default: module.MobilePromptTrigger }
})

const Toaster = lazy(async () => {
  const module = await import('@/components/ui/toast')
  return { default: module.Toaster }
})

const WorkspaceShell = lazy(async () => {
  const module = await import('@/components/workspace-shell')
  return { default: module.WorkspaceShell }
})

const SearchModal = lazy(async () => {
  const module = await import('@/components/search/search-modal')
  return { default: module.SearchModal }
})

const OnboardingTour = lazy(async () => {
  const module = await import('@/components/onboarding/onboarding-tour')
  return { default: module.OnboardingTour }
})

const KeyboardShortcutsModal = lazy(async () => {
  const module = await import('@/components/keyboard-shortcuts-modal')
  return { default: module.KeyboardShortcutsModal }
})

const APP_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "frame-src 'self' http: https:",
].join('; ')

const THEME_STORAGE_KEY = 'nyx-theme'
const LEGACY_THEME_STORAGE_KEY = 'hermes-theme'
const DEFAULT_THEME = 'nyx-official'
const VALID_THEMES = [
  'nyx-official',
  'nyx-official-light',
  'nyx-classic',
  'nyx-classic-light',
  'nyx-slate',
  'nyx-slate-light',
  'nyx-mono',
  'nyx-mono-light',
]

const themeScript = `
(() => {
  window.process = window.process || { env: {}, platform: 'browser' };

  try {
    const root = document.documentElement
    const storedTheme = localStorage.getItem('${THEME_STORAGE_KEY}') || localStorage.getItem('${LEGACY_THEME_STORAGE_KEY}')
    const legacyThemes = {
      'hermes-official': 'nyx-official',
      'hermes-official-light': 'nyx-official-light',
      'hermes-classic': 'nyx-classic',
      'hermes-classic-light': 'nyx-classic-light',
      'hermes-slate': 'nyx-slate',
      'hermes-slate-light': 'nyx-slate-light',
      'hermes-mono': 'nyx-mono',
      'hermes-mono-light': 'nyx-mono-light',
    }
    const theme = ${JSON.stringify(VALID_THEMES)}.includes(storedTheme) ? storedTheme : (legacyThemes[storedTheme] || '${DEFAULT_THEME}')
    if (storedTheme) {
      localStorage.setItem('${THEME_STORAGE_KEY}', theme)
      localStorage.removeItem('${LEGACY_THEME_STORAGE_KEY}')
    }
    const lightThemes = ['nyx-official-light', 'nyx-classic-light', 'nyx-slate-light', 'nyx-mono-light']
    const isDark = !lightThemes.includes(theme)
    root.classList.remove('light', 'dark', 'system')
    root.classList.add(isDark ? 'dark' : 'light')
    root.setAttribute('data-theme', theme)
    root.style.setProperty('color-scheme', isDark ? 'dark' : 'light')

    // Demo mode
    try {
      if (new URLSearchParams(window.location.search).get('demo') === '1') {
        document.documentElement.setAttribute('data-demo', 'true');
      }
    } catch {}
  } catch {}
})()
`

const themeColorScript = `
(() => {
  try {
    const root = document.documentElement
    const theme = root.getAttribute('data-theme') || '${DEFAULT_THEME}'
    const colors = {
      'nyx-official': '#0A0E1A',
      'nyx-official-light': '#F6F8FC',
      'nyx-classic': '#0d0f12',
      'nyx-classic-light': '#F5F2ED',
      'nyx-slate': '#0d1117',
      'nyx-slate-light': '#F6F8FA',
      'nyx-mono': '#111111',
      'nyx-mono-light': '#FAFAFA',
    }
    const nextColor = colors[theme] || colors['${DEFAULT_THEME}']
    const isDark = !['nyx-official-light', 'nyx-classic-light', 'nyx-slate-light', 'nyx-mono-light'].includes(String(theme))

    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', nextColor)
    root.style.setProperty('color-scheme', isDark ? 'dark' : 'light')
  } catch {}
})()
`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content:
          'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual',
      },
      {
        title: WORKSPACE_DISPLAY_NAME,
      },
      {
        name: 'description',
        content:
          'NyxHive workspace for chat, tools, files, memory, and jobs.',
      },
      {
        property: 'og:image',
        content: '/cover.png',
      },
      {
        property: 'og:image:type',
        content: 'image/png',
      },
      {
        name: 'twitter:card',
        content: 'summary_large_image',
      },
      {
        name: 'twitter:image',
        content: '/cover.png',
      },
      // PWA meta tags
      {
        name: 'theme-color',
        content: '#0A0E1A',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'default',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/png',
        href: '/nyx-avatar.png',
      },
      // PWA manifest and icons
      {
        rel: 'manifest',
        href: '/api/manifest',
      },
      {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
        sizes: '180x180',
      },
    ],
  }),

  shellComponent: RootDocument,
  component: RootLayout,
  errorComponent: function RootError({ error }) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-primary-50">
        <h1 className="text-2xl font-semibold text-primary-900 mb-4">
          Something went wrong
        </h1>
        <pre className="p-4 bg-primary-100 rounded-lg text-sm text-primary-700 max-w-full overflow-auto mb-6">
          {error instanceof Error ? error.message : String(error)}
        </pre>
        <button
          onClick={() => (window.location.href = '/')}
          className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
        >
          Return Home
        </button>
      </div>
    )
  },
})

const queryClient = new QueryClient()

function RootLayout() {
  const [mounted, setMounted] = useState(false)

  // Unregister any existing service workers — they cause stale asset issues
  // after Docker image updates and behind reverse proxies (Pangolin, Cloudflare, etc.)
  useEffect(() => {
    setMounted(true)
    initializeSettingsAppearance()

    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          registration.unregister()
        }
      })
      // Also clear any stale caches
      if ('caches' in window) {
        caches.keys().then((names) => {
          for (const name of names) {
            caches.delete(name)
          }
        })
      }
    }
  }, [])

  if (!mounted) {
    return <div className="min-h-screen theme-bg" aria-hidden="true" />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}>
        <GlobalShortcutListener />
        <TerminalShortcutListener />
        <MobilePromptTrigger />
        <Toaster />
      </Suspense>
      <Suspense fallback={<div className="min-h-screen theme-bg" aria-hidden="true" />}>
        <WorkspaceShell />
      </Suspense>
      <Suspense fallback={null}>
        <SearchModal />
      </Suspense>
      <Suspense fallback={null}>
        <OnboardingTour />
      </Suspense>
      <Suspense fallback={null}>
        <KeyboardShortcutsModal />
      </Suspense>
    </QueryClientProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const workspaceBrandingScript = buildWorkspaceBrandingBootstrapScript({
    agentName: WORKSPACE_AGENT_NAME,
    displayName: WORKSPACE_DISPLAY_NAME,
    apiUrl: WORKSPACE_API_URL,
  })

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={APP_CSP} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
          // Polyfill crypto.randomUUID for non-secure contexts (HTTP access via LAN IP)
          if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
            crypto.randomUUID = function() {
              return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, function(c) {
                return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
              });
            };
          }
        `,
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: workspaceBrandingScript }} />
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeColorScript }} />
      </head>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `
          (function(){
            if (document.getElementById('splash-screen')) return;
            var workspaceName = ${JSON.stringify(WORKSPACE_DISPLAY_NAME)};
            var bg = '#0A0E1A', txt = '#E6EAF2', muted = '#9AA5BD', accent = '#6366F1';
            try {
              var theme = localStorage.getItem('${THEME_STORAGE_KEY}') || localStorage.getItem('${LEGACY_THEME_STORAGE_KEY}') || '${DEFAULT_THEME}';
              var legacyThemes = { 'hermes-official':'nyx-official', 'hermes-official-light':'nyx-official-light', 'hermes-classic':'nyx-classic', 'hermes-classic-light':'nyx-classic-light', 'hermes-slate':'nyx-slate', 'hermes-slate-light':'nyx-slate-light', 'hermes-mono':'nyx-mono', 'hermes-mono-light':'nyx-mono-light' };
              theme = legacyThemes[theme] || theme;
              if (theme === 'nyx-classic') {
                bg = '#0d0f12';
                txt = '#eceff4';
                muted = '#7f8a96';
                accent = '#b98a44';
              } else if (theme === 'nyx-official-light') {
                bg = '#F6F8FC';
                txt = '#111827';
                muted = '#4B5563';
                accent = '#4F46E5';
              } else if (theme === 'nyx-classic-light') {
                bg = '#F5F2ED';
                txt = '#1a1f26';
                muted = '#6F675E';
                accent = '#b98a44';
              } else if (theme === 'nyx-slate') {
                bg = '#0d1117';
                txt = '#c9d1d9';
                muted = '#8b949e';
                accent = '#7eb8f6';
              } else if (theme === 'nyx-slate-light') {
                bg = '#F6F8FA';
                txt = '#24292f';
                muted = '#57606A';
                accent = '#3b82f6';
              } else if (theme === 'nyx-mono') {
                bg = '#111111';
                txt = '#e6edf3';
                muted = '#888888';
                accent = '#aaaaaa';
              } else if (theme === 'nyx-mono-light') {
                bg = '#FAFAFA';
                txt = '#1a1a1a';
                muted = '#666666';
                accent = '#666666';
              }
            } catch(e){}

            var isDark = !['nyx-official-light','nyx-classic-light','nyx-slate-light','nyx-mono-light'].includes(theme);
            var quips = ["Consulting the oracle...","Loading ancient knowledge...","Warming up Nyx...","Calibrating tool chain...","Preparing the workspace...","Bridging realms...","Initializing agent runtime..."];
            var quip = quips[Math.floor(Math.random() * quips.length)];

            var d = document.createElement('div');
            d.id = 'splash-screen';
            d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:'+bg+';transition:opacity 0.5s ease;';
            d.innerHTML = '<img src="/nyx-avatar.webp" alt="'+workspaceName+'" style="width:80px;height:80px;margin-bottom:20px;border-radius:16px;filter:drop-shadow(0 8px 32px color-mix(in srgb,'+accent+' 45%, transparent))" />'
              + '<img src="'+(isDark ? '/nyx-wordmark.svg' : '/nyx-wordmark-light.svg')+'" alt="'+workspaceName+'" style="width:280px;height:auto;margin-bottom:8px;filter:drop-shadow(0 4px 16px '+(isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)')+')" />'
              + '<div style="font:400 14px/1 system-ui,-apple-system,sans-serif;letter-spacing:0.04em;color:'+muted+'">'+workspaceName+'</div>'
              + '<div style="margin-top:28px;width:140px;height:3px;background:'+(isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')+';border-radius:3px;overflow:hidden;position:relative"><div id=splash-bar style="width:0%;height:100%;background:'+accent+';border-radius:3px;transition:width 0.4s ease"></div></div>';
            document.body.prepend(d);

            var bar = document.getElementById('splash-bar');
            if (bar) {
              setTimeout(function(){ bar.style.width='15%' }, 300);
              setTimeout(function(){ bar.style.width='40%' }, 800);
              setTimeout(function(){ bar.style.width='65%' }, 1500);
              setTimeout(function(){ bar.style.width='85%' }, 2500);
              setTimeout(function(){ bar.style.width='92%' }, 3200);
            }

            window.__dismissSplash = function() {
              var el = document.getElementById('splash-screen');
              if (!el) return;
              if (bar) bar.style.width = '100%';
              setTimeout(function(){
                el.style.opacity = '0';
                setTimeout(function(){ el.remove(); }, 500);
              }, 300);
            };
            // Fallback: always dismiss after 5s
            setTimeout(function(){ window.__dismissSplash && window.__dismissSplash(); }, 5000);
            // Fast dismiss: returning users skip quickly
            try {
              if (localStorage.getItem('nyx-settings') || localStorage.getItem('hermes-settings')) {
                setTimeout(function(){ window.__dismissSplash && window.__dismissSplash(); }, 600);
              }
            } catch(e) {}
          })()
        `,
          }}
        />
        <div className="root">{children}</div>
        <Scripts />
        <script
          dangerouslySetInnerHTML={{
            __html: `
          (function(){
            var start = Date.now();
            function check() {
              var el = document.querySelector('nav, aside, .workspace-shell, [data-testid]');
              var elapsed = Date.now() - start;
              if (el && elapsed > 2500) { window.__dismissSplash && window.__dismissSplash(); }
              else { setTimeout(check, 200); }
            }
            setTimeout(check, 2500);
          })()
        `,
          }}
        />
      </body>
    </html>
  )
}
