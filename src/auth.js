import { UserManager, WebStorageStateStore } from 'oidc-client-ts'

export const ZITADEL_AUTHORITY = 'https://ashterix-mkjzns.eu1.zitadel.cloud'
export const ZITADEL_PROJECT_ID = '388903513951875876'
export const ZITADEL_CLIENT_ID = '388904162139747950'
export const ZITADEL_MEDIA_PROJECT_ID = '389018638520205980'
export const ZITADEL_MEDIA_AUDIENCE_SCOPE =
  `urn:zitadel:iam:org:project:id:${ZITADEL_MEDIA_PROJECT_ID}:aud`
export const ZITADEL_PROJECT_ROLES_SCOPE = 'urn:zitadel:iam:org:projects:roles'

export const OIDC_SCOPE = [
  'openid',
  'profile',
  'email',
  ZITADEL_MEDIA_AUDIENCE_SCOPE,
  ZITADEL_PROJECT_ROLES_SCOPE,
].join(' ')

const roleClaim = 'urn:zitadel:iam:org:project:roles'

export const rolesFromProfile = (profile = {}) => {
  const roles = profile[roleClaim] ?? profile.roles ?? {}
  if (Array.isArray(roles)) return roles.map(String)
  if (roles && typeof roles === 'object') return Object.keys(roles)
  return []
}

export const safeReturnUrl = (candidate, origin = window.location.origin) => {
  try {
    const url = new URL(candidate ?? '/', origin)
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/'
  } catch {
    return '/'
  }
}

const displayName = (profile = {}) =>
  profile.given_name ??
  profile.name ??
  profile.preferred_username ??
  profile.email ??
  'your account'

const isCallback = () => {
  const parameters = new URLSearchParams(window.location.search)
  return parameters.has('code') && parameters.has('state')
}

const createManager = () =>
  new UserManager({
    authority: ZITADEL_AUTHORITY,
    client_id: ZITADEL_CLIENT_ID,
    redirect_uri: `${window.location.origin}/`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: OIDC_SCOPE,
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: true,
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  })

export const setupAccountMenu = async () => {
  const button = document.querySelector('#account-menu-button')
  const panel = document.querySelector('#account-menu-panel')
  const status = document.querySelector('#account-status')
  const walkBooks = document.querySelector('#account-walk-books')
  const signIn = document.querySelector('#account-sign-in')
  const signOut = document.querySelector('#account-sign-out')

  if (!button || !panel || !status || !walkBooks || !signIn || !signOut) return null

  const configured = ZITADEL_CLIENT_ID !== ''
  const manager = configured ? createManager() : null
  let user = null
  let authError = null

  const close = () => {
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
  }

  const render = () => {
    const authenticated = Boolean(user && !user.expired)
    status.textContent = authError
      ? authError
      : configured
      ? authenticated
        ? `Signed in as ${displayName(user.profile)}`
        : 'Not signed in'
      : 'Sign-in is being connected'
    signIn.hidden = authenticated || !configured
    walkBooks.hidden = !authenticated
    signOut.hidden = !authenticated
  }

  button.addEventListener('click', () => {
    const willOpen = panel.hidden
    panel.hidden = !willOpen
    button.setAttribute('aria-expanded', String(willOpen))
    if (willOpen) panel.querySelector('button:not([hidden])')?.focus()
  })

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.account-menu')) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) {
      close()
      button.focus()
    }
  })

  signIn.addEventListener('click', async () => {
    authError = null
    status.textContent = 'Opening Ashterix sign-in…'
    await manager.signinRedirect({ state: { returnTo: window.location.href } })
  })

  walkBooks.addEventListener('click', () => {
    close()
    document.dispatchEvent(new CustomEvent('walk-books:open'))
  })

  signOut.addEventListener('click', async () => {
    status.textContent = 'Signing out…'
    await manager.signoutRedirect()
  })

  if (!manager) {
    render()
    return null
  }

  try {
    if (isCallback()) {
      user = await manager.signinRedirectCallback()
      const returnTo = safeReturnUrl(user.state?.returnTo)
      window.history.replaceState({}, '', returnTo)
    } else {
      user = await manager.getUser()
      if (user?.expired) {
        await manager.removeUser()
        user = null
      }
    }
  } catch (error) {
    console.error('Could not complete sign-in', error)
    authError = 'Sign-in could not be completed'
  }

  manager.events.addUserLoaded((loadedUser) => {
    user = loadedUser
    authError = null
    render()
  })
  manager.events.addUserUnloaded(() => {
    user = null
    render()
  })
  manager.events.addAccessTokenExpired(async () => {
    await manager.removeUser()
    user = null
    render()
  })

  render()

  return {
    getAccessToken: () => (user && !user.expired ? user.access_token : null),
    getRoles: () => rolesFromProfile(user?.profile),
    isSignedIn: () => Boolean(user && !user.expired),
  }
}
