import { BrowserWindow, session } from 'electron'
import { join } from 'path'

// Login helper for the shared embedded-browser profile. Signing in here means
// every workspace pane (Overleaf, Docs, Canvas, ...) is already authenticated.
const BROWSE_PARTITION = 'persist:asit-browse'

export interface Provider {
  id: string
  name: string
  description: string
  loginUrl: string
  domain: string
  markerCookie?: string // cookie that only exists when actually logged in
}

const PROVIDERS: Provider[] = [
  {
    id: 'google',
    name: 'Google',
    description: 'Gmail, Docs, Drive, Calendar, YouTube — and "Sign in with Google" everywhere',
    loginUrl: 'https://accounts.google.com/',
    domain: 'google.com',
    markerCookie: 'SAPISID'
  },
  {
    id: 'overleaf',
    name: 'Overleaf',
    description: 'LaTeX editor',
    loginUrl: 'https://www.overleaf.com/login',
    domain: 'overleaf.com'
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Code, repos, gists',
    loginUrl: 'https://github.com/login',
    domain: 'github.com',
    markerCookie: 'logged_in'
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Notes and wikis',
    loginUrl: 'https://www.notion.so/login',
    domain: 'notion.so'
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    description: 'Outlook, Teams, OneDrive, Office',
    loginUrl: 'https://login.live.com/',
    domain: 'live.com',
    // login.live.com sets persistent cookies on a mere visit — only these
    // exist after an actual sign-in.
    markerCookie: 'MSPAuth|__Host-MSAAUTH|MSPProf'
  },
  {
    id: 'canvas',
    name: 'Canvas LMS',
    description: 'Course pages and assignments (school Canvas)',
    loginUrl: 'https://www.instructure.com/canvas/login/free-for-teacher',
    domain: 'instructure.com'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Link WhatsApp Web once (scan the QR with your phone) to send messages from the ⚡ bar',
    loginUrl: 'https://web.whatsapp.com/',
    domain: 'web.whatsapp.com',
    markerCookie: 'wa_ul'
  },
  {
    id: 'gradescope',
    name: 'Gradescope',
    description: 'Assignment submissions and grades',
    loginUrl: 'https://www.gradescope.com/login',
    domain: 'gradescope.com'
  }
]

export interface AccountStatus extends Provider {
  connected: boolean
}

export async function accountStatuses(): Promise<AccountStatus[]> {
  const ses = session.fromPartition(BROWSE_PARTITION)
  return Promise.all(
    PROVIDERS.map(async (p) => {
      let connected = false
      try {
        const cookies = await ses.cookies.get({ domain: p.domain })
        if (p.markerCookie) {
          const names = p.markerCookie.split('|')
          const marker = cookies.find((c) => names.includes(c.name))
          connected = !!marker && marker.value !== 'no'
        } else {
          // Heuristic: a persistent (non-session) cookie usually means a login.
          connected = cookies.some((c) => c.expirationDate !== undefined && !c.session)
        }
      } catch {
        connected = false
      }
      return { ...p, connected }
    })
  )
}

// Opens a normal window on the shared partition; resolves when it's closed so
// the caller can re-check statuses.
export function openLogin(providerId: string, parent: BrowserWindow | null): Promise<void> {
  const provider = PROVIDERS.find((p) => p.id === providerId)
  if (!provider) return Promise.resolve()
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 980,
      height: 760,
      parent: parent ?? undefined,
      autoHideMenuBar: true,
      title: `Sign in to ${provider.name} — closes into ASIT's browser profile`,
      webPreferences: {
        partition: BROWSE_PARTITION,
        sandbox: true,
        contextIsolation: true,
        preload: join(__dirname, '../preload/pane.js') // snippet expansion in login forms
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
    win.loadURL(provider.loginUrl)
    win.on('closed', () => resolve())
  })
}
