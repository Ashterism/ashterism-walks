export const MEDIA_API_BASE_URL = 'https://media.ashterism.com'
export const BOOK_CATALOGUE_ASSET_ID = '0e1d6348-cf2a-48b9-b615-3bf44e45d85c'

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
  const pageViewer = root.querySelector('#book-page-viewer')
  const pageViewerTitle = root.querySelector('#book-page-viewer-title')
  const pageViewerStatus = root.querySelector('#book-page-viewer-status')
  const pageViewerImage = root.querySelector('#book-page-viewer-image')
  const pageViewerClose = root.querySelector('#book-page-viewer-close')
  let loaded = false
  let coverObjectUrls = []
  let overviewObjectUrls = []
  let walkObjectUrls = []
  let fullSizeUrl = null
  let viewerRequest = 0

  const closePageViewer = () => {
    viewerRequest += 1
    if (pageViewer?.open) pageViewer.close()
    if (fullSizeUrl) URL.revokeObjectURL(fullSizeUrl)
    fullSizeUrl = null
    pageViewerImage.removeAttribute('src')
    pageViewerImage.hidden = true
  }

  const openPageViewer = async (page, alt) => {
    closePageViewer()
    const request = ++viewerRequest
    pageViewerTitle.textContent = page.label || 'Book page'
    pageViewerStatus.textContent = 'Loading full-size page…'
    pageViewerStatus.hidden = false
    pageViewer.showModal()

    try {
      const response = await fetchPrivate(page.contentPath, getAccessToken())
      const url = URL.createObjectURL(await response.blob())
      if (request !== viewerRequest) {
        URL.revokeObjectURL(url)
        return
      }
      fullSizeUrl = url
      pageViewerImage.src = fullSizeUrl
      pageViewerImage.alt = alt
      pageViewerImage.hidden = false
      pageViewerStatus.hidden = true
    } catch (error) {
      pageViewerStatus.textContent = error.message
    }
  }

  pageViewerClose?.addEventListener('click', closePageViewer)
  pageViewer?.addEventListener('close', closePageViewer)
  pageViewer?.addEventListener('click', (event) => {
    if (event.target === pageViewer) closePageViewer()
  })

  const clearObjectUrls = () => {
    closePageViewer()
    coverObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    overviewObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    walkObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    coverObjectUrls = []
    overviewObjectUrls = []
    walkObjectUrls = []
  }

  const loadPageFigure = async (page, alt, urlGroup) => {
    const response = await fetchPrivate(page.displayPath, getAccessToken())
    const url = URL.createObjectURL(await response.blob())
    urlGroup.push(url)
    const figure = element('figure', '')
    const button = element('button', 'book-page-button')
    button.type = 'button'
    button.setAttribute('aria-label', `Open ${page.label || 'book page'} full size`)
    const image = element('img', '')
    image.src = url
    image.alt = alt
    image.loading = 'lazy'
    button.append(image, element('span', 'book-page-button__hint', 'View full size'))
    button.addEventListener('click', () => openPageViewer(page, alt))
    figure.append(button, element('figcaption', '', page.label))
    return figure
  }

  const showError = (message) => {
    status.textContent = message
    status.hidden = false
    browser.hidden = true
  }

  const selectSection = (buttons, section) => {
    buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.bookSection === section)))
  }

  const clearPagePreviews = () => {
    closePageViewer()
    overviewObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    walkObjectUrls.forEach((url) => URL.revokeObjectURL(url))
    overviewObjectUrls = []
    walkObjectUrls = []
  }

  const renderWalk = async (book, walk, detail, buttons) => {
    selectSection(buttons, `walk-${walk.number}`)
    clearPagePreviews()
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
      const pageImages = await Promise.all(walk.pages.map((page) => loadPageFigure(page, `${walk.title}, ${page.label}`, walkObjectUrls)))
      pages.replaceChildren(...pageImages)
    } catch (error) {
      pages.replaceChildren(element('p', 'book-library__error', error.message))
    }
  }

  const renderFrontMatter = async (book, detail, buttons) => {
    selectSection(buttons, 'maps-index')
    clearPagePreviews()
    detail.replaceChildren()

    const frontPages = book.frontMatter?.slice(0, 2) || []
    if (!frontPages.length) {
      detail.append(element('p', 'book-library__error', 'The book maps are not available yet.'))
      return
    }

    const copy = element('div', 'book-walk-preview__copy')
    copy.append(element('p', 'detail-card__eyebrow', 'Front of the book'))
    copy.append(element('h3', '', 'Book maps & index'))
    copy.append(element('p', 'book-section-intro', 'The walk index and the overview map showing all 28 routes.'))
    const pages = element('div', 'book-walk-preview__pages')
    pages.setAttribute('aria-live', 'polite')
    pages.append(element('p', 'book-library__loading', 'Loading the book maps…'))
    detail.append(copy, pages)

    try {
      const figures = await Promise.all(frontPages.map((page) => loadPageFigure(page, `${book.title}, ${page.label}`, overviewObjectUrls)))
      pages.replaceChildren(...figures)
    } catch (error) {
      pages.replaceChildren(element('p', 'book-library__error', error.message))
    }
  }

  const loadCover = async (book, container) => {
    if (!book.cover) return
    try {
      const path = book.cover.thumbPath || book.cover.displayPath || book.cover.contentPath
      const response = await fetchPrivate(path, getAccessToken())
      const url = URL.createObjectURL(await response.blob())
      coverObjectUrls.push(url)
      const image = element('img', 'book-cover')
      image.src = url
      image.alt = `Cover of ${book.title}`
      container.replaceChildren(image)
    } catch {
      // The title and walks remain usable if a cover cannot be loaded.
    }
  }

  const render = (catalogue) => {
    const books = catalogue.books || []
    if (!books.length) throw new Error('No walk book is available yet.')

    const bookList = element('div', 'book-list')
    const detail = element('section', 'book-walk-preview')
    detail.setAttribute('aria-label', 'Selected book section')

    books.forEach((book, bookIndex) => {
      const bookEntry = element('details', 'book-entry')
      bookEntry.open = bookIndex === 0
      const summary = element('summary', '')
      const cover = element('span', 'book-cover-placeholder', book.cover ? 'Loading cover' : 'Cover coming soon')
      summary.append(cover)
      const summaryCopy = element('span', 'book-entry__summary-copy')
      summaryCopy.append(element('strong', '', book.title), element('small', '', `${book.walks.length} walks + maps & index`))
      summary.append(summaryCopy)

      const list = element('div', 'book-entry__walks')
      const buttons = []
      const frontMatterButton = element('button', 'book-entry__front-matter')
      frontMatterButton.type = 'button'
      frontMatterButton.dataset.bookSection = 'maps-index'
      frontMatterButton.append(element('strong', '', 'Book maps & index'), element('span', '', 'Contents · All walks overview'))
      frontMatterButton.addEventListener('click', () => renderFrontMatter(book, detail, buttons))
      list.append(frontMatterButton)
      buttons.push(frontMatterButton)

      book.walks.forEach((walk) => {
        const button = element('button', '')
        button.type = 'button'
        button.dataset.bookSection = `walk-${walk.number}`
        button.append(element('strong', '', `${walk.number}. ${walk.title}`), element('span', '', `${walk.distance} · ${walk.start}`))
        button.addEventListener('click', () => renderWalk(book, walk, detail, buttons))
        list.append(button)
        buttons.push(button)
      })

      bookEntry.addEventListener('toggle', () => {
        if (!bookEntry.open) return
        bookList.querySelectorAll('.book-entry').forEach((entry) => {
          if (entry !== bookEntry) entry.open = false
        })
        renderFrontMatter(book, detail, buttons)
      })
      bookEntry.append(summary, list)
      bookList.append(bookEntry)
      loadCover(book, cover)

      if (bookIndex === 0) renderFrontMatter(book, detail, buttons)
    })

    browser.replaceChildren(bookList, detail)
    browser.hidden = false
    status.hidden = true
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
