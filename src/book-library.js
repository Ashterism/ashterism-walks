export const MEDIA_API_BASE_URL = 'https://media.ashterism.com'
export const BOOK_CATALOGUE_ASSET_ID = 'a8927d75-17bb-4931-9fd9-787eb04fbd59'

const cataloguePath = `/v1/assets/${BOOK_CATALOGUE_ASSET_ID}/content`

export const mediaUrl = (path, baseUrl = MEDIA_API_BASE_URL) => {
  if (!path?.startsWith('/')) throw new Error('Private media paths must be absolute API paths')
  return new URL(path, `${baseUrl}/`).toString()
}

const fetchPrivate = async (path, token) => {
  if (!token) throw new Error('Sign in again to open the private library.')
  const response = await fetch(mediaUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })

  if (response.status === 401) throw new Error('Your session has expired. Sign out and back in.')
  if (response.status === 403) throw new Error('Your account does not have access to this book.')
  if (!response.ok) throw new Error('The private library could not be loaded.')
  return response
}

const element = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export const setupBookLibrary = ({ root, getAccessToken }) => {
  if (!root) return { load: async () => {} }

  const status = root.querySelector('#book-library-status')
  const browser = root.querySelector('#book-browser')
  let loaded = false
  let objectUrls = []

  const clearObjectUrls = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
    objectUrls = []
  }

  const showError = (message) => {
    status.textContent = message
    status.hidden = false
    browser.hidden = true
  }

  const renderWalk = async (book, walk, detail, buttons) => {
    buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.walkNumber === String(walk.number))))
    clearObjectUrls()
    detail.replaceChildren()

    const copy = element('div', 'book-walk-preview__copy')
    copy.append(element('p', 'detail-card__eyebrow', `Walk ${walk.number}`))
    copy.append(element('h3', '', walk.title))

    const facts = element('dl', '')
    for (const [label, value] of [
      ['Distance', walk.distance],
      ['Start', walk.start],
      ['Grid reference', walk.gridReference],
      ['Ascent', walk.ascent],
      ['Time', walk.time],
    ]) {
      const row = element('div', '')
      row.append(element('dt', '', label), element('dd', '', value))
      facts.append(row)
    }
    copy.append(facts)

    const pages = element('div', 'book-walk-preview__pages')
    pages.setAttribute('aria-live', 'polite')
    pages.append(element('p', 'book-library__loading', 'Loading photographed pages…'))
    detail.append(copy, pages)

    try {
      const token = getAccessToken()
      const pageImages = await Promise.all(walk.pages.map(async (page) => {
        const response = await fetchPrivate(page.displayPath, token)
        const url = URL.createObjectURL(await response.blob())
        objectUrls.push(url)
        const figure = element('figure', '')
        const image = element('img', '')
        image.src = url
        image.alt = `${walk.title}, ${page.label}`
        image.loading = 'lazy'
        figure.append(image, element('figcaption', '', page.label))
        return figure
      }))
      pages.replaceChildren(...pageImages)
    } catch (error) {
      pages.replaceChildren(element('p', 'book-library__error', error.message))
    }
  }

  const render = (catalogue) => {
    const book = catalogue.books?.[0]
    if (!book) throw new Error('No walk book is available yet.')

    const bookEntry = element('details', 'book-entry')
    bookEntry.open = true
    const summary = element('summary', '')
    summary.append(element('span', 'book-cover-placeholder', 'Cover coming soon'))
    const summaryCopy = element('span', 'book-entry__summary-copy')
    summaryCopy.append(element('strong', '', book.title), element('small', '', `${book.walks.length} walks`))
    summary.append(summaryCopy)

    const list = element('div', 'book-entry__walks')
    const detail = element('section', 'book-walk-preview')
    detail.setAttribute('aria-label', 'Selected walk')
    const buttons = book.walks.map((walk) => {
      const button = element('button', '')
      button.type = 'button'
      button.dataset.walkNumber = walk.number
      button.append(element('strong', '', `${walk.number}. ${walk.title}`), element('span', '', `${walk.distance} · ${walk.start}`))
      button.addEventListener('click', () => renderWalk(book, walk, detail, buttons))
      list.append(button)
      return button
    })

    bookEntry.append(summary, list)
    browser.replaceChildren(bookEntry, detail)
    browser.hidden = false
    status.hidden = true
    renderWalk(book, book.walks[0], detail, buttons)
  }

  const load = async () => {
    if (loaded) return
    status.textContent = 'Loading your private walk books…'
    status.hidden = false
    browser.hidden = true
    try {
      const response = await fetchPrivate(cataloguePath, getAccessToken())
      render(await response.json())
      loaded = true
    } catch (error) {
      showError(error.message)
    }
  }

  return { load, clearObjectUrls }
}
